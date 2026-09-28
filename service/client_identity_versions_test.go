package service

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClientIdentityVersionServiceLoadsNPMVersionsAndFallsBackToCache(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		assert.Equal(t, "application/vnd.npm.install-v1+json", r.Header.Get("Accept"))
		if requestCount > 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		assert.Contains(t, r.URL.Path, "@openai")
		_, _ = w.Write([]byte(`{"name":"@openai/codex","dist-tags":{"latest":"1.2.3"},"versions":{"1.2.3":{},"1.2.2":{},"not-a-version":{}}}`))
	}))
	defer server.Close()

	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:     server.Client(),
		NPMRegistryURL: server.URL,
		CacheTTL:       time.Minute,
	})

	lookup, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.Equal(t, "1.2.3", lookup.Latest)
	assert.Equal(t, []string{"1.2.3", "1.2.2"}, lookup.Versions)
	assert.Equal(t, dto.ClientIdentitySourceNPM, lookup.Source.Kind)
	assert.Equal(t, dto.ClientIdentityNPMCodexPackage, lookup.Source.Package)
	assert.False(t, lookup.Cached)

	stale, err := service.RefreshVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.True(t, stale.Cached)
	assert.True(t, stale.Stale)
	assert.Equal(t, "1.2.3", stale.Latest)
}

func TestClientIdentityVersionServiceRefreshesCachedEntriesOnly(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		_, _ = w.Write([]byte(`{"name":"@openai/codex","dist-tags":{"latest":"1.2.3"},"versions":{"1.2.3":{}}}`))
	}))
	defer server.Close()

	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:     server.Client(),
		NPMRegistryURL: server.URL,
	})

	_, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.Equal(t, 1, requestCount)

	summary, err := service.RefreshCachedVersions(t.Context())
	require.NoError(t, err)
	assert.Equal(t, ClientIdentityVersionRefreshSummary{Checked: 1, Refreshed: 1}, summary)
	assert.Equal(t, 2, requestCount)

	// Unused profiles are not fetched by the scheduled refresh pass.
	_, err = service.RefreshCachedVersions(t.Context())
	require.NoError(t, err)
	assert.Equal(t, 3, requestCount)
}

func TestClientIdentityVersionServiceMarksCacheDueAfterTTL(t *testing.T) {
	now := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		CacheTTL: time.Hour,
		Now:      func() time.Time { return now },
	})

	_, err := service.ListVersions(
		t.Context(),
		dto.ClientIdentityProfileCodeBuddyCLI,
		dto.ClientIdentityPlatformLinuxX64,
	)
	require.NoError(t, err)
	assert.False(t, service.HasDueVersions())

	now = now.Add(time.Hour)
	assert.True(t, service.HasDueVersions())
}

func TestClientIdentityVersionServiceFailedRefreshExtendsCacheWindow(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if requestCount > 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"name":"@openai/codex","dist-tags":{"latest":"1.2.3"},"versions":{"1.2.3":{}}}`))
	}))
	defer server.Close()

	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:     server.Client(),
		NPMRegistryURL: server.URL,
		CacheTTL:       time.Hour,
	})

	first, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.Equal(t, "1.2.3", first.Latest)

	stale, err := service.RefreshVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.True(t, stale.Stale)
	assert.Equal(t, 2, requestCount)

	cached, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.Equal(t, "1.2.3", cached.Latest)
	assert.True(t, cached.Cached)
	assert.False(t, cached.Stale)
	assert.Equal(t, 2, requestCount)
}

func TestClientIdentityVersionServiceFiltersNPMBuildsByPlatform(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "application/vnd.npm.install-v1+json", r.Header.Get("Accept"))
		_, err := w.Write([]byte(`{
			"name":"@openai/codex",
			"dist-tags":{"latest":"1.4.0-win32-x64"},
			"versions":{
				"1.4.0":{},
				"1.4.0-win32-x64":{},
				"1.4.0-linux-x64":{},
				"1.4.0-darwin-arm64":{},
				"1.3.0-linux-x64":{},
				"1.3.0-linux-x64-beta":{},
				"1.2.0-beta":{},
				"1.1.0-darwin-x64":{},
				"1.0.0-win32-arm64":{}
			}
		}`))
		require.NoError(t, err)
	}))
	defer server.Close()

	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:     server.Client(),
		NPMRegistryURL: server.URL,
	})

	lookup, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, dto.ClientIdentityPlatformLinuxX64)
	require.NoError(t, err)
	assert.Equal(t, dto.ClientIdentityPlatformLinuxX64, lookup.Platform)
	assert.Equal(t, "1.4.0", lookup.Latest)
	assert.Equal(t, []string{
		"1.4.0",
		"1.4.0-linux-x64",
		"1.3.0-linux-x64",
	}, lookup.Versions)
	assert.NotContains(t, lookup.Versions, "1.4.0-win32-x64")
	assert.NotContains(t, lookup.Versions, "1.4.0-darwin-arm64")
	assert.NotContains(t, lookup.Versions, "1.1.0-darwin-x64")
	assert.NotContains(t, lookup.Versions, "1.0.0-win32-arm64")
	assert.NotContains(t, lookup.Versions, "1.3.0-linux-x64-beta")

	defaultLookup, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.Equal(t, "1.4.0", defaultLookup.Latest)
	assert.Equal(t, []string{"1.4.0"}, defaultLookup.Versions)
}

func TestClientIdentityVersionServiceFiltersNPMPrereleasesAndFallsBackToStableLatest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := w.Write([]byte(`{
			"name":"@openai/codex",
			"dist-tags":{"latest":"1.5.0-beta.1"},
			"versions":{
				"1.5.0-beta.1":{},
				"1.4.0":{},
				"1.3.0-alpha":{},
				"1.2.0":{}
			}
		}`))
		require.NoError(t, err)
	}))
	defer server.Close()

	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:     server.Client(),
		NPMRegistryURL: server.URL,
	})

	lookup, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.Equal(t, "1.4.0", lookup.Latest)
	assert.Equal(t, []string{"1.4.0", "1.2.0"}, lookup.Versions)
	assert.NotContains(t, lookup.Versions, "1.5.0-beta.1")
	assert.NotContains(t, lookup.Versions, "1.3.0-alpha")
}

func TestNPMVersionPlatformFilterKeepsBaseAndMatchingArchitectureBuilds(t *testing.T) {
	tests := []struct {
		name     string
		platform string
		version  string
		want     bool
	}{
		{name: "base version", platform: dto.ClientIdentityPlatformMacOSArm64, version: "2.0.0", want: true},
		{name: "matching darwin architecture", platform: dto.ClientIdentityPlatformMacOSArm64, version: "2.0.0-darwin-arm64", want: true},
		{name: "matching platform build with metadata", platform: dto.ClientIdentityPlatformLinuxX64, version: "2.0.0-linux-x64+foo", want: true},
		{name: "other darwin architecture", platform: dto.ClientIdentityPlatformMacOSArm64, version: "2.0.0-darwin-x64", want: false},
		{name: "other operating system", platform: dto.ClientIdentityPlatformMacOSArm64, version: "2.0.0-linux-arm64", want: false},
		{name: "platform build metadata is not prerelease", platform: dto.ClientIdentityPlatformLinuxX64, version: "2.0.0+foo-linux-x64", want: true},
		{name: "platform build metadata is base version on another platform", platform: dto.ClientIdentityPlatformWindowsX64, version: "2.0.0+foo-linux-x64", want: true},
		{name: "default platform keeps base version", platform: "", version: "2.0.0", want: true},
		{name: "default platform keeps build metadata", platform: "", version: "2.0.0+foo-linux-x64", want: true},
		{name: "default platform excludes matching platform build", platform: "", version: "2.0.0-linux-x64+foo", want: false},
		{name: "default platform excludes windows x64 build", platform: "", version: "2.0.0-win32-x64", want: false},
		{name: "default platform excludes windows arm64 build", platform: "", version: "2.0.0-win32-arm64", want: false},
		{name: "default platform excludes linux x64 build", platform: "", version: "2.0.0-linux-x64", want: false},
		{name: "default platform excludes linux arm64 build", platform: "", version: "2.0.0-linux-arm64", want: false},
		{name: "default platform excludes darwin x64 build", platform: "", version: "2.0.0-darwin-x64", want: false},
		{name: "default platform excludes darwin arm64 build", platform: "", version: "2.0.0-darwin-arm64", want: false},
		{name: "alpha is not a platform build", platform: dto.ClientIdentityPlatformLinuxX64, version: "2.0.0-alpha-linux-x64", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, isNPMVersionAllowedForPlatform(tt.version, tt.platform))
		})
	}
}

func TestClientIdentityVersionsUseSemverOrdering(t *testing.T) {
	assert.Greater(t, compareClientIdentityVersions("2.10.0", "2.9.99"), 0)
	assert.Greater(t, compareClientIdentityVersions("2.10.0", "2.10.0-beta.1"), 0)
	assert.Greater(t, compareClientIdentityVersions("2.10.0-beta.2", "2.10.0-beta.1"), 0)
}

func TestClientIdentityVersionServiceAllowsManualProfilesWithoutLatest(t *testing.T) {
	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{})
	lookup, err := service.ListVersions(
		t.Context(),
		dto.ClientIdentityProfileCodeBuddyCLI,
		dto.ClientIdentityPlatformLinuxX64,
	)
	require.NoError(t, err)
	assert.Empty(t, lookup.Versions)
	assert.Empty(t, lookup.Latest)
	assert.Equal(t, dto.ClientIdentitySourceManual, lookup.Source.Kind)
}

func TestClientIdentityVersionServiceAcceptsLargeOfficialNPMPackument(t *testing.T) {
	body := fmt.Sprintf(
		`{"name":"@openai/codex","dist-tags":{"latest":"1.2.3"},"versions":{"1.2.3":{}},"padding":%q}`,
		strings.Repeat("x", 3<<20),
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "application/vnd.npm.install-v1+json", r.Header.Get("Accept"))
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:     server.Client(),
		NPMRegistryURL: server.URL,
	})
	lookup, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.Equal(t, []string{"1.2.3"}, lookup.Versions)
}

func TestClientIdentityVersionServiceUsesOfficialWorkBuddyProductEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "workbuddy-win32-x64-user", r.URL.Query().Get("platform"))
		_, _ = w.Write([]byte(`{"productVersion":"5.3.8.34705286","downloadUrl":"https://example.invalid/installer"}`))
	}))
	defer server.Close()

	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:         server.Client(),
		WorkBuddyUpdateURL: server.URL + "/v2/update",
	})
	lookup, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodeBuddy, dto.ClientIdentityPlatformWindowsX64)
	require.NoError(t, err)
	assert.Equal(t, dto.ClientIdentityClientTypeCodeBuddy, lookup.ClientType)
	assert.Equal(t, dto.ClientIdentityPlatformWindowsX64, lookup.Platform)
	assert.Equal(t, []string{"5.3.8.34705286"}, lookup.Versions)
	assert.Equal(t, dto.ClientIdentitySourceWorkBuddy, lookup.Source.Kind)
	assert.Empty(t, lookup.Source.Package)
}

func TestClientIdentityVersionServiceRejectsUnverifiedWorkBuddyPlatform(t *testing.T) {
	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{})
	_, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodeBuddy, dto.ClientIdentityPlatformMacOSArm64)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not supported by WorkBuddy update service")
}

func TestClientIdentityVersionServiceRejectsInvalidWorkBuddyProductVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"productVersion":"5.3.8.34705286-beta"}`))
	}))
	defer server.Close()

	service := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:         server.Client(),
		WorkBuddyUpdateURL: server.URL,
	})
	_, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodeBuddy, "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid WorkBuddy product version")
}

// clientIdentityRegistry is a fake npm registry. It answers a package with its
// latest version, or 502 when that version is empty or missing, and counts the
// requests per package.
type clientIdentityRegistry struct {
	mu       sync.Mutex
	latest   map[string]string
	requests map[string]int
}

func newClientIdentityRegistry(t *testing.T, latest map[string]string) (*clientIdentityRegistry, *httptest.Server) {
	t.Helper()
	registry := &clientIdentityRegistry{latest: latest, requests: make(map[string]int)}
	server := httptest.NewServer(registry)
	t.Cleanup(server.Close)
	return registry, server
}

func (r *clientIdentityRegistry) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	name := strings.TrimPrefix(req.URL.Path, "/")
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests[name]++
	version := r.latest[name]
	if version == "" {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	_, _ = fmt.Fprintf(w, `{"name":%q,"dist-tags":{"latest":%q},"versions":{%q:{}}}`, name, version, version)
}

func (r *clientIdentityRegistry) setLatest(name, version string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.latest[name] = version
}

func (r *clientIdentityRegistry) requestCount(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.requests[name]
}

func TestClientIdentityLatestVersionIsCheckedInTheBackground(t *testing.T) {
	now := time.Date(2026, time.September, 28, 0, 0, 0, 0, time.UTC)
	registry, server := newClientIdentityRegistry(t, map[string]string{
		dto.ClientIdentityNPMClaudeCodePackage: "2.1.283",
	})
	versions := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:       server.Client(),
		NPMRegistryURL:   server.URL,
		CacheTTL:         time.Hour,
		Now:              func() time.Time { return now },
		BackgroundChecks: true,
	})

	// Until the first check answers, callers keep their built-in version.
	assert.Empty(t, versions.LatestVersion(dto.ClientIdentityProfileClaudeCode, ""))
	versions.background.Wait()
	assert.Equal(t, "2.1.283", versions.LatestVersion(dto.ClientIdentityProfileClaudeCode, ""))

	// A version checked a cache period ago is still used while the next
	// check runs.
	registry.setLatest(dto.ClientIdentityNPMClaudeCodePackage, "2.1.284")
	now = now.Add(time.Hour)
	assert.Equal(t, "2.1.283", versions.LatestVersion(dto.ClientIdentityProfileClaudeCode, ""))
	versions.background.Wait()
	assert.Equal(t, "2.1.284", versions.LatestVersion(dto.ClientIdentityProfileClaudeCode, ""))
	assert.Equal(t, 2, registry.requestCount(dto.ClientIdentityNPMClaudeCodePackage))
}

func TestClientIdentityLatestVersionRetriesAnUnansweredSourceLater(t *testing.T) {
	now := time.Date(2026, time.September, 28, 0, 0, 0, 0, time.UTC)
	registry, server := newClientIdentityRegistry(t, map[string]string{})
	versions := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:       server.Client(),
		NPMRegistryURL:   server.URL,
		CacheTTL:         time.Hour,
		Now:              func() time.Time { return now },
		BackgroundChecks: true,
	})
	check := func() string {
		versions.LatestVersion(dto.ClientIdentityProfileCodexCLI, "")
		versions.background.Wait()
		return versions.LatestVersion(dto.ClientIdentityProfileCodexCLI, "")
	}

	// With nothing cached, a source that does not answer is not asked again
	// until the retry delay has passed.
	assert.Empty(t, check())
	assert.Empty(t, check())
	assert.Equal(t, 1, registry.requestCount(dto.ClientIdentityNPMCodexPackage))
	registry.setLatest(dto.ClientIdentityNPMCodexPackage, "0.158.0")
	now = now.Add(clientIdentityCheckRetry)
	assert.Equal(t, "0.158.0", check())
	assert.Equal(t, 2, registry.requestCount(dto.ClientIdentityNPMCodexPackage))

	// A cached version outlives a failed check, which is retried after the
	// retry delay rather than after another cache period.
	registry.setLatest(dto.ClientIdentityNPMCodexPackage, "")
	now = now.Add(time.Hour)
	assert.Equal(t, "0.158.0", check())
	registry.setLatest(dto.ClientIdentityNPMCodexPackage, "0.159.0")
	now = now.Add(clientIdentityCheckRetry)
	assert.Equal(t, "0.159.0", check())
	assert.Equal(t, 4, registry.requestCount(dto.ClientIdentityNPMCodexPackage))
}

func TestClientIdentityLatestVersionWithoutBackgroundChecksUsesAdminLookups(t *testing.T) {
	registry, server := newClientIdentityRegistry(t, map[string]string{
		dto.ClientIdentityNPMClaudeCodePackage: "2.1.283",
	})
	versions := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:     server.Client(),
		NPMRegistryURL: server.URL,
	})

	assert.Empty(t, versions.LatestVersion(dto.ClientIdentityProfileClaudeCLI, ""))
	versions.background.Wait()
	assert.Zero(t, registry.requestCount(dto.ClientIdentityNPMClaudeCodePackage))

	_, err := versions.ListVersions(t.Context(), dto.ClientIdentityProfileClaudeCLI, "")
	require.NoError(t, err)
	assert.Equal(t, "2.1.283", versions.LatestVersion(dto.ClientIdentityProfileClaudeCLI, ""))
}

func TestClientIdentityVersionChecksCoverEnabledChannelsFollowingTheLatestVersion(t *testing.T) {
	truncate(t)
	channels := []*model.Channel{
		{Id: 1, Type: constant.ChannelTypeClaudeCode, Name: "claude code", Key: "sk-1", Status: common.ChannelStatusEnabled},
		{
			Id: 2, Type: constant.ChannelTypeAnthropic, Name: "anthropic", Key: "sk-2", Status: common.ChannelStatusEnabled,
			OtherSettings: `{"client_identity":{"client_type":"claude","profile":"claude_cli","platform":"macos-arm64"}}`,
		},
		{
			Id: 3, Type: constant.ChannelTypeCodexCompatibility, Name: "pinned codex", Key: "sk-3", Status: common.ChannelStatusEnabled,
			OtherSettings: `{"client_identity":{"client_type":"codex","profile":"codex_compatibility","version":"0.150.0"}}`,
		},
		{Id: 4, Type: constant.ChannelTypeCodexCompatibility, Name: "disabled codex", Key: "sk-4", Status: common.ChannelStatusManuallyDisabled},
		{Id: 5, Type: constant.ChannelTypeOpenAI, Name: "openai", Key: "sk-5", Status: common.ChannelStatusEnabled},
		{Id: 6, Type: constant.ChannelTypeCodex, Name: "codex", Key: "sk-6", Status: common.ChannelStatusEnabled},
	}
	for _, channel := range channels {
		require.NoError(t, model.DB.Create(channel).Error)
	}
	registry, server := newClientIdentityRegistry(t, map[string]string{
		dto.ClientIdentityNPMClaudeCodePackage: "2.1.283",
		dto.ClientIdentityNPMCodexPackage:      "0.158.0",
	})
	versions := NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{
		HTTPClient:       server.Client(),
		NPMRegistryURL:   server.URL,
		BackgroundChecks: true,
	})

	versions.checkChannelVersions()
	versions.background.Wait()

	// The Claude Code channel and the Claude CLI identity are checked. The
	// pinned and disabled Codex compatibility channels, the Codex channel
	// without a saved identity and the plain OpenAI channel are not.
	assert.Zero(t, registry.requestCount(dto.ClientIdentityNPMCodexPackage))
	assert.Equal(t, "2.1.283", versions.LatestVersion(dto.ClientIdentityProfileClaudeCode, ""))
	assert.Equal(t, "2.1.283", versions.LatestVersion(dto.ClientIdentityProfileClaudeCLI, dto.ClientIdentityPlatformMacOSArm64))
}

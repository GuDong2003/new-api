package service

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
		"1.2.0-beta",
	}, lookup.Versions)
	assert.NotContains(t, lookup.Versions, "1.4.0-win32-x64")
	assert.NotContains(t, lookup.Versions, "1.4.0-darwin-arm64")
	assert.NotContains(t, lookup.Versions, "1.1.0-darwin-x64")
	assert.NotContains(t, lookup.Versions, "1.0.0-win32-arm64")

	defaultLookup, err := service.ListVersions(t.Context(), dto.ClientIdentityProfileCodexLegacy, "")
	require.NoError(t, err)
	assert.Equal(t, "1.4.0", defaultLookup.Latest)
	assert.Equal(t, []string{"1.4.0", "1.2.0-beta"}, defaultLookup.Versions)
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
		{name: "other darwin architecture", platform: dto.ClientIdentityPlatformMacOSArm64, version: "2.0.0-darwin-x64", want: false},
		{name: "other operating system", platform: dto.ClientIdentityPlatformMacOSArm64, version: "2.0.0-linux-arm64", want: false},
		{name: "default platform keeps base version", platform: "", version: "2.0.0", want: true},
		{name: "default platform excludes windows x64 build", platform: "", version: "2.0.0-win32-x64", want: false},
		{name: "default platform excludes windows arm64 build", platform: "", version: "2.0.0-win32-arm64", want: false},
		{name: "default platform excludes linux x64 build", platform: "", version: "2.0.0-linux-x64", want: false},
		{name: "default platform excludes linux arm64 build", platform: "", version: "2.0.0-linux-arm64", want: false},
		{name: "default platform excludes darwin x64 build", platform: "", version: "2.0.0-darwin-x64", want: false},
		{name: "default platform excludes darwin arm64 build", platform: "", version: "2.0.0-darwin-arm64", want: false},
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

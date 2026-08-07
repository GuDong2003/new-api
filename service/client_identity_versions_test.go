package service

import (
	"net/http"
	"net/http/httptest"
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

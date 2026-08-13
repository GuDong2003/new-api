package service

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSanitizeSVGPreservesSafeAnimations(t *testing.T) {
	source := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <style>
    @keyframes pulse { from { opacity: .4; } to { opacity: 1; } }
    .face { animation: pulse 1s infinite alternate; fill: url(#paint); }
  </style>
  <defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>
  <circle class="face" cx="32" cy="32" r="24">
    <animate attributeName="r" values="22;25;22" dur="1.2s" repeatCount="indefinite"/>
  </circle>
</svg>`)

	sanitized, err := SanitizeSVG(source)
	require.NoError(t, err)
	result := string(sanitized)
	assert.Contains(t, result, "@keyframes pulse")
	assert.Contains(t, result, `animation: pulse 1s infinite alternate`)
	assert.Contains(t, result, `<animate attributeName="r"`)
	assert.Contains(t, result, `repeatCount="indefinite"`)
	assert.Contains(t, result, `fill: url(#paint)`)
}

func TestSanitizeSVGRemovesExecutableAndExternalContent(t *testing.T) {
	source := []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10">
  <script>alert(1)</script>
  <foreignObject><iframe src="https://example.com"/></foreignObject>
  <image href="https://example.com/tracker.png"/>
  <use href="https://example.com/a.svg#x"/>
  <circle cx="5" cy="5" r="4" onclick="alert(2)" style="fill:url(https://example.com/a.png)"/>
</svg>`)

	sanitized, err := SanitizeSVG(source)
	require.NoError(t, err)
	result := string(sanitized)
	assert.NotContains(t, result, "script")
	assert.NotContains(t, result, "foreignObject")
	assert.NotContains(t, result, "iframe")
	assert.NotContains(t, result, "image")
	assert.NotContains(t, result, "onload")
	assert.NotContains(t, result, "onclick")
	assert.NotContains(t, result, "https://")
	assert.Contains(t, result, `<circle cx="5" cy="5" r="4"></circle>`)
}

func TestSanitizeSVGRejectsEscapedExternalCSSURL(t *testing.T) {
	for _, stylesheet := range []string{
		`.x{fill:u\72l(https://example.com/a.png)}`,
		".x{fill:u\\\nrl(https://example.com/a.png)}",
	} {
		source := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><style>` + stylesheet + `</style><circle class="x" r="1"/></svg>`)

		_, err := SanitizeSVG(source)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "unsafe resource reference")
	}
}

func TestManagedAvatarLifecycleOnlyTouchesDedicatedFiles(t *testing.T) {
	t.Setenv("AVATAR_STORAGE_DIR", t.TempDir())
	prepared := &PreparedAvatar{Data: []byte("safe-avatar"), Extension: "png", MIMEType: "image/png"}

	avatarURL, err := StoreAvatar(prepared)
	require.NoError(t, err)
	filename, ok := ManagedAvatarFilename(avatarURL)
	require.True(t, ok)
	storedPath, ok := AvatarFilePath(filename)
	require.True(t, ok)
	_, err = os.Stat(storedPath)
	require.NoError(t, err)

	outsidePath := filepath.Join(filepath.Dir(storedPath), "outside.txt")
	require.NoError(t, os.WriteFile(outsidePath, []byte("keep"), 0600))
	require.NoError(t, DeleteManagedAvatar("/api/avatar/../outside.txt"))
	_, err = os.Stat(outsidePath)
	require.NoError(t, err)

	require.NoError(t, DeleteManagedAvatar(avatarURL))
	_, err = os.Stat(storedPath)
	assert.ErrorIs(t, err, os.ErrNotExist)
}

func TestAvatarRemoteURLAndIPValidation(t *testing.T) {
	_, err := validateAvatarRemoteURL("http://example.com/avatar.png")
	require.Error(t, err)
	_, err = validateAvatarRemoteURL("https://user:pass@example.com/avatar.png")
	require.Error(t, err)
	parsed, err := validateAvatarRemoteURL("https://example.com/avatar.svg")
	require.NoError(t, err)
	assert.Equal(t, "example.com", parsed.Hostname())

	for _, blocked := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1"} {
		assert.False(t, isSafeRemoteIP(net.ParseIP(blocked)), blocked)
	}
	assert.True(t, isSafeRemoteIP(net.ParseIP("1.1.1.1")))
}

func TestPrepareAvatarRejectsNonImage(t *testing.T) {
	_, err := PrepareAvatar([]byte(strings.Repeat("not an image", 20)))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "only JPEG")
}

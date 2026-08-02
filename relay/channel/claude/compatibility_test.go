package claude

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClaudeCodeCompatibilityUsesBearerIdentity(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	c.Request.Header.Set("Anthropic-Beta", "interleaved-thinking-2025-05-14")
	info := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType: constant.ChannelTypeClaudeCode,
			ApiKey:      "test-key",
		},
	}
	headers := http.Header{
		"X-Stainless-Lang": []string{"node"},
		"Sec-Fetch-Mode":   []string{"cors"},
	}

	require.NoError(t, (&Adaptor{}).SetupRequestHeader(c, &headers, info))

	assert.Equal(t, "Bearer test-key", headers.Get("Authorization"))
	assert.Empty(t, headers.Get("x-api-key"))
	assert.Empty(t, headers.Get("x-stainless-lang"))
	assert.Empty(t, headers.Get("sec-fetch-mode"))
	assert.Equal(t, "2.1.178 (Claude Code)", headers.Get("User-Agent"))
	assert.Equal(t, "2023-06-01", headers.Get("Anthropic-Version"))
	assert.Equal(t, "application/json", headers.Get("Accept"))
	assert.Equal(t, "application/json", headers.Get("Content-Type"))
	assert.Equal(t, "interleaved-thinking-2025-05-14", headers.Get("Anthropic-Beta"))
}

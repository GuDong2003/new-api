package claude

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClaudeCodeSetupRetainsInboundAnthropicBeta(t *testing.T) {
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

	assert.Equal(t, "test-key", headers.Get("x-api-key"))
	assert.Equal(t, "node", headers.Get("x-stainless-lang"))
	assert.Equal(t, "2023-06-01", headers.Get("Anthropic-Version"))
	assert.Equal(t, "interleaved-thinking-2025-05-14", headers.Get("Anthropic-Beta"))
}

func TestClaudeCodeDoApiRequestFinalizesProfileAndReusesSession(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	capturedHeaders := make(chan http.Header, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/messages", r.URL.Path)
		capturedHeaders <- r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	info := &relaycommon.RelayInfo{
		IsStream: true,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:    constant.ChannelTypeClaudeCode,
			ChannelBaseUrl: server.URL,
			ApiKey:         "test-key",
			HeadersOverride: map[string]any{
				"X-Safe-Static": "survives",
			},
		},
	}

	for range 2 {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
		c.Request.Header.Set("Content-Type", "text/plain")
		c.Request.Header.Set("Accept", "text/plain")
		c.Request.Header.Set("Anthropic-Version", "old-version")
		c.Request.Header.Set("Anthropic-Beta", "interleaved-thinking-2025-05-14")
		c.Request.Header.Set("X-Stainless-Lang", "node")
		c.Request.Header.Set("X-Claude-Code-Session-Id", "client-supplied")

		result, err := (&Adaptor{}).DoRequest(c, info, http.NoBody)
		require.NoError(t, err)
		resp, ok := result.(*http.Response)
		require.True(t, ok)
		require.NoError(t, resp.Body.Close())
	}

	first := <-capturedHeaders
	second := <-capturedHeaders
	for _, headers := range []http.Header{first, second} {
		assert.Equal(t, "Bearer test-key", headers.Get("Authorization"))
		assert.Equal(t, "test-key", headers.Get("X-Api-Key"))
		assert.Equal(t, "claude-cli/2.1.214 (external, cli)", headers.Get("User-Agent"))
		assert.Equal(t, "cli", headers.Get("X-App"))
		assert.Equal(t, "2023-06-01", headers.Get("Anthropic-Version"))
		assert.Equal(t, "application/json", headers.Get("Content-Type"))
		assert.Equal(t, "text/event-stream", headers.Get("Accept"))
		assert.Equal(t, "survives", headers.Get("X-Safe-Static"))
		assert.Equal(t, "interleaved-thinking-2025-05-14", headers.Get("Anthropic-Beta"))
		assert.Equal(t, "node", headers.Get("X-Stainless-Lang"))
		assert.NotEmpty(t, headers.Get("X-Client-Request-Id"))
	}

	firstSessionID := first.Get("X-Claude-Code-Session-Id")
	_, err := uuid.Parse(firstSessionID)
	require.NoError(t, err)
	assert.NotEqual(t, "client-supplied", firstSessionID)
	assert.Equal(t, firstSessionID, second.Get("X-Claude-Code-Session-Id"))
}

func TestClaudeCodeCountTokensURL(t *testing.T) {
	adaptor := &Adaptor{}

	// Claude Code 兼容渠道：count_tokens 模式拼 /v1/messages/count_tokens
	requestURL, err := adaptor.GetRequestURL(&relaycommon.RelayInfo{
		RelayMode: relayconstant.RelayModeCountTokens,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:    constant.ChannelTypeClaudeCode,
			ChannelBaseUrl: "https://proxy.example",
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "https://proxy.example/v1/messages/count_tokens", requestURL)

	// 普通推理请求仍走 /v1/messages（Claude Code 渠道默认带 ?beta=true）
	requestURL, err = adaptor.GetRequestURL(&relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:    constant.ChannelTypeClaudeCode,
			ChannelBaseUrl: "https://proxy.example",
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "https://proxy.example/v1/messages?beta=true", requestURL)
}

func TestClaudeCodeBetaQueryDefaultsTrue(t *testing.T) {
	adaptor := &Adaptor{}

	// Claude Code 兼容渠道默认追加 ?beta=true（对齐真实客户端）
	requestURL, err := adaptor.GetRequestURL(&relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:    constant.ChannelTypeClaudeCode,
			ChannelBaseUrl: "https://proxy.example",
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "https://proxy.example/v1/messages?beta=true", requestURL)

	// 标准 Anthropic 渠道保持原行为（默认不加）
	requestURL, err = adaptor.GetRequestURL(&relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:    constant.ChannelTypeAnthropic,
			ChannelBaseUrl: "https://proxy.example",
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "https://proxy.example/v1/messages", requestURL)
}

func TestClaudeCodeChannelTestCanDisableClientProfile(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	info := &relaycommon.RelayInfo{
		IsChannelTest:                   true,
		DisableChannelTestClientProfile: true,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType: constant.ChannelTypeClaudeCode,
			ApiKey:      "test-key",
		},
	}

	headers := http.Header{}
	require.NoError(t, (&Adaptor{}).SetupRequestHeader(c, &headers, info))
	assert.Equal(t, "test-key", headers.Get("x-api-key"))
	assert.Empty(t, headers.Get("Authorization"))
	assert.Empty(t, headers.Get("User-Agent"))
}

func TestClaudeCodeChannelTestWithoutProfileKeepsAPIKeyOnWire(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	capturedHeaders := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeaders <- r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	info := &relaycommon.RelayInfo{
		IsChannelTest:                   true,
		DisableChannelTestClientProfile: true,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:    constant.ChannelTypeClaudeCode,
			ChannelBaseUrl: server.URL,
			ApiKey:         "test-key",
		},
	}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)

	result, err := (&Adaptor{}).DoRequest(c, info, http.NoBody)
	require.NoError(t, err)
	resp, ok := result.(*http.Response)
	require.True(t, ok)
	require.NoError(t, resp.Body.Close())

	headers := <-capturedHeaders
	assert.Equal(t, "test-key", headers.Get("X-Api-Key"))
	assert.Empty(t, headers.Get("Authorization"))
	assert.Empty(t, headers.Get("X-Claude-Code-Session-Id"))
}

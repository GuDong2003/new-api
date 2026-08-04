package channel

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestProcessHeaderOverride_ChannelTestSkipsPassthroughRules(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	ctx.Request.Header.Set("X-Trace-Id", "trace-123")

	info := &relaycommon.RelayInfo{
		IsChannelTest: true,
		ChannelMeta: &relaycommon.ChannelMeta{
			HeadersOverride: map[string]any{
				"*": "",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Empty(t, headers)
}

func TestProcessHeaderOverride_ChannelTestSkipsClientHeaderPlaceholder(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	ctx.Request.Header.Set("X-Trace-Id", "trace-123")

	info := &relaycommon.RelayInfo{
		IsChannelTest: true,
		ChannelMeta: &relaycommon.ChannelMeta{
			HeadersOverride: map[string]any{
				"X-Upstream-Trace": "{client_header:X-Trace-Id}",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	_, ok := headers["x-upstream-trace"]
	require.False(t, ok)
}

func TestProcessHeaderOverride_NonTestKeepsClientHeaderPlaceholder(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	ctx.Request.Header.Set("X-Trace-Id", "trace-123")

	info := &relaycommon.RelayInfo{
		IsChannelTest: false,
		ChannelMeta: &relaycommon.ChannelMeta{
			HeadersOverride: map[string]any{
				"X-Upstream-Trace": "{client_header:X-Trace-Id}",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Equal(t, "trace-123", headers["x-upstream-trace"])
}

func TestProcessHeaderOverride_RuntimeOverrideIsFinalHeaderMap(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	info := &relaycommon.RelayInfo{
		IsChannelTest:             false,
		UseRuntimeHeadersOverride: true,
		RuntimeHeadersOverride: map[string]any{
			"x-static":  "runtime-value",
			"x-runtime": "runtime-only",
		},
		ChannelMeta: &relaycommon.ChannelMeta{
			HeadersOverride: map[string]any{
				"X-Static": "legacy-value",
				"X-Legacy": "legacy-only",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Equal(t, "runtime-value", headers["x-static"])
	require.Equal(t, "runtime-only", headers["x-runtime"])
	_, exists := headers["x-legacy"]
	require.False(t, exists)
}

func TestInitChannelMetaClearsInheritedRuntimeHeadersForActiveClaudeCode(t *testing.T) {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	setChannelMeta := func(channelType int, paramOverride map[string]any) {
		ctx.Set(string(constant.ContextKeyChannelType), channelType)
		ctx.Set(string(constant.ContextKeyChannelParamOverride), paramOverride)
		ctx.Set(string(constant.ContextKeyChannelHeaderOverride), map[string]any{})
	}

	info := &relaycommon.RelayInfo{
		RequestHeaders: map[string]string{
			"X-Inbound-Secret": "inbound-value",
		},
	}
	setChannelMeta(constant.ChannelTypeAnthropic, map[string]any{
		"operations": []any{
			map[string]any{
				"mode": "copy_header",
				"from": "X-Inbound-Secret",
				"to":   "X-Safe-Output",
			},
		},
	})
	info.InitChannelMeta(ctx)
	_, err := relaycommon.ApplyParamOverrideWithRelayInfo([]byte(`{}`), info)
	require.NoError(t, err)
	require.True(t, info.UseRuntimeHeadersOverride)
	require.Equal(t, "inbound-value", info.RuntimeHeadersOverride["x-safe-output"])

	setChannelMeta(constant.ChannelTypeClaudeCode, map[string]any{})
	info.InitChannelMeta(ctx)
	require.False(t, info.UseRuntimeHeadersOverride)
	require.Nil(t, info.RuntimeHeadersOverride)

	headers, err := ResolveHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.NotContains(t, headers, "x-safe-output")

	setChannelMeta(constant.ChannelTypeClaudeCode, map[string]any{
		"operations": []any{
			map[string]any{
				"mode":  "set_header",
				"path":  "X-Fresh-Static",
				"value": "static-value",
			},
		},
	})
	info.InitChannelMeta(ctx)
	_, err = relaycommon.ApplyParamOverrideWithRelayInfo([]byte(`{}`), info)
	require.NoError(t, err)
	require.True(t, info.UseRuntimeHeadersOverride)
	require.Equal(t, "static-value", info.RuntimeHeadersOverride["x-fresh-static"])

	headers, err = ResolveHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Equal(t, "static-value", headers["x-fresh-static"])

	disabledInfo := &relaycommon.RelayInfo{
		IsChannelTest:                   true,
		DisableChannelTestClientProfile: true,
		UseRuntimeHeadersOverride:       true,
		RuntimeHeadersOverride: map[string]any{
			"x-inherited": "preserved",
		},
	}
	setChannelMeta(constant.ChannelTypeClaudeCode, map[string]any{})
	disabledInfo.InitChannelMeta(ctx)
	require.True(t, disabledInfo.UseRuntimeHeadersOverride)
	require.Equal(t, "preserved", disabledInfo.RuntimeHeadersOverride["x-inherited"])
}

func TestProcessHeaderOverride_PassthroughSkipsAcceptEncoding(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	ctx.Request.Header.Set("X-Trace-Id", "trace-123")
	ctx.Request.Header.Set("Accept-Encoding", "gzip")

	info := &relaycommon.RelayInfo{
		IsChannelTest: false,
		ChannelMeta: &relaycommon.ChannelMeta{
			HeadersOverride: map[string]any{
				"*": "",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Equal(t, "trace-123", headers["x-trace-id"])

	_, hasAcceptEncoding := headers["accept-encoding"]
	require.False(t, hasAcceptEncoding)
}

func TestProcessHeaderOverride_PassHeadersTemplateSetsRuntimeHeaders(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	ctx.Request.Header.Set("Originator", "Codex CLI")
	ctx.Request.Header.Set("Session_id", "sess-123")

	info := &relaycommon.RelayInfo{
		IsChannelTest: false,
		RequestHeaders: map[string]string{
			"Originator": "Codex CLI",
			"Session_id": "sess-123",
		},
		ChannelMeta: &relaycommon.ChannelMeta{
			ParamOverride: map[string]any{
				"operations": []any{
					map[string]any{
						"mode":  "pass_headers",
						"value": []any{"Originator", "Session_id", "X-Codex-Beta-Features"},
					},
				},
			},
			HeadersOverride: map[string]any{
				"X-Static": "legacy-value",
			},
		},
	}

	_, err := relaycommon.ApplyParamOverrideWithRelayInfo([]byte(`{"model":"gpt-4.1"}`), info)
	require.NoError(t, err)
	require.True(t, info.UseRuntimeHeadersOverride)
	require.Equal(t, "Codex CLI", info.RuntimeHeadersOverride["originator"])
	require.Equal(t, "sess-123", info.RuntimeHeadersOverride["session_id"])
	_, exists := info.RuntimeHeadersOverride["x-codex-beta-features"]
	require.False(t, exists)
	require.Equal(t, "legacy-value", info.RuntimeHeadersOverride["x-static"])

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Equal(t, "Codex CLI", headers["originator"])
	require.Equal(t, "sess-123", headers["session_id"])
	_, exists = headers["x-codex-beta-features"]
	require.False(t, exists)

	upstreamReq := httptest.NewRequest(http.MethodPost, "https://example.com/v1/responses", nil)
	applyHeaderOverrideToRequest(upstreamReq, headers)
	require.Equal(t, "Codex CLI", upstreamReq.Header.Get("Originator"))
	require.Equal(t, "sess-123", upstreamReq.Header.Get("Session_id"))
	require.Empty(t, upstreamReq.Header.Get("X-Codex-Beta-Features"))
}

func TestProcessHeaderOverride_ClaudeCodeProfileRejectsUnsafeOverrides(t *testing.T) {
	reservedHeaders := []string{
		"Authorization",
		"Proxy-Authorization",
		"Cookie",
		"X-Api-Key",
		"X-Goog-Api-Key",
		"User-Agent",
		"Anthropic-Version",
		"Accept",
		"Content-Type",
		"X-App",
		"X-Claude-Code-Session-Id",
		"X-Stainless-Lang",
		"Anthropic-Dangerous-Direct-Browser-Access",
		"Accept-Language",
		"Sec-Fetch-Mode",
	}
	tests := []struct {
		name      string
		overrides map[string]any
	}{
		{name: "wildcard", overrides: map[string]any{"*": ""}},
		{name: "regex", overrides: map[string]any{"re:^X-": ""}},
		{name: "regex v2", overrides: map[string]any{"regex:^X-": ""}},
		{name: "client header placeholder", overrides: map[string]any{"X-Safe": "{client_header:X-Trace-Id}"}},
		{name: "api key placeholder", overrides: map[string]any{"X-Safe": "Bearer {api_key}"}},
	}
	for _, header := range reservedHeaders {
		tests = append(tests, struct {
			name      string
			overrides map[string]any
		}{
			name:      "reserved " + header,
			overrides: map[string]any{header: "static-value"},
		})
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
			ctx.Request.Header.Set("X-Trace-Id", "trace-123")
			info := &relaycommon.RelayInfo{
				ChannelMeta: &relaycommon.ChannelMeta{
					ChannelType:     constant.ChannelTypeClaudeCode,
					ApiKey:          "channel-key",
					HeadersOverride: test.overrides,
				},
			}

			_, err := processHeaderOverride(info, ctx)
			require.Error(t, err)
			var apiErr *types.NewAPIError
			require.ErrorAs(t, err, &apiErr)
			require.Equal(t, types.ErrorCodeChannelHeaderOverrideInvalid, apiErr.GetErrorCode())
		})
	}
}

func TestProcessHeaderOverride_ClaudeCodeProfileAllowsSafeStaticHeaders(t *testing.T) {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	info := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType: constant.ChannelTypeClaudeCode,
			HeadersOverride: map[string]any{
				"X-Safe-Static":  "safe-value",
				"Anthropic-Beta": "interleaved-thinking-2025-05-14",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Equal(t, map[string]string{
		"x-safe-static":  "safe-value",
		"anthropic-beta": "interleaved-thinking-2025-05-14",
	}, headers)
}

func TestProcessHeaderOverride_NonClaudeCodePreservesExistingBehavior(t *testing.T) {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	ctx.Request.Header.Set("X-Trace-Id", "trace-123")
	info := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType: constant.ChannelTypeAnthropic,
			ApiKey:      "channel-key",
			HeadersOverride: map[string]any{
				"*":             "",
				"Authorization": "Bearer static",
				"X-Client":      "{client_header:X-Trace-Id}",
				"X-Channel-Key": "{api_key}",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Equal(t, "trace-123", headers["x-trace-id"])
	require.Equal(t, "Bearer static", headers["authorization"])
	require.Equal(t, "trace-123", headers["x-client"])
	require.Equal(t, "channel-key", headers["x-channel-key"])
}

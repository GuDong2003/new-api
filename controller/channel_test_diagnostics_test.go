package controller

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func channelProbeSSE(events ...string) string {
	return "data: " + strings.Join(events, "\n\ndata: ") + "\n\n"
}

func TestChannelProbeValidatesProtocolResults(t *testing.T) {
	tests := []struct {
		name, endpoint, kind, body, status, reason string
		stream, compatibility                      bool
	}{
		{"chat text", "openai", "basic", `{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}]}`, "passed", "response_validated", false, false},
		{"chat empty", "openai", "basic", `{"choices":[]}`, "failed", "empty_output", false, false},
		{"empty body", "openai", "basic", "", "failed", "empty_response", false, false},
		{"malformed body", "openai", "basic", "<html>bad gateway</html>", "failed", "invalid_json", false, false},
		{"error inside a 200", "openai", "basic", `{"error":{"message":"rate limit"}}`, "failed", "upstream_error", false, false},
		{"output hit the token limit", "openai", "basic", `{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}`, "failed", "output_incomplete", false, false},
		{"chat stream", "openai", "basic", channelProbeSSE(`{"choices":[{"delta":{"content":"pong"}}]}`, `{"choices":[{"delta":{},"finish_reason":"stop"}]}`, "[DONE]"), "passed", "response_validated", true, false},
		{"stream without a completion frame", "openai", "basic", channelProbeSSE(`{"choices":[{"delta":{"content":"partial"}}]}`), "failed", "incomplete_stream", true, false},
		{"stream carrying only DONE", "openai", "basic", channelProbeSSE("[DONE]"), "failed", "invalid_stream", true, false},
		{"stream carrying only a keepalive", "openai", "basic", ": ping\n\n", "failed", "invalid_stream", true, false},
		{"plain JSON where SSE was requested", "openai", "basic", `{"choices":[{"message":{"content":"pong"}}]}`, "failed", "invalid_stream", true, false},
		{"responses text", "openai-response", "basic", `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"pong"}]}]}`, "passed", "response_validated", false, false},
		{"responses stream", "openai-response", "basic", channelProbeSSE(`{"type":"response.output_text.delta","delta":"pong"}`, `{"type":"response.completed","response":{"status":"completed"}}`), "passed", "response_validated", true, false},
		{"responses reported incomplete", "openai-response", "basic", channelProbeSSE(`{"type":"response.output_text.delta","delta":"pong"}`, `{"type":"response.incomplete"}`), "failed", "output_incomplete", true, false},
		{"responses still in progress", "openai-response", "basic", `{"status":"in_progress","output":[{"type":"message","content":[{"type":"output_text","text":"partial"}]}]}`, "failed", "output_incomplete", false, false},
		{"claude text", "anthropic", "basic", `{"content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn"}`, "passed", "response_validated", false, false},
		{"claude stream", "anthropic", "basic", channelProbeSSE(`{"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}`, `{"type":"message_stop"}`), "passed", "response_validated", true, false},
		{"gemini text", "gemini", "basic", `{"candidates":[{"content":{"parts":[{"text":"pong"}]},"finishReason":"STOP"}]}`, "passed", "response_validated", false, false},
		{"gemini stream", "gemini", "basic", channelProbeSSE(`{"candidates":[{"content":{"parts":[{"text":"pong"}]},"finishReason":"STOP"}]}`), "passed", "response_validated", true, false},
		{"image url", "image-generation", "basic", `{"data":[{"url":"https://example.com/image.png"}]}`, "passed", "response_validated", false, false},
		{"image list empty", "image-generation", "basic", `{"data":[]}`, "failed", "empty_output", false, false},
		{"image base64 not decodable", "image-generation", "basic", `{"data":[{"b64_json":"not base64!"}]}`, "failed", "empty_output", false, false},
		{"image stream completed", "image-generation", "basic", channelProbeSSE(`{"type":"image_generation.completed","b64_json":"aW1hZ2U="}`), "passed", "response_validated", true, false},
		{"image stream with previews only", "image-generation", "basic", channelProbeSSE(`{"type":"image_generation.partial_image","b64_json":"aW1hZ2U="}`, "[DONE]"), "failed", "incomplete_stream", true, false},
		{"embedding vector", "embeddings", "basic", `{"data":[{"embedding":[0.1,0.2]}]}`, "passed", "response_validated", false, false},
		{"embedding vector empty", "embeddings", "basic", `{"data":[{"embedding":[]}]}`, "failed", "empty_output", false, false},
		{"embedding vector not numeric", "embeddings", "basic", `{"data":[{"embedding":["0.1"]}]}`, "failed", "empty_output", false, false},
		{"rerank result", "jina-rerank", "basic", `{"results":[{"index":0,"relevance_score":0.9}]}`, "passed", "response_validated", false, false},
		{"compaction result", "openai-response-compact", "basic", `{"output":[{"type":"compaction","encrypted_content":"compact"}]}`, "passed", "response_validated", false, false},
		{"late error event without data", "openai", "basic", channelProbeSSE(`{"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}`) + "event: error\n\n", "failed", "upstream_error", true, false},
		{"tool never called", "openai", "tool_call", `{"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}]}`, "failed", "tool_not_called", false, false},
		{"tool called with bad arguments", "openai", "tool_call", `{"choices":[{"message":{"tool_calls":[{"function":{"name":"channel_test_echo","arguments":"{\"message\":123}"}}]}}]}`, "failed", "invalid_tool_arguments", false, false},
		{"a different tool was called", "openai", "tool_call", `{"choices":[{"message":{"tool_calls":[{"function":{"name":"other_tool","arguments":"{\"message\":\"ping\"}"}}]}}]}`, "failed", "unexpected_tool", false, false},
		// The channel answered, but the gateway manufactured the SSE frames from
		// a non-streaming upstream response.
		{"stream faked from a complete upstream response", "image-generation", "basic", channelProbeSSE(`{"type":"image_generation.completed","b64_json":"aW1hZ2U="}`, "[DONE]"), "degraded", "compatibility_stream", true, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			diagnostics := &channelTestDiagnostics{
				EndpointType:    test.endpoint,
				TestType:        test.kind,
				RequestedStream: test.stream,
				UpstreamStream:  common.GetPointer(!test.compatibility),
			}

			validateChannelProbeResponse([]byte(test.body), diagnostics, nil)

			assert.Equal(t, test.status, diagnostics.Status)
			assert.Equal(t, test.reason, diagnostics.Reason)
		})
	}
}

func TestChannelProbeMergesToolArgumentsAcrossProtocols(t *testing.T) {
	tests := []struct {
		name, endpoint, body string
		stream               bool
	}{
		{"chat JSON", "openai", `{"choices":[{"message":{"tool_calls":[{"id":"call-1","function":{"name":"channel_test_echo","arguments":"{\"message\":\"ping\"}"}}]},"finish_reason":"tool_calls"}]}`, false},
		{"chat fragments", "openai", channelProbeSSE(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"channel_test_echo","arguments":"{\"mess"}}]}}]}`, `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"age\":\"ping\"}"}}]},"finish_reason":"tool_calls"}]}`), true},
		{"responses JSON", "openai-response", `{"status":"completed","output":[{"id":"item-1","type":"function_call","name":"channel_test_echo","arguments":"{\"message\":\"ping\"}"}]}`, false},
		{"responses fragments", "openai-response", channelProbeSSE(`{"type":"response.output_item.added","output_index":0,"item":{"id":"item-1","type":"function_call","name":"channel_test_echo","arguments":""}}`, `{"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\"message\":"}`, `{"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"\"ping\"}"}`, `{"type":"response.completed","response":{"status":"completed"}}`), true},
		{"claude JSON", "anthropic", `{"content":[{"type":"tool_use","id":"call-1","name":"channel_test_echo","input":{"message":"ping"}}],"stop_reason":"tool_use"}`, false},
		{"claude fragments", "anthropic", channelProbeSSE(`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"channel_test_echo","input":{}}}`, `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"message\":"}}`, `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"ping\"}"}}`, `{"type":"message_stop"}`), true},
		{"gemini JSON", "gemini", `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"channel_test_echo","args":{"message":"ping"}}}]},"finishReason":"STOP"}]}`, false},
		{"gemini stream", "gemini", channelProbeSSE(`{"candidates":[{"content":{"parts":[{"functionCall":{"name":"channel_test_echo","args":{"message":"ping"}}}]},"finishReason":"STOP"}]}`), true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			diagnostics := &channelTestDiagnostics{
				EndpointType:    test.endpoint,
				TestType:        "tool_call",
				RequestedStream: test.stream,
				UpstreamStream:  common.GetPointer(true),
			}

			validateChannelProbeResponse([]byte(test.body), diagnostics, nil)

			assert.Equal(t, "passed", diagnostics.Status)
			assert.Equal(t, "tool_validated", diagnostics.Reason)
			assert.Equal(t, 1, diagnostics.ToolCount)
			require.NotNil(t, diagnostics.ToolNameValid)
			assert.True(t, *diagnostics.ToolNameValid)
			require.NotNil(t, diagnostics.ToolArgumentsValid)
			assert.True(t, *diagnostics.ToolArgumentsValid)
		})
	}
}

func TestChannelProbeReportsLateStreamFailures(t *testing.T) {
	valid := channelProbeSSE(`{"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}`)

	t.Run("an error frame after a good frame fails the probe", func(t *testing.T) {
		lateError := valid + ":" + strings.Repeat("x", 9000) + "\n\n" + channelProbeSSE(`{"error":{"message":"late failure"}}`)
		diagnostics := &channelTestDiagnostics{EndpointType: "openai", TestType: "basic", RequestedStream: true}

		validateChannelProbeResponse([]byte(lateError), diagnostics, nil)

		assert.Equal(t, "failed", diagnostics.Status)
		assert.Equal(t, "upstream_error", diagnostics.Reason)
	})

	t.Run("a stream that timed out fails even with a valid body", func(t *testing.T) {
		status := relaycommon.NewStreamStatus()
		status.SetEndReason(relaycommon.StreamEndReasonTimeout, context.DeadlineExceeded)
		diagnostics := &channelTestDiagnostics{EndpointType: "openai", TestType: "basic", RequestedStream: true}

		validateChannelProbeResponse([]byte(valid), diagnostics, status)

		assert.Equal(t, "failed", diagnostics.Status)
		assert.Equal(t, "stream_timeout", diagnostics.Reason)
	})
}

func TestChannelProbeCountsDistinctToolCallsSeparately(t *testing.T) {
	body := `{"choices":[{"message":{"tool_calls":[{"id":"a","function":{"name":"wrong","arguments":"{\"message\":\"ping\"}"}},{"id":"b","function":{"name":"channel_test_echo","arguments":"{\"message\":\"ping\"}"}}]}}]}`
	diagnostics := &channelTestDiagnostics{EndpointType: "openai", TestType: "tool_call"}

	validateChannelProbeResponse([]byte(body), diagnostics, nil)

	assert.Equal(t, 2, diagnostics.ToolCount)
	assert.Equal(t, "unexpected_tool", diagnostics.Reason)
}

func TestChannelProbeEndpointResolution(t *testing.T) {
	mapping := `{"image-alias":"gpt-image-2"}`
	channel := &model.Channel{Type: constant.ChannelTypeOpenAI, ModelMapping: &mapping}

	t.Run("classifies an alias by the upstream model it maps to", func(t *testing.T) {
		endpoint, err := resolveChannelProbeEndpoint(channel, "image-alias", "auto")

		require.NoError(t, err)
		assert.Equal(t, "image-generation", endpoint)
	})

	t.Run("keeps an explicitly chosen endpoint over auto detection", func(t *testing.T) {
		endpoint, err := resolveChannelProbeEndpoint(channel, "image-alias", "openai-response")

		require.NoError(t, err)
		assert.Equal(t, "openai-response", endpoint)
	})

	t.Run("rejects an endpoint that has no probe support", func(t *testing.T) {
		_, err := resolveChannelProbeEndpoint(channel, "gpt-4o", "midjourney")

		require.Error(t, err)
	})

	t.Run("terminates on a model mapping that points back at itself", func(t *testing.T) {
		cyclic := `{"a":"b","b":"a"}`
		looping := &model.Channel{Type: constant.ChannelTypeOpenAI, ModelMapping: &cyclic}

		endpoint, err := resolveChannelProbeEndpoint(looping, "a", "auto")

		require.NoError(t, err)
		assert.NotEmpty(t, endpoint)
	})
}

func TestChannelProbeSkipsCombinationsTheEndpointCannotSupport(t *testing.T) {
	assert.True(t, channelProbeNotApplicable("image-generation", "tool_call", false))
	assert.False(t, channelProbeNotApplicable("image-generation", "basic", true))
	assert.True(t, channelProbeNotApplicable("embeddings", "basic", true))
	assert.True(t, channelProbeNotApplicable("jina-rerank", "tool_call", false))
	assert.False(t, channelProbeNotApplicable("openai", "tool_call", true))
}

func TestChannelProbeToolRequestKeepsEnoughOutputBudget(t *testing.T) {
	channel := &model.Channel{Type: constant.ChannelTypeOpenAI}

	// Each endpoint declares the probe tool and its output budget in its own
	// native shape, since the probe runs before any format conversion.
	for _, test := range []struct{ endpoint, toolPath, budgetPath string }{
		{"openai", "tools.0.function.name", "max_tokens"},
		{"openai-response", "tools.0.name", "max_output_tokens"},
		{"anthropic", "tools.0.name", "max_tokens"},
		{"gemini", "tools.0.functionDeclarations.0.name", "generationConfig.maxOutputTokens"},
	} {
		t.Run(test.endpoint+" carries the probe tool and a raised budget", func(t *testing.T) {
			request := buildTestRequestWithMessage("gpt-4o", test.endpoint, channel, true, "custom message")
			require.NoError(t, configureChannelProbeRequest(request, "tool_call", true, "custom message"))

			data, err := common.Marshal(request)
			require.NoError(t, err)
			assert.Equal(t, channelTestToolName, gjson.GetBytes(data, test.toolPath).String())
			assert.GreaterOrEqual(t, gjson.GetBytes(data, test.budgetPath).Int(), int64(1024))
			// The tool probe replaces the configured message with its own
			// instruction, so the model has one unambiguous task.
			assert.NotContains(t, string(data), "custom message")
		})
	}

	t.Run("a reasoning model gets its budget as max_completion_tokens", func(t *testing.T) {
		request := buildTestRequestWithMessage("o3", "openai", channel, false, "")
		require.NoError(t, configureChannelProbeRequest(request, "tool_call", false, ""))

		general, ok := request.(*dto.GeneralOpenAIRequest)
		require.True(t, ok)
		require.NotNil(t, general.MaxCompletionTokens)
		assert.Equal(t, uint(1024), *general.MaxCompletionTokens)
		assert.Nil(t, general.MaxTokens)
	})

	t.Run("a gemini model keeps its larger default budget", func(t *testing.T) {
		request := buildTestRequestWithMessage("gemini-2.5-flash", "openai", channel, false, "")
		require.NoError(t, configureChannelProbeRequest(request, "tool_call", false, ""))

		general, ok := request.(*dto.GeneralOpenAIRequest)
		require.True(t, ok)
		require.NotNil(t, general.MaxTokens)
		assert.Equal(t, uint(3000), *general.MaxTokens)
	})
}

func TestChannelProbeLimitsSurviveParamOverride(t *testing.T) {
	t.Run("image count is forced back to one", func(t *testing.T) {
		body, err := enforceChannelProbeLimits([]byte(`{"n":4,"prompt":"x"}`), []byte(`{"n":1}`), "image-generation", "basic")

		require.NoError(t, err)
		assert.Equal(t, int64(1), gjson.GetBytes(body, "n").Int())
	})

	t.Run("a lowered token budget is raised back for a tool probe", func(t *testing.T) {
		body, err := enforceChannelProbeLimits([]byte(`{"max_tokens":16}`), []byte(`{"max_tokens":1024}`), "openai", "tool_call")

		require.NoError(t, err)
		assert.GreaterOrEqual(t, gjson.GetBytes(body, "max_tokens").Int(), int64(1024))
	})

	t.Run("gemini keeps its budget under generationConfig", func(t *testing.T) {
		body, err := enforceChannelProbeLimits([]byte(`{"generationConfig":{"maxOutputTokens":8}}`), []byte(`{"generationConfig":{"maxOutputTokens":1024}}`), "gemini", "tool_call")

		require.NoError(t, err)
		assert.GreaterOrEqual(t, gjson.GetBytes(body, "generationConfig.maxOutputTokens").Int(), int64(1024))
	})

	t.Run("an unrelated basic probe is left untouched", func(t *testing.T) {
		original := `{"max_tokens":16}`

		body, err := enforceChannelProbeLimits([]byte(original), []byte(original), "openai", "basic")

		require.NoError(t, err)
		assert.JSONEq(t, original, string(body))
	})
}

func TestChannelTestPreviewRedactsEveryStreamEvent(t *testing.T) {
	preview := sanitizeChannelTestResponsePreview([]byte(channelProbeSSE(
		`{"choices":[{"delta":{"content":"pong"}}],"headers":{"cookie":"private-cookie"},"metadata":{"secret":"private-metadata"},"api_key":"private-key"}`,
		"[DONE]",
	)))

	assert.NotContains(t, preview, "private-")
	assert.Contains(t, preview, "pong")
	assert.Contains(t, preview, "[DONE]")
	assert.Contains(t, preview, "[REDACTED]")
}

func TestChannelTestPreviewRedactsSecretsOutsideJSONKeys(t *testing.T) {
	t.Run("a credential in a plain text message is redacted", func(t *testing.T) {
		preview := sanitizeChannelTestResponsePreview([]byte("upstream rejected api_key: sk-private-value for this channel"))

		assert.NotContains(t, preview, "sk-private-value")
		assert.Contains(t, preview, "[REDACTED]")
	})

	t.Run("a credential nested under a sensitive key is redacted", func(t *testing.T) {
		preview := sanitizeChannelTestResponsePreview([]byte(`{"error":{"message":"denied"},"headers":{"authorization":"Bearer sk-private-value"}}`))

		assert.NotContains(t, preview, "sk-private-value")
		assert.Contains(t, preview, "denied")
	})

	t.Run("a token inside a URL is redacted", func(t *testing.T) {
		// Redaction may reach past the token here, because re-marshaling escapes
		// the query separator. Over-redacting a preview is the safe direction.
		preview := sanitizeChannelTestResponsePreview([]byte(`{"detail":"GET https://upstream.test/v1?access_token=sk-private-value failed"}`))

		assert.NotContains(t, preview, "sk-private-value")
		assert.Contains(t, preview, "upstream.test")
	})
}

func TestChannelTestDetailedRejectsUnknownTestType(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/channel/test/1", strings.NewReader(`{"test_type":"unknown"}`))
	c.Request.Header.Set("Content-Type", "application/json")

	TestChannelDetailed(c)

	assert.Equal(t, http.StatusBadRequest, recorder.Code)
}

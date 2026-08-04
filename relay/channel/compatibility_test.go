package channel

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestApplyCompatibilityHeaders(t *testing.T) {
	tests := []struct {
		name        string
		channelType int
		isStream    bool
		assertions  func(t *testing.T, headers http.Header)
	}{
		{
			name:        "Codex",
			channelType: constant.ChannelTypeCodexCompatibility,
			isStream:    true,
			assertions: func(t *testing.T, headers http.Header) {
				assert.Equal(t, "Bearer test-key", headers.Get("Authorization"))
				assert.Equal(t, "responses=experimental", headers.Get("OpenAI-Beta"))
				assert.Equal(t, "codex_cli_rs", headers.Get("Originator"))
				assert.Equal(t, "codex_cli_rs/0.146.0", headers.Get("User-Agent"))
				assert.Equal(t, "application/json", headers.Get("Content-Type"))
				assert.Equal(t, "text/event-stream", headers.Get("Accept"))
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			headers := http.Header{
				"X-Api-Key":        []string{"discard"},
				"X-Stainless-Lang": []string{"node"},
				"Sec-Fetch-Mode":   []string{"cors"},
			}

			ApplyCompatibilityHeaders(test.channelType, headers, "test-key", test.isStream)

			test.assertions(t, headers)
		})
	}
}

func TestApplyClaudeCodeCompatibilityHeaders(t *testing.T) {
	const sessionID = "123e4567-e89b-12d3-a456-426614174000"

	tests := []struct {
		name       string
		isStream   bool
		wantAccept string
	}{
		{name: "stream", isStream: true, wantAccept: "text/event-stream"},
		{name: "non-stream", isStream: false, wantAccept: "application/json"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			headers := http.Header{
				"authorization":            []string{"discard"},
				"proxy-authorization":      []string{"discard"},
				"cookie":                   []string{"discard"},
				"user-agent":               []string{"discard"},
				"anthropic-version":        []string{"discard"},
				"content-type":             []string{"discard"},
				"accept":                   []string{"discard"},
				"x-api-key":                []string{"discard"},
				"x-goog-api-key":           []string{"discard"},
				"x-app":                    []string{"discard"},
				"x-claude-code-session-id": []string{"client-supplied"},
				"x-stainless-lang":         []string{"node"},
				"anthropic-dangerous-direct-browser-access": []string{"true"},
				"accept-language": []string{"en-US"},
				"sec-fetch-mode":  []string{"cors"},
				"Anthropic-Beta":  []string{"interleaved-thinking-2025-05-14"},
				"X-Safe-Static":   []string{"survives"},
			}

			ApplyClaudeCodeCompatibilityHeaders(headers, "test-key", test.isStream, sessionID)
			ApplyClaudeCodeCompatibilityHeaders(headers, "test-key", test.isStream, sessionID)

			require.Equal(t, http.Header{
				"Authorization":            []string{"Bearer test-key"},
				"User-Agent":               []string{"claude-cli/2.1.214"},
				"X-App":                    []string{"cli"},
				"Anthropic-Version":        []string{"2023-06-01"},
				"Content-Type":             []string{"application/json"},
				"Accept":                   []string{test.wantAccept},
				"X-Claude-Code-Session-Id": []string{sessionID},
				"Anthropic-Beta":           []string{"interleaved-thinking-2025-05-14"},
				"X-Safe-Static":            []string{"survives"},
			}, headers)
		})
	}

	headers := http.Header{
		"X-Claude-Code-Session-Id": []string{"client-supplied"},
	}
	ApplyClaudeCodeCompatibilityHeaders(headers, "test-key", false, "")
	assert.Empty(t, headers.Get("X-Claude-Code-Session-Id"))
}

func TestCodeBuddyCompatibilityBuildsWorkBuddyProfile(t *testing.T) {
	headers := http.Header{
		"Authorization": []string{"Bearer upstream-key"},
		"X-Api-Key":     []string{"discard"},
	}

	ApplyCompatibilityHeaders(constant.ChannelTypeCodeBuddy, headers, "upstream-key", true)

	assert.Equal(t, "Bearer upstream-key", headers.Get("Authorization"))
	assert.Equal(t, "upstream-key", headers.Get("X-API-Key"))
	assert.Equal(t, "application/json", headers.Get("Accept"))
	assert.Equal(t, "WorkBuddy/5.3.8 WorkBuddy/5.3.8 CLI/2.115.0", headers.Get("User-Agent"))
	assert.Equal(t, "conversation", headers.Get("X-Agent-Purpose"))
	assert.Equal(t, "www.codebuddy.cn", headers.Get("X-Domain"))
	assert.Equal(t, "SaaS", headers.Get("X-Product"))
	assert.Equal(t, "1", headers.Get("X-CodeBuddy-Request"))
	assert.Len(t, headers.Get("Acp-Connection-ID"), 36)
	assert.Equal(t, "6.25.0", headers.Get("X-Stainless-Package-Version"))
	assert.Equal(t, "XMLHttpRequest", headers.Get("X-Requested-With"))
	assert.Empty(t, headers.Get("X-Product-Version"))
	assert.Empty(t, headers.Get("X-Session-ID"))
	assert.Len(t, headers.Get("X-Conversation-ID"), 36)
	assert.Regexp(t, `^[0-9a-f]{32}$`, headers.Get("X-Conversation-Message-ID"))
	assert.Equal(t, headers.Get("X-Conversation-Message-ID"), headers.Get("X-Request-ID"))
	assert.Regexp(t, `^[0-9a-f]{32}$`, headers.Get("X-Conversation-Request-ID"))
	assert.NotEqual(t, headers.Get("X-Conversation-Message-ID"), headers.Get("X-Conversation-Request-ID"))
	assert.Regexp(t, `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, headers.Get("X-User-Id"))

	traceID := headers.Get("X-Trace-ID")
	spanID := headers.Get("X-B3-SpanID")
	assert.Regexp(t, `^[0-9a-f]{32}$`, traceID)
	assert.Regexp(t, `^[0-9a-f]{16}$`, spanID)
	assert.Equal(t, traceID, headers.Get("X-B3-TraceID"))
	assert.Equal(t, spanID, headers.Get("X-B3-ParentSpanID"))
	assert.Equal(t, "1", headers.Get("X-B3-Sampled"))
	assert.Equal(t, "00-"+traceID+"-"+spanID+"-01", headers.Get("Traceparent"))
	assert.Equal(t, traceID+"-"+spanID+"-1-"+spanID, headers.Get("B3"))
}

func TestApplyCodeBuddyRequestProfile(t *testing.T) {
	stream := false
	temperature := 0.0
	request := &dto.GeneralOpenAIRequest{
		Messages:    []dto.Message{{Role: "developer", Content: "caller instructions"}, {Role: "user", Content: "hello"}},
		Stream:      &stream,
		Temperature: &temperature,
	}

	ApplyCodeBuddyRequestProfile(request)
	ApplyCodeBuddyRequestProfile(request)

	require.Len(t, request.Messages, 3)
	assert.Equal(t, "system", request.Messages[0].Role)
	assert.Equal(t, "This conversation is powered by gpt-5.6-sol\r\n\r\nYour main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag.", request.Messages[0].StringContent())
	assert.Equal(t, "developer", request.Messages[1].Role)
	// 调用方显式指定的 stream/temperature 应原样透传，不被覆盖
	require.NotNil(t, request.Stream)
	assert.False(t, *request.Stream)
	require.NotNil(t, request.Temperature)
	assert.Equal(t, 0.0, *request.Temperature)
	assert.Equal(t, "low", request.ReasoningEffort)
	require.NotNil(t, request.StreamOptions)
	assert.True(t, request.StreamOptions.IncludeUsage)
}

func TestApplyCodeBuddyRequestProfileDefaults(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{
		Messages: []dto.Message{{Role: "user", Content: "hello"}},
	}

	ApplyCodeBuddyRequestProfile(request)

	require.NotNil(t, request.Stream)
	assert.True(t, *request.Stream)
	require.NotNil(t, request.Temperature)
	assert.Equal(t, 1.0, *request.Temperature)
	assert.Equal(t, "low", request.ReasoningEffort)
}

func TestCodeBuddyConversationIdentityIsStableAcrossTurns(t *testing.T) {
	conversationID := ResolveCodeBuddyConversationID(nil, &dto.OpenAIResponsesRequest{
		PromptCacheKey: json.RawMessage(`"session-123"`),
	})
	require.NotEmpty(t, conversationID)

	first := http.Header{}
	second := http.Header{}
	ApplyCompatibilityHeadersWithConversation(constant.ChannelTypeCodeBuddy, first, "test-key", true, conversationID)
	ApplyCompatibilityHeadersWithConversation(constant.ChannelTypeCodeBuddy, second, "test-key", true, conversationID)

	assert.Equal(t, conversationID, first.Get("X-Conversation-ID"))
	assert.Equal(t, first.Get("X-Conversation-ID"), second.Get("X-Conversation-ID"))
	assert.Equal(t, first.Get("Acp-Connection-ID"), second.Get("Acp-Connection-ID"))
	assert.NotEqual(t, first.Get("X-Request-ID"), second.Get("X-Request-ID"))
}

func TestResolveCodeBuddyConversationIDPrefersIncomingHeader(t *testing.T) {
	incomingID := "a66fe5d5-ceb0-4f54-a69d-060e98bfb0c6"
	headers := http.Header{"X-Conversation-Id": []string{incomingID}}
	request := &dto.GeneralOpenAIRequest{PromptCacheKey: "different-session"}

	assert.Equal(t, incomingID, ResolveCodeBuddyConversationID(headers, request))
}

package channel

import (
	"encoding/json"
	"net/http"
	"strings"
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
		{
			name:        "Claude Code",
			channelType: constant.ChannelTypeClaudeCode,
			assertions: func(t *testing.T, headers http.Header) {
				assert.Equal(t, "Bearer test-key", headers.Get("Authorization"))
				assert.Empty(t, headers.Get("x-api-key"))
				assert.Empty(t, headers.Get("x-stainless-lang"))
				assert.Empty(t, headers.Get("sec-fetch-mode"))
				assert.Equal(t, "2.1.178 (Claude Code)", headers.Get("User-Agent"))
				assert.Equal(t, "2023-06-01", headers.Get("Anthropic-Version"))
				assert.Equal(t, "application/json", headers.Get("Accept"))
				assert.Equal(t, "application/json", headers.Get("Content-Type"))
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

func TestCodeBuddyCompatibilityBuildsWorkBuddyProfile(t *testing.T) {
	headers := http.Header{
		"Authorization": []string{"Bearer upstream-key"},
		"X-Api-Key":     []string{"discard"},
	}

	ApplyCompatibilityHeaders(constant.ChannelTypeCodeBuddy, headers, "upstream-key", true)

	assert.Equal(t, "Bearer upstream-key", headers.Get("Authorization"))
	assert.Equal(t, "upstream-key", headers.Get("X-API-Key"))
	assert.Equal(t, "WorkBuddy/5.3.8 WorkBuddy/5.3.8 CLI/2.115.0", headers.Get("User-Agent"))
	assert.Equal(t, "conversation", headers.Get("X-Agent-Purpose"))
	assert.Equal(t, "1", headers.Get("X-CodeBuddy-Request"))
	assert.Equal(t, "5.3.8", headers.Get("X-Product-Version"))
	assert.Empty(t, headers.Get("X-API-Mock-WorkBuddy-Compatible"))
	assert.Len(t, headers.Get("Acp-Connection-ID"), 36)
	assert.Len(t, headers.Get("X-Conversation-ID"), 36)
	assert.Regexp(t, `^[0-9a-f]{32}$`, headers.Get("X-Conversation-Message-ID"))
	assert.Equal(t, headers.Get("X-Conversation-Message-ID"), headers.Get("X-Conversation-Request-ID"))
	assert.Equal(t, headers.Get("X-Conversation-Message-ID"), headers.Get("X-Request-ID"))

	traceID := headers.Get("X-Trace-ID")
	assert.Regexp(t, `^[0-9a-f]{32}$`, traceID)
	assert.Equal(t, "00-"+traceID+"-"+headers.Get("X-B3-SpanID")+"-01", headers.Get("Traceparent"))
	assert.Equal(t, strings.Join([]string{traceID, headers.Get("X-B3-SpanID"), "1", headers.Get("X-B3-ParentSpanID")}, "-"), headers.Get("B3"))
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
	assert.Equal(t, codeBuddyModelInstructions, request.Messages[0].StringContent())
	assert.Equal(t, "developer", request.Messages[1].Role)
	require.NotNil(t, request.Stream)
	assert.True(t, *request.Stream)
	require.NotNil(t, request.Temperature)
	assert.Equal(t, 1.0, *request.Temperature)
	assert.Equal(t, "low", request.ReasoningEffort)
	require.NotNil(t, request.StreamOptions)
	assert.True(t, request.StreamOptions.IncludeUsage)
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

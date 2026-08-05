package channel

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/constant"
	"github.com/google/uuid"
)

const (
	codexCompatibilityOriginator = "codex_cli_rs"
	codexCompatibilityUserAgent  = "codex_cli_rs/0.146.0"
	claudeCodeCompatibilityUA    = "claude-cli/2.1.214 (external, cli)"
)

// ApplyCompatibilityHeaders applies the fixed upstream identity for API-key
// compatibility channels. Channel header overrides are applied afterward.
func ApplyCompatibilityHeaders(channelType int, headers http.Header, apiKey string, isStream bool) {
	ApplyCompatibilityHeadersWithConversation(channelType, headers, apiKey, isStream, "")
}

// ApplyCompatibilityHeadersWithConversation preserves WorkBuddy's stable
// session identity while keeping request/message IDs unique per turn.
func ApplyCompatibilityHeadersWithConversation(channelType int, headers http.Header, apiKey string, isStream bool, conversationID string) {
	switch channelType {
	case constant.ChannelTypeCodeBuddy:
		applyCodeBuddyHeaders(headers, apiKey, conversationID, isStream)
	case constant.ChannelTypeCodexCompatibility:
		headers.Set("Authorization", "Bearer "+apiKey)
		headers.Set("OpenAI-Beta", "responses=experimental")
		headers.Set("Originator", codexCompatibilityOriginator)
		headers.Set("User-Agent", codexCompatibilityUserAgent)
		headers.Set("Content-Type", "application/json")
		if isStream {
			headers.Set("Accept", "text/event-stream")
		} else {
			headers.Set("Accept", "application/json")
		}
	}
}

// ApplyClaudeCodeCompatibilityHeaders finalizes the fixed Claude Code
// upstream identity. It is deliberately separate from generic compatibility
// profiles because it must run after adapter setup and header overrides.
// includeAPIKey controls the x-api-key credential header: the Gateway protocol
// requires both Authorization and x-api-key on inference requests, but only one
// credential header on GET /v1/models.
func ApplyClaudeCodeCompatibilityHeaders(headers http.Header, apiKey string, isStream bool, sessionID string, includeAPIKey bool) {
	for name := range headers {
		if isClaudeCodeManagedHeader(strings.ToLower(name)) {
			// http.Header.Del canonicalizes its argument, which can leave a
			// differently-cased map key behind. Delete the actual key instead.
			delete(headers, name)
		}
	}

	headers.Set("Authorization", "Bearer "+apiKey)
	if includeAPIKey {
		headers.Set("X-Api-Key", apiKey)
	}
	headers.Set("User-Agent", claudeCodeCompatibilityUA)
	headers.Set("X-App", "cli")
	headers.Set("Anthropic-Version", "2023-06-01")
	headers.Set("Content-Type", "application/json")
	if isStream {
		headers.Set("Accept", "text/event-stream")
	} else {
		headers.Set("Accept", "application/json")
	}
	if sessionID != "" {
		headers.Set("X-Claude-Code-Session-Id", sessionID)
	}
	if headers.Get("X-Client-Request-Id") == "" {
		headers.Set("X-Client-Request-Id", uuid.NewString())
	}
}

func isClaudeCodeManagedHeader(lowerName string) bool {
	switch lowerName {
	case "authorization",
		"proxy-authorization",
		"cookie",
		"user-agent",
		"anthropic-version",
		"content-type",
		"accept",
		"x-api-key",
		"x-goog-api-key",
		"x-app",
		"x-claude-code-session-id",
		"x-client-request-id",
		"anthropic-dangerous-direct-browser-access",
		"accept-language":
		return true
	default:
		// x-stainless-* 与真实客户端一致，保留透传（客户端携带时原样转发）。
		return strings.HasPrefix(lowerName, "sec-fetch-")
	}
}

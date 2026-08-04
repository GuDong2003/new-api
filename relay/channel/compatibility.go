package channel

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/constant"
)

const (
	codexCompatibilityOriginator = "codex_cli_rs"
	codexCompatibilityUserAgent  = "codex_cli_rs/0.146.0"
	claudeCodeCompatibilityUA    = "claude-cli/2.1.214"
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
		applyCodeBuddyHeaders(headers, apiKey, conversationID)
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
func ApplyClaudeCodeCompatibilityHeaders(headers http.Header, apiKey string, isStream bool, sessionID string) {
	for name := range headers {
		if isClaudeCodeManagedHeader(strings.ToLower(name)) {
			// http.Header.Del canonicalizes its argument, which can leave a
			// differently-cased map key behind. Delete the actual key instead.
			delete(headers, name)
		}
	}

	headers.Set("Authorization", "Bearer "+apiKey)
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
		"anthropic-dangerous-direct-browser-access",
		"accept-language":
		return true
	default:
		return strings.HasPrefix(lowerName, "x-stainless-") ||
			strings.HasPrefix(lowerName, "sec-fetch-")
	}
}

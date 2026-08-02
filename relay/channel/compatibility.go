package channel

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/constant"
)

const (
	codexCompatibilityOriginator = "pi"
	codexCompatibilityUserAgent  = "pi (new-api)"
	claudeCodeCompatibilityUA    = "2.1.178 (Claude Code)"
)

// ApplyCompatibilityHeaders applies the fixed upstream identity for API-key
// compatibility channels. Channel header overrides are applied afterward.
func ApplyCompatibilityHeaders(channelType int, headers http.Header, apiKey string, isStream bool) {
	switch channelType {
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
	case constant.ChannelTypeClaudeCode:
		for name := range headers {
			lowerName := strings.ToLower(name)
			if lowerName == "x-api-key" ||
				lowerName == "anthropic-dangerous-direct-browser-access" ||
				lowerName == "accept-language" ||
				lowerName == "x-app" ||
				strings.HasPrefix(lowerName, "x-stainless-") ||
				strings.HasPrefix(lowerName, "sec-fetch-") {
				headers.Del(name)
			}
		}
		headers.Set("Authorization", "Bearer "+apiKey)
		headers.Set("User-Agent", claudeCodeCompatibilityUA)
		headers.Set("Anthropic-Version", "2023-06-01")
		headers.Set("Accept", "application/json")
		headers.Set("Content-Type", "application/json")
	}
}

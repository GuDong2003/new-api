package channel

import (
	"encoding/json"
	"regexp"

	"github.com/QuantumNous/new-api/relaykit/dto"
)

// codexForbiddenPhraseRe matches the phrase "you are codex" with word
// boundaries, case insensitive. Some upstreams (e.g. the CodeBuddy relay
// backend) reject any request whose message content mentions Codex in this
// exact form (403), while "codex" alone or "you are the codex" is allowed.
var codexForbiddenPhraseRe = regexp.MustCompile(`(?i)\byou are codex\b`)

const codexForbiddenPhraseReplacement = "you are a coding assistant"

// CleanupCodexForbiddenPhraseInMessages rewrites every "you are codex" phrase
// found anywhere in a message (content, reasoning and tool-call arguments) so
// that requests pass upstreams which forbid that phrase across all text.
func CleanupCodexForbiddenPhraseInMessages(messages []dto.Message) {
	for i := range messages {
		messages[i].Content = cleanupCodexContentValue(messages[i].Content)
		if messages[i].ReasoningContent != nil {
			*messages[i].ReasoningContent = cleanupCodexString(*messages[i].ReasoningContent)
		}
		if messages[i].Reasoning != nil {
			*messages[i].Reasoning = cleanupCodexString(*messages[i].Reasoning)
		}
		if messages[i].ToolCalls != nil {
			calls := messages[i].ParseToolCalls()
			changed := false
			for j := range calls {
				clean := cleanupCodexString(calls[j].Function.Arguments)
				if clean != calls[j].Function.Arguments {
					calls[j].Function.Arguments = clean
					changed = true
				}
			}
			if changed {
				if b, err := json.Marshal(calls); err == nil {
					messages[i].ToolCalls = b
				}
			}
		}
	}
}

func cleanupCodexString(s string) string {
	if s == "" || !codexForbiddenPhraseRe.MatchString(s) {
		return s
	}
	return codexForbiddenPhraseRe.ReplaceAllString(s, codexForbiddenPhraseReplacement)
}

func cleanupCodexContentValue(v any) any {
	switch t := v.(type) {
	case string:
		return cleanupCodexString(t)
	case []any:
		for i, item := range t {
			t[i] = cleanupCodexContentValue(item)
		}
		return t
	case []dto.MediaContent:
		for i := range t {
			t[i].Text = cleanupCodexString(t[i].Text)
		}
		return t
	case map[string]any:
		for k, item := range t {
			t[k] = cleanupCodexContentValue(item)
		}
		return t
	default:
		return v
	}
}

package channel

import (
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
// found in message contents (plain strings and media content blocks) so that
// requests pass upstreams which forbid that phrase.
func CleanupCodexForbiddenPhraseInMessages(messages []dto.Message) {
	for i := range messages {
		messages[i].Content = cleanupCodexContentValue(messages[i].Content)
	}
}

func cleanupCodexContentValue(v any) any {
	switch t := v.(type) {
	case string:
		if codexForbiddenPhraseRe.MatchString(t) {
			return codexForbiddenPhraseRe.ReplaceAllString(t, codexForbiddenPhraseReplacement)
		}
		return t
	case []any:
		for i, item := range t {
			t[i] = cleanupCodexContentValue(item)
		}
		return t
	case []dto.MediaContent:
		for i := range t {
			t[i].Text = codexForbiddenPhraseRe.ReplaceAllString(t[i].Text, codexForbiddenPhraseReplacement)
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

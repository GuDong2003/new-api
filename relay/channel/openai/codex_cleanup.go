package openai

import (
	"encoding/json"
	"regexp"

	"github.com/QuantumNous/new-api/common"
)

// codexForbiddenPhraseRe matches the phrase "you are codex" with word
// boundaries, case insensitive. Some upstreams reject any request whose
// message content mentions Codex in this exact form (403), while "codex"
// alone or "you are the codex" is allowed.
var codexForbiddenPhraseRe = regexp.MustCompile(`(?i)\byou are codex\b`)

const codexForbiddenPhraseReplacement = "you are a coding assistant"

// CleanupCodexForbiddenPhrase rewrites every "you are codex" phrase found in
// any string inside the Responses input payload, so that requests pass
// upstreams which forbid that phrase. It returns the original bytes when
// nothing changed or the payload cannot be parsed.
func CleanupCodexForbiddenPhrase(input json.RawMessage) json.RawMessage {
	if len(input) == 0 || !codexForbiddenPhraseRe.Match(input) {
		return input
	}
	var v any
	if err := common.Unmarshal(input, &v); err != nil {
		return input
	}
	cleaned := cleanupCodexForbiddenPhraseValue(v)
	if b, err := common.Marshal(cleaned); err == nil {
		return b
	}
	return input
}

func cleanupCodexForbiddenPhraseValue(v any) any {
	switch t := v.(type) {
	case string:
		return codexForbiddenPhraseRe.ReplaceAllString(t, codexForbiddenPhraseReplacement)
	case []any:
		for i, item := range t {
			t[i] = cleanupCodexForbiddenPhraseValue(item)
		}
		return t
	case map[string]any:
		for k, item := range t {
			t[k] = cleanupCodexForbiddenPhraseValue(item)
		}
		return t
	default:
		return v
	}
}

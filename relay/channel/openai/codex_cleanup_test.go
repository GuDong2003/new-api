package openai

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCleanupCodexForbiddenPhrase(t *testing.T) {
	t.Run("plain string input", func(t *testing.T) {
		out := CleanupCodexForbiddenPhrase(json.RawMessage(`"you are Codex, help me"`))
		assert.JSONEq(t, `"you are a coding assistant, help me"`, string(out))
	})

	t.Run("message array with string content", func(t *testing.T) {
		in := json.RawMessage(`[{"role":"user","content":"YOU ARE CODEX now"}]`)
		out := CleanupCodexForbiddenPhrase(in)
		var got []map[string]any
		require.NoError(t, json.Unmarshal(out, &got))
		assert.Equal(t, "you are a coding assistant now", got[0]["content"])
	})

	t.Run("message array with content blocks", func(t *testing.T) {
		in := json.RawMessage(`[{"role":"user","content":[{"type":"text","text":"you are codex agent"},{"type":"input_image","image_url":"x"}]}]`)
		out := CleanupCodexForbiddenPhrase(in)
		var got []map[string]any
		require.NoError(t, json.Unmarshal(out, &got))
		blocks := got[0]["content"].([]any)
		text := blocks[0].(map[string]any)
		assert.Equal(t, "you are a coding assistant agent", text["text"])
		// 非文本块不被破坏
		img := blocks[1].(map[string]any)
		assert.Equal(t, "input_image", img["type"])
	})

	t.Run("allowed variants untouched", func(t *testing.T) {
		in := json.RawMessage(`[{"role":"user","content":"codex is great"},{"role":"assistant","content":"you are the codex and openai codex"}]`)
		out := CleanupCodexForbiddenPhrase(in)
		assert.JSONEq(t, string(in), string(out))
	})

	t.Run("no match returns original bytes", func(t *testing.T) {
		in := json.RawMessage(`[{"role":"user","content":"hello world"}]`)
		assert.Equal(t, string(in), string(CleanupCodexForbiddenPhrase(in)))
	})

	t.Run("invalid json returns original", func(t *testing.T) {
		in := json.RawMessage(`not-json`)
		assert.Equal(t, string(in), string(CleanupCodexForbiddenPhrase(in)))
	})

	t.Run("empty input returns empty", func(t *testing.T) {
		assert.Empty(t, CleanupCodexForbiddenPhrase(nil))
	})
}

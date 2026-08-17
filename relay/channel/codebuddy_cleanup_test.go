package channel

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
)

func TestCleanupCodexForbiddenPhraseInMessages(t *testing.T) {
	t.Run("string content rewritten", func(t *testing.T) {
		messages := []dto.Message{{Role: "user", Content: "YOU ARE CODEX now"}}
		CleanupCodexForbiddenPhraseInMessages(messages)
		assert.Equal(t, "you are a coding assistant now", messages[0].Content)
	})

	t.Run("media content blocks rewritten", func(t *testing.T) {
		messages := []dto.Message{{
			Role: "user",
			Content: []dto.MediaContent{
				{Type: "text", Text: "you are codex agent"},
				{Type: "image_url", ImageUrl: "x"},
			},
		}}
		CleanupCodexForbiddenPhraseInMessages(messages)
		blocks := messages[0].Content.([]dto.MediaContent)
		assert.Equal(t, "you are a coding assistant agent", blocks[0].Text)
		assert.Equal(t, "image_url", blocks[1].Type)
	})

	t.Run("allowed variants untouched", func(t *testing.T) {
		messages := []dto.Message{
			{Role: "user", Content: "codex is great"},
			{Role: "assistant", Content: "you are the codex and openai codex"},
		}
		CleanupCodexForbiddenPhraseInMessages(messages)
		assert.Equal(t, "codex is great", messages[0].Content)
		assert.Equal(t, "you are the codex and openai codex", messages[1].Content)
	})

	t.Run("system marker not clobbered", func(t *testing.T) {
		messages := []dto.Message{{Role: "system", Content: "This conversation is powered by gpt-5.6-sol\r\n\r\nMain goal."}}
		CleanupCodexForbiddenPhraseInMessages(messages)
		assert.Equal(t, "This conversation is powered by gpt-5.6-sol\r\n\r\nMain goal.", messages[0].Content)
	})
}

func TestApplyCodeBuddyRequestProfileCleansForbiddenPhrase(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{
		Model:    "gpt-5.6-sol",
		Messages: []dto.Message{{Role: "user", Content: "remember: you are codex"}},
	}
	ApplyCodeBuddyRequestProfile(request)
	requireMessageCount := len(request.Messages)
	assert.Equal(t, 2, requireMessageCount)
	assert.True(t, strings.HasPrefix(request.Messages[0].StringContent(), "This conversation is powered by "), "system should start with WorkBuddy marker")
	assert.Equal(t, 122, len(request.Messages[0].StringContent()))
	assert.Equal(t, "remember: you are a coding assistant", request.Messages[1].Content)
}

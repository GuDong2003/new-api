package channel

import (
	"net/http"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/stretchr/testify/assert"
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
				assert.Equal(t, "pi", headers.Get("Originator"))
				assert.Equal(t, "pi (new-api)", headers.Get("User-Agent"))
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

package openai

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodexCompatibilityBuildsPiCompatibleResponsesRequest(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	info := &relaycommon.RelayInfo{
		IsStream: true,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType: constant.ChannelTypeCodexCompatibility,
			ApiKey:      "test-key",
		},
	}
	adaptor := &Adaptor{}
	adaptor.Init(info)

	headers := http.Header{}
	require.NoError(t, adaptor.SetupRequestHeader(c, &headers, info))
	assert.Equal(t, "Bearer test-key", headers.Get("Authorization"))
	assert.Equal(t, "responses=experimental", headers.Get("OpenAI-Beta"))
	assert.Equal(t, "codex_cli_rs", headers.Get("Originator"))
	assert.Equal(t, "text/event-stream", headers.Get("Accept"))

	maxOutputTokens := uint(4096)
	converted, err := adaptor.ConvertOpenAIResponsesRequest(c, info, dto.OpenAIResponsesRequest{
		Model:           "gpt-5-codex",
		MaxOutputTokens: &maxOutputTokens,
	})
	require.NoError(t, err)
	request, ok := converted.(dto.OpenAIResponsesRequest)
	require.True(t, ok)
	assert.Nil(t, request.MaxOutputTokens)
	assert.JSONEq(t, `false`, string(request.Store))
	assert.JSONEq(t, `"You are a helpful assistant."`, string(request.Instructions))
	assert.JSONEq(t, `{"verbosity":"low"}`, string(request.Text))
	assert.JSONEq(t, `["reasoning.encrypted_content"]`, string(request.Include))
	assert.JSONEq(t, `"auto"`, string(request.ToolChoice))
	assert.JSONEq(t, `true`, string(request.ParallelToolCalls))
}

func TestCodeBuddyCompatibilityBuildsWorkBuddyRequest(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	info := &relaycommon.RelayInfo{
		IsStream: false,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType: constant.ChannelTypeCodeBuddy,
			ApiKey:      "test-key",
		},
	}
	adaptor := &Adaptor{}
	adaptor.Init(info)

	headers := http.Header{}
	require.NoError(t, adaptor.SetupRequestHeader(c, &headers, info))
	assert.Equal(t, "Bearer test-key", headers.Get("Authorization"))
	assert.Equal(t, "test-key", headers.Get("X-API-Key"))
	assert.Equal(t, "conversation", headers.Get("X-Agent-Purpose"))
	assert.Equal(t, "1", headers.Get("X-CodeBuddy-Request"))
	assert.Empty(t, headers.Get("X-API-Mock-WorkBuddy-Compatible"))

	stream := false
	temperature := 0.0
	converted, err := adaptor.ConvertOpenAIRequest(c, info, &dto.GeneralOpenAIRequest{
		Messages:    []dto.Message{{Role: "user", Content: "hello"}},
		Stream:      &stream,
		Temperature: &temperature,
	})
	require.NoError(t, err)
	request, ok := converted.(*dto.GeneralOpenAIRequest)
	require.True(t, ok)
	require.Len(t, request.Messages, 2)
	assert.Equal(t, "system", request.Messages[0].Role)
	assert.NotEmpty(t, request.Messages[0].StringContent())
	require.NotNil(t, request.Stream)
	assert.True(t, *request.Stream)
	require.NotNil(t, request.Temperature)
	assert.Equal(t, 1.0, *request.Temperature)
	assert.Equal(t, "low", request.ReasoningEffort)
	require.NotNil(t, request.StreamOptions)
	assert.True(t, request.StreamOptions.IncludeUsage)
}

func TestCodexCompatibilityResolvesPiResponsesPath(t *testing.T) {
	adaptor := &Adaptor{}
	tests := []struct {
		baseURL string
		wantURL string
	}{
		{baseURL: "https://proxy.example/backend-api", wantURL: "https://proxy.example/backend-api/codex/responses"},
		{baseURL: "https://proxy.example/backend-api/codex", wantURL: "https://proxy.example/backend-api/codex/responses"},
		{baseURL: "https://proxy.example/backend-api/codex/responses/", wantURL: "https://proxy.example/backend-api/codex/responses"},
	}

	for _, test := range tests {
		t.Run(test.baseURL, func(t *testing.T) {
			requestURL, err := adaptor.GetRequestURL(&relaycommon.RelayInfo{
				ChannelMeta: &relaycommon.ChannelMeta{
					ChannelType:    constant.ChannelTypeCodexCompatibility,
					ChannelBaseUrl: test.baseURL,
				},
			})

			require.NoError(t, err)
			assert.Equal(t, test.wantURL, requestURL)
		})
	}
}

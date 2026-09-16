package channel

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/gin-gonic/gin"
)

func TestUpstreamImageTaskResponseRecognizesCompletedPayload(t *testing.T) {
	payload := []byte(`{"task_id":"upstream-task","status":"completed","data":[{"url":"https://cdn.example/image.png"}]}`)
	envelope, err := parseUpstreamImageTaskResponse(payload)
	require.NoError(t, err)
	assert.Equal(t, "upstream-task", envelope.TaskID)
	assert.True(t, envelope.Completed())
	assert.True(t, envelope.HasData())
}

func TestUpstreamImageTaskResponseRecognizesErrorPayload(t *testing.T) {
	envelope, err := parseUpstreamImageTaskResponse([]byte(`{"task_id":"upstream-task","error":{"message":"generation failed"}}`))
	require.NoError(t, err)
	assert.True(t, envelope.Failed())
}

func TestUpstreamImageTaskURLStaysOnTheSelectedChannelOrigin(t *testing.T) {
	base, err := http.NewRequest(http.MethodPost, "https://qkmss.example/v1/images/generations?async=1", nil)
	require.NoError(t, err)

	resolved, err := resolveUpstreamImageTaskURL(base.URL.String(), "/v1/images/generations/upstream-task", "upstream-task")
	require.NoError(t, err)
	assert.Equal(t, "https://qkmss.example/v1/images/generations/upstream-task", resolved.String())
	resolved, err = resolveUpstreamImageTaskURL(base.URL.String(), "v1/images/generations/upstream-task", "upstream-task")
	require.NoError(t, err)
	assert.Equal(t, "https://qkmss.example/v1/images/generations/upstream-task", resolved.String())

	_, err = resolveUpstreamImageTaskURL(base.URL.String(), "https://other.example/task/upstream-task", "upstream-task")
	assert.Error(t, err)
}

func TestDoUpstreamImageRequestPollsAndPreservesFinalResponse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service.InitHttpClient()
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPost {
			assert.Equal(t, "1", request.URL.Query().Get("async"))
			assert.Equal(t, "respond-async", request.Header.Get("Prefer"))
			assert.Equal(t, "true", request.Header.Get("X-Image-Async"))
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(writer, `{"task_id":"upstream-task","status":"processing"}`)
			return
		}
		assert.Equal(t, "/v1/images/generations/upstream-task", request.URL.Path)
		assert.Equal(t, "Bearer upstream-key", request.Header.Get("Authorization"))
		polls++
		writer.Header().Set("Content-Type", "application/json")
		if polls == 1 {
			_, _ = io.WriteString(writer, `{"task_id":"upstream-task","status":"processing","data":[]}`)
			return
		}
		_, _ = io.WriteString(writer, `{"task_id":"upstream-task","status":"completed","data":[{"url":"https://cdn.example/image.png"}]}`)
	}))
	defer server.Close()

	request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/images/generations", bytes.NewBufferString(`{"model":"gpt-image-2.5"}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer upstream-key")
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = request
	context.Set(string(constant.ContextKeyAsyncImageTaskID), "task-local")
	info := &relaycommon.RelayInfo{
		RelayMode:   relayconstant.RelayModeImagesGenerations,
		ChannelMeta: &relaycommon.ChannelMeta{},
	}
	response, err := doRequest(context, request, info)
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.JSONEq(t, `{"task_id":"upstream-task","status":"completed","data":[{"url":"https://cdn.example/image.png"}]}`, string(body))
	assert.Equal(t, 2, polls)
}

func TestDoUpstreamImageRequestFallsBackWhenAsyncIsUnsupported(t *testing.T) {
	service.InitHttpClient()
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		posts++
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Query().Get("async") == "1" {
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(writer, `{"error":{"message":"async is not supported"}}`)
			return
		}
		_, _ = io.WriteString(writer, `{"created":1,"data":[{"url":"https://cdn.example/image.png"}]}`)
	}))
	defer server.Close()

	request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/images/generations", bytes.NewBufferString(`{"model":"gpt-image-2.5"}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer upstream-key")
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = request
	context.Set(string(constant.ContextKeyAsyncImageTaskID), "task-local")
	info := &relaycommon.RelayInfo{
		RelayMode:   relayconstant.RelayModeImagesGenerations,
		ChannelMeta: &relaycommon.ChannelMeta{},
	}
	response, err := doRequest(context, request, info)
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.JSONEq(t, `{"created":1,"data":[{"url":"https://cdn.example/image.png"}]}`, string(body))
	assert.Equal(t, 2, posts)
}

func TestUnsupportedAsyncDetectionDoesNotRetryOrdinaryImageErrors(t *testing.T) {
	assert.True(t, isUnsupportedUpstreamImageAsync(http.StatusBadRequest, []byte(`{"error":{"message":"unknown parameter: async"}}`)))
	assert.True(t, isUnsupportedUpstreamImageAsync(http.StatusNotImplemented, nil))
	assert.False(t, isUnsupportedUpstreamImageAsync(http.StatusBadRequest, []byte(`{"error":{"message":"invalid prompt"}}`)))
}

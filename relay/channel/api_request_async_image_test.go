package channel

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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

func TestUpstreamImageTaskURLStaysWithTheChannelProvider(t *testing.T) {
	const channel = "https://api.qkmss.com/v1/images/generations?async=1"
	tests := []struct {
		name    string
		base    string
		taskURL string
		want    string // empty when the task URL is refused
	}{
		{name: "a path resolves on the channel host", base: channel, taskURL: "/v1/images/generations/upstream-task", want: "https://api.qkmss.com/v1/images/generations/upstream-task"},
		{name: "a relative path resolves on the channel host", base: channel, taskURL: "v1/images/generations/upstream-task", want: "https://api.qkmss.com/v1/images/generations/upstream-task"},
		{name: "the provider's parent domain is followed", base: channel, taskURL: "https://qkmss.com/v1/images/generations/upstream-task", want: "https://qkmss.com/v1/images/generations/upstream-task"},
		{name: "a subdomain of the channel host is followed", base: "https://qkmss.com/v1/images/generations?async=1", taskURL: "https://tasks.qkmss.com/v1/images/generations/upstream-task", want: "https://tasks.qkmss.com/v1/images/generations/upstream-task"},
		{name: "a channel on http may be sent on to https", base: "http://api.qkmss.com/v1/images/generations?async=1", taskURL: "https://qkmss.com/v1/images/generations/upstream-task", want: "https://qkmss.com/v1/images/generations/upstream-task"},
		{name: "a channel on https is never sent back to http", base: channel, taskURL: "http://api.qkmss.com/v1/images/generations/upstream-task"},
		{name: "another provider is refused", base: channel, taskURL: "https://other.example/task/upstream-task"},
		{name: "a sibling host may belong to another tenant", base: "https://myres.openai.azure.com/openai/images/generations?async=1", taskURL: "https://attacker.openai.azure.com/task/upstream-task"},
		{name: "a public suffix is nobody's own domain", base: "https://alice.github.io/v1/images/generations?async=1", taskURL: "https://github.io/v1/images/generations/upstream-task"},
		{name: "another port on the provider's domain is refused", base: channel, taskURL: "https://qkmss.com:6379/v1/images/generations/upstream-task"},
		{name: "a host spelled outside ASCII matches only itself", base: "https://api.siliconflow.cn/v1/images/generations?async=1", taskURL: "https://sİlİconflow.cn/v1/images/generations/upstream-task"},
		{name: "a host on an unlisted top-level domain matches only itself", base: "http://image-svc.ai.svc.cluster.local:8080/v1/images/generations?async=1", taskURL: "http://ai.svc.cluster.local:8080/v1/images/generations/upstream-task"},
		{name: "a channel addressed by IP matches only itself", base: "http://10.0.0.1:3000/v1/images/generations?async=1", taskURL: "http://192.168.0.1:3000/v1/images/generations/upstream-task"},
		{name: "a channel on a bare host name matches only itself", base: "http://image-worker:8080/v1/images/generations?async=1", taskURL: "http://other-worker:8080/v1/images/generations/upstream-task"},
		{name: "only web addresses are followed", base: channel, taskURL: "ftp://api.qkmss.com/upstream-task"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolved, err := resolveUpstreamImageTaskURL(tt.base, tt.taskURL, "upstream-task")
			if tt.want == "" {
				assert.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, resolved.String())
		})
	}
}

func TestUpstreamImagePollAsksEachHostByItsOwnName(t *testing.T) {
	source, err := http.NewRequest(http.MethodPost, "http://api.qkmss.com/v1/images/generations?async=1", nil)
	require.NoError(t, err)
	source.Header.Set("Authorization", "Bearer upstream-key")
	source.Host = "alias.qkmss.com" // a Host header override the channel sets for its own host

	for target, wantHost := range map[string]string{
		"http://api.qkmss.com/v1/images/generations/upstream-task":      "alias.qkmss.com",
		"https://api.qkmss.com:443/v1/images/generations/upstream-task": "alias.qkmss.com",
		"https://qkmss.com/v1/images/generations/upstream-task":         "qkmss.com",
	} {
		targetURL, err := url.Parse(target)
		require.NoError(t, err)
		poll, err := newUpstreamImagePollRequest(source, targetURL)
		require.NoError(t, err)
		assert.Equal(t, wantHost, poll.Host, target)
		assert.Equal(t, "Bearer upstream-key", poll.Header.Get("Authorization"), target)
	}
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

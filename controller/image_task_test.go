package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestImageTaskStatus(t *testing.T) {
	tests := []struct {
		name   string
		status string
		want   string
	}{
		{name: "queued", status: "QUEUED", want: "queued"},
		{name: "submitted", status: "SUBMITTED", want: "queued"},
		{name: "running", status: "IN_PROGRESS", want: "in_progress"},
		{name: "success", status: "SUCCESS", want: "completed"},
		{name: "failure", status: "FAILURE", want: "failed"},
		{name: "unrecognized", status: "WHATEVER", want: "unknown"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, imageTaskStatus(test.status))
		})
	}
}

func TestIsAsyncImageRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name    string
		target  string
		headers map[string]string
		request *dto.ImageRequest
		running bool
		want    bool
	}{
		{name: "plain request stays synchronous", target: "/v1/images/generations", request: &dto.ImageRequest{}, want: false},
		{name: "async query", target: "/v1/images/generations?async=true", request: &dto.ImageRequest{}, want: true},
		{name: "async query disabled", target: "/v1/images/generations?async=false", request: &dto.ImageRequest{}, want: false},
		{
			name:    "prefer header among other tokens",
			target:  "/v1/images/generations",
			headers: map[string]string{"Prefer": "wait=5, respond-async"},
			request: &dto.ImageRequest{},
			want:    true,
		},
		{
			name:    "vendor header",
			target:  "/v1/images/generations",
			headers: map[string]string{"X-Image-Async": "1"},
			request: &dto.ImageRequest{},
			want:    true,
		},
		{
			name:   "body field",
			target: "/v1/images/generations",
			request: &dto.ImageRequest{
				Extra: map[string]json.RawMessage{"async": json.RawMessage("true")},
			},
			want: true,
		},
		{
			name:    "query wins over body",
			target:  "/v1/images/generations?async=false",
			request: &dto.ImageRequest{Extra: map[string]json.RawMessage{"async": json.RawMessage("true")}},
			want:    false,
		},
		{
			name:    "detached replay is never re-accepted",
			target:  "/v1/images/generations?async=true",
			request: &dto.ImageRequest{},
			running: true,
			want:    false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, _ := gin.CreateTestContext(httptest.NewRecorder())
			context.Request = httptest.NewRequest(http.MethodPost, test.target, nil)
			for key, value := range test.headers {
				context.Request.Header.Set(key, value)
			}
			if test.running {
				context.Set(asyncImageRunningKey, true)
			}
			assert.Equal(t, test.want, isAsyncImageRequest(context, test.request))
		})
	}
}

func TestAsyncImageStorable(t *testing.T) {
	count := func(n uint) *uint { return &n }

	tests := []struct {
		name     string
		database common.DatabaseType
		request  *dto.ImageRequest
		want     bool
	}{
		{name: "single inline image fits on mysql", database: common.DatabaseTypeMySQL, request: &dto.ImageRequest{}, want: true},
		{name: "explicit single inline image fits on mysql", database: common.DatabaseTypeMySQL, request: &dto.ImageRequest{N: count(1)}, want: true},
		{name: "mysql sends an inline pair to the sync path", database: common.DatabaseTypeMySQL, request: &dto.ImageRequest{N: count(2)}, want: false},
		{name: "mysql keeps a url batch async", database: common.DatabaseTypeMySQL, request: &dto.ImageRequest{N: count(8), ResponseFormat: "url"}, want: true},
		{name: "postgres holds an inline batch", database: common.DatabaseTypePostgreSQL, request: &dto.ImageRequest{N: count(4)}, want: true},
		{name: "postgres sends an oversized inline batch to the sync path", database: common.DatabaseTypePostgreSQL, request: &dto.ImageRequest{N: count(8)}, want: false},
		{name: "sqlite holds an inline batch", database: common.DatabaseTypeSQLite, request: &dto.ImageRequest{N: count(4), ResponseFormat: "b64_json"}, want: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			previous := common.MainDatabaseType()
			common.SetMainDatabaseType(test.database)
			t.Cleanup(func() { common.SetMainDatabaseType(previous) })
			assert.Equal(t, test.want, asyncImageStorable(test.request))
		})
	}
}

func TestImageTaskStatusURL(t *testing.T) {
	tests := []struct {
		name        string
		requestPath string
		want        string
	}{
		{name: "generations", requestPath: "/v1/images/generations", want: "/v1/images/generations/task_a"},
		{name: "edits share the generation namespace", requestPath: "/v1/images/edits", want: "/v1/images/generations/task_a"},
		{name: "legacy edits alias", requestPath: "/v1/edits", want: "/v1/images/generations/task_a"},
		{name: "playground", requestPath: "/pg/images/edits", want: "/pg/images/generations/task_a"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, imageTaskStatusURL(test.requestPath, "task_a"))
		})
	}
}

func TestDetachAsyncImageBodyStripsAsyncAndStream(t *testing.T) {
	gin.SetMode(gin.TestMode)

	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest(
		http.MethodPost,
		"/v1/images/generations?async=true",
		strings.NewReader(`{"model":"gpt-image-1","prompt":"a cat","async":true,"stream":true}`),
	)
	context.Request.Header.Set("Content-Type", "application/json")

	storage, err := detachAsyncImageBody(context)
	require.NoError(t, err)
	t.Cleanup(func() { storage.Close() })

	data, err := storage.Bytes()
	require.NoError(t, err)

	var detached map[string]any
	require.NoError(t, common.Unmarshal(data, &detached))
	assert.NotContains(t, detached, "async")
	assert.Equal(t, false, detached["stream"])
	assert.Equal(t, "a cat", detached["prompt"])
}

func TestAsyncImageResult(t *testing.T) {
	t.Run("stores the provider object as returned", func(t *testing.T) {
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: maxAsyncImageResultBytes()}
		recorder.WriteHeader(http.StatusOK)
		_, err := recorder.Write([]byte(`{"created":1,"data":[{"url":"https://cdn.example/a.png"}]}`))
		require.NoError(t, err)

		result, err := asyncImageResult(recorder)
		require.NoError(t, err)
		assert.JSONEq(t, `{"created":1,"data":[{"url":"https://cdn.example/a.png"}]}`, string(result))
		assert.Equal(t, "https://cdn.example/a.png", firstAsyncImageURL(result))
	})

	t.Run("reports the upstream error message", func(t *testing.T) {
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: maxAsyncImageResultBytes()}
		recorder.WriteHeader(http.StatusBadRequest)
		_, err := recorder.Write([]byte(`{"error":{"message":"prompt was rejected"}}`))
		require.NoError(t, err)

		_, err = asyncImageResult(recorder)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "prompt was rejected")
		assert.Contains(t, err.Error(), "400")
	})

	t.Run("rejects a result larger than the async limit", func(t *testing.T) {
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: 1 << 20}
		recorder.WriteHeader(http.StatusOK)
		_, err := recorder.Write(make([]byte, recorder.limit+1))
		require.NoError(t, err)

		_, err = asyncImageResult(recorder)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "async limit")
	})

	t.Run("collapses a streamed response into completed images", func(t *testing.T) {
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: maxAsyncImageResultBytes()}
		recorder.header.Set("Content-Type", "text/event-stream")
		recorder.WriteHeader(http.StatusOK)
		_, err := recorder.Write([]byte(strings.Join([]string{
			`data: {"type":"image_generation.partial_image","b64_json":"cGFydGlhbA==","image_index":0}`,
			"",
			`data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","image_index":0,"usage":{"total_tokens":7}}`,
			"",
			"data: [DONE]",
			"",
		}, "\n")))
		require.NoError(t, err)

		result, err := asyncImageResult(recorder)
		require.NoError(t, err)

		var response struct {
			Data []struct {
				B64Json string `json:"b64_json"`
			} `json:"data"`
			Usage struct {
				TotalTokens int `json:"total_tokens"`
			} `json:"usage"`
		}
		require.NoError(t, common.Unmarshal(result, &response))
		require.Len(t, response.Data, 1)
		assert.Equal(t, "ZmluYWw=", response.Data[0].B64Json)
		assert.Equal(t, 7, response.Usage.TotalTokens)
	})

	t.Run("fails a stream that never completed", func(t *testing.T) {
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: maxAsyncImageResultBytes()}
		recorder.header.Set("Content-Type", "text/event-stream")
		recorder.WriteHeader(http.StatusOK)
		_, err := recorder.Write([]byte("data: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"cGFydGlhbA==\"}\n\n"))
		require.NoError(t, err)

		_, err = asyncImageResult(recorder)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "ended before generation completed")
	})
}

func TestBuildImageTaskPayload(t *testing.T) {
	t.Run("pending task exposes no images", func(t *testing.T) {
		task := &model.Task{TaskID: "task_pending", Status: model.TaskStatusInProgress, Progress: "0%", SubmitTime: 1700000000}
		task.Properties.OriginModelName = "gpt-image-1"

		payload, err := buildImageTaskPayload(task, "/v1/images/generations/task_pending")
		require.NoError(t, err)
		assert.JSONEq(t, `{
			"data": [],
			"task_id": "task_pending",
			"status": "in_progress",
			"progress": 0,
			"status_url": "/v1/images/generations/task_pending",
			"created_at": 1700000000,
			"model": "gpt-image-1"
		}`, string(payload))
	})

	t.Run("completed task keeps the provider payload", func(t *testing.T) {
		task := &model.Task{
			TaskID:     "task_done",
			Status:     model.TaskStatusSuccess,
			Progress:   "100%",
			SubmitTime: 1700000000,
			Data:       json.RawMessage(`{"created":42,"data":[{"url":"https://cdn.example/a.png"}]}`),
		}

		payload, err := buildImageTaskPayload(task, "/v1/images/generations/task_done")
		require.NoError(t, err)

		var response struct {
			Created  int64  `json:"created"`
			Status   string `json:"status"`
			Progress int    `json:"progress"`
			TaskID   string `json:"task_id"`
			Data     []struct {
				URL string `json:"url"`
			} `json:"data"`
		}
		require.NoError(t, common.Unmarshal(payload, &response))
		assert.Equal(t, int64(42), response.Created)
		assert.Equal(t, "completed", response.Status)
		assert.Equal(t, 100, response.Progress)
		assert.Equal(t, "task_done", response.TaskID)
		require.Len(t, response.Data, 1)
		assert.Equal(t, "https://cdn.example/a.png", response.Data[0].URL)
	})

	t.Run("failed task reports the reason", func(t *testing.T) {
		task := &model.Task{
			TaskID:     "task_failed",
			Status:     model.TaskStatusFailure,
			Progress:   "100%",
			SubmitTime: 1700000000,
			FailReason: "upstream returned 500",
		}

		payload, err := buildImageTaskPayload(task, "/v1/images/generations/task_failed")
		require.NoError(t, err)

		var response struct {
			Status string `json:"status"`
			Error  struct {
				Message string `json:"message"`
				Code    any    `json:"code"`
			} `json:"error"`
		}
		require.NoError(t, common.Unmarshal(payload, &response))
		assert.Equal(t, "failed", response.Status)
		assert.Equal(t, "upstream returned 500", response.Error.Message)
		assert.Equal(t, "image_task_failed", response.Error.Code)
	})
}

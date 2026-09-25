package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	taskdto "github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestImageTaskSubmissionUsesAutomaticallySelectedChannel(t *testing.T) {
	previousDB := model.DB
	previousDatabase := common.MainDatabaseType()
	previousRedisEnabled := common.RedisEnabled
	previousCountToken, previousSensitive := constant.CountToken, setting.CheckSensitiveEnabled
	previousMaxBody := constant.MaxRequestBodyMB
	previousLog, previousBatch := common.LogConsumeEnabled, common.BatchUpdateEnabled
	previousFreePreConsume := operation_setting.GetQuotaSetting().EnableFreeModelPreConsume
	previousPrices := ratio_setting.ModelPrice2JSONString()
	constant.CountToken, setting.CheckSensitiveEnabled = false, false
	constant.MaxRequestBodyMB = 128
	common.LogConsumeEnabled, common.BatchUpdateEnabled = false, false
	operation_setting.GetQuotaSetting().EnableFreeModelPreConsume = false
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"async-image-test":0.02}`))
	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousDatabase)
		common.RedisEnabled = previousRedisEnabled
		constant.CountToken, setting.CheckSensitiveEnabled = previousCountToken, previousSensitive
		constant.MaxRequestBodyMB = previousMaxBody
		common.LogConsumeEnabled, common.BatchUpdateEnabled = previousLog, previousBatch
		operation_setting.GetQuotaSetting().EnableFreeModelPreConsume = previousFreePreConsume
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(previousPrices))
	})

	for _, test := range []struct {
		name                    string
		edit, async, failInsert bool
		// count drives the requested image quantity. A batch large enough to
		// outgrow the result budget used to be answered synchronously; every
		// quantity now takes the same asynchronous path.
		count int
	}{
		{name: "async generation", async: true},
		{name: "async multipart edit", edit: true, async: true},
		{name: "async inline batch", async: true, count: 8},
		{name: "synchronous generation"},
		{name: "synchronous multipart edit", edit: true},
		{name: "generation falls back when task insert fails", async: true, failInsert: true},
		{name: "edit falls back when task insert fails", edit: true, async: true, failInsert: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			count := max(test.count, 1)
			database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			require.NoError(t, err)
			connection, err := database.DB()
			require.NoError(t, err)
			connection.SetMaxOpenConns(1)
			t.Cleanup(func() { require.NoError(t, connection.Close()) })
			require.NoError(t, database.AutoMigrate(&model.Task{}, &model.User{}, &model.Channel{}, &model.UserSubscription{}))
			require.NoError(t, model.MigrateGallery(database))
			model.DB = database
			require.NoError(t, database.Create(&model.User{Id: 7, Username: "image-owner", Group: "default", Quota: 100_000_000}).Error)
			completed := make(chan error, 1)
			require.NoError(t, database.Callback().Update().After("gorm:commit_or_rollback_transaction").Register("test:image-task-completed", func(tx *gorm.DB) {
				task, ok := tx.Statement.Dest.(*model.Task)
				if ok && (task.Status == model.TaskStatusSuccess || task.Status == model.TaskStatusFailure) {
					completed <- tx.Error
				}
			}))
			if test.failInsert {
				require.NoError(t, database.Callback().Create().Before("gorm:create").Register("test:image-task-insert-failure", func(tx *gorm.DB) {
					if _, ok := tx.Statement.Dest.(*model.Task); ok {
						tx.AddError(errors.New("task storage unavailable"))
					}
				}))
			}

			type upstreamRequest struct {
				body        []byte
				contentType string
				path        string
				err         error
			}
			requests := make(chan upstreamRequest, 2)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				requests <- upstreamRequest{body, r.Header.Get("Content-Type"), r.URL.Path, err}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"created":1,"data":[{"url":"https://example.com/generated.png"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`)
			}))
			t.Cleanup(upstream.Close)
			channel := &model.Channel{
				Id: 73, Name: "automatically selected", Type: constant.ChannelTypeOpenAI,
				Key: "test-key", BaseURL: &upstream.URL, Status: common.ChannelStatusEnabled,
				ModelMapping: common.GetPointer(`{"async-image-test":"upstream-image"}`),
			}
			require.NoError(t, database.Create(channel).Error)

			var body bytes.Buffer
			path, contentType := "/pg/images/generations", "application/json"
			if test.edit {
				path = "/pg/images/edits"
				writer := multipart.NewWriter(&body)
				for key, value := range map[string]string{
					"model": "async-image-test", "prompt": "remove text", "group": "default",
					"n": strconv.Itoa(count), "quality": "high", "stream": "false",
				} {
					require.NoError(t, writer.WriteField(key, value))
				}
				file, err := writer.CreateFormFile("image", "reference.png")
				require.NoError(t, err)
				_, err = io.WriteString(file, "reference-image")
				require.NoError(t, err)
				require.NoError(t, writer.Close())
				contentType = writer.FormDataContentType()
			} else {
				body.WriteString(`{"model":"async-image-test","prompt":"remove text","group":"default","n":` + strconv.Itoa(count) + `,"quality":"high","stream":false}`)
			}
			target := path
			if test.async {
				target += "?async=true"
			}
			recorder := httptest.NewRecorder()
			engine := gin.New()
			engine.POST(path, middleware.RelayPanicRecover(), middleware.BodyStorageCleanup(), func(c *gin.Context) {
				c.Set("id", 7)
				c.Set("group", "default")
				c.Set("user_group", "default")
				// This is the context populated by automatic channel distribution;
				// no channel selector is sent by the client.
				require.Nil(t, middleware.SetupContextForSelectedChannel(c, channel, "async-image-test"))
				Relay(c, types.RelayFormatOpenAIImage)
			})
			request := httptest.NewRequest(http.MethodPost, target, &body)
			request.Header.Set("Content-Type", contentType)
			engine.ServeHTTP(recorder, request)

			var result struct {
				TaskID    string          `json:"task_id"`
				Status    string          `json:"status"`
				StatusURL string          `json:"status_url"`
				Data      []dto.ImageData `json:"data"`
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &result))
			if test.async && !test.failInsert {
				require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
				require.NotEmpty(t, result.TaskID)
				assert.Equal(t, "in_progress", result.Status)
				assert.Equal(t, "/pg/images/generations/"+result.TaskID, result.StatusURL)
				select {
				case err := <-completed:
					require.NoError(t, err)
				case <-time.After(5 * time.Second):
					t.Fatal("background image task did not finish")
				}
				task, exists, err := model.GetByTaskId(7, result.TaskID)
				require.NoError(t, err)
				require.True(t, exists)
				require.Equal(t, model.TaskStatus(model.TaskStatusSuccess), task.Status, task.FailReason)
				assert.Equal(t, 73, task.ChannelId)
				assert.Equal(t, "async-image-test", task.Properties.OriginModelName)
				assert.Greater(t, task.Quota, 0)
				assert.Equal(t, "https://example.com/generated.png", task.PrivateData.ResultURL)
				fetch := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(fetch)
				c.Request = httptest.NewRequest(http.MethodGet, result.StatusURL, nil)
				c.Set("id", 7)
				c.Params = gin.Params{{Key: "task_id", Value: result.TaskID}}
				ImageTaskFetch(c)
				require.Equal(t, http.StatusOK, fetch.Code)
				require.NoError(t, common.Unmarshal(fetch.Body.Bytes(), &result))
				assert.Equal(t, "completed", result.Status)
			} else {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
				assert.Empty(t, result.TaskID)
				var count int64
				require.NoError(t, database.Model(&model.Task{}).Count(&count).Error)
				if test.failInsert {
					assert.Zero(t, count)
				} else {
					assert.Equal(t, int64(1), count)
				}
			}
			require.Len(t, result.Data, 1)
			assert.Equal(t, "https://example.com/generated.png", result.Data[0].Url)
			require.Len(t, requests, 1, "the selected upstream must receive exactly one generation")
			received := <-requests
			require.NoError(t, received.err)
			assert.Equal(t, strings.Replace(path, "/pg/", "/v1/", 1), received.path)
			if test.edit {
				forwarded := httptest.NewRequest(http.MethodPost, received.path, bytes.NewReader(received.body))
				forwarded.Header.Set("Content-Type", received.contentType)
				require.NoError(t, forwarded.ParseMultipartForm(1<<20))
				t.Cleanup(func() { require.NoError(t, forwarded.MultipartForm.RemoveAll()) })
				assert.Equal(t, "upstream-image", forwarded.PostForm.Get("model"))
				assert.Equal(t, "remove text", forwarded.PostForm.Get("prompt"))
				assert.False(t, forwarded.PostForm.Has("group"))
				file, _, err := forwarded.FormFile("image")
				require.NoError(t, err)
				defer file.Close()
				reference, err := io.ReadAll(file)
				require.NoError(t, err)
				assert.Equal(t, "reference-image", string(reference))
			} else {
				var payload map[string]any
				require.NoError(t, common.Unmarshal(received.body, &payload))
				assert.Equal(t, "upstream-image", payload["model"])
				assert.Equal(t, "remove text", payload["prompt"])
				assert.NotContains(t, payload, "group")
			}
		})
	}
}

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

// An accepted task already has a record; carrying it out in the background must
// not leave a second, zero-duration one beside it holding the same result.
func TestShouldRecordSynchronousImageTask(t *testing.T) {
	tests := []struct {
		name    string
		target  string
		running bool
		want    bool
	}{
		{name: "a caller waiting on the response is recorded", target: "/v1/images/generations", want: true},
		{name: "a caller asking for a task is not", target: "/v1/images/generations?async=true", want: false},
		{name: "an accepted task being carried out is not", target: "/v1/images/generations?async=true", running: true, want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, _ := gin.CreateTestContext(httptest.NewRecorder())
			context.Request = httptest.NewRequest(http.MethodPost, test.target, nil)
			if test.running {
				context.Set(asyncImageRunningKey, true)
			}
			assert.Equal(t, test.want, shouldRecordSynchronousImageTask(context, &dto.ImageRequest{}))
		})
	}
}

func TestImageResultBudget(t *testing.T) {
	count := func(n uint) *uint { return &n }

	tests := []struct {
		name     string
		database common.DatabaseType
		request  *dto.ImageRequest
		want     int
	}{
		{name: "a url batch carries no image bytes", database: common.DatabaseTypeSQLite, request: &dto.ImageRequest{N: count(64), ResponseFormat: "url"}, want: 8 << 20},
		{name: "mysql keeps its tighter floor for url results", database: common.DatabaseTypeMySQL, request: &dto.ImageRequest{N: count(64), ResponseFormat: "url"}, want: 3 << 20},
		{name: "an absent count is one inline image", database: common.DatabaseTypeSQLite, request: &dto.ImageRequest{}, want: asyncImageInlineImageBudget},
		{name: "mysql gives an inline image the same room", database: common.DatabaseTypeMySQL, request: &dto.ImageRequest{N: count(1)}, want: asyncImageInlineImageBudget},
		{name: "an inline batch grows with its count", database: common.DatabaseTypePostgreSQL, request: &dto.ImageRequest{N: count(4)}, want: 4 * asyncImageInlineImageBudget},
		{name: "an explicit inline format grows too", database: common.DatabaseTypeSQLite, request: &dto.ImageRequest{N: count(2), ResponseFormat: "b64_json"}, want: 2 * asyncImageInlineImageBudget},
		// An unvalidated *uint can carry a wrapped negative; an unclamped
		// multiply would overflow to a negative budget, which reads as an
		// instantly overflowing buffer and fails every run.
		{name: "an absurd count stays within the result cap", database: common.DatabaseTypeSQLite, request: &dto.ImageRequest{N: count(1 << 62)}, want: 1 << 30},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			previous := common.MainDatabaseType()
			common.SetMainDatabaseType(test.database)
			t.Cleanup(func() { common.SetMainDatabaseType(previous) })
			budget := imageResultBudget(test.request)
			assert.Equal(t, test.want, budget)
			assert.Positive(t, budget)
		})
	}

	// An image between the two limits would be cut off before it is decoded.
	t.Run("one inline image fits the largest image a task keeps", func(t *testing.T) {
		assert.GreaterOrEqual(t, imageResultBudget(&dto.ImageRequest{}), base64.StdEncoding.EncodedLen(imageTaskArtifactMaxBytes))
	})
}

// A result that cannot reach the gallery still lands on the task row, so the
// fallback has to drop every inline payload. b64_json is the documented one,
// but a provider may answer with an equally large inline data URL.
func TestStripImageTaskBase64DropsInlinePayloads(t *testing.T) {
	result := json.RawMessage(`{"created":1,"data":[` +
		`{"b64_json":"AAAA","revised_prompt":"kept"},` +
		`{"url":"data:image/png;base64,AAAA"},` +
		`{"url":"https://cdn.example.com/a.png"}]}`)

	stripped := stripImageTaskBase64(result)

	assert.NotContains(t, string(stripped), "b64_json")
	assert.NotContains(t, string(stripped), "data:image/png")
	assert.Contains(t, string(stripped), "https://cdn.example.com/a.png")
	assert.Contains(t, string(stripped), "kept")
	assert.Equal(t, "https://cdn.example.com/a.png", firstAsyncImageURL(stripped))
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
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: imageResultBudget(nil)}
		recorder.WriteHeader(http.StatusOK)
		_, err := recorder.Write([]byte(`{"created":1,"data":[{"url":"https://cdn.example/a.png"}]}`))
		require.NoError(t, err)

		result, err := asyncImageResult(recorder)
		require.NoError(t, err)
		assert.JSONEq(t, `{"created":1,"data":[{"url":"https://cdn.example/a.png"}]}`, string(result))
		assert.Equal(t, "https://cdn.example/a.png", firstAsyncImageURL(result))
	})

	t.Run("reports the upstream error message", func(t *testing.T) {
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: imageResultBudget(nil)}
		recorder.WriteHeader(http.StatusBadRequest)
		_, err := recorder.Write([]byte(`{"error":{"message":"prompt was rejected"}}`))
		require.NoError(t, err)

		_, err = asyncImageResult(recorder)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "prompt was rejected")
		assert.Contains(t, err.Error(), "400")
	})

	t.Run("rejects a result larger than a task can keep", func(t *testing.T) {
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: 1 << 20}
		recorder.WriteHeader(http.StatusOK)
		_, err := recorder.Write(make([]byte, recorder.limit+1))
		require.NoError(t, err)

		_, err = asyncImageResult(recorder)
		// Retrying without async generates and charges again, and the
		// synchronous path keeps nothing larger, so the error does not suggest it.
		require.EqualError(t, err, "image result exceeds the 1 MB an image task can keep")
	})

	t.Run("collapses a streamed response into completed images", func(t *testing.T) {
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: imageResultBudget(nil)}
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
		recorder := &asyncImageResponseRecorder{header: http.Header{}, limit: imageResultBudget(nil)}
		recorder.header.Set("Content-Type", "text/event-stream")
		recorder.WriteHeader(http.StatusOK)
		_, err := recorder.Write([]byte("data: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"cGFydGlhbA==\"}\n\n"))
		require.NoError(t, err)

		_, err = asyncImageResult(recorder)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "ended before generation completed")
	})
}

// The async image task records the charge of the work it presents. When a task
// plugin generated the images, the image task adopts the plugin task so task
// lists show one record per request. A plugin success the image task could not
// present stays visible instead, and the failed image task shows no charge, so
// the charge appears exactly once.
func TestFinishAsyncImageTaskRecordsChargeOnce(t *testing.T) {
	for _, tc := range []struct {
		name        string
		pluginTask  *pluginImageTaskRef
		quota       int
		status      int
		wantStatus  model.TaskStatus
		wantQuota   int
		wantAdopted bool
	}{
		{name: "relayed image keeps its billed quota", quota: 5_000_000, status: http.StatusOK, wantStatus: model.TaskStatusSuccess, wantQuota: 5_000_000},
		{name: "plugin image adopts its plugin task", pluginTask: &pluginImageTaskRef{TaskID: "task_plugin", Success: true}, quota: 5_000_000, status: http.StatusOK, wantStatus: model.TaskStatusSuccess, wantQuota: 5_000_000, wantAdopted: true},
		{name: "plugin success left unpresented stays visible", pluginTask: &pluginImageTaskRef{TaskID: "task_plugin", Success: true}, quota: 5_000_000, status: http.StatusInternalServerError, wantStatus: model.TaskStatusFailure},
		{name: "plugin failure is adopted by the failed image task", pluginTask: &pluginImageTaskRef{TaskID: "task_plugin"}, status: http.StatusBadRequest, wantStatus: model.TaskStatusFailure, wantAdopted: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previousDB := model.DB
			database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			require.NoError(t, err)
			connection, err := database.DB()
			require.NoError(t, err)
			connection.SetMaxOpenConns(1)
			t.Cleanup(func() {
				model.DB = previousDB
				require.NoError(t, connection.Close())
			})
			model.DB = database
			require.NoError(t, database.AutoMigrate(&model.Task{}))

			task := &model.Task{
				TaskID:     "task_billed",
				Platform:   constant.TaskPlatformImage,
				Status:     model.TaskStatusInProgress,
				Progress:   "0%",
				SubmitTime: 1700000000,
			}
			require.NoError(t, task.Insert())
			require.NoError(t, (&model.Task{TaskID: "task_plugin", Platform: "image-bridge", Status: model.TaskStatusSuccess, Quota: tc.quota}).Insert())
			run := &asyncImageRun{
				keys:       map[string]any{string(constant.ContextKeyAsyncImageQuota): tc.quota},
				pluginTask: tc.pluginTask,
			}
			recorder := &asyncImageResponseRecorder{
				header: make(http.Header),
				limit:  imageResultBudget(nil),
			}
			recorder.WriteHeader(tc.status)
			_, err = recorder.Write([]byte(`{"created":1,"data":[{"url":"https://cdn.example/image.png"}]}`))
			require.NoError(t, err)

			finishAsyncImageTask(context.Background(), task, run, recorder)

			var stored, plugin model.Task
			require.NoError(t, database.Where("task_id = ?", task.TaskID).First(&stored).Error)
			assert.Equal(t, tc.wantStatus, stored.Status)
			assert.Equal(t, tc.wantQuota, stored.Quota)
			require.NoError(t, database.Where("task_id = ?", "task_plugin").First(&plugin).Error)
			if tc.wantAdopted {
				assert.Equal(t, task.TaskID, plugin.ParentTaskID)
			} else {
				assert.Empty(t, plugin.ParentTaskID)
			}
		})
	}
}

func TestFinishAsyncImageTaskPersistsGalleryArtifactsWithoutBase64TaskData(t *testing.T) {
	previousDB := model.DB
	previousSecret := common.CryptoSecret
	previousServerAddress := system_setting.ServerAddress
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	connection, err := database.DB()
	require.NoError(t, err)
	connection.SetMaxOpenConns(1)
	t.Setenv("GALLERY_STORAGE_DIR", t.TempDir())
	t.Cleanup(func() {
		model.DB = previousDB
		common.CryptoSecret = previousSecret
		system_setting.ServerAddress = previousServerAddress
		require.NoError(t, connection.Close())
	})
	common.CryptoSecret = "image-task-test-secret"
	system_setting.ServerAddress = "https://gateway.example"
	model.DB = database
	require.NoError(t, database.AutoMigrate(&model.Task{}))
	require.NoError(t, model.MigrateGallery(database))

	var picture bytes.Buffer
	require.NoError(t, png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 8, 4))))
	task := &model.Task{
		TaskID:     "task_gallery_artifacts",
		Platform:   constant.TaskPlatformImage,
		UserId:     7,
		Status:     model.TaskStatusInProgress,
		Progress:   "0%",
		SubmitTime: 1700000000,
		Properties: model.Properties{OriginModelName: "gpt-image-1", Input: "a fox"},
	}
	require.NoError(t, task.Insert())
	run := &asyncImageRun{keys: map[string]any{}}
	recorder := &asyncImageResponseRecorder{header: make(http.Header), limit: imageResultBudget(nil)}
	recorder.WriteHeader(http.StatusOK)
	result := `{"created":1,"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(picture.Bytes()) + `"}]}`
	_, err = recorder.Write([]byte(result))
	require.NoError(t, err)

	finishAsyncImageTask(context.Background(), task, run, recorder)

	var stored model.Task
	require.NoError(t, database.Where("task_id = ?", task.TaskID).First(&stored).Error)
	require.Equal(t, model.TaskStatus(model.TaskStatusSuccess), stored.Status)
	require.NotEmpty(t, stored.PrivateData.GalleryImageIDs["image-0"])
	assert.NotContains(t, string(stored.Data), "b64_json")
	imageFile, _, err := service.OpenGalleryImage(context.Background(), 7, stored.PrivateData.GalleryImageIDs["image-0"], true)
	require.NoError(t, err)
	_, _, err = image.Decode(imageFile)
	imageFile.Close()
	require.NoError(t, err)
}

func TestPersistSynchronousImageTaskCreatesGalleryArtifacts(t *testing.T) {
	for _, tc := range []struct {
		name       string
		clientGone bool
	}{
		{name: "client still connected"},
		// A client usually closes the connection as soon as it has its images;
		// the record of work it was charged for must survive that.
		{name: "client already disconnected", clientGone: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previousDB := model.DB
			previousSecret := common.CryptoSecret
			previousServerAddress := system_setting.ServerAddress
			database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			require.NoError(t, err)
			connection, err := database.DB()
			require.NoError(t, err)
			connection.SetMaxOpenConns(1)
			t.Setenv("GALLERY_STORAGE_DIR", t.TempDir())
			t.Cleanup(func() {
				model.DB = previousDB
				common.CryptoSecret = previousSecret
				system_setting.ServerAddress = previousServerAddress
				require.NoError(t, connection.Close())
			})
			model.DB = database
			common.CryptoSecret = "sync-image-task-test-secret"
			system_setting.ServerAddress = "https://gateway.example"
			require.NoError(t, database.AutoMigrate(&model.Task{}))
			require.NoError(t, model.MigrateGallery(database))

			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			requestContext, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			if tc.clientGone {
				cancel()
			}
			c.Request = httptest.NewRequest(http.MethodPost, "/pg/images/generations", nil).WithContext(requestContext)
			c.Set("id", 7)
			c.Set("group", "default")
			common.SetContextKey(c, constant.ContextKeyAsyncImageQuota, 12345)
			info := &relaycommon.RelayInfo{
				UserId:          7,
				UsingGroup:      "default",
				OriginModelName: "gpt-image-1",
				RelayMode:       relayconstant.RelayModeImagesGenerations,
				ChannelMeta:     &relaycommon.ChannelMeta{ChannelId: 73},
			}
			request := &dto.ImageRequest{Prompt: "a white fox"}
			var picture bytes.Buffer
			require.NoError(t, png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 8, 4))))
			result := json.RawMessage(`{"created":1,"data":[{"url":"","b64_json":"` + base64.StdEncoding.EncodeToString(picture.Bytes()) + `"}]}`)

			task, err := persistSynchronousImageTask(c, info, request, result)
			require.NoError(t, err)
			require.NotNil(t, task)
			assert.Equal(t, model.TaskStatus(model.TaskStatusSuccess), task.Status)
			assert.Equal(t, 12345, task.Quota)
			assert.NotEmpty(t, task.PrivateData.GalleryImageIDs["image-0"])
			assert.NotContains(t, string(task.Data), "b64_json")
			var stored model.Task
			require.NoError(t, database.Where("task_id = ?", task.TaskID).First(&stored).Error)
			assert.Equal(t, task.PrivateData.GalleryImageIDs, stored.PrivateData.GalleryImageIDs)
		})
	}
}

// useImageTaskGallery points tasks and the gallery at a fresh database and
// gallery directory for one test.
func useImageTaskGallery(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB := model.DB
	previousSecret := common.CryptoSecret
	previousServerAddress := system_setting.ServerAddress
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	connection, err := database.DB()
	require.NoError(t, err)
	connection.SetMaxOpenConns(1)
	t.Setenv("GALLERY_STORAGE_DIR", t.TempDir())
	t.Cleanup(func() {
		model.DB = previousDB
		common.CryptoSecret = previousSecret
		system_setting.ServerAddress = previousServerAddress
		require.NoError(t, connection.Close())
	})
	common.CryptoSecret = "image-task-test-secret"
	system_setting.ServerAddress = "https://gateway.example"
	model.DB = database
	require.NoError(t, database.AutoMigrate(&model.Task{}))
	require.NoError(t, model.MigrateGallery(database))
	return database
}

// A detailed 4K render runs to tens of megabytes of base64: past the buffer a
// task used to keep and past the largest image it used to decode. The drawing
// page offers those sizes, so the task keeps the image instead of failing after
// the upstream call was already charged.
func TestImageTasksKeepFullSizeImages(t *testing.T) {
	// Without compression the fixture is as large as a detailed render:
	// 11.6 MB decoded, 15.4 MB once base64 carries it.
	var picture bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.NoCompression}
	require.NoError(t, encoder.Encode(&picture, image.NewNRGBA(image.Rect(0, 0, 1700, 1700))))
	require.Greater(t, picture.Len(), 10<<20)
	result := `{"created":1,"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(picture.Bytes()) + `"}]}`
	require.Greater(t, len(result), 8<<20)
	// The drawing page sends GPT Image requests without a response format.
	request := &dto.ImageRequest{Prompt: "a sunburst"}

	t.Run("an async task", func(t *testing.T) {
		database := useImageTaskGallery(t)
		task := &model.Task{
			TaskID:     "task_full_size",
			Platform:   constant.TaskPlatformImage,
			UserId:     7,
			Status:     model.TaskStatusInProgress,
			Progress:   "0%",
			SubmitTime: 1700000000,
			Properties: model.Properties{OriginModelName: "gpt-image-2", Input: request.Prompt},
		}
		require.NoError(t, task.Insert())
		recorder := &asyncImageResponseRecorder{header: make(http.Header), limit: imageResultBudget(request)}
		recorder.WriteHeader(http.StatusOK)
		_, err := recorder.Write([]byte(result))
		require.NoError(t, err)

		finishAsyncImageTask(context.Background(), task, &asyncImageRun{keys: map[string]any{}}, recorder)

		var stored model.Task
		require.NoError(t, database.Where("task_id = ?", task.TaskID).First(&stored).Error)
		require.Equal(t, model.TaskStatus(model.TaskStatusSuccess), stored.Status, stored.FailReason)
		assert.NotContains(t, string(stored.Data), "b64_json")
		original, _, err := service.OpenGalleryImage(context.Background(), 7, stored.PrivateData.GalleryImageIDs["image-0"], false)
		require.NoError(t, err)
		kept, err := io.ReadAll(original)
		original.Close()
		require.NoError(t, err)
		assert.True(t, bytes.Equal(picture.Bytes(), kept), "the gallery keeps the image byte for byte")
	})

	t.Run("a synchronous request", func(t *testing.T) {
		database := useImageTaskGallery(t)
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/pg/images/generations", nil)
		c.Set("id", 7)
		info := &relaycommon.RelayInfo{
			UserId:          7,
			UsingGroup:      "default",
			OriginModelName: "gpt-image-2",
			RelayMode:       relayconstant.RelayModeImagesGenerations,
			ChannelMeta:     &relaycommon.ChannelMeta{ChannelId: 73},
		}
		record := captureSynchronousImageTask(c, info, request)
		require.NotNil(t, record)
		c.Writer.Header().Set("Content-Type", "application/json")
		c.Writer.WriteHeader(http.StatusOK)
		_, err := c.Writer.Write([]byte(result))
		require.NoError(t, err)

		record(true)

		var stored model.Task
		require.NoError(t, database.Where("user_id = ?", 7).First(&stored).Error)
		assert.Equal(t, model.TaskStatus(model.TaskStatusSuccess), stored.Status)
		original, _, err := service.OpenGalleryImage(context.Background(), 7, stored.PrivateData.GalleryImageIDs["image-0"], false)
		require.NoError(t, err)
		kept, err := io.ReadAll(original)
		original.Close()
		require.NoError(t, err)
		assert.True(t, bytes.Equal(picture.Bytes(), kept), "the gallery keeps the image byte for byte")
	})
}

// Providers send inline images padded, unpadded, wrapped across lines or as a
// data URL. The gallery reads each through a streaming decoder, which has to be
// told the padding up front instead of retrying the other encoding.
func TestAsyncImageReadersDecodeInlineImages(t *testing.T) {
	var picture bytes.Buffer
	require.NoError(t, png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 8, 5))))
	padded := base64.StdEncoding.EncodeToString(picture.Bytes())
	unpadded := base64.RawStdEncoding.EncodeToString(picture.Bytes())
	require.NotEqual(t, padded, unpadded, "the fixture has to need padding")
	var wrapped strings.Builder
	for start := 0; start < len(padded); start += 16 {
		wrapped.WriteString(padded[start:min(start+16, len(padded))] + "\r\n")
	}

	for _, tc := range []struct {
		name    string
		value   string
		dataURL bool
	}{
		{name: "padded base64", value: padded},
		{name: "unpadded base64", value: unpadded},
		{name: "base64 wrapped across lines", value: wrapped.String()},
		{name: "a data URL", value: "data:image/png;base64," + padded, dataURL: true},
		{name: "a data URL with an uppercase scheme", value: "DATA:image/png;base64," + unpadded, dataURL: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			content, err := asyncImageBase64Reader(tc.value)
			if tc.dataURL {
				var isDataURL bool
				content, isDataURL, err = asyncImageDataURLReader(tc.value)
				require.True(t, isDataURL)
			}
			require.NoError(t, err)
			decoded, err := io.ReadAll(content)
			require.NoError(t, err)
			assert.Equal(t, picture.Bytes(), decoded)
		})
	}
}

// When the gallery cannot keep the images, the task row keeps the provider
// result without its inline payloads. The link it records must be a real one
// too: an inline data URL there is the whole image again.
func TestFinishAsyncImageTaskFallbackRecordsNoInlineImage(t *testing.T) {
	database := useImageTaskGallery(t)
	_, err := service.UpdateGallerySettings(context.Background(), model.GallerySettings{
		Enabled: false, RetentionDays: 7, UserMaxImages: 100, UserMaxBytes: 200 << 20, TotalMaxBytes: 512 << 20,
	})
	require.NoError(t, err)
	task := &model.Task{
		TaskID:     "task_gallery_off",
		Platform:   constant.TaskPlatformImage,
		UserId:     7,
		Status:     model.TaskStatusInProgress,
		Progress:   "0%",
		SubmitTime: 1700000000,
		Properties: model.Properties{OriginModelName: "gpt-image-2", Input: "a fox"},
	}
	require.NoError(t, task.Insert())
	recorder := &asyncImageResponseRecorder{header: make(http.Header), limit: imageResultBudget(&dto.ImageRequest{})}
	recorder.WriteHeader(http.StatusOK)
	_, err = recorder.Write([]byte(`{"created":1,"data":[{"url":"data:image/png;base64,AAAA"},{"url":"https://cdn.example/a.png"}]}`))
	require.NoError(t, err)

	finishAsyncImageTask(context.Background(), task, &asyncImageRun{keys: map[string]any{}}, recorder)

	var stored model.Task
	require.NoError(t, database.Where("task_id = ?", task.TaskID).First(&stored).Error)
	assert.Equal(t, "https://cdn.example/a.png", stored.PrivateData.ResultURL)
	assert.NotContains(t, string(stored.Data), "data:image/png")
}

// An image a task plugin generated for the drawing page is recorded like any
// other drawing image: one task in the task lists, carrying the charge the
// plugin settled, with the images copied to the gallery. The plugin task behind
// it stays reachable by its ID, which its consume log shows. A failure the
// image task never presents leaves the plugin task as the only record.
func TestServeTaskPluginImageTaskKeepsOneTaskPerRequest(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     model.TaskStatus
		wantStatus int
	}{
		{"success", model.TaskStatusSuccess, http.StatusOK},
		{"failure", model.TaskStatusFailure, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database, dialect := openTaskDialectDatabase(t, &model.Task{}, &model.GallerySettings{}, &model.GalleryImage{}, &model.GalleryCanvas{}, &model.GalleryRemoval{})
			previousDB, previousMain, previousLog := model.DB, common.MainDatabaseType(), common.LogDatabaseType()
			previousSecret, previousServerAddress := common.CryptoSecret, system_setting.ServerAddress
			t.Cleanup(func() {
				model.DB = previousDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.CryptoSecret, system_setting.ServerAddress = previousSecret, previousServerAddress
			})
			model.DB = database
			common.SetDatabaseTypes(dialect, dialect)
			common.CryptoSecret = "plugin-image-task-test-secret"
			system_setting.ServerAddress = "https://gateway.example"
			t.Setenv("GALLERY_STORAGE_DIR", t.TempDir())
			require.NoError(t, model.MigrateGallery(database))

			pinned := imageProtocolTestEndpoint(t)
			c, recorder := newImageProtocolTestContext("b64_json")
			c.Request = httptest.NewRequest(http.MethodPost, "/pg/images/generations", strings.NewReader(`{}`))
			c.Set("task_request", map[string]any{"model": "image-model", "prompt": "a cat", "n": int64(2)})
			c.Set("channel_id", 3)
			var picture bytes.Buffer
			require.NoError(t, png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 8, 4))))
			deps := pluginProtocolTestDeps()
			deps.downloadImage = func(string) (string, string, error) {
				return "image/png", base64.StdEncoding.EncodeToString(picture.Bytes()), nil
			}
			deps.submit = func(c *gin.Context, info *relaycommon.RelayInfo) (*taskSubmissionOutcome, *taskdto.TaskError) {
				// The submission retried on another channel before it settled.
				c.Set("channel_id", 5)
				outcome := imageProtocolTestOutcome(info, tc.status, "https://cdn.example/1.png", "https://cdn.example/2.png")
				outcome.Task.ChannelId = 5
				outcome.Task.Quota = 4321
				require.NoError(t, outcome.Task.Insert())
				return outcome, nil
			}

			serveTaskPluginImageTask(c, pinned, deps)
			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())

			userTasks := model.TaskGetAllUserTask(71, 0, 10, model.SyncTaskQueryParams{})
			allTasks := model.TaskGetAllTasks(0, 10, model.SyncTaskQueryParams{})
			require.Len(t, userTasks, 1)
			require.Len(t, allTasks, 1)
			assert.EqualValues(t, 1, model.TaskCountAllUserTask(71, model.SyncTaskQueryParams{}))
			assert.EqualValues(t, 1, model.TaskCountAllTasks(model.SyncTaskQueryParams{}))
			byID := model.SyncTaskQueryParams{TaskID: "task_image"}
			assert.Len(t, model.TaskGetAllUserTask(71, 0, 10, byID), 1)
			assert.Len(t, model.TaskGetAllTasks(0, 10, byID), 1)
			assert.EqualValues(t, 1, model.TaskCountAllUserTask(71, byID))
			assert.EqualValues(t, 1, model.TaskCountAllTasks(byID))
			if tc.status == model.TaskStatusFailure {
				assert.Equal(t, "task_image", userTasks[0].TaskID)
				return
			}
			record := allTasks[0]
			assert.Equal(t, constant.TaskPlatformImage, record.Platform)
			assert.Equal(t, model.TaskStatus(model.TaskStatusSuccess), record.Status)
			assert.Equal(t, 4321, record.Quota)
			assert.Equal(t, 5, record.ChannelId)
			assert.Equal(t, "a cat", record.Properties.Input)
			assert.Equal(t, "drawing", record.PrivateData.GallerySource)
			assert.Len(t, record.PrivateData.GalleryImageIDs, 2)
		})
	}
}

func TestImageTaskGallerySourceSeparatesAPIAndCanvasGeneration(t *testing.T) {
	// The drawing page generates with every model family, NovelAI included, so
	// the source follows where the request came from, not which model served it.
	for _, modelName := range []string{"gpt-image-1", "nai-diffusion-4-full", "qwen-image"} {
		request := &dto.ImageRequest{Model: modelName}
		assert.Equal(t, "api", imageTaskGallerySource(&relaycommon.RelayInfo{}, request), modelName)
		assert.Equal(t, "drawing", imageTaskGallerySource(&relaycommon.RelayInfo{IsPlayground: true}, request), modelName)
	}
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

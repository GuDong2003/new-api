package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/bytedance/gopkg/util/gopool"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/sjson"
)

// Asynchronous image generation answers an ordinary image request with a
// durable task and finishes the relay in the background. The relay itself is
// untouched: channel retry, billing, and content audit still run exactly as in
// the synchronous path; only the provider response is captured onto the task
// instead of being written back to the submitting client.

// Task states exposed to API clients. They reuse the video task vocabulary so
// clients can share one polling implementation across media types.
const (
	imageTaskStatusQueued     = "queued"
	imageTaskStatusInProgress = "in_progress"
	imageTaskStatusCompleted  = "completed"
	imageTaskStatusFailed     = "failed"
	imageTaskStatusUnknown    = "unknown"
	imageTaskArtifactMaxBytes = 10 << 20
)

// asyncImageRequestTimeout bounds one detached generation. constant.TaskTimeoutMinutes
// sweeps whatever outlives it, so this stays well below that sweep.
const asyncImageRequestTimeout = 10 * time.Minute

// asyncImageInlineImageBudget is a conservative per-image estimate for an inline
// base64 result; a 1024x1024 PNG lands near 1.5 MB once base64 expands it.
const asyncImageInlineImageBudget = 2 << 20

// maxAsyncImageResultBytes caps the provider payload persisted on a task row.
// MySQL's default max_allowed_packet is 4 MB on 5.7, so a MySQL deployment keeps
// a tighter budget; SQLite and PostgreSQL have no comparable per-statement limit
// and can hold a larger batch.
func maxAsyncImageResultBytes() int {
	if common.UsingMainDatabase(common.DatabaseTypeMySQL) {
		return 3 << 20
	}
	return 8 << 20
}

// asyncImageSlots bounds detached image runs. An accepted task is not held open
// by a client connection, so without this a burst of submissions would open an
// unbounded number of concurrent upstream generations. It also bounds memory:
// every run buffers its response, so the ceiling is this many results in flight.
var asyncImageSlots = make(chan struct{}, 32)

// maxAsyncImageFailReason keeps a failure message inside the task's string column.
const maxAsyncImageFailReason = 200

// asyncImageRunningKey marks the detached run so the dispatcher in Relay does
// not accept the replayed request as a new async submission.
const asyncImageRunningKey = "async_image_running"

func imageTaskStatus(status string) string {
	switch model.TaskStatus(status) {
	case model.TaskStatusNotStart, model.TaskStatusSubmitted, model.TaskStatusQueued:
		return imageTaskStatusQueued
	case model.TaskStatusInProgress:
		return imageTaskStatusInProgress
	case model.TaskStatusSuccess:
		return imageTaskStatusCompleted
	case model.TaskStatusFailure:
		return imageTaskStatusFailed
	default:
		return imageTaskStatusUnknown
	}
}

// isAsyncImageRequest reports whether the caller asked for a task instead of an
// inline image response. The query parameter and the two headers work for
// multipart uploads as well, where the JSON body field is not available.
func isAsyncImageRequest(c *gin.Context, request *dto.ImageRequest) bool {
	if c.GetBool(asyncImageRunningKey) {
		return false
	}
	if raw := c.Query("async"); raw != "" {
		enabled, err := strconv.ParseBool(raw)
		return err == nil && enabled
	}
	for prefer := range strings.SplitSeq(c.GetHeader("Prefer"), ",") {
		if strings.EqualFold(strings.TrimSpace(prefer), "respond-async") {
			return true
		}
	}
	if raw := c.GetHeader("X-Image-Async"); raw != "" {
		enabled, err := strconv.ParseBool(raw)
		return err == nil && enabled
	}
	if request != nil {
		if raw, ok := request.Extra["async"]; ok {
			var enabled bool
			if err := common.Unmarshal(raw, &enabled); err == nil {
				return enabled
			}
		}
	}
	return false
}

// asyncImageRunContextKey carries detached submission state into the background
// handler chain, which builds its own gin context from the replayed request.
type asyncImageRunContextKey struct{}

type asyncImageRun struct {
	keys      map[string]any
	channelID int
}

var (
	asyncImageEngineOnce sync.Once
	asyncImageEngineRef  *gin.Engine
)

// asyncImageEngine returns the handler chain that finishes an accepted async
// image request. Replaying through a real gin chain keeps body-storage cleanup
// and content-audit capture identical to the synchronous route. Authentication,
// rate limiting, and channel distribution are deliberately absent: the
// submitting request already passed them and their results travel in the copied
// context keys. The chain is built lazily because it ends in Relay, which in
// turn dispatches async submissions back here.
func asyncImageEngine() *gin.Engine {
	asyncImageEngineOnce.Do(func() {
		engine := gin.New()
		engine.POST("/*path",
			middleware.RelayPanicRecover(),
			func(c *gin.Context) {
				run := asyncImageRunFromRequest(c)
				if run == nil {
					c.AbortWithStatus(http.StatusInternalServerError)
					return
				}
				if c.Keys == nil {
					c.Keys = make(map[string]any, len(run.keys))
				}
				maps.Copy(c.Keys, run.keys)
			},
			middleware.BodyStorageCleanup(),
			service.CaptureContentAudit,
			func(c *gin.Context) {
				Relay(c, types.RelayFormatOpenAIImage)
				if run := asyncImageRunFromRequest(c); run != nil {
					run.channelID = c.GetInt("channel_id")
					run.keys[string(constant.ContextKeyAsyncImageQuota)] = common.GetContextKeyInt(c, constant.ContextKeyAsyncImageQuota)
				}
			},
		)
		asyncImageEngineRef = engine
	})
	return asyncImageEngineRef
}

func asyncImageRunFromRequest(c *gin.Context) *asyncImageRun {
	run, _ := c.Request.Context().Value(asyncImageRunContextKey{}).(*asyncImageRun)
	return run
}

// asyncImageResponseRecorder buffers the detached relay response. It keeps at
// most maxAsyncImageResultBytes; anything larger marks the run as overflowing
// so the task fails instead of persisting an oversized row.
type asyncImageResponseRecorder struct {
	header   http.Header
	body     bytes.Buffer
	status   int
	limit    int
	overflow bool
}

// imageResponseCaptureWriter mirrors a synchronous image response to the
// client while retaining a bounded copy for creating the completed task row.
type imageResponseCaptureWriter struct {
	gin.ResponseWriter
	body     bytes.Buffer
	limit    int
	overflow bool
}

func (w *imageResponseCaptureWriter) Write(data []byte) (int, error) {
	remaining := w.limit - w.body.Len()
	if remaining <= 0 {
		w.overflow = true
	} else if len(data) > remaining {
		_, _ = w.body.Write(data[:remaining])
		w.overflow = true
	} else {
		_, _ = w.body.Write(data)
	}
	return w.ResponseWriter.Write(data)
}

func (w *imageResponseCaptureWriter) WriteString(value string) (int, error) {
	return w.Write([]byte(value))
}

func (r *asyncImageResponseRecorder) Header() http.Header {
	return r.header
}

func (r *asyncImageResponseRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
}

func (r *asyncImageResponseRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	remaining := r.limit - r.body.Len()
	if remaining <= 0 {
		r.overflow = true
		return len(data), nil
	}
	if len(data) > remaining {
		r.body.Write(data[:remaining])
		r.overflow = true
		return len(data), nil
	}
	return r.body.Write(data)
}

// Flush and CloseNotify exist because gin's ResponseWriter type-asserts both
// without checking; streaming image relays call Flush on every event.
func (r *asyncImageResponseRecorder) Flush() {}

func (r *asyncImageResponseRecorder) CloseNotify() <-chan bool {
	return make(chan bool)
}

func (r *asyncImageResponseRecorder) statusCode() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

// imageTaskStatusURL locates where a submitted task is read back. Edits share
// the generation task namespace, so every task resolves to the generations path
// of the API prefix that accepted it (/v1 or the playground's /pg).
func imageTaskStatusURL(requestPath, taskID string) string {
	prefix, _, found := strings.Cut(requestPath, "/images/")
	if !found {
		prefix = strings.TrimSuffix(path.Dir(requestPath), "/images")
	}
	return prefix + "/images/generations/" + taskID
}

func imageTaskAction(relayMode int) string {
	if relayMode == relayconstant.RelayModeImagesEdits {
		return constant.TaskActionImageEdit
	}
	return constant.TaskActionImageGeneration
}

func imageTaskGallerySource(info *relaycommon.RelayInfo, request *dto.ImageRequest) string {
	if info == nil || !info.IsPlayground {
		return "api"
	}
	modelName := ""
	if request != nil {
		modelName = request.Model
	}
	if modelName == "" {
		modelName = info.OriginModelName
	}
	if strings.Contains(strings.ToLower(modelName), "nai") {
		return "nai"
	}
	return "drawing"
}

// asyncImageStorable reports whether a finished result can be kept on a task
// row. Inline base64 is the only image payload that grows large, and MySQL's
// default max_allowed_packet (4 MB on 5.7) bounds one row, so a base64 batch is
// answered synchronously instead of being accepted and then failing.
func asyncImageStorable(request *dto.ImageRequest) bool {
	if strings.EqualFold(request.ResponseFormat, "url") {
		return true
	}
	count := uint64(1)
	if request.N != nil && *request.N > 0 {
		count = uint64(*request.N)
	}
	return count*asyncImageInlineImageBudget <= uint64(maxAsyncImageResultBytes())
}

// submitAsyncImageTask persists the task, hands the request to a detached
// replay, and answers the caller with the task handle. It runs before
// pre-consume: the detached relay owns the entire billing lifecycle.
//
// Accepting a task is best effort. Every failure here reports false so the
// caller finishes the request on the ordinary synchronous path; nothing is
// persisted and no quota is touched until the task is actually accepted.
func submitAsyncImageTask(c *gin.Context, info *relaycommon.RelayInfo, request *dto.ImageRequest) bool {
	if !asyncImageStorable(request) {
		logger.LogInfo(c, "async image declined: a base64 batch result does not fit a task row, using the synchronous path")
		return false
	}
	body, err := detachAsyncImageBody(c)
	if err != nil {
		logger.LogWarn(c, "async image declined: %s", err.Error())
		return false
	}

	// Distribution has selected the channel in the context, but ChannelMeta
	// stays nil until ImageHelper runs. Keep it that way so a synchronous
	// fallback still uses the selected channel as its first attempt.
	now := time.Now().Unix()
	task := &model.Task{
		TaskID:     model.GenerateTaskID(),
		Platform:   constant.TaskPlatformImage,
		UserId:     info.UserId,
		Group:      info.UsingGroup,
		ChannelId:  common.GetContextKeyInt(c, constant.ContextKeyChannelId),
		Action:     imageTaskAction(info.RelayMode),
		Status:     model.TaskStatusInProgress,
		Progress:   "0%",
		SubmitTime: now,
		StartTime:  now,
		Properties: model.Properties{
			Input:             request.Prompt,
			OriginModelName:   info.OriginModelName,
			UpstreamModelName: info.OriginModelName,
		},
		// Quota stays zero on purpose. The detached relay pre-consumes, settles
		// and refunds through the ordinary consume-log path, so the task timeout
		// sweeper must never issue a second refund for the same request.
		PrivateData: model.TaskPrivateData{NodeName: common.NodeName},
	}
	task.PrivateData.GallerySource = imageTaskGallerySource(info, request)

	run := &asyncImageRun{keys: make(map[string]any, len(c.Keys)+3)}
	maps.Copy(run.keys, c.Keys)
	run.keys[string(constant.ContextKeyAsyncImageTaskID)] = task.TaskID
	run.keys[common.KeyBodyStorage] = body
	run.keys[asyncImageRunningKey] = true

	runContext, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), asyncImageRequestTimeout)
	replay, err := buildAsyncImageRequest(c.Request, body, context.WithValue(runContext, asyncImageRunContextKey{}, run))
	if err != nil {
		cancel()
		body.Close()
		logger.LogWarn(c, "async image declined: %s", err.Error())
		return false
	}
	payload, err := buildImageTaskPayload(task, imageTaskStatusURL(c.Request.URL.Path, task.TaskID))
	if err != nil {
		cancel()
		body.Close()
		logger.LogWarn(c, "async image declined: %s", err.Error())
		return false
	}
	if err := task.InsertWithContext(c.Request.Context()); err != nil {
		cancel()
		body.Close()
		logger.LogWarn(c, "async image declined: %s", err.Error())
		return false
	}

	gopool.Go(func() {
		defer cancel()
		finishContext := context.WithoutCancel(runContext)
		select {
		case asyncImageSlots <- struct{}{}:
		case <-runContext.Done():
			failAsyncImageTask(finishContext, task, "image task timed out while queued")
			return
		}
		defer func() { <-asyncImageSlots }()
		recorder := &asyncImageResponseRecorder{header: make(http.Header), limit: maxAsyncImageResultBytes()}
		asyncImageEngine().ServeHTTP(recorder, replay)
		finishAsyncImageTask(finishContext, task, run, recorder)
	})

	c.Data(http.StatusAccepted, "application/json", payload)
	return true
}

// detachAsyncImageBody copies the submitted body into storage the detached run
// owns. JSON bodies additionally lose the async marker and any streaming
// request: nobody observes the detached response, so partial-image events would
// only be buffered and discarded.
func detachAsyncImageBody(c *gin.Context) (common.BodyStorage, error) {
	storage, err := common.GetBodyStorage(c)
	if err != nil {
		return nil, err
	}
	if strings.Contains(c.Request.Header.Get("Content-Type"), "multipart/form-data") {
		reader, readerErr := storage.NewReader()
		if readerErr != nil {
			return nil, readerErr
		}
		defer reader.Close()
		return common.CreateBodyStorageFromReader(reader, storage.Size(), int64(constant.MaxRequestBodyMB)<<20)
	}
	data, err := storage.Bytes()
	if err != nil {
		return nil, err
	}
	data, err = sjson.DeleteBytes(data, "async")
	if err != nil {
		return nil, err
	}
	data, err = sjson.SetBytes(data, "stream", false)
	if err != nil {
		return nil, err
	}
	return common.CreateBodyStorage(data)
}

func buildAsyncImageRequest(original *http.Request, body common.BodyStorage, ctx context.Context) (*http.Request, error) {
	reader, err := body.NewReader()
	if err != nil {
		return nil, err
	}
	replay := original.Clone(ctx)
	replay.Body = reader
	replay.GetBody = body.NewReader
	replay.ContentLength = body.Size()
	// Stripping the async marker changes the body length, so the inbound header
	// must not keep contradicting ContentLength.
	replay.Header.Del("Content-Length")
	// Force a re-parse from the detached storage; the submitting request's
	// multipart temp files are removed as soon as it returns.
	replay.MultipartForm = nil
	replay.Form = nil
	replay.PostForm = nil
	// Strip every async marker so the replay cannot be accepted as a new
	// submission even if the context flag is ever lost.
	query := replay.URL.Query()
	query.Del("async")
	replay.URL.RawQuery = query.Encode()
	replay.Header.Del("Prefer")
	replay.Header.Del("X-Image-Async")
	return replay, nil
}

// finishAsyncImageTask records the detached outcome. The status guard keeps a
// task that the timeout sweeper already failed from being revived.
func finishAsyncImageTask(ctx context.Context, task *model.Task, run *asyncImageRun, recorder *asyncImageResponseRecorder) {
	fromStatus := task.Status
	task.Progress = "100%"
	task.FinishTime = time.Now().Unix()
	if run.channelID != 0 {
		task.ChannelId = run.channelID
	}
	if run != nil {
		if quota, ok := run.keys[string(constant.ContextKeyAsyncImageQuota)].(int); ok && quota >= 0 {
			task.Quota = quota
		}
	}

	result, err := asyncImageResult(recorder)
	if err != nil {
		task.Status = model.TaskStatusFailure
		task.FailReason = truncateAsyncImageText(err.Error())
	} else {
		task.Status = model.TaskStatusSuccess
		storedResult, imageIDs, persistErr := persistImageTaskArtifacts(ctx, task, result)
		if persistErr != nil {
			// Gallery storage is an optional durable copy. Keep the generated
			// response available when storage is disabled or full; the task still
			// represents a successful upstream generation.
			logger.LogWarn(ctx, fmt.Sprintf("persist async image artifacts for task %s failed: %v", task.TaskID, persistErr))
			task.Data = stripImageTaskBase64(result)
			task.PrivateData.ResultURL = firstAsyncImageURL(result)
		} else {
			task.Data = storedResult
			task.PrivateData.GalleryImageIDs = imageIDs
			task.PrivateData.ResultURL = firstAsyncImageURL(storedResult)
		}
	}

	won, updateErr := task.UpdateWithStatus(fromStatus)
	if updateErr != nil {
		logger.LogError(ctx, fmt.Sprintf("persist async image task %s failed: %v", task.TaskID, updateErr))
		return
	}
	if !won {
		logger.LogInfo(ctx, fmt.Sprintf("async image task %s already transitioned, skip result write", task.TaskID))
	}
}

func persistImageTaskArtifacts(ctx context.Context, task *model.Task, result json.RawMessage) (json.RawMessage, map[string]string, error) {
	if task == nil || task.UserId <= 0 {
		return nil, nil, errors.New("image task owner is invalid")
	}
	var response dto.ImageResponse
	if err := common.Unmarshal(result, &response); err != nil {
		return nil, nil, fmt.Errorf("decode image result: %w", err)
	}
	if len(response.Data) == 0 {
		return nil, nil, errors.New("image result contains no images")
	}

	imageIDs := make(map[string]string, len(response.Data))
	gallerySource := task.PrivateData.GallerySource
	if gallerySource == "" {
		gallerySource = "api"
	}
	published := false
	defer func() {
		if published {
			return
		}
		for _, imageID := range imageIDs {
			_ = service.DeleteGalleryImage(context.Background(), task.UserId, imageID)
		}
	}()

	sanitized := make([]dto.ImageData, len(response.Data))
	for index, item := range response.Data {
		artifactKey := fmt.Sprintf("image-%d", index)
		var galleryImage *model.GalleryImage
		var err error
		if strings.TrimSpace(item.B64Json) != "" {
			data, decodeErr := decodeAsyncImageBase64(item.B64Json)
			if decodeErr != nil {
				return nil, nil, decodeErr
			}
			galleryImage, err = service.SaveTaskGalleryImageWithSource(ctx, task.UserId, task.TaskID, artifactKey, gallerySource, task.Properties.OriginModelName, task.Properties.Input, "", bytes.NewReader(data))
		} else if strings.TrimSpace(item.Url) != "" {
			if data, isDataURL, decodeErr := decodeAsyncImageDataURL(item.Url); isDataURL {
				if decodeErr != nil {
					return nil, nil, decodeErr
				}
				galleryImage, err = service.SaveTaskGalleryImageWithSource(ctx, task.UserId, task.TaskID, artifactKey, gallerySource, task.Properties.OriginModelName, task.Properties.Input, "", bytes.NewReader(data))
			} else {
				galleryImage, err = service.SaveTaskGalleryImageFromURLWithSource(ctx, task.UserId, task.TaskID, artifactKey, gallerySource, task.Properties.OriginModelName, task.Properties.Input, item.Url)
			}
		} else {
			return nil, nil, fmt.Errorf("image result %s has no image data", artifactKey)
		}
		if err != nil {
			return nil, nil, fmt.Errorf("save %s: %w", artifactKey, err)
		}
		imageIDs[artifactKey] = galleryImage.ID
		contentURL, urlErr := service.BuildTaskArtifactContentURL(task.TaskID, artifactKey)
		if urlErr != nil {
			return nil, nil, urlErr
		}
		sanitized[index] = dto.ImageData{Url: contentURL, RevisedPrompt: item.RevisedPrompt}
	}

	encodedData, err := common.Marshal(sanitized)
	if err != nil {
		return nil, nil, err
	}
	sanitizedResult, err := sjson.SetRawBytes(bytes.Clone(result), "data", encodedData)
	if err != nil {
		return nil, nil, err
	}
	for index := range sanitized {
		sanitizedResult, err = sjson.DeleteBytes(sanitizedResult, "data."+strconv.Itoa(index)+".b64_json")
		if err != nil {
			return nil, nil, err
		}
	}
	published = true
	return json.RawMessage(sanitizedResult), imageIDs, nil
}

func decodeAsyncImageBase64(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > ((imageTaskArtifactMaxBytes+2)/3)*4+4 {
		return nil, errors.New("base64 image exceeds the gallery size limit")
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		data, err = base64.RawStdEncoding.DecodeString(value)
	}
	if err != nil || len(data) == 0 || len(data) > imageTaskArtifactMaxBytes {
		return nil, errors.New("invalid base64 image data")
	}
	return data, nil
}

func decodeAsyncImageDataURL(value string) ([]byte, bool, error) {
	if !strings.HasPrefix(strings.ToLower(value), "data:") {
		return nil, false, nil
	}
	header, payload, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(strings.ToLower(header), "data:image/") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return nil, true, errors.New("unsupported image data URL")
	}
	data, err := decodeAsyncImageBase64(payload)
	return data, true, err
}

func failAsyncImageTask(ctx context.Context, task *model.Task, reason string) {
	fromStatus := task.Status
	task.Status = model.TaskStatusFailure
	task.Progress = "100%"
	task.FinishTime = time.Now().Unix()
	task.FailReason = truncateAsyncImageText(reason)
	if _, err := task.UpdateWithStatus(fromStatus); err != nil {
		logger.LogError(ctx, fmt.Sprintf("fail async image task %s failed: %v", task.TaskID, err))
	}
}

// asyncImageResult normalizes a detached response into the provider JSON object
// stored on the task, or reports why the run cannot be stored.
func asyncImageResult(r *asyncImageResponseRecorder) (json.RawMessage, error) {
	if r.overflow {
		return nil, fmt.Errorf("image result exceeds the %d MB async limit, retry without async", r.limit>>20)
	}
	body := r.body.Bytes()
	if status := r.statusCode(); status != http.StatusOK {
		return nil, fmt.Errorf("upstream returned %d: %s", status, asyncImageErrorMessage(body))
	}
	if common.GetJsonType(body) == "object" {
		return json.RawMessage(bytes.Clone(body)), nil
	}
	if strings.HasPrefix(r.header.Get("Content-Type"), "text/event-stream") {
		return collapseAsyncImageStream(body)
	}
	return nil, fmt.Errorf("upstream returned an unsupported async image response")
}

func synchronousImageResult(w *imageResponseCaptureWriter) (json.RawMessage, error) {
	recorder := &asyncImageResponseRecorder{
		header:   w.Header().Clone(),
		body:     w.body,
		status:   w.Status(),
		limit:    w.limit,
		overflow: w.overflow,
	}
	return asyncImageResult(recorder)
}

func persistSynchronousImageTask(c *gin.Context, info *relaycommon.RelayInfo, request *dto.ImageRequest, result json.RawMessage) (*model.Task, error) {
	now := time.Now().Unix()
	task := &model.Task{
		TaskID:     model.GenerateTaskID(),
		Platform:   constant.TaskPlatformImage,
		UserId:     info.UserId,
		Group:      info.UsingGroup,
		ChannelId:  info.GetChannelID(),
		Action:     imageTaskAction(info.RelayMode),
		Status:     model.TaskStatusSuccess,
		Progress:   "100%",
		SubmitTime: now,
		StartTime:  now,
		FinishTime: now,
		Properties: model.Properties{Input: request.Prompt, OriginModelName: info.OriginModelName, UpstreamModelName: info.UpstreamModelName},
		PrivateData: model.TaskPrivateData{
			NodeName: common.NodeName,
		},
		Quota: common.GetContextKeyInt(c, constant.ContextKeyAsyncImageQuota),
	}
	if task.Properties.UpstreamModelName == "" {
		task.Properties.UpstreamModelName = info.OriginModelName
	}
	task.PrivateData.GallerySource = imageTaskGallerySource(info, request)
	storedResult, imageIDs, err := persistImageTaskArtifacts(c.Request.Context(), task, result)
	if err != nil {
		logger.LogWarn(c, fmt.Sprintf("persist synchronous image artifacts for task %s failed: %v", task.TaskID, err))
		task.Data = stripImageTaskBase64(result)
	} else {
		task.Data = storedResult
		task.PrivateData.GalleryImageIDs = imageIDs
		task.PrivateData.ResultURL = firstAsyncImageURL(storedResult)
	}
	if err = task.InsertWithContext(c.Request.Context()); err != nil {
		for _, imageID := range imageIDs {
			_ = service.DeleteGalleryImage(context.Background(), task.UserId, imageID)
		}
		return nil, err
	}
	return task, nil
}

func stripImageTaskBase64(result json.RawMessage) json.RawMessage {
	var response dto.ImageResponse
	if err := common.Unmarshal(result, &response); err != nil {
		return json.RawMessage(`{"data":[]}`)
	}
	for index := range response.Data {
		response.Data[index].B64Json = ""
	}
	encoded, err := common.Marshal(response)
	if err != nil {
		return json.RawMessage(`{"data":[]}`)
	}
	for index := range response.Data {
		encoded, err = sjson.DeleteBytes(encoded, "data."+strconv.Itoa(index)+".b64_json")
		if err != nil {
			return json.RawMessage(`{"data":[]}`)
		}
	}
	return json.RawMessage(encoded)
}

// collapseAsyncImageStream folds a streamed image response into the same object
// a non-streaming provider returns. Partial-image events are dropped: no client
// is attached to the detached run, so only completed images are durable.
func collapseAsyncImageStream(body []byte) (json.RawMessage, error) {
	type streamEvent struct {
		Type         string          `json:"type"`
		B64Json      string          `json:"b64_json"`
		Url          string          `json:"url"`
		RevisedPromt string          `json:"revised_prompt"`
		OutputFormat string          `json:"output_format"`
		Usage        json.RawMessage `json:"usage"`
	}
	response := dto.ImageResponse{Data: []dto.ImageData{}, Created: time.Now().Unix()}
	var usage json.RawMessage
	for block := range bytes.SplitSeq(body, []byte("\n")) {
		payload, ok := bytes.CutPrefix(bytes.TrimRight(block, "\r"), []byte("data:"))
		if !ok {
			continue
		}
		payload = bytes.TrimSpace(payload)
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}
		var event streamEvent
		if err := common.Unmarshal(payload, &event); err != nil {
			continue
		}
		if !strings.HasSuffix(event.Type, ".completed") {
			continue
		}
		response.Data = append(response.Data, dto.ImageData{
			Url:           event.Url,
			B64Json:       event.B64Json,
			RevisedPrompt: event.RevisedPromt,
		})
		if len(event.Usage) > 0 {
			usage = event.Usage
		}
	}
	if len(response.Data) == 0 {
		return nil, fmt.Errorf("the image stream ended before generation completed")
	}
	encoded, err := common.Marshal(response)
	if err != nil {
		return nil, err
	}
	if len(usage) > 0 {
		encoded, err = sjson.SetRawBytes(encoded, "usage", usage)
		if err != nil {
			return nil, err
		}
	}
	return json.RawMessage(encoded), nil
}

func asyncImageErrorMessage(body []byte) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := common.Unmarshal(body, &payload); err == nil && payload.Error.Message != "" {
		return payload.Error.Message
	}
	return strings.TrimSpace(string(body))
}

func firstAsyncImageURL(body json.RawMessage) string {
	var response dto.ImageResponse
	if err := common.Unmarshal(body, &response); err != nil {
		return ""
	}
	for _, item := range response.Data {
		if item.Url != "" {
			return item.Url
		}
	}
	return ""
}

func truncateAsyncImageText(text string) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) <= maxAsyncImageFailReason {
		return text
	}
	return string(runes[:maxAsyncImageFailReason]) + "..."
}

// ImageTaskFetch returns one async image task to its owner. A finished task
// answers with the provider payload it produced, extended with the task fields,
// so a client can reuse the same response parser it uses for sync generation.
func ImageTaskFetch(c *gin.Context) {
	taskID := c.Param("task_id")
	userID := common.GetContextKeyInt(c, constant.ContextKeyUserId)
	task, exist, err := model.GetByTaskId(userID, taskID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": types.OpenAIError{Message: "failed to query image task", Type: "new_api_error", Code: "query_data_error"},
		})
		return
	}
	if !exist || task.Platform != constant.TaskPlatformImage {
		c.JSON(http.StatusNotFound, gin.H{
			"error": types.OpenAIError{Message: "image task not found", Type: "invalid_request_error", Code: "task_not_found"},
		})
		return
	}
	payload, err := buildImageTaskPayload(task, c.Request.URL.Path)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": types.OpenAIError{Message: "failed to render image task", Type: "new_api_error", Code: "bad_response_body"},
		})
		return
	}
	c.Data(http.StatusOK, "application/json", payload)
}

func buildImageTaskPayload(task *model.Task, statusURL string) ([]byte, error) {
	status := imageTaskStatus(string(task.Status))
	payload := []byte(`{"data":[]}`)
	if status == imageTaskStatusCompleted && common.GetJsonType(task.Data) == "object" {
		payload = bytes.Clone(task.Data)
	}

	fields := []struct {
		path  string
		value any
	}{
		{"task_id", task.TaskID},
		{"status", status},
		{"progress", asyncImageProgress(task.Progress)},
		{"status_url", statusURL},
		{"created_at", task.SubmitTime},
		{"model", task.Properties.OriginModelName},
	}
	var err error
	for _, field := range fields {
		payload, err = sjson.SetBytes(payload, field.path, field.value)
		if err != nil {
			return nil, err
		}
	}
	if status == imageTaskStatusFailed {
		payload, err = sjson.SetBytes(payload, "error", types.OpenAIError{
			Message: task.FailReason,
			Type:    "upstream_error",
			Code:    "image_task_failed",
		})
		if err != nil {
			return nil, err
		}
	}
	return payload, nil
}

func asyncImageProgress(progress string) int {
	value, err := strconv.Atoi(strings.TrimSuffix(strings.TrimSpace(progress), "%"))
	if err != nil || value < 0 {
		return 0
	}
	return min(value, 100)
}

package controller

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"net/http"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/bytedance/gopkg/util/gopool"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
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
)

// asyncImageRequestTimeout bounds one detached generation. constant.TaskTimeoutMinutes
// sweeps whatever outlives it, so this stays well below that sweep.
const asyncImageRequestTimeout = 10 * time.Minute

// asyncImagePluginRunMargin is the time a plugin-served run keeps beyond the
// plugin's wait for its vendor task, for submission and presenting the result.
const asyncImagePluginRunMargin = 2 * time.Minute

// imageTaskPersistTimeout bounds recording a synchronous result, including
// downloading URL results into the gallery.
const imageTaskPersistTimeout = 2 * time.Minute

// imageTaskArtifactMaxBytes is the largest single image a task keeps. The
// drawing page offers 4K sizes, and a detailed 4K PNG lands at 15–40 MB.
const imageTaskArtifactMaxBytes = 48 << 20

// asyncImageInlineImageBudget is the room one inline image takes in a buffered
// result: the base64 form of the largest image a task keeps, plus the JSON
// around it.
const asyncImageInlineImageBudget = ((imageTaskArtifactMaxBytes+2)/3)*4 + 64<<10

// imageResultMaxBudget bounds the buffered copy of any one response however
// many images it asks for, which also keeps the budget within int everywhere.
const imageResultMaxBudget = 1 << 30

// imageResultBudget caps the buffered copy of one provider response. Inline
// base64 is the only payload that grows with the requested images, so each one
// gets room for the largest image a task keeps: a 4K render is stored instead
// of failing after the upstream call was already charged. The buffer grows only
// as the response arrives, and it is never persisted as-is —
// persistImageTaskArtifacts swaps base64 for gallery URLs and
// stripImageTaskBase64 drops inline payloads on the fallback.
//
// URL results carry no image bytes and keep the floor. MySQL's default
// max_allowed_packet is 4 MB on 5.7, so a MySQL deployment keeps the tighter
// floor.
func imageResultBudget(request *dto.ImageRequest) int {
	floor := 8 << 20
	if common.UsingMainDatabase(common.DatabaseTypeMySQL) {
		floor = 3 << 20
	}
	if request == nil || strings.EqualFold(request.ResponseFormat, "url") {
		return floor
	}
	count := uint64(1)
	if request.N != nil && *request.N > 0 {
		// n is bounded at validation, but this runs on the raw *uint, where a
		// wrapped negative arrives as a huge positive and would overflow the
		// multiply into a negative budget.
		count = min(uint64(*request.N), uint64(dto.MaxImageN))
	}
	return int(min(count*asyncImageInlineImageBudget, imageResultMaxBudget))
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

// asyncImageQueueTimeoutReason is the failure of a task that never got a free
// upstream slot.
const asyncImageQueueTimeoutReason = "image task timed out while queued"

// imageTaskIDHeader lets a caller name the task its image request creates. A
// caller that loses the reply to its submission, as behind a proxy error page,
// then still knows where the task is, instead of reporting a failure while the
// image is generated and billed anyway.
const imageTaskIDHeader = "X-Image-Task-Id"

// proposedImageTaskIDKey carries an accepted caller-chosen task ID from the
// submission check to wherever the task row is created.
const proposedImageTaskIDKey = "proposed_image_task_id"

// imageTaskIDPattern is the shape of a task ID the gateway generates itself.
var imageTaskIDPattern = regexp.MustCompile(`^task_[0-9A-Za-z]{32}$`)

// Kinds of image task failure, named for what the owner can do about each.
const (
	imageFailureContentPolicy = "content_policy"
	imageFailureTimeout       = "timeout"
	imageFailureUnavailable   = "unavailable"
	imageFailureTaskLost      = "task_lost"
	imageFailureQueueTimeout  = "queue_timeout"
	imageFailureInterrupted   = "interrupted"
	imageFailureTooLarge      = "result_too_large"
	imageFailureOther         = "other"
)

// imageTaskFailure is one cause of a failed image task. Message is the
// provider's own explanation, kept only when it is the reason itself rather
// than proxy boilerplate the kind already says better.
type imageTaskFailure struct {
	Kind    string `json:"kind"`
	Status  int    `json:"status,omitempty"`
	Message string `json:"message,omitempty"`
}

// imageAttemptFailuresKey collects why each relay attempt of an image request
// failed. A failed task reports all of them: the first provider's refusal is
// often the reason, and a retry elsewhere only adds a timeout on top.
const imageAttemptFailuresKey = "image_attempt_failures"

// maxImageTaskFailures bounds the causes one task keeps.
const maxImageTaskFailures = 8

var (
	imageRefusalCodes = []string{"content_policy_violation", "moderation_blocked", "content_filter", "sensitive_words_detected"}
	imageRefusalWords = []string{"安全风险", "违规", "违禁", "敏感", "审核", "更换提示词", "safety", "moderation", "content policy", "content_policy"}
	imageTimeoutWords = []string{"timeout", "timed out", "deadline exceeded", "超时"}
	// requestIDSuffix is what the relay appends to the message it answers with.
	requestIDSuffix = regexp.MustCompile(`\s*\(request id: [^)]*\)\s*$`)
	// upstreamFailureReason is how a failed task's reason quotes the answer it got.
	upstreamFailureReason = regexp.MustCompile(`(?s)^upstream returned (\d{3}): (.*)$`)
)

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

// shouldRecordSynchronousImageTask reports whether this request has to leave a
// task record behind once it answers. A caller waiting on an inline image gets
// one so the result is still reachable afterwards. A caller who asked for a
// task already has one, and so does an accepted task being carried out in the
// background — recording that replay would duplicate the task it is running,
// down to the artifacts, with no time elapsed between submission and finish.
func shouldRecordSynchronousImageTask(c *gin.Context, request *dto.ImageRequest) bool {
	return !isAsyncImageRequest(c, request) && !c.GetBool(asyncImageRunningKey)
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
	keys       map[string]any
	channelID  int
	pluginTask *pluginImageTaskRef
	// failures holds why each relay attempt failed, in order.
	failures []imageTaskFailure
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
				// A model a task plugin serves is generated by that plugin; every
				// other model goes through the ordinary relay.
				RelayTaskPluginEndpoint(c, func(c *gin.Context) { Relay(c, types.RelayFormatOpenAIImage) })
				if run := asyncImageRunFromRequest(c); run != nil {
					run.channelID = c.GetInt("channel_id")
					run.keys[string(constant.ContextKeyAsyncImageQuota)] = common.GetContextKeyInt(c, constant.ContextKeyAsyncImageQuota)
					run.pluginTask = pluginImageTaskFromContext(c)
					run.failures, _ = c.Value(imageAttemptFailuresKey).([]imageTaskFailure)
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
// most imageResultBudget bytes; anything larger marks the run as overflowing so
// the task fails instead of persisting an oversized row.
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

// imageTaskGallerySource names where an image came from. The drawing page
// generates with every model family, so any playground image is a drawing
// image; "nai" remains only on images saved before the NAI page merged into it.
func imageTaskGallerySource(info *relaycommon.RelayInfo, _ *dto.ImageRequest) string {
	if info == nil || !info.IsPlayground {
		return "api"
	}
	return "drawing"
}

// acceptProposedImageTaskID checks the task ID a caller chose for its image
// request. It must look like one the gateway generates and must not name any
// existing task: task IDs are not unique in the database, and some reads find a
// task by its ID alone. The replay of an accepted task created its row already.
func acceptProposedImageTaskID(c *gin.Context) *types.NewAPIError {
	proposed := strings.TrimSpace(c.GetHeader(imageTaskIDHeader))
	if proposed == "" || c.GetBool(asyncImageRunningKey) {
		return nil
	}
	if !imageTaskIDPattern.MatchString(proposed) {
		return types.NewErrorWithStatusCode(errors.New("image task id must be task_ followed by 32 letters or digits"), types.ErrorCodeInvalidRequest, http.StatusBadRequest, types.ErrOptionWithSkipRetry())
	}
	_, exists, err := model.GetByOnlyTaskId(proposed)
	if err != nil {
		return types.NewErrorWithStatusCode(err, types.ErrorCodeQueryDataError, http.StatusInternalServerError, types.ErrOptionWithSkipRetry())
	}
	if exists {
		return types.NewErrorWithStatusCode(errors.New("image task id is already in use"), types.ErrorCodeInvalidRequest, http.StatusConflict, types.ErrOptionWithSkipRetry())
	}
	c.Set(proposedImageTaskIDKey, proposed)
	return nil
}

// imageTaskID names the task this request creates: the one its caller chose,
// or a fresh one.
func imageTaskID(c *gin.Context) string {
	if proposed := c.GetString(proposedImageTaskIDKey); proposed != "" {
		return proposed
	}
	return model.GenerateTaskID()
}

// submitAsyncImageTask persists the task, hands the request to a detached
// replay, and answers the caller with the task handle. It runs before
// pre-consume: the detached relay owns the entire billing lifecycle.
//
// Accepting a task is best effort. Every failure here reports false so the
// caller finishes the request on the ordinary synchronous path; nothing is
// persisted and no quota is touched until the task is actually accepted.
func submitAsyncImageTask(c *gin.Context, info *relaycommon.RelayInfo, request *dto.ImageRequest) bool {
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
		TaskID:     imageTaskID(c),
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

	runTimeout := asyncImageRequestTimeout
	if _, pluginServed := c.Get(pluginruntime.ContextKeyPinnedEndpoint); pluginServed {
		// A plugin waits for its vendor task inside the request for up to the
		// protocol timeout. The run has to outlast that wait, or a task the
		// vendor finishes late is settled without its images reaching this task.
		runTimeout = max(runTimeout, defaultPluginProtocolBridgeDeps().submissionTimeout+asyncImagePluginRunMargin)
	}
	runContext, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), runTimeout)
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
			failAsyncImageTask(finishContext, task, asyncImageQueueTimeoutReason)
			return
		}
		defer func() { <-asyncImageSlots }()
		recorder := &asyncImageResponseRecorder{header: make(http.Header), limit: imageResultBudget(request)}
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
	// Strip every async marker, and the task name the submission was accepted
	// under, so the replay cannot be accepted as a new submission even if the
	// context flag is ever lost.
	query := replay.URL.Query()
	query.Del("async")
	replay.URL.RawQuery = query.Encode()
	replay.Header.Del("Prefer")
	replay.Header.Del("X-Image-Async")
	replay.Header.Del(imageTaskIDHeader)
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
		task.Data = imageTaskFailureData(run, recorder, err)
		if run.pluginTask != nil && run.pluginTask.Success {
			// The plugin task keeps its charge and its images visible, so this
			// failure must not show the same charge a second time.
			task.Quota = 0
		}
	} else {
		task.Status = model.TaskStatusSuccess
		storedResult, imageIDs, persistErr := persistImageTaskArtifacts(ctx, task, result)
		if persistErr != nil {
			// Gallery storage is an optional durable copy. Keep the generated
			// response available when storage is disabled or full; the task still
			// represents a successful upstream generation.
			logger.LogWarn(ctx, fmt.Sprintf("persist async image artifacts for task %s failed: %v", task.TaskID, persistErr))
			task.Data = stripImageTaskBase64(result)
			// Only a real link: an inline data URL here is the whole image again.
			task.PrivateData.ResultURL = firstAsyncImageURL(task.Data)
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
		return
	}
	adoptPluginImageTask(ctx, run.pluginTask, task.TaskID, task.Status == model.TaskStatusSuccess)
}

func persistImageTaskArtifacts(ctx context.Context, task *model.Task, result json.RawMessage) (json.RawMessage, map[string]string, error) {
	if task == nil || task.UserId <= 0 {
		return nil, nil, errors.New("image task owner is invalid")
	}
	// Each image is read out of the result on its own and decoded straight into
	// the gallery. Decoding the whole response would hold every image a second
	// time, and a 4K PNG alone runs to tens of megabytes.
	if !gjson.ValidBytes(result) {
		return nil, nil, errors.New("decode image result: invalid JSON")
	}
	count := int(gjson.GetBytes(result, "data.#").Int())
	if count == 0 {
		return nil, nil, errors.New("image result contains no images")
	}

	imageIDs := make(map[string]string, count)
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

	sanitized := make([]dto.ImageData, count)
	for index := range count {
		artifactKey := fmt.Sprintf("image-%d", index)
		item := "data." + strconv.Itoa(index)
		inline := strings.TrimSpace(gjson.GetBytes(result, item+".b64_json").String())
		link := strings.TrimSpace(gjson.GetBytes(result, item+".url").String())
		var galleryImage *model.GalleryImage
		var err error
		if inline != "" {
			content, decodeErr := asyncImageBase64Reader(inline)
			if decodeErr != nil {
				return nil, nil, decodeErr
			}
			galleryImage, err = service.SaveTaskGalleryImageWithSource(ctx, task.UserId, task.TaskID, artifactKey, gallerySource, task.Properties.OriginModelName, task.Properties.Input, "", content)
		} else if link != "" {
			if content, isDataURL, decodeErr := asyncImageDataURLReader(link); isDataURL {
				if decodeErr != nil {
					return nil, nil, decodeErr
				}
				galleryImage, err = service.SaveTaskGalleryImageWithSource(ctx, task.UserId, task.TaskID, artifactKey, gallerySource, task.Properties.OriginModelName, task.Properties.Input, "", content)
			} else {
				galleryImage, err = service.SaveTaskGalleryImageFromURLWithSource(ctx, task.UserId, task.TaskID, artifactKey, gallerySource, task.Properties.OriginModelName, task.Properties.Input, link)
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
		sanitized[index] = dto.ImageData{Url: contentURL, RevisedPrompt: gjson.GetBytes(result, item+".revised_prompt").String()}
	}

	encodedData, err := common.Marshal(sanitized)
	if err != nil {
		return nil, nil, err
	}
	// sjson builds a new document and leaves the result as it is.
	sanitizedResult, err := sjson.SetRawBytes(result, "data", encodedData)
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

// asyncImageBase64Reader decodes one inline image while the gallery copies it,
// so the decoded image never sits in memory beside its base64 form. Providers
// pad the encoding or leave the padding off, and a streaming decoder has to be
// told which: an unpadded length that is not a multiple of four is raw.
func asyncImageBase64Reader(value string) (io.Reader, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > base64.StdEncoding.EncodedLen(imageTaskArtifactMaxBytes)+4 {
		return nil, errors.New("base64 image exceeds the gallery size limit")
	}
	encoding := base64.StdEncoding
	if (len(value)-strings.Count(value, "\n")-strings.Count(value, "\r"))%4 != 0 {
		encoding = base64.RawStdEncoding
	}
	return base64.NewDecoder(encoding, strings.NewReader(value)), nil
}

func asyncImageDataURLReader(value string) (io.Reader, bool, error) {
	if len(value) < len("data:") || !strings.EqualFold(value[:len("data:")], "data:") {
		return nil, false, nil
	}
	header, payload, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(strings.ToLower(header), "data:image/") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return nil, true, errors.New("unsupported image data URL")
	}
	content, err := asyncImageBase64Reader(payload)
	return content, true, err
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

// classifyImageFailure sorts one failure by what its owner can do about it: a
// refused prompt, a timeout, an unavailable provider, a provider that lost the
// task, or anything else.
func classifyImageFailure(status int, code, message string) imageTaskFailure {
	message = strings.TrimSpace(requestIDSuffix.ReplaceAllString(message, ""))
	lower := strings.ToLower(message)
	mentions := func(words []string) bool {
		return slices.ContainsFunc(words, func(word string) bool { return strings.Contains(lower, word) })
	}
	failure := imageTaskFailure{Status: status}
	switch {
	case slices.Contains(imageRefusalCodes, code) || mentions(imageRefusalWords):
		failure.Kind, failure.Message = imageFailureContentPolicy, truncateAsyncImageText(message)
	case status == http.StatusRequestTimeout || status == http.StatusGatewayTimeout || status == 524 || mentions(imageTimeoutWords):
		failure.Kind = imageFailureTimeout
	case status == http.StatusNotFound && strings.Contains(lower, "task not found"):
		failure.Kind = imageFailureTaskLost
	case status == http.StatusTooManyRequests || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || (status >= 520 && status <= 527):
		failure.Kind = imageFailureUnavailable
	default:
		failure.Kind, failure.Message = imageFailureOther, truncateAsyncImageText(message)
	}
	return failure
}

// recordImageAttemptFailure notes why one relay attempt of an image request
// failed, in the words that attempt would have answered with. A repeat of the
// cause just before it adds nothing.
func recordImageAttemptFailure(c *gin.Context, err *types.NewAPIError) {
	shown := err.ToOpenAIError()
	code := ""
	if shown.Code != nil {
		code = fmt.Sprint(shown.Code)
	}
	failure := classifyImageFailure(err.StatusCode, code, shown.Message)
	failures, _ := c.Value(imageAttemptFailuresKey).([]imageTaskFailure)
	if len(failures) >= maxImageTaskFailures || (len(failures) > 0 && failures[len(failures)-1] == failure) {
		return
	}
	c.Set(imageAttemptFailuresKey, append(failures, failure))
}

// imageTaskFailureData records why a finished image task failed. A relay that
// answered with an error failed every attempt it made, so each attempt's cause
// is kept in order; any other failure lies in the answer itself.
func imageTaskFailureData(run *asyncImageRun, recorder *asyncImageResponseRecorder, err error) json.RawMessage {
	var failures []imageTaskFailure
	status := recorder.statusCode()
	switch {
	case recorder.overflow:
		failures = []imageTaskFailure{{Kind: imageFailureTooLarge}}
	case status != http.StatusOK && len(run.failures) > 0:
		failures = run.failures
	case status != http.StatusOK:
		failures = []imageTaskFailure{classifyImageFailure(status, "", asyncImageErrorMessage(recorder.body.Bytes()))}
	default:
		failures = []imageTaskFailure{classifyImageFailure(0, "", err.Error())}
	}
	data, marshalErr := common.Marshal(map[string][]imageTaskFailure{"failure_reasons": failures})
	if marshalErr != nil {
		return nil
	}
	return data
}

// asyncImageResult normalizes a detached response into the provider JSON object
// stored on the task, or reports why the run cannot be stored.
func asyncImageResult(r *asyncImageResponseRecorder) (json.RawMessage, error) {
	if r.overflow {
		return nil, fmt.Errorf("image result exceeds the %d MB an image task can keep", r.limit>>20)
	}
	body := r.body.Bytes()
	if status := r.statusCode(); status != http.StatusOK {
		return nil, fmt.Errorf("upstream returned %d: %s", status, asyncImageErrorMessage(body))
	}
	if common.GetJsonType(body) == "object" {
		// Nothing writes to the recorder any more, so the result shares its
		// buffer instead of holding every image a second time.
		return json.RawMessage(body), nil
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

// pluginImageTaskKey carries the task a plugin ran for an image request, so the
// image task that presents the images records its charge and adopts it.
const pluginImageTaskKey = "plugin_image_task"

// pluginImageTaskRef is recorded only once the plugin task is terminal: an
// unfinished task may still be completed by the poller and must stay visible.
type pluginImageTaskRef struct {
	TaskID  string
	Success bool
}

func pluginImageTaskFromContext(c *gin.Context) *pluginImageTaskRef {
	ref, _ := c.Value(pluginImageTaskKey).(*pluginImageTaskRef)
	return ref
}

// adoptPluginImageTask hides the plugin task behind the image task that shows
// its outcome, so task lists carry one record per request. A plugin task that
// succeeded stays visible when the image task could not present its images, so
// a charge never disappears behind a failure.
func adoptPluginImageTask(ctx context.Context, ref *pluginImageTaskRef, parentTaskID string, parentSucceeded bool) {
	if ref == nil || (ref.Success && !parentSucceeded) {
		return
	}
	if err := model.SetTaskParent(ctx, ref.TaskID, parentTaskID); err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("adopt plugin task %s into image task %s failed: %v", ref.TaskID, parentTaskID, err))
	}
}

// captureSynchronousImageTask starts retaining the image response a caller
// waits for. The returned function records that response as a completed task
// once it is final; it is nil when this request leaves no record of its own.
func captureSynchronousImageTask(c *gin.Context, info *relaycommon.RelayInfo, request *dto.ImageRequest) func(succeeded bool) {
	if !shouldRecordSynchronousImageTask(c, request) {
		return nil
	}
	originalWriter := c.Writer
	capture := &imageResponseCaptureWriter{
		ResponseWriter: originalWriter,
		limit:          imageResultBudget(request),
	}
	c.Writer = capture
	return func(succeeded bool) {
		c.Writer = originalWriter
		if !succeeded || !capture.Written() {
			return
		}
		result, err := synchronousImageResult(capture)
		if err != nil {
			logger.LogWarn(c, fmt.Sprintf("persist synchronous image task skipped: %v", err))
			return
		}
		task, err := persistSynchronousImageTask(c, info, request, result)
		if err != nil {
			logger.LogWarn(c, fmt.Sprintf("persist synchronous image task failed: %v", err))
			return
		}
		adoptPluginImageTask(context.WithoutCancel(c.Request.Context()), pluginImageTaskFromContext(c), task.TaskID, true)
	}
}

// serveTaskPluginImageTask gives an image request a task plugin serves the same
// async handling, task record and gallery copy as a relayed image request. The
// plugin generates and bills the images; this layer only presents them.
func serveTaskPluginImageTask(c *gin.Context, pinned pluginruntime.PinnedEndpoint, deps pluginProtocolBridgeDeps) {
	if apiErr := acceptProposedImageTaskID(c); apiErr != nil {
		c.JSON(apiErr.StatusCode, gin.H{"error": apiErr.ToOpenAIError()})
		return
	}
	info, request := pluginImageTaskRequest(c, pinned)
	if isAsyncImageRequest(c, request) && submitAsyncImageTask(c, info, request) {
		return
	}
	recordImageTask := captureSynchronousImageTask(c, info, request)
	serveTaskPluginImageProtocol(c, pinned, deps)
	if recordImageTask == nil {
		return
	}
	// A retried submission may have finished on another channel.
	info.ChannelId = c.GetInt("channel_id")
	recordImageTask(c.Writer.Status() == http.StatusOK)
}

// pluginImageTaskRequest describes a plugin-served image request in the terms
// the image task layer records. Prompt and count come from the request the
// plugin decoded and bills; the response format and the async flag are gateway
// concerns the plugin never sees, so they come from the client body.
func pluginImageTaskRequest(c *gin.Context, pinned pluginruntime.PinnedEndpoint) (*relaycommon.RelayInfo, *dto.ImageRequest) {
	request := &dto.ImageRequest{Model: pinned.Model, Extra: map[string]json.RawMessage{}}
	if decoded, ok := c.Value("task_request").(map[string]any); ok {
		request.Prompt, _ = decoded["prompt"].(string)
		// The count only sizes the response buffer; the plugin bounds and
		// bills the real quantity.
		var count uint
		switch n := decoded["n"].(type) {
		case int64:
			if n > 0 {
				count = uint(min(n, int64(dto.MaxImageN)))
			}
		case float64:
			if n > 0 && math.Trunc(n) == n {
				count = uint(min(n, float64(dto.MaxImageN)))
			}
		}
		if count > 0 {
			request.N = &count
		}
	}
	if protocolRequest, ok := c.Value(pluginruntime.ContextKeyProtocolRequest).(pluginruntime.ProtocolRequestContext); ok {
		body, _ := protocolRequest.Body.(map[string]any)
		clientField := func(name string) any {
			if value, ok := body["value"].(map[string]any); ok {
				return value[name]
			}
			if fields, ok := body["fields"].(map[string][]string); ok && len(fields[name]) > 0 {
				return fields[name][0]
			}
			return nil
		}
		request.ResponseFormat, _ = clientField("response_format").(string)
		switch async := clientField("async").(type) {
		case bool:
			request.Extra["async"] = json.RawMessage(strconv.FormatBool(async))
		case string:
			if enabled, err := strconv.ParseBool(async); err == nil {
				request.Extra["async"] = json.RawMessage(strconv.FormatBool(enabled))
			}
		}
	}
	relayMode := relayconstant.RelayModeImagesGenerations
	if pinned.Operation.Name == "edit" {
		relayMode = relayconstant.RelayModeImagesEdits
	}
	info := &relaycommon.RelayInfo{
		UserId:          c.GetInt("id"),
		UsingGroup:      common.GetContextKeyString(c, constant.ContextKeyUsingGroup),
		OriginModelName: pinned.Model,
		RelayMode:       relayMode,
		IsPlayground:    strings.HasPrefix(c.Request.URL.Path, "/pg"),
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelId:         c.GetInt("channel_id"),
			UpstreamModelName: cmp.Or(pinned.MappedModel, pinned.Model),
		},
	}
	return info, request
}

func persistSynchronousImageTask(c *gin.Context, info *relaycommon.RelayInfo, request *dto.ImageRequest, result json.RawMessage) (*model.Task, error) {
	now := time.Now().Unix()
	task := &model.Task{
		TaskID:     imageTaskID(c),
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
	// The response is already written, and a client commonly closes the
	// connection as soon as it has its images. The record of work it was
	// charged for must not depend on that connection.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), imageTaskPersistTimeout)
	defer cancel()
	storedResult, imageIDs, err := persistImageTaskArtifacts(ctx, task, result)
	if err != nil {
		logger.LogWarn(c, fmt.Sprintf("persist synchronous image artifacts for task %s failed: %v", task.TaskID, err))
		task.Data = stripImageTaskBase64(result)
	} else {
		task.Data = storedResult
		task.PrivateData.GalleryImageIDs = imageIDs
		task.PrivateData.ResultURL = firstAsyncImageURL(storedResult)
	}
	if err = task.InsertWithContext(ctx); err != nil {
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
		// A provider may inline the image in the url field instead. That
		// payload is as large as b64_json, and this fallback is what reaches
		// the task row, so it cannot be carried over either.
		if strings.HasPrefix(strings.ToLower(response.Data[index].Url), "data:") {
			response.Data[index].Url = ""
		}
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
		reasons, err := common.Marshal(imageTaskFailures(task))
		if err != nil {
			return nil, err
		}
		payload, err = sjson.SetRawBytes(payload, "failure_reasons", reasons)
		if err != nil {
			return nil, err
		}
	}
	return payload, nil
}

// imageTaskFailures lists why a failed image task failed. A task this gateway
// finished records its causes; one that failed without recording any, or before
// causes were recorded at all, is read from its failure reason.
func imageTaskFailures(task *model.Task) []imageTaskFailure {
	var recorded struct {
		FailureReasons []imageTaskFailure `json:"failure_reasons"`
	}
	if common.GetJsonType(task.Data) == "object" && common.Unmarshal(task.Data, &recorded) == nil && len(recorded.FailureReasons) > 0 {
		return recorded.FailureReasons
	}
	reason := strings.TrimSpace(task.FailReason)
	switch {
	case reason == "":
		return []imageTaskFailure{}
	case reason == service.ImageTaskInterruptedReason:
		return []imageTaskFailure{{Kind: imageFailureInterrupted}}
	case reason == asyncImageQueueTimeoutReason:
		return []imageTaskFailure{{Kind: imageFailureQueueTimeout}}
	case strings.HasPrefix(reason, "image result exceeds"):
		return []imageTaskFailure{{Kind: imageFailureTooLarge}}
	}
	if quoted := upstreamFailureReason.FindStringSubmatch(reason); quoted != nil {
		status, _ := strconv.Atoi(quoted[1])
		return []imageTaskFailure{classifyImageFailure(status, "", quoted[2])}
	}
	return []imageTaskFailure{classifyImageFailure(0, "", reason)}
}

func asyncImageProgress(progress string) int {
	value, err := strconv.Atoi(strings.TrimSuffix(strings.TrimSpace(progress), "%"))
	if err != nil || value < 0 {
		return 0
	}
	return min(value, 100)
}

package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

type contentAuditConfigSnapshot struct {
	state   model.ContentAuditStorageState
	expires int64
	ready   bool
}

type contentAuditRuntime struct {
	processID       string
	store           atomic.Pointer[contentAuditStore]
	snapshot        atomic.Pointer[contentAuditConfigSnapshot]
	memory          contentAuditMemory
	active          atomic.Int64
	captured        atomic.Int64
	saved           atomic.Int64
	partial         atomic.Int64
	dropped         atomic.Int64
	queueDrops      atomic.Int64
	memoryDrops     atomic.Int64
	admissionDrops  atomic.Int64
	storageDrops    atomic.Int64
	shutdownDrops   atomic.Int64
	imageFailures   atomic.Int64
	lastWarning     int64
	queue           chan *contentAuditJob
	stopping        atomic.Bool
	cancel          context.CancelFunc
	workers         sync.WaitGroup
	refreshMu       sync.Mutex
	ioMu            sync.RWMutex
	activeAttempts  sync.Map
	readersMu       sync.Mutex
	originalReaders map[string]int
	originalCleanup map[string]bool
	recoveredStore  string
	maintenanceWake chan struct{}
}

var contentAuditEngine = &contentAuditRuntime{processID: contentAuditRandomID(), queue: make(chan *contentAuditJob, 64), maintenanceWake: make(chan struct{}, 1)}
var contentAuditStartOnce sync.Once

type ContentAuditImageView struct {
	Index          int    `json:"index"`
	Address        string `json:"address,omitempty"`
	Status         string `json:"status"`
	MIME           string `json:"mime,omitempty"`
	Width          int    `json:"width,omitempty"`
	Height         int    `json:"height,omitempty"`
	OriginalStatus string `json:"original_status"`
	OriginalMIME   string `json:"original_mime,omitempty"`
	OriginalBytes  int64  `json:"original_bytes,omitempty"`
}

type ContentAuditImagePage struct {
	Items     []ContentAuditImageView `json:"items"`
	NextAfter *int                    `json:"next_after"`
	Total     int64                   `json:"total"`
}

type ContentAuditPayload struct {
	Request           json.RawMessage         `json:"request"`
	Response          json.RawMessage         `json:"response"`
	Images            []ContentAuditImageView `json:"images"`
	ResponseText      string                  `json:"response_text,omitempty"`
	TextViewTruncated bool                    `json:"text_view_truncated,omitempty"`
	ImageNextAfter    *int                    `json:"image_next_after"`
	ImageTotal        int64                   `json:"image_total"`
}

type contentAuditJob struct {
	owners   atomic.Int32
	released atomic.Bool
	record   model.ContentAudit
	payload  ContentAuditPayload
	images   *contentAuditImages
	charged  int64
}

func StartContentAudit() {
	contentAuditStartOnce.Do(func() {
		r := contentAuditEngine
		ctx, cancel := context.WithCancel(context.Background())
		r.cancel = cancel
		r.start(ctx)
	})
}

func StopContentAuditAdmission() { contentAuditEngine.stopping.Store(true) }

func StopContentAudit(ctx context.Context) error {
	r := contentAuditEngine
	r.stopping.Store(true)
	// HTTP shutdown runs first. A handler that outlives it discards its owned
	// snapshot rather than enqueueing after stop. No channel is ever closed
	// underneath an active relay writer.
	if r.cancel != nil {
		r.cancel()
	}
	done := make(chan struct{})
	go func() { r.workers.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func ContentAuditProtocol(path string) (string, string) {
	switch path {
	case "/v1/chat/completions", "/pg/chat/completions":
		return "openai_chat", "text"
	case "/v1/completions":
		return "openai_completions", "text"
	case "/v1/responses", "/v1/responses/compact":
		return "openai_responses", "text"
	case "/v1/messages":
		return "claude", "text"
	case "/v1/images/generations", "/v1/images/edits", "/v1/edits", "/pg/images/generations", "/pg/images/edits":
		return "openai_images", "image"
	}
	if (strings.HasPrefix(path, "/v1beta/models/") || strings.HasPrefix(path, "/v1/models/")) && (strings.HasSuffix(path, ":generateContent") || strings.HasSuffix(path, ":streamGenerateContent")) {
		return "gemini", "text"
	}
	return "", ""
}

type contentAuditResponseWriter struct {
	gin.ResponseWriter
	response *contentAuditResponse
	failed   bool
}

func (w *contentAuditResponseWriter) Write(data []byte) (int, error) {
	n, err := w.ResponseWriter.Write(data)
	if n > 0 {
		w.response.write(data[:n], strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream"))
	}
	if err != nil {
		w.failed = true
	}
	return n, err
}
func (w *contentAuditResponseWriter) WriteString(data string) (int, error) {
	n, err := w.ResponseWriter.WriteString(data)
	stream := strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream")
	for offset := 0; offset < n; {
		end := min(n, offset+32<<10)
		w.response.write([]byte(data[offset:end]), stream)
		offset = end
	}
	if err != nil {
		w.failed = true
	}
	return n, err
}
func (w *contentAuditResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// CaptureContentAudit is installed ONLY after successful authentication and
// first channel distribution. It performs no audit DB, network, or file-store
// I/O. BodyStorage.NewReader isolates the cursor; the queue owns only snapshots.
func CaptureContentAudit(c *gin.Context) {
	r := contentAuditEngine
	protocol, kind := ContentAuditProtocol(c.Request.URL.Path)
	config := r.snapshot.Load()
	if c.Request.Method != http.MethodPost || protocol == "" || c.GetInt("id") <= 0 || c.GetInt("channel_id") <= 0 || r.stopping.Load() || config == nil || !config.ready || !config.state.Enabled || config.expires <= time.Now().Unix() {
		c.Next()
		return
	}
	if strings.HasPrefix(c.Request.URL.Path, "/pg/") && c.GetBool("use_access_token") {
		c.Next()
		return
	}
	if r.active.Add(1) > 64 {
		r.active.Add(-1)
		r.dropped.Add(1)
		r.memoryDrops.Add(1)
		c.Next()
		return
	}
	charged := int64(6*(config.state.RequestLimit+config.state.ResponseLimit) + (2 << 20))
	if !r.memory.acquire(charged) {
		r.active.Add(-1)
		r.dropped.Add(1)
		r.memoryDrops.Add(1)
		c.Next()
		return
	}
	images := &contentAuditImages{budget: &r.memory, enabled: config.state.ThumbnailEnabled, protocol: protocol}
	var imageCapture *contentAuditImages
	if kind == "image" || protocol == "openai_responses" || protocol == "gemini" {
		imageCapture = images
	}
	response := newContentAuditResponse(config.state.ResponseLimit, imageCapture)
	writer := &contentAuditResponseWriter{ResponseWriter: c.Writer, response: response}
	started := common.GetContextKeyTime(c, constant.ContextKeyRequestStartTime)
	if started.IsZero() {
		started = time.Now()
	}
	job := &contentAuditJob{images: images, charged: charged, record: model.ContentAudit{
		AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: config.state.Epoch,
		CreatedAt: started.Unix(), ExpiresAt: started.Unix() + int64(config.state.RetentionDays)*86400,
		UserID: c.GetInt("id"), Username: contentAuditText(c.GetString("username"), 64), Path: contentAuditText(c.Request.URL.Path, 255), Protocol: protocol, Kind: kind,
		RequestID: contentAuditText(c.GetString(common.RequestIdKey), 64), Model: contentAuditText(c.GetString("original_model"), 128), Integrity: "complete",
	}}
	job.payload.Images = []ContentAuditImageView{}
	job.payload.Request = json.RawMessage(`{"omitted":"body_unavailable"}`)
	job.record.RequestTruncated = true
	if value, ok := c.Get(common.KeyBodyStorage); ok {
		if storage, ok := value.(common.BodyStorage); ok {
			if reader, err := storage.NewReader(); err == nil {
				job.payload.Request, _, job.record.RequestTruncated = captureContentAuditRequest(reader, c.GetHeader("Content-Type"), config.state.RequestLimit)
				job.record.RequestObserved = storage.Size()
				_ = reader.Close()
			}
		}
	}
	if imageCapture != nil {
		images.session.initial = job.record
		job.owners.Store(2)
		select {
		case r.queue <- job:
		default:
			job.owners.Store(1)
			r.release(job)
			r.active.Add(-1)
			r.queueDrops.Add(1)
			r.dropped.Add(1)
			c.Next()
			return
		}
	}
	c.Writer = writer
	r.captured.Add(1)
	defer func() {
		c.Writer = writer.ResponseWriter
		r.active.Add(-1)
		job.payload.Response = response.snapshot()
		if images.session != nil && images.session.next > 0 {
			job.record.Kind = "image"
		}
		job.record.CompletedAt = time.Now().Unix()
		job.record.DurationMS = max(0, time.Since(started).Milliseconds())
		job.record.ChannelID = c.GetInt("channel_id")
		job.record.ChannelName = contentAuditText(c.GetString("channel_name"), 128)
		job.record.GroupName = contentAuditText(c.GetString("group"), 64)
		job.record.UpstreamRequestID = contentAuditText(c.GetString(common.UpstreamRequestIdKey), 128)
		job.record.HTTPStatus = writer.Status()
		job.record.IsStream = response.stream
		job.record.RetryCount = max(0, len(c.GetStringSlice("use_channel"))-1)
		job.record.RequestSaved = len(job.payload.Request)
		job.record.ResponseSaved = len(job.payload.Response)
		job.record.ResponseObserved = response.observed
		job.record.ResponseTruncated = response.truncated
		job.record.OmittedImages = images.omitted
		job.record.CompletionReason = "completed"
		if c.GetBool("content_audit_relay_error") || writer.Status() >= 400 {
			job.record.CompletionReason = "upstream_error"
		}
		if errors.Is(c.Request.Context().Err(), context.DeadlineExceeded) {
			job.record.CompletionReason = "timeout"
		} else if c.Request.Context().Err() != nil || writer.failed {
			job.record.CompletionReason = "client_disconnected"
		}
		if response.stream && !response.terminal && protocol != "gemini" && job.record.CompletionReason == "completed" {
			job.record.CompletionReason = "stream_incomplete"
		}
		if job.record.RequestTruncated || job.record.ResponseTruncated || job.record.CompletionReason == "client_disconnected" || job.record.CompletionReason == "timeout" || job.record.CompletionReason == "stream_incomplete" || (response.stream && job.record.CompletionReason == "upstream_error") {
			job.record.Integrity = "partial"
		}
		if imageCapture != nil {
			if images.session.broken {
				job.record.Integrity = "partial"
				job.record.ErrorCode = "resource_busy"
			}
			close(images.session.done)
			r.release(job)
			return
		}
		if r.stopping.Load() {
			r.release(job)
			r.dropped.Add(1)
			r.shutdownDrops.Add(1)
			return
		}
		select {
		case r.queue <- job:
		default:
			r.release(job)
			r.dropped.Add(1)
			r.queueDrops.Add(1)
		}
	}()
	c.Next()
}

func (r *contentAuditRuntime) release(job *contentAuditJob) {
	if job.owners.Load() > 0 && job.owners.Add(-1) > 0 {
		return
	}
	if !job.released.CompareAndSwap(false, true) {
		return
	}
	job.images.release()
	r.memory.release(job.charged)
	job.charged = 0
}
func (r *contentAuditRuntime) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			for {
				select {
				case job := <-r.queue:
					if job.images.session != nil {
						r.runOriginalJob(ctx, job)
					} else {
						r.release(job)
					}
					r.dropped.Add(1)
					r.shutdownDrops.Add(1)
				default:
					return
				}
			}
		case job := <-r.queue:
			r.runJob(ctx, job)
		}
	}
}

func (r *contentAuditRuntime) runJob(parent context.Context, job *contentAuditJob) {
	if job.images.session != nil {
		r.runOriginalJob(parent, job)
		return
	}
	defer r.release(job)
	// Only background persistence shares this lock. Relay capture remains
	// nonblocking, and the two writers may persist concurrently.
	r.ioMu.RLock()
	defer r.ioMu.RUnlock()
	ctx, cancel := context.WithTimeout(parent, 65*time.Second)
	defer cancel()
	state, err := model.GetContentAuditState(ctx)
	store := r.store.Load()
	if err != nil || store == nil {
		r.dropped.Add(1)
		r.storageDrops.Add(1)
		return
	}
	if _, _, err := store.space(state.CapacityBytes); err != nil {
		r.dropped.Add(1)
		r.storageDrops.Add(1)
		return
	}

	if err := model.ReserveContentAudit(ctx, &job.record); err != nil {
		if errors.Is(err, model.ErrContentAuditCapacity) {
			r.wakeMaintenance()
		}
		r.dropped.Add(1)
		r.admissionDrops.Add(1)
		return
	}
	published := false
	var directory *os.Root
	defer func() {
		if directory != nil {
			_ = directory.Close()
		}
		if published {
			return
		}
		r.dropped.Add(1)
		r.storageDrops.Add(1)
		// Filesystem handles are closed before the reservation becomes reclaimable.
		stopped, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = model.StopContentAuditAttempt(stopped, &job.record, "write_failed")
		r.wakeMaintenance()
	}()

	if ctx.Err() != nil {
		return
	}
	current, err := model.GetContentAuditState(ctx)
	if err != nil || !current.Enabled || current.Epoch != job.record.Epoch || current.Reconciling || job.record.RequestSaved > current.RequestLimit || job.record.ResponseSaved > current.ResponseLimit || current.UsedBytes+current.ReservedBytes > current.CapacityBytes {
		return
	}

	body, err := common.Marshal(job.payload)
	if err != nil {
		return
	}
	directory, err = store.beginAttempt(state, &job.record)
	if err != nil {
		return
	}
	remaining := job.record.ReservedBytes
	files := make([]model.ContentAuditFile, 0, 5)
	payloadFile := model.ContentAuditFile{ID: contentAuditRandomID(), Kind: "payload", PlainBytes: len(body), MIME: "application/json"}
	payloadFile.Bytes, err = store.write(ctx, directory, job.record.StorageID, job.record.AuditID, job.record.Attempt, payloadFile.ID, payloadFile.Kind, body, true, &remaining)
	if err != nil {
		return
	}
	files = append(files, payloadFile)
	actual := payloadFile.Bytes

	closed, err := common.Marshal(contentAuditClosedAttempt{AuditID: job.record.AuditID, Attempt: job.record.Attempt, Owner: job.record.Owner, Fence: job.record.Fence, Files: files, FileBytes: actual})
	if err != nil {
		return
	}
	closedBytes, err := store.write(ctx, directory, job.record.StorageID, job.record.AuditID, job.record.Attempt, "closed", "closed", closed, false, &remaining)
	if err != nil {
		return
	}
	actual += closedBytes
	_ = directory.Close()
	directory = nil
	// No filesystem writes follow the closed marker. A recovery process may
	// revoke publication and delete this attempt, even if this worker pauses.
	currentRoot, err := store.open(state)
	if err != nil {
		return
	}
	_ = currentRoot.Close()
	err = model.PublishContentAudit(ctx, &job.record, files, actual)
	if err != nil {
		check, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		current, lookupErr := model.GetContentAudit(check, job.record.AuditID)
		cancel()
		if lookupErr != nil || current.Status != model.ContentAuditReady || current.Attempt != job.record.Attempt {
			return
		}
	}
	published = true
	r.saved.Add(1)
	if job.record.Integrity == "partial" {
		r.partial.Add(1)
	}
}

func (r *contentAuditRuntime) start(ctx context.Context) {
	for range 2 {
		r.workers.Go(func() { r.worker(ctx) })
	}
	r.workers.Go(func() {
		r.refreshLocal(ctx)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.refreshLocal(ctx)
			}
		}
	})
	r.workers.Go(func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			case <-r.maintenanceWake:
			}
			if ctx.Err() != nil {
				return
			}
			_ = r.maintain(ctx, false)
			r.refreshLocal(ctx)
		}
	})
}

func (r *contentAuditRuntime) wakeMaintenance() {
	select {
	case r.maintenanceWake <- struct{}{}:
	default:
	}
}

func (r *contentAuditRuntime) refreshLocal(parent context.Context) {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	state, err := model.GetContentAuditState(ctx)
	if err != nil {
		r.snapshot.Store(nil)
		return
	}
	store := r.store.Load()
	if store == nil {
		store, err = newContentAuditStore(os.Getenv("CONTENT_AUDIT_STORAGE_DIR"))
		if err == nil {
			r.store.Store(store)
		}
	}
	reason := "not_initialized"
	if store == nil {
		reason = "storage_not_configured"
	} else if state.StorageID != "" {
		root, openErr := store.open(state)
		if openErr != nil {
			reason = "storage_or_key_mismatch"
		} else {
			_ = root.Close()
			if _, _, err := store.space(state.CapacityBytes); err != nil {
				reason = "storage_space"
			} else {
				reason = ""
			}
		}
	}
	if reason == "" && r.recoveredStore != state.StorageID {
		// Exactly one process owns this directory/database. The previous
		// process must have exited before this runtime starts recovery.
		r.snapshot.Store(nil)
		if err := r.maintain(parent, true); err != nil {
			reason = "recovery_unavailable"
		} else {
			r.recoveredStore = state.StorageID
		}
		// Refresh the short health deadline after the retained-store scan.
		cancel()
		ctx, cancel = context.WithTimeout(parent, 5*time.Second)
		defer cancel()
	}
	if err := model.SetContentAuditHealth(ctx, state.ConfigVersion, reason == "", reason); err != nil {
		r.snapshot.Store(nil)
		return
	}
	state, err = model.GetContentAuditState(ctx)
	if err != nil {
		r.snapshot.Store(nil)
		return
	}
	ready := reason == "" && r.recoveredStore == state.StorageID && state.PauseReason == "" && !state.Reconciling && state.HealthyUntil > time.Now().Unix()
	r.snapshot.Store(&contentAuditConfigSnapshot{state: *state, expires: time.Now().Unix() + 10, ready: ready})
	if state.Enabled && !ready && time.Now().Unix()-r.lastWarning >= 300 {
		r.lastWarning = time.Now().Unix()
		common.SysError("content audit paused or incomplete; consult root content audit status")
	}
}

var _ io.Writer = (*contentAuditJSON)(nil)

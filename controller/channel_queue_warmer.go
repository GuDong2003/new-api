package controller

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

const (
	queueDefaultInterval    = 30
	queueDefaultTimeout     = 25
	queueDefaultBackoff     = 30
	queueDefaultMaxFailures = 10
	queueDefaultCooldown    = 300
	queueLeaseMargin        = 5

	queueWarmupFailureSampleLimit  = 10
	queueWarmupFailureSampleLength = 256
)

type channelWarmerState struct {
	mu              sync.Mutex
	inFlight        bool
	consecutiveFail int
	breakerUntil    time.Time
	lastWarmAt      time.Time
	lastResult      string
	lastStatusCode  int
	warming         bool
}

type ChannelQueueStatusView struct {
	ChannelID       int    `json:"channel_id"`
	ChannelName     string `json:"channel_name"`
	ChannelEnabled  bool   `json:"channel_enabled"`
	Enabled         bool   `json:"enabled"`
	Model           string `json:"model"`
	Warming         bool   `json:"warming"`
	BreakerActive   bool   `json:"breaker_active"`
	BreakerUntil    int64  `json:"breaker_until,omitempty"`
	ConsecutiveFail int    `json:"consecutive_failures"`
	LastWarmAt      int64  `json:"last_warm_at,omitempty"`
	LastStatusCode  int    `json:"last_status_code,omitempty"`
	LastResult      string `json:"last_result,omitempty"`
}

type ChannelQueueConfigView struct {
	ChannelID      int                       `json:"channel_id"`
	ChannelName    string                    `json:"channel_name"`
	ChannelStatus  int                       `json:"channel_status"`
	ChannelEnabled bool                      `json:"channel_enabled"`
	Models         []string                  `json:"models"`
	Queue          *dto.ChannelQueueSettings `json:"queue,omitempty"`
	Status         ChannelQueueStatusView    `json:"status"`
}

var channelWarmerStates sync.Map // channel ID int -> *channelWarmerState

type channelQueueWarmupTaskPayload struct {
	ChannelIDs []int  `json:"channel_ids,omitempty"`
	Trigger    string `json:"trigger,omitempty"`
}

type channelQueueWarmupResult struct {
	ScannedChannels   int            `json:"scanned_channels"`
	AttemptedChannels int            `json:"attempted_channels"`
	Succeeded         int            `json:"succeeded"`
	QueueBusy         int            `json:"queue_busy"`
	Timeout           int            `json:"timeout"`
	Failed            int            `json:"failed"`
	Skipped           int            `json:"skipped"`
	StatusCodes       map[string]int `json:"status_codes,omitempty"`
	FailureSamples    []string       `json:"failure_samples,omitempty"`
}

type channelQueueWarmupOutcome struct {
	ChannelID  int
	Outcome    warmupOutcome
	StatusCode int
	Attempts   int
	Message    string
	Skipped    bool
}

func buildDueChannelQueueWarmupTask(now int64) (*model.SystemTask, bool, error) {
	channelIDs, err := collectQueueChannelIDs(now, false)
	if err != nil {
		return nil, false, err
	}
	if len(channelIDs) == 0 {
		return nil, false, nil
	}
	if active, err := model.GetActiveSystemTask(model.SystemTaskTypeChannelQueueWarmup); err != nil {
		return nil, false, err
	} else if active != nil {
		return active, false, nil
	}
	task, err := model.CreateSystemTask(model.SystemTaskTypeChannelQueueWarmup, channelQueueWarmupTaskPayload{
		ChannelIDs: channelIDs,
		Trigger:    "due",
	}, nil)
	if err != nil {
		active, activeErr := model.GetActiveSystemTask(model.SystemTaskTypeChannelQueueWarmup)
		if activeErr == nil && active != nil {
			return active, false, nil
		}
		return nil, false, err
	}
	return task, true, nil
}

func collectQueueChannelIDs(now int64, force bool) ([]int, error) {
	channels, err := model.GetAllChannels(0, -1, false, false)
	if err != nil {
		return nil, err
	}
	channelIDs := make([]int, 0, len(channels))
	for _, channel := range channels {
		if channel == nil || channel.Status != common.ChannelStatusEnabled {
			continue
		}
		q := readQueueSetting(channel)
		if q == nil || !q.Enabled {
			continue
		}
		if force {
			channelIDs = append(channelIDs, channel.Id)
			continue
		}
		lease, err := model.GetNamedLease(queueLeaseName(channel.Id))
		if err != nil {
			return nil, err
		}
		if lease == nil || lease.ExpiresAt < now {
			channelIDs = append(channelIDs, channel.Id)
		}
	}
	return channelIDs, nil
}

func runChannelQueueWarmupRound(ctx context.Context, payload channelQueueWarmupTaskPayload, reportProgress func(processed, total int)) (*channelQueueWarmupResult, error) {
	channelIDs := payload.ChannelIDs
	result := &channelQueueWarmupResult{
		ScannedChannels: len(channelIDs),
		StatusCodes:     make(map[string]int),
	}
	if len(channelIDs) == 0 {
		if reportProgress != nil {
			reportProgress(0, 0)
		}
		return result, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	outcomes := make(chan channelQueueWarmupOutcome, len(channelIDs))
	var wg sync.WaitGroup
	for _, channelID := range channelIDs {
		channelID := channelID
		wg.Add(1)
		go func() {
			defer wg.Done()
			channel, err := model.GetChannelById(channelID, true)
			if err != nil {
				outcomes <- channelQueueWarmupOutcome{ChannelID: channelID, Outcome: warmupOutcomeFailure, Message: sanitizeWarmupMessage(err.Error())}
				return
			}
			if channel == nil || channel.Status != common.ChannelStatusEnabled {
				outcomes <- channelQueueWarmupOutcome{ChannelID: channelID, Skipped: true}
				return
			}
			q := readQueueSetting(channel)
			if q == nil || !q.Enabled {
				outcomes <- channelQueueWarmupOutcome{ChannelID: channelID, Skipped: true}
				return
			}
			outcomes <- warmOneChannel(ctx, channel, q)
		}()
	}
	wg.Wait()
	close(outcomes)

	processed := 0
	for outcome := range outcomes {
		processed++
		if reportProgress != nil {
			reportProgress(processed, len(channelIDs))
		}
		if outcome.Skipped {
			result.Skipped++
			continue
		}
		if outcome.Attempts > 0 {
			result.AttemptedChannels++
		}
		if outcome.StatusCode != 0 {
			result.StatusCodes[fmt.Sprintf("%d", outcome.StatusCode)]++
		}
		switch outcome.Outcome {
		case warmupOutcomeSuccess:
			result.Succeeded++
		case warmupOutcomeQueueBusy:
			result.QueueBusy++
		case warmupOutcomeTimeout:
			result.Timeout++
		default:
			result.Failed++
			if outcome.Message != "" && len(result.FailureSamples) < queueWarmupFailureSampleLimit {
				result.FailureSamples = append(result.FailureSamples, truncateWarmup(outcome.Message, queueWarmupFailureSampleLength))
			}
		}
	}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	return result, nil
}

func warmOneChannel(parentCtx context.Context, channel *model.Channel, q *dto.ChannelQueueSettings) channelQueueWarmupOutcome {
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	if channel == nil || q == nil {
		return channelQueueWarmupOutcome{Skipped: true}
	}
	if parentCtx.Err() != nil {
		return channelQueueWarmupOutcome{ChannelID: channel.Id, Skipped: true}
	}
	state := getWarmerState(channel.Id)
	state.mu.Lock()
	if state.inFlight {
		state.mu.Unlock()
		return channelQueueWarmupOutcome{ChannelID: channel.Id, Skipped: true}
	}
	if q.CircuitBreakerEnabled && !state.breakerUntil.IsZero() && time.Now().Before(state.breakerUntil) {
		state.mu.Unlock()
		return channelQueueWarmupOutcome{ChannelID: channel.Id, Skipped: true}
	}
	state.inFlight = true
	state.warming = true
	state.mu.Unlock()
	defer func() {
		state.mu.Lock()
		state.inFlight = false
		state.warming = false
		state.mu.Unlock()
	}()

	interval := durationOrDefault(q.Interval, queueDefaultInterval)
	now := time.Now().Unix()
	holder := fmt.Sprintf("%s-%s", common.NodeName, common.GetRandomString(8))
	acquired, err := model.AcquireNamedLease(queueLeaseName(channel.Id), holder, now, now+int64(interval.Seconds())+queueLeaseMargin)
	if err != nil {
		logger.LogWarn(parentCtx, fmt.Sprintf("queue warmer: lease acquire failed channel=%d: %v", channel.Id, err))
		return channelQueueWarmupOutcome{ChannelID: channel.Id, Outcome: warmupOutcomeFailure, Message: sanitizeWarmupMessage(err.Error())}
	}
	if !acquired {
		return channelQueueWarmupOutcome{ChannelID: channel.Id, Skipped: true}
	}

	timeout := durationOrDefault(q.Timeout, queueDefaultTimeout)
	if timeout >= interval {
		timeout = interval - time.Second
		if timeout < time.Second {
			timeout = time.Second
		}
	}
	ctx, cancel := context.WithTimeout(parentCtx, timeout)
	defer cancel()
	backoff := durationOrDefault(q.BackoffSeconds, queueDefaultBackoff)
	var lastResult QueueWarmupResult
	result := channelQueueWarmupOutcome{ChannelID: channel.Id}
	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			break
		}
		result.Attempts = attempt
		lastResult = PerformChannelQueueWarmup(ctx, channel, strings.TrimSpace(q.Model), q.EndpointType, q.WarmupMessage, q.MaxTokens, shouldUseStreamForQueueWarmup(channel))
		if classifyWarmupOutcome(lastResult, q) != warmupOutcomeQueueBusy {
			break
		}
		if q.MaxQueueAttempts > 0 && attempt >= q.MaxQueueAttempts {
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
	}
	if result.Attempts == 0 {
		return channelQueueWarmupOutcome{ChannelID: channel.Id, Skipped: true}
	}

	outcome := classifyWarmupOutcome(lastResult, q)
	result.Outcome = outcome
	result.StatusCode = lastResult.StatusCode
	result.Message = sanitizeWarmupMessage(lastResult.Message)
	state.mu.Lock()
	state.lastWarmAt = time.Now()
	state.lastStatusCode = lastResult.StatusCode
	state.lastResult = classifyWarmupResult(outcome, lastResult)
	switch outcome {
	case warmupOutcomeSuccess:
		state.consecutiveFail = 0
		state.breakerUntil = time.Time{}
	case warmupOutcomeFailure:
		state.consecutiveFail++
		maxFailures := q.MaxConsecutiveFailures
		if maxFailures <= 0 {
			maxFailures = queueDefaultMaxFailures
		}
		if q.CircuitBreakerEnabled && state.consecutiveFail >= maxFailures {
			cooldown := durationOrDefault(q.CooldownSeconds, queueDefaultCooldown)
			state.breakerUntil = time.Now().Add(cooldown)
			logger.LogWarn(ctx, fmt.Sprintf("queue warmer: breaker tripped channel=%d cooldown=%s failures=%d", channel.Id, cooldown, state.consecutiveFail))
		}
	}
	state.mu.Unlock()
	return result
}

func queueLeaseName(channelID int) string {
	return fmt.Sprintf("upstream_queue:%d", channelID)
}

type warmupOutcome int

const (
	warmupOutcomeSuccess warmupOutcome = iota
	warmupOutcomeQueueBusy
	warmupOutcomeTimeout
	warmupOutcomeFailure
)

func classifyWarmupOutcome(result QueueWarmupResult, q *dto.ChannelQueueSettings) warmupOutcome {
	if result.IsTimeout {
		return warmupOutcomeTimeout
	}
	if result.Err == nil && result.StatusCode >= 200 && result.StatusCode < 300 {
		return warmupOutcomeSuccess
	}
	if isQueueBusyStatusCode(result.StatusCode, q) || isQueueBusyMessage(result.Message) {
		return warmupOutcomeQueueBusy
	}
	return warmupOutcomeFailure
}

func classifyWarmupResult(outcome warmupOutcome, result QueueWarmupResult) string {
	switch outcome {
	case warmupOutcomeSuccess:
		return "ok"
	case warmupOutcomeQueueBusy:
		return "queue_busy"
	case warmupOutcomeTimeout:
		return "timeout"
	default:
		if result.Message != "" {
			return truncateWarmup(result.Message, 120)
		}
		return "error"
	}
}

func isQueueBusyStatusCode(statusCode int, q *dto.ChannelQueueSettings) bool {
	codes := []int{http.StatusTooManyRequests, http.StatusServiceUnavailable}
	if q != nil && len(q.QueueBusyStatusCodes) > 0 {
		codes = q.QueueBusyStatusCodes
	}
	for _, code := range codes {
		if code == statusCode {
			return true
		}
	}
	return false
}

func isQueueBusyMessage(message string) bool {
	lower := strings.ToLower(message)
	for _, hint := range []string{"queue", "busy", "full", "rate limit", "rate_limit", "too many requests", "overloaded", "capacity"} {
		if strings.Contains(lower, hint) {
			return true
		}
	}
	return false
}

func shouldUseStreamForQueueWarmup(channel *model.Channel) bool {
	return channel != nil && channel.Type == constant.ChannelTypeCodex
}

func durationOrDefault(value, fallback int) time.Duration {
	if value <= 0 || value > model.MaxQueueDurationSeconds {
		value = fallback
	}
	return time.Duration(value) * time.Second
}

func getWarmerState(channelID int) *channelWarmerState {
	if value, ok := channelWarmerStates.Load(channelID); ok {
		return value.(*channelWarmerState)
	}
	state := &channelWarmerState{}
	actual, _ := channelWarmerStates.LoadOrStore(channelID, state)
	return actual.(*channelWarmerState)
}

func readQueueSetting(channel *model.Channel) *dto.ChannelQueueSettings {
	if channel == nil || channel.Setting == nil || strings.TrimSpace(*channel.Setting) == "" {
		return nil
	}
	return channel.GetSetting().Queue
}

func sanitizeWarmupMessage(message string) string {
	message = common.MaskSensitiveInfo(strings.TrimSpace(message))
	return common.LocalLogPreview(message)
}

func truncateWarmup(message string, maxLength int) string {
	if len(message) <= maxLength {
		return message
	}
	return message[:maxLength]
}

func buildChannelQueueStatusView(channel *model.Channel, q *dto.ChannelQueueSettings) ChannelQueueStatusView {
	view := ChannelQueueStatusView{}
	if channel == nil {
		return view
	}
	view.ChannelID = channel.Id
	view.ChannelName = channel.Name
	view.ChannelEnabled = channel.Status == common.ChannelStatusEnabled
	view.Enabled = q != nil && q.Enabled
	if q != nil {
		view.Model = q.Model
	}
	state := getWarmerState(channel.Id)
	state.mu.Lock()
	view.Warming = state.warming
	view.BreakerActive = q != nil && q.CircuitBreakerEnabled && !state.breakerUntil.IsZero() && time.Now().Before(state.breakerUntil)
	view.ConsecutiveFail = state.consecutiveFail
	view.LastStatusCode = state.lastStatusCode
	view.LastResult = state.lastResult
	if view.BreakerActive {
		view.BreakerUntil = state.breakerUntil.Unix()
	}
	if !state.lastWarmAt.IsZero() {
		view.LastWarmAt = state.lastWarmAt.Unix()
	}
	state.mu.Unlock()
	return view
}

func GetChannelQueueStatus() []ChannelQueueStatusView {
	channels, err := model.GetAllChannels(0, -1, false, false)
	if err != nil {
		return nil
	}
	views := make([]ChannelQueueStatusView, 0)
	for _, channel := range channels {
		q := readQueueSetting(channel)
		if q == nil || !q.Enabled {
			continue
		}
		views = append(views, buildChannelQueueStatusView(channel, q))
	}
	return views
}

func GetChannelQueueStatusHandler(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": GetChannelQueueStatus()})
}

func GetChannelQueueConfigHandler(c *gin.Context) {
	channels, err := model.GetAllChannels(0, -1, false, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	views := make([]ChannelQueueConfigView, 0, len(channels))
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		q := readQueueSetting(channel)
		models := channel.GetModels()
		if models == nil {
			models = []string{}
		}
		views = append(views, ChannelQueueConfigView{
			ChannelID:      channel.Id,
			ChannelName:    channel.Name,
			ChannelStatus:  channel.Status,
			ChannelEnabled: channel.Status == common.ChannelStatusEnabled,
			Models:         models,
			Queue:          q,
			Status:         buildChannelQueueStatusView(channel, q),
		})
	}
	common.ApiSuccess(c, views)
}

func UpdateChannelQueueConfigHandler(c *gin.Context) {
	channelID, err := strconv.Atoi(c.Param("id"))
	if err != nil || channelID <= 0 {
		common.ApiErrorMsg(c, "invalid channel id")
		return
	}
	raw, err := c.GetRawData()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	var queue dto.ChannelQueueSettings
	if err := common.Unmarshal(raw, &queue); err != nil {
		common.ApiError(c, err)
		return
	}
	queue.Model = strings.TrimSpace(queue.Model)
	queue.EndpointType = strings.ToLower(strings.TrimSpace(queue.EndpointType))
	channel, err := model.GetChannelById(channelID, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	setting := channel.GetSetting()
	setting.Queue = &queue
	channel.SetSetting(setting)
	if err := channel.ValidateSettings(); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.DB.Model(&model.Channel{}).Where("id = ?", channelID).Update("setting", channel.Setting).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	updated, err := model.GetChannelById(channelID, true)
	if err == nil {
		model.CacheUpdateChannel(updated)
		channel = updated
	}
	common.ApiSuccess(c, buildChannelQueueConfigView(channel))
}

func DeleteChannelQueueConfigHandler(c *gin.Context) {
	channelID, err := strconv.Atoi(c.Param("id"))
	if err != nil || channelID <= 0 {
		common.ApiErrorMsg(c, "invalid channel id")
		return
	}
	channel, err := model.GetChannelById(channelID, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	setting := channel.GetSetting()
	setting.Queue = nil
	channel.SetSetting(setting)
	if err := model.DB.Model(&model.Channel{}).Where("id = ?", channelID).Update("setting", channel.Setting).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	updated, err := model.GetChannelById(channelID, true)
	if err == nil {
		model.CacheUpdateChannel(updated)
		channel = updated
	}
	common.ApiSuccess(c, buildChannelQueueConfigView(channel))
}

func buildChannelQueueConfigView(channel *model.Channel) ChannelQueueConfigView {
	q := readQueueSetting(channel)
	models := channel.GetModels()
	if models == nil {
		models = []string{}
	}
	return ChannelQueueConfigView{
		ChannelID:      channel.Id,
		ChannelName:    channel.Name,
		ChannelStatus:  channel.Status,
		ChannelEnabled: channel.Status == common.ChannelStatusEnabled,
		Models:         models,
		Queue:          q,
		Status:         buildChannelQueueStatusView(channel, q),
	}
}

func RunChannelQueueWarmupHandler(c *gin.Context) {
	channelIDs, err := collectQueueChannelIDs(common.GetTimestamp(), true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if len(channelIDs) == 0 {
		common.ApiSuccess(c, nil)
		return
	}
	task, created, err := service.EnqueueSystemTask(model.SystemTaskTypeChannelQueueWarmup, channelQueueWarmupTaskPayload{
		ChannelIDs: channelIDs,
		Trigger:    "manual",
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"task_id": task.TaskID, "status": task.Status, "created": created})
}

func ListChannelQueueWarmupLogsHandler(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	tasks, err := model.ListSystemTasksByType(model.SystemTaskTypeChannelQueueWarmup, limit)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	responses := make([]model.SystemTaskResponse, 0, len(tasks))
	for _, task := range tasks {
		responses = append(responses, task.ToResponse())
	}
	common.ApiSuccess(c, responses)
}

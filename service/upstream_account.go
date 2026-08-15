package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	upstreamAccountRequestTimeout    = 30 * time.Second
	upstreamCheckinRetryInterval     = 6 * time.Hour
	upstreamCheckinRetryJitter       = 30 * time.Minute
	upstreamCheckinMaxAttemptsPerDay = 4
)

type UpstreamAccountOperationResult struct {
	Status     string  `json:"status"`
	Message    string  `json:"message"`
	Reward     float64 `json:"reward,omitempty"`
	Balance    float64 `json:"balance,omitempty"`
	Unit       string  `json:"unit,omitempty"`
	HttpStatus int     `json:"http_status,omitempty"`
	DurationMs int64   `json:"duration_ms"`
}

// UpstreamChannelBalanceRefreshResult contains the aggregate snapshot for a
// channel and the per-account refresh outcome. A failed account does not hide
// the other accounts' stored balances; the aggregate status and Errors make
// the partial result explicit to callers.
type UpstreamChannelBalanceRefreshResult struct {
	Summary   *model.UpstreamChannelBalanceSummary `json:"summary"`
	Refreshed int                                  `json:"refreshed"`
	Failed    int                                  `json:"failed"`
	Errors    []string                             `json:"errors,omitempty"`
}

func upstreamHTTPClient() *http.Client {
	if client := GetHttpClient(); client != nil {
		return client
	}
	return http.DefaultClient
}

func upstreamFailureStatus(err error) string {
	message := strings.ToLower(err.Error())
	manualMarkers := []string{"turnstile", "captcha", "cloudflare", "challenge", "人机", "验证码", "安全验证"}
	for _, marker := range manualMarkers {
		if strings.Contains(message, marker) {
			return model.UpstreamStatusManualRequired
		}
	}
	return model.UpstreamStatusFailed
}

func nextUpstreamCheckinDay(now time.Time) int64 {
	tomorrow := now.AddDate(0, 0, 1)
	return time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), 0, 5, 0, 0, tomorrow.Location()).Unix()
}

// nextUpstreamCheckinTime keeps a successful account on a once-per-day
// cadence. Failed automatic attempts are retried after roughly six hours,
// with a small positive jitter to avoid sending all accounts at the same
// instant. Once the daily attempt budget is exhausted, retries stop until the
// next daily cycle.
func nextUpstreamCheckinTime(success bool, status string, attempts int) int64 {
	now := time.Now()
	if success || status == model.UpstreamStatusManualRequired || attempts >= upstreamCheckinMaxAttemptsPerDay {
		return nextUpstreamCheckinDay(now)
	}
	jitterMinutes := common.GetRandomInt(int(upstreamCheckinRetryJitter/time.Minute) + 1)
	return now.Add(upstreamCheckinRetryInterval + time.Duration(jitterMinutes)*time.Minute).Unix()
}

func beginScheduledUpstreamCheckinAttempt(account *model.UpstreamAccount) (int, string, error) {
	today := time.Now().Format("2006-01-02")
	attempts := account.CheckinAttempts
	if account.CheckinAttemptDate != today {
		attempts = 0
	}
	attempts++
	trigger := model.UpstreamTriggerScheduled
	if account.CheckinAttemptDate == today && account.CheckinAttempts > 0 {
		trigger = model.UpstreamTriggerRetry
	}
	if err := model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
		"checkin_attempt_date": today,
		"checkin_attempts":     attempts,
		"updated_time":         common.GetTimestamp(),
	}).Error; err != nil {
		return 0, "", err
	}
	account.CheckinAttemptDate = today
	account.CheckinAttempts = attempts
	return attempts, trigger, nil
}

func recordUpstreamOperation(accountId int, logType, trigger string, result *UpstreamAccountOperationResult) {
	_ = model.CreateUpstreamAccountLog(&model.UpstreamAccountLog{
		AccountId:  accountId,
		Type:       logType,
		Trigger:    trigger,
		Status:     result.Status,
		Message:    result.Message,
		Reward:     result.Reward,
		Balance:    result.Balance,
		Unit:       result.Unit,
		HttpStatus: result.HttpStatus,
		DurationMs: result.DurationMs,
	})
}

func RefreshUpstreamAccountBalance(ctx context.Context, account *model.UpstreamAccount, trigger string) (*UpstreamAccountOperationResult, error) {
	started := time.Now()
	adapter := upstreamSiteAdapterFor(account)
	if adapter.mode == upstreamAdapterExternal {
		message := "该站点不支持内置余额查询，请使用外部站点页面"
		result := &UpstreamAccountOperationResult{Status: model.UpstreamStatusManualRequired, Message: message, DurationMs: time.Since(started).Milliseconds()}
		_ = model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
			"balance_status":    model.UpstreamStatusManualRequired,
			"last_error":        message,
			"next_balance_time": time.Now().Add(30 * time.Minute).Unix(),
			"updated_time":      common.GetTimestamp(),
		}).Error
		recordUpstreamOperation(account.Id, model.UpstreamLogTypeBalance, trigger, result)
		return result, errors.New(message)
	}
	response, err := doUpstreamJSONRequest(ctx, account, adapter, http.MethodGet, adapter.healthPath, nil, nil)
	httpStatus := 0
	if response != nil {
		httpStatus = response.httpStatus
	}
	if err != nil {
		status := upstreamFailureStatus(err)
		result := &UpstreamAccountOperationResult{Status: status, Message: err.Error(), HttpStatus: httpStatus, DurationMs: time.Since(started).Milliseconds()}
		_ = model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
			"balance_status":    status,
			"last_error":        err.Error(),
			"next_balance_time": time.Now().Add(30 * time.Minute).Unix(),
			"updated_time":      common.GetTimestamp(),
		}).Error
		recordUpstreamOperation(account.Id, model.UpstreamLogTypeBalance, trigger, result)
		return result, err
	}
	snapshot, parseErr := parseUpstreamBalance(ctx, account, adapter, response.payload)
	if parseErr != nil {
		err = parseErr
	}
	if err != nil {
		result := &UpstreamAccountOperationResult{Status: model.UpstreamStatusFailed, Message: err.Error(), HttpStatus: httpStatus, DurationMs: time.Since(started).Milliseconds()}
		_ = model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
			"balance_status":    model.UpstreamStatusFailed,
			"last_error":        err.Error(),
			"next_balance_time": time.Now().Add(30 * time.Minute).Unix(),
			"updated_time":      common.GetTimestamp(),
		}).Error
		recordUpstreamOperation(account.Id, model.UpstreamLogTypeBalance, trigger, result)
		return result, err
	}
	quota := snapshot.rawQuota
	quotaPerUnit := snapshot.quotaPerUnit
	balance := snapshot.balance
	unit := snapshot.unit
	now := common.GetTimestamp()
	nextBalance := time.Now().Add(time.Duration(account.BalanceInterval) * time.Minute).Unix()
	updates := map[string]any{
		"balance":              balance,
		"balance_unit":         unit,
		"raw_quota":            quota,
		"quota_per_unit":       quotaPerUnit,
		"balance_updated_time": now,
		"balance_status":       model.UpstreamStatusHealthy,
		"last_error":           "",
		"next_balance_time":    nextBalance,
		"updated_time":         now,
	}
	if err := model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(updates).Error; err != nil {
		return nil, err
	}
	account.Balance = balance
	account.BalanceUnit = unit
	account.RawQuota = quota
	account.QuotaPerUnit = quotaPerUnit
	account.BalanceUpdatedTime = now
	account.BalanceStatus = model.UpstreamStatusHealthy
	account.NextBalanceTime = nextBalance
	result := &UpstreamAccountOperationResult{
		Status: model.UpstreamStatusHealthy, Message: "余额刷新成功", Balance: balance, Unit: unit,
		HttpStatus: httpStatus, DurationMs: time.Since(started).Milliseconds(),
	}
	recordUpstreamOperation(account.Id, model.UpstreamLogTypeBalance, trigger, result)
	return result, nil
}

// RefreshUpstreamChannelBalances refreshes each account bound to a channel at
// most once and then returns the aggregate persisted balance. The link table
// is many-to-many, so this is the single entry point used by channel-level
// manual balance queries.
func RefreshUpstreamChannelBalances(ctx context.Context, channelId int, trigger string) (*UpstreamChannelBalanceRefreshResult, error) {
	accounts, err := model.GetUpstreamAccountsForChannel(channelId)
	if err != nil {
		return nil, err
	}
	result := &UpstreamChannelBalanceRefreshResult{}
	for _, account := range accounts {
		if _, refreshErr := RefreshUpstreamAccountBalance(ctx, account, trigger); refreshErr != nil {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %s", account.Name, refreshErr.Error()))
			continue
		}
		result.Refreshed++
	}
	summary, err := model.GetUpstreamChannelBalanceSummary(channelId)
	if err != nil {
		return nil, err
	}
	result.Summary = summary
	return result, nil
}

func CheckinUpstreamAccount(ctx context.Context, account *model.UpstreamAccount, trigger string) (*UpstreamAccountOperationResult, error) {
	attempts := account.CheckinAttempts
	operationTrigger := trigger
	isAutomaticAttempt := trigger == model.UpstreamTriggerScheduled || trigger == model.UpstreamTriggerRetry
	if isAutomaticAttempt {
		today := time.Now().Format("2006-01-02")
		if account.CheckinAttemptDate == today && account.CheckinAttempts >= upstreamCheckinMaxAttemptsPerDay {
			// This is a defensive guard for stale due rows. The normal scheduler
			// will already have moved the account to the next daily cycle.
			next := nextUpstreamCheckinDay(time.Now())
			_ = model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
				"next_checkin_time": next,
				"updated_time":      common.GetTimestamp(),
			}).Error
			return &UpstreamAccountOperationResult{
				Status:  model.UpstreamStatusHealthy,
				Message: "今日自动签到次数已达上限",
			}, nil
		}
		var err error
		attempts, operationTrigger, err = beginScheduledUpstreamCheckinAttempt(account)
		if err != nil {
			return nil, err
		}
	}
	started := time.Now()
	adapter := upstreamSiteAdapterFor(account)
	if adapter.mode == upstreamAdapterExternal || !adapter.option.SupportsCheckin {
		message := "该站点不支持内置签到，请打开外部签到页面"
		result := &UpstreamAccountOperationResult{Status: model.UpstreamStatusManualRequired, Message: message, DurationMs: time.Since(started).Milliseconds()}
		now := common.GetTimestamp()
		_ = model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
			"last_checkin_time":    now,
			"last_checkin_status":  model.UpstreamStatusManualRequired,
			"last_checkin_message": message,
			"last_error":           message,
			"next_checkin_time":    nextUpstreamCheckinTime(false, model.UpstreamStatusManualRequired, attempts),
			"updated_time":         now,
		}).Error
		recordUpstreamOperation(account.Id, model.UpstreamLogTypeCheckin, operationTrigger, result)
		return result, errors.New(message)
	}
	checkinPath := adapter.option.CheckinPath
	extraHeaders := map[string]string(nil)
	if adapter.mode == upstreamAdapterAnyRouter {
		extraHeaders = map[string]string{"X-Requested-With": "XMLHttpRequest"}
	}
	response, err := doUpstreamJSONRequest(ctx, account, adapter, adapter.checkinMethod, checkinPath, []byte("{}"), extraHeaders)
	httpStatus := 0
	if response != nil {
		httpStatus = response.httpStatus
	}
	if err != nil {
		if upstreamAlreadyChecked(err.Error()) {
			message := err.Error()
			result := &UpstreamAccountOperationResult{Status: model.UpstreamStatusHealthy, Message: message, HttpStatus: httpStatus, DurationMs: time.Since(started).Milliseconds()}
			now := common.GetTimestamp()
			if updateErr := model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
				"last_checkin_time":    now,
				"last_checkin_status":  model.UpstreamStatusHealthy,
				"last_checkin_message": message,
				"last_error":           "",
				"next_checkin_time":    nextUpstreamCheckinTime(true, model.UpstreamStatusHealthy, attempts),
				"updated_time":         now,
			}).Error; updateErr != nil {
				return nil, updateErr
			}
			recordUpstreamOperation(account.Id, model.UpstreamLogTypeCheckin, operationTrigger, result)
			_, _ = RefreshUpstreamAccountBalance(ctx, account, operationTrigger)
			return result, nil
		}
		status := upstreamFailureStatus(err)
		result := &UpstreamAccountOperationResult{Status: status, Message: err.Error(), HttpStatus: httpStatus, DurationMs: time.Since(started).Milliseconds()}
		now := common.GetTimestamp()
		_ = model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
			"last_checkin_time":    now,
			"last_checkin_status":  status,
			"last_checkin_message": err.Error(),
			"last_error":           err.Error(),
			"next_checkin_time":    nextUpstreamCheckinTime(false, status, attempts),
			"updated_time":         now,
		}).Error
		recordUpstreamOperation(account.Id, model.UpstreamLogTypeCheckin, operationTrigger, result)
		return result, err
	}
	reward := upstreamCheckinReward(response.payload)
	message := strings.TrimSpace(upstreamResponseMessage(response.payload))
	if upstreamCheckinPayloadAlreadyChecked(response.payload) {
		message = "今日已签到"
	}
	if message == "" {
		message = "签到成功"
	}
	result := &UpstreamAccountOperationResult{
		Status: model.UpstreamStatusHealthy, Message: message, Reward: reward,
		HttpStatus: httpStatus, DurationMs: time.Since(started).Milliseconds(),
	}
	now := common.GetTimestamp()
	if err := model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
		"last_checkin_time":    now,
		"last_checkin_status":  model.UpstreamStatusHealthy,
		"last_checkin_message": message,
		"last_error":           "",
		"next_checkin_time":    nextUpstreamCheckinTime(true, model.UpstreamStatusHealthy, attempts),
		"updated_time":         now,
	}).Error; err != nil {
		return nil, err
	}
	recordUpstreamOperation(account.Id, model.UpstreamLogTypeCheckin, operationTrigger, result)
	// A successful check-in can change quota. Use the exact same balance path
	// as manual/channel refreshes so units and channel views remain consistent.
	_, _ = RefreshUpstreamAccountBalance(ctx, account, operationTrigger)
	return result, nil
}

func HealthCheckUpstreamAccount(ctx context.Context, account *model.UpstreamAccount, trigger string) (*UpstreamAccountOperationResult, error) {
	started := time.Now()
	adapter := upstreamSiteAdapterFor(account)
	if adapter.mode == upstreamAdapterExternal {
		message := "该站点不支持内置健康检查，请使用外部站点页面"
		result := &UpstreamAccountOperationResult{Status: model.UpstreamStatusManualRequired, Message: message, DurationMs: time.Since(started).Milliseconds()}
		now := common.GetTimestamp()
		_ = model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
			"last_health_time": now,
			"health_status":    model.UpstreamStatusManualRequired,
			"last_error":       message,
			"updated_time":     now,
		}).Error
		recordUpstreamOperation(account.Id, model.UpstreamLogTypeHealth, trigger, result)
		return result, errors.New(message)
	}
	response, err := doUpstreamJSONRequest(ctx, account, adapter, http.MethodGet, adapter.healthPath, nil, nil)
	httpStatus := 0
	if response != nil {
		httpStatus = response.httpStatus
	}
	status := model.UpstreamStatusHealthy
	message := "连接和认证正常"
	if err != nil {
		status = upstreamFailureStatus(err)
		message = err.Error()
	}
	result := &UpstreamAccountOperationResult{Status: status, Message: message, HttpStatus: httpStatus, DurationMs: time.Since(started).Milliseconds()}
	now := common.GetTimestamp()
	updates := map[string]any{"last_health_time": now, "health_status": status, "updated_time": now}
	if err != nil {
		updates["last_error"] = err.Error()
	} else {
		updates["last_error"] = ""
	}
	_ = model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(updates).Error
	recordUpstreamOperation(account.Id, model.UpstreamLogTypeHealth, trigger, result)
	return result, err
}

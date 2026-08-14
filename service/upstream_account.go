package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const upstreamAccountRequestTimeout = 30 * time.Second

type upstreamAPIResponse struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type UpstreamAccountOperationResult struct {
	Status     string  `json:"status"`
	Message    string  `json:"message"`
	Reward     float64 `json:"reward,omitempty"`
	Balance    float64 `json:"balance,omitempty"`
	Unit       string  `json:"unit,omitempty"`
	HttpStatus int     `json:"http_status,omitempty"`
	DurationMs int64   `json:"duration_ms"`
}

func upstreamHTTPClient() *http.Client {
	if client := GetHttpClient(); client != nil {
		return client
	}
	return http.DefaultClient
}

func doUpstreamAccountRequest(ctx context.Context, account *model.UpstreamAccount, method, path string) (*upstreamAPIResponse, int, error) {
	credential, err := account.GetCredential()
	if err != nil {
		return nil, 0, err
	}
	requestContext, cancel := context.WithTimeout(ctx, upstreamAccountRequestTimeout)
	defer cancel()
	url := strings.TrimRight(account.BaseURL, "/") + path
	request, err := http.NewRequestWithContext(requestContext, method, url, bytes.NewReader(nil))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "new-api-upstream-account/1.0")
	if account.AuthType == model.UpstreamAuthTypeCookie {
		request.Header.Set("Cookie", credential)
	} else {
		request.Header.Set("Authorization", "Bearer "+credential)
		if account.UserId > 0 {
			request.Header.Set("New-Api-User", strconv.Itoa(account.UserId))
		}
	}
	response, err := upstreamHTTPClient().Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return nil, response.StatusCode, err
	}
	apiResponse := &upstreamAPIResponse{}
	if len(body) > 0 {
		if err := json.Unmarshal(body, apiResponse); err != nil {
			if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
				return nil, response.StatusCode, fmt.Errorf("upstream returned HTTP %d", response.StatusCode)
			}
			return nil, response.StatusCode, fmt.Errorf("invalid upstream JSON response: %w", err)
		}
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(apiResponse.Message)
		if message == "" {
			message = fmt.Sprintf("upstream returned HTTP %d", response.StatusCode)
		}
		return apiResponse, response.StatusCode, errors.New(message)
	}
	if !apiResponse.Success {
		message := strings.TrimSpace(apiResponse.Message)
		if message == "" {
			message = "upstream operation failed"
		}
		return apiResponse, response.StatusCode, errors.New(message)
	}
	return apiResponse, response.StatusCode, nil
}

func numberFromJSON(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func decodeDataMap(response *upstreamAPIResponse) (map[string]any, error) {
	data := map[string]any{}
	decoder := json.NewDecoder(bytes.NewReader(response.Data))
	decoder.UseNumber()
	if err := decoder.Decode(&data); err != nil {
		return nil, err
	}
	return data, nil
}

func readRemoteQuotaPerUnit(ctx context.Context, account *model.UpstreamAccount) float64 {
	response, _, err := doUpstreamAccountRequest(ctx, account, http.MethodGet, "/api/status")
	if err != nil {
		return account.QuotaPerUnit
	}
	data, err := decodeDataMap(response)
	if err != nil {
		return account.QuotaPerUnit
	}
	value, ok := numberFromJSON(data["quota_per_unit"])
	if !ok || value <= 0 {
		return account.QuotaPerUnit
	}
	return value
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

func nextUpstreamCheckinTime(success bool, status string) int64 {
	now := time.Now()
	if success || status == model.UpstreamStatusManualRequired {
		tomorrow := now.AddDate(0, 0, 1)
		return time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), 0, 5, 0, 0, tomorrow.Location()).Unix()
	}
	return now.Add(30 * time.Minute).Unix()
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
	response, httpStatus, err := doUpstreamAccountRequest(ctx, account, http.MethodGet, "/api/user/self")
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
	data, decodeErr := decodeDataMap(response)
	if decodeErr != nil {
		err = fmt.Errorf("cannot decode upstream user data: %w", decodeErr)
	} else if _, ok := data["quota"]; !ok {
		err = errors.New("upstream user response does not contain quota")
	}
	quota, quotaOK := numberFromJSON(data["quota"])
	if err == nil && !quotaOK {
		err = errors.New("upstream quota is not numeric")
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
	quotaPerUnit := readRemoteQuotaPerUnit(ctx, account)
	balance := quota
	unit := "QUOTA"
	if quotaPerUnit > 0 {
		balance = quota / quotaPerUnit
		unit = "USD"
	}
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

func CheckinUpstreamAccount(ctx context.Context, account *model.UpstreamAccount, trigger string) (*UpstreamAccountOperationResult, error) {
	started := time.Now()
	response, httpStatus, err := doUpstreamAccountRequest(ctx, account, http.MethodPost, "/api/user/checkin")
	if err != nil {
		lowerMessage := strings.ToLower(err.Error())
		if strings.Contains(lowerMessage, "already") || strings.Contains(lowerMessage, "已签到") || strings.Contains(lowerMessage, "重复签到") {
			message := err.Error()
			result := &UpstreamAccountOperationResult{Status: model.UpstreamStatusHealthy, Message: message, HttpStatus: httpStatus, DurationMs: time.Since(started).Milliseconds()}
			now := common.GetTimestamp()
			if updateErr := model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", account.Id).Updates(map[string]any{
				"last_checkin_time":    now,
				"last_checkin_status":  model.UpstreamStatusHealthy,
				"last_checkin_message": message,
				"last_error":           "",
				"next_checkin_time":    nextUpstreamCheckinTime(true, model.UpstreamStatusHealthy),
				"updated_time":         now,
			}).Error; updateErr != nil {
				return nil, updateErr
			}
			recordUpstreamOperation(account.Id, model.UpstreamLogTypeCheckin, trigger, result)
			_, _ = RefreshUpstreamAccountBalance(ctx, account, trigger)
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
			"next_checkin_time":    nextUpstreamCheckinTime(false, status),
			"updated_time":         now,
		}).Error
		recordUpstreamOperation(account.Id, model.UpstreamLogTypeCheckin, trigger, result)
		return result, err
	}
	data, _ := decodeDataMap(response)
	reward, _ := numberFromJSON(data["quota_awarded"])
	message := strings.TrimSpace(response.Message)
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
		"next_checkin_time":    nextUpstreamCheckinTime(true, model.UpstreamStatusHealthy),
		"updated_time":         now,
	}).Error; err != nil {
		return nil, err
	}
	recordUpstreamOperation(account.Id, model.UpstreamLogTypeCheckin, trigger, result)
	// A successful check-in can change quota. Use the exact same balance path
	// as manual/channel refreshes so units and channel views remain consistent.
	_, _ = RefreshUpstreamAccountBalance(ctx, account, trigger)
	return result, nil
}

func HealthCheckUpstreamAccount(ctx context.Context, account *model.UpstreamAccount, trigger string) (*UpstreamAccountOperationResult, error) {
	started := time.Now()
	_, httpStatus, err := doUpstreamAccountRequest(ctx, account, http.MethodGet, "/api/user/self")
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

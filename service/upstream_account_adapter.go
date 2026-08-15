package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	upstreamAdapterGeneric    = "generic"
	upstreamAdapterAnyRouter  = "anyrouter"
	upstreamAdapterVoAPIV2    = "voapi-v2"
	upstreamAdapterSub2API    = "sub2api"
	upstreamAdapterAIHubMix   = "aihubmix"
	upstreamAdapterSharedChat = "sharedchat"
	upstreamAdapterOpenRouter = "openrouter"
	upstreamAdapterExternal   = "external"
)

type upstreamSiteAdapter struct {
	option        model.UpstreamSiteTypeOption
	mode          string
	userHeader    string
	healthPath    string
	checkinMethod string
	defaultUnit   string
	defaultQPU    float64
}

type upstreamRawResponse struct {
	payload    any
	httpStatus int
}

type upstreamBalanceSnapshot struct {
	balance      float64
	rawQuota     float64
	quotaPerUnit float64
	unit         string
}

func findUpstreamSiteTypeOption(siteType string) (model.UpstreamSiteTypeOption, bool) {
	for _, option := range model.GetUpstreamSiteTypeOptions() {
		if option.Value == siteType {
			return option, true
		}
	}
	return model.UpstreamSiteTypeOption{}, false
}

func upstreamSiteAdapterFor(account *model.UpstreamAccount) upstreamSiteAdapter {
	siteType := account.SiteType
	if siteType == "" {
		siteType = model.UpstreamSiteTypeNewAPI
	}
	option, ok := findUpstreamSiteTypeOption(siteType)
	if !ok {
		option = model.UpstreamSiteTypeOption{
			Value: siteType,
			Label: siteType,
		}
	}
	adapter := upstreamSiteAdapter{
		option:        option,
		mode:          upstreamAdapterGeneric,
		healthPath:    option.BalancePath,
		checkinMethod: http.MethodPost,
		defaultUnit:   "QUOTA",
	}
	switch siteType {
	case model.UpstreamSiteTypeAnyRouter:
		adapter.mode = upstreamAdapterAnyRouter
	case model.UpstreamSiteTypeVoAPIV2:
		adapter.mode = upstreamAdapterVoAPIV2
		adapter.userHeader = ""
	case model.UpstreamSiteTypeSub2API:
		adapter.mode = upstreamAdapterSub2API
		adapter.defaultUnit = "USD"
		adapter.defaultQPU = 1
	case model.UpstreamSiteTypeAIHubMix:
		adapter.mode = upstreamAdapterAIHubMix
		adapter.defaultUnit = "USD"
		adapter.defaultQPU = 500000
	case model.UpstreamSiteTypeSharedChat:
		adapter.mode = upstreamAdapterSharedChat
		adapter.defaultUnit = "USD"
		adapter.defaultQPU = 1
	case model.UpstreamSiteTypeOpenRouter:
		adapter.mode = upstreamAdapterOpenRouter
		adapter.defaultUnit = "USD"
		adapter.defaultQPU = 1
	case model.UpstreamSiteTypeUnknown, model.UpstreamSiteTypeOctopus, model.UpstreamSiteTypeAxonHub, model.UpstreamSiteTypeClaudeCodeHub:
		adapter.mode = upstreamAdapterExternal
	}
	switch siteType {
	case model.UpstreamSiteTypeVeloera:
		adapter.checkinMethod = http.MethodPost
	case model.UpstreamSiteTypeVoAPIV2:
		adapter.checkinMethod = http.MethodPost
	}
	switch siteType {
	case model.UpstreamSiteTypeVeloera:
		adapter.userHeader = "Veloera-User"
	case model.UpstreamSiteTypeVAPI:
		adapter.userHeader = "X-Api-User"
	case model.UpstreamSiteTypeVoAPI:
		adapter.userHeader = "voapi-user"
	case model.UpstreamSiteTypeRixAPI:
		adapter.userHeader = "Rix-Api-User"
	case model.UpstreamSiteTypeNeoAPI:
		adapter.userHeader = "neo-api-user"
	case model.UpstreamSiteTypeNewAPI, model.UpstreamSiteTypeOneAPI, model.UpstreamSiteTypeOneHub, model.UpstreamSiteTypeDoneHub, model.UpstreamSiteTypeSuperAPI, model.UpstreamSiteTypeWongGongyi, model.UpstreamSiteTypeUnknown:
		adapter.userHeader = "New-Api-User"
	}
	return adapter
}

func upstreamRequestURL(account *model.UpstreamAccount, path string) string {
	return strings.TrimRight(account.BaseURL, "/") + path
}

func upstreamRequestHeaders(account *model.UpstreamAccount, adapter upstreamSiteAdapter, extra map[string]string) (map[string]string, error) {
	credential, err := account.GetCredential()
	if err != nil {
		return nil, err
	}
	headers := map[string]string{
		"Accept":       "application/json",
		"Content-Type": "application/json",
		"User-Agent":   "new-api-upstream-account/1.0",
	}
	if account.AuthType == model.UpstreamAuthTypeCookie {
		headers["Cookie"] = credential
	} else {
		headers["Authorization"] = "Bearer " + credential
		if adapter.userHeader != "" && account.UserId > 0 {
			headers[adapter.userHeader] = strconv.Itoa(account.UserId)
		}
	}
	for key, value := range extra {
		headers[key] = value
	}
	return headers, nil
}

func upstreamResponseMessage(payload any) string {
	root := upstreamMap(payload)
	for _, key := range []string{"message", "msg", "error", "detail"} {
		if value, ok := root[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	if data := upstreamMap(root["data"]); data != nil {
		for _, key := range []string{"message", "msg", "error", "detail"} {
			if value, ok := data[key].(string); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	return ""
}

func upstreamMap(value any) map[string]any {
	if value == nil {
		return nil
	}
	if result, ok := value.(map[string]any); ok {
		return result
	}
	return nil
}

func upstreamPayloadData(payload any) map[string]any {
	root := upstreamMap(payload)
	if root == nil {
		return nil
	}
	if data := upstreamMap(root["data"]); data != nil {
		return data
	}
	return root
}

func upstreamPayloadSuccess(payload any) (bool, bool) {
	root := upstreamMap(payload)
	if root == nil {
		return true, false
	}
	value, exists := root["success"]
	if !exists {
		return true, false
	}
	success, ok := value.(bool)
	if !ok {
		return true, false
	}
	return success, true
}

func upstreamCode(payload any) (float64, bool) {
	root := upstreamMap(payload)
	if root == nil {
		return 0, false
	}
	return upstreamNumber(root["code"])
}

func upstreamNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func upstreamFirstNumber(data map[string]any, keys ...string) (float64, bool) {
	for _, key := range keys {
		if value, ok := upstreamNumber(data[key]); ok {
			return value, true
		}
	}
	return 0, false
}

func doUpstreamJSONRequest(ctx context.Context, account *model.UpstreamAccount, adapter upstreamSiteAdapter, method, path string, body []byte, extraHeaders map[string]string) (*upstreamRawResponse, error) {
	if path == "" {
		return nil, errors.New("upstream endpoint is not configured for this site type")
	}
	headers, err := upstreamRequestHeaders(account, adapter, extraHeaders)
	if err != nil {
		return nil, err
	}
	requestContext, cancel := context.WithTimeout(ctx, upstreamAccountRequestTimeout)
	defer cancel()
	if body == nil && method != http.MethodGet && method != http.MethodHead {
		body = []byte("{}")
	}
	request, err := http.NewRequestWithContext(requestContext, method, upstreamRequestURL(account, path), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := upstreamHTTPClient().Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	rawResponse := &upstreamRawResponse{httpStatus: response.StatusCode}
	bodyBytes, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return rawResponse, err
	}
	var payload any
	if len(bytes.TrimSpace(bodyBytes)) > 0 {
		if err := common.Unmarshal(bodyBytes, &payload); err != nil {
			if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
				return rawResponse, fmt.Errorf("upstream returned HTTP %d", response.StatusCode)
			}
			return rawResponse, fmt.Errorf("invalid upstream JSON response: %w", err)
		}
	}
	rawResponse.payload = payload
	message := upstreamResponseMessage(payload)
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		if message == "" {
			message = fmt.Sprintf("upstream returned HTTP %d", response.StatusCode)
		}
		return rawResponse, errors.New(message)
	}
	if success, exists := upstreamPayloadSuccess(payload); exists && !success {
		if message == "" {
			message = "upstream operation failed"
		}
		return rawResponse, errors.New(message)
	}
	if adapter.mode == upstreamAdapterSub2API {
		if code, ok := upstreamCode(payload); ok && code != 0 {
			if message == "" {
				message = "Sub2API operation failed"
			}
			return rawResponse, errors.New(message)
		}
	}
	return &upstreamRawResponse{payload: payload, httpStatus: response.StatusCode}, nil
}

func resolveUpstreamQuotaPerUnit(ctx context.Context, account *model.UpstreamAccount, adapter upstreamSiteAdapter, data map[string]any) float64 {
	if value, ok := upstreamFirstNumber(data, "quota_per_unit", "quotaPerUnit"); ok && value > 0 {
		return value
	}
	if account.QuotaPerUnit > 0 {
		return account.QuotaPerUnit
	}
	if adapter.defaultQPU > 0 {
		return adapter.defaultQPU
	}
	if adapter.mode != upstreamAdapterGeneric && adapter.mode != upstreamAdapterAnyRouter {
		return 0
	}
	statusResponse, err := doUpstreamJSONRequest(ctx, account, adapter, http.MethodGet, "/api/status", nil, nil)
	if err != nil {
		return 0
	}
	statusData := upstreamPayloadData(statusResponse.payload)
	value, ok := upstreamFirstNumber(statusData, "quota_per_unit", "quotaPerUnit")
	if !ok || value <= 0 {
		return 0
	}
	return value
}

func parseUpstreamBalance(ctx context.Context, account *model.UpstreamAccount, adapter upstreamSiteAdapter, payload any) (upstreamBalanceSnapshot, error) {
	data := upstreamPayloadData(payload)
	if data == nil {
		return upstreamBalanceSnapshot{}, errors.New("upstream balance response is not an object")
	}
	snapshot := upstreamBalanceSnapshot{unit: adapter.defaultUnit}
	switch adapter.mode {
	case upstreamAdapterOpenRouter:
		totalCredits, creditsOK := upstreamFirstNumber(data, "total_credits", "totalCredits")
		totalUsage, usageOK := upstreamFirstNumber(data, "total_usage", "totalUsage")
		if !creditsOK || !usageOK {
			return upstreamBalanceSnapshot{}, errors.New("OpenRouter credits response is missing total credits or usage")
		}
		snapshot.balance = totalCredits - totalUsage
		snapshot.rawQuota = snapshot.balance
		snapshot.quotaPerUnit = 1
		snapshot.unit = "USD"
	case upstreamAdapterSharedChat:
		codex := upstreamMap(data["codex"])
		subscriptions := upstreamMap(codex["subscriptions"])
		remaining, ok := upstreamFirstNumber(subscriptions, "remainingAmount", "remaining_amount")
		if !ok {
			return upstreamBalanceSnapshot{}, errors.New("SharedChat quota response is missing remaining amount")
		}
		snapshot.balance = remaining
		snapshot.rawQuota = remaining
		snapshot.quotaPerUnit = 1
		snapshot.unit = "USD"
	case upstreamAdapterVoAPIV2:
		basic, basicOK := upstreamFirstNumber(data, "basicBalance", "basic_balance")
		bind, bindOK := upstreamFirstNumber(data, "bindBalance", "bind_balance")
		if !basicOK && !bindOK {
			return upstreamBalanceSnapshot{}, errors.New("VoAPI response is missing balance")
		}
		snapshot.balance = basic + bind
		snapshot.rawQuota = snapshot.balance
		snapshot.quotaPerUnit = 1
		snapshot.unit = "USD"
	case upstreamAdapterSub2API:
		balance, ok := upstreamFirstNumber(data, "balance", "balance_usd", "balanceUsd")
		if !ok {
			return upstreamBalanceSnapshot{}, errors.New("Sub2API response is missing balance")
		}
		snapshot.balance = balance
		snapshot.rawQuota = balance
		snapshot.quotaPerUnit = 1
		snapshot.unit = "USD"
	default:
		if nested := upstreamMap(data["user"]); nested != nil {
			data = nested
		}
		quota, quotaOK := upstreamFirstNumber(data, "quota", "remain_quota", "remaining_quota")
		if quotaOK {
			snapshot.rawQuota = quota
			snapshot.quotaPerUnit = resolveUpstreamQuotaPerUnit(ctx, account, adapter, data)
			snapshot.balance = quota
			if snapshot.quotaPerUnit > 0 {
				snapshot.balance = quota / snapshot.quotaPerUnit
				snapshot.unit = "USD"
			}
		} else if balance, balanceOK := upstreamFirstNumber(data, "balance", "amount", "remainingAmount", "remaining_amount"); balanceOK {
			snapshot.balance = balance
			snapshot.rawQuota = balance
			if unit, ok := data["unit"].(string); ok && strings.TrimSpace(unit) != "" {
				snapshot.unit = strings.TrimSpace(unit)
			}
			snapshot.quotaPerUnit = 1
		} else {
			return upstreamBalanceSnapshot{}, errors.New("upstream response does not contain a supported balance field")
		}
	}
	if snapshot.balance < 0 {
		return upstreamBalanceSnapshot{}, errors.New("upstream balance is negative")
	}
	return snapshot, nil
}

func upstreamCheckinReward(payload any) float64 {
	data := upstreamPayloadData(payload)
	if reward, ok := upstreamFirstNumber(data, "quota_awarded", "quotaAwarded", "reward", "bonusAmount", "bonus_amount", "amount"); ok {
		return reward
	}
	return 0
}

func upstreamAlreadyChecked(message string) bool {
	lower := strings.ToLower(strings.TrimSpace(message))
	for _, marker := range []string{"already", "already checked", "已签到", "今日已签到", "重复签到", "今天已经签到", "signed today"} {
		if strings.Contains(lower, strings.ToLower(marker)) {
			return true
		}
	}
	return false
}

func upstreamCheckinPayloadAlreadyChecked(payload any) bool {
	data := upstreamPayloadData(payload)
	if checked, ok := data["checked_in"].(bool); ok && checked {
		return true
	}
	if checked, ok := data["checkedIn"].(bool); ok && checked {
		return true
	}
	if code, ok := upstreamCode(payload); ok && code == 1 {
		return true
	}
	return false
}

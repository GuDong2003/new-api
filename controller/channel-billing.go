package controller

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay/channel/advancedcustom"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/shopspring/decimal"

	"github.com/gin-gonic/gin"
)

// https://github.com/songquanpeng/one-api/issues/79

type OpenAISubscriptionResponse struct {
	Object             string  `json:"object"`
	HasPaymentMethod   bool    `json:"has_payment_method"`
	SoftLimitUSD       float64 `json:"soft_limit_usd"`
	HardLimitUSD       float64 `json:"hard_limit_usd"`
	SystemHardLimitUSD float64 `json:"system_hard_limit_usd"`
	AccessUntil        int64   `json:"access_until"`
}

type OpenAIUsageDailyCost struct {
	Timestamp float64 `json:"timestamp"`
	LineItems []struct {
		Name string  `json:"name"`
		Cost float64 `json:"cost"`
	}
}

type OpenAICreditGrants struct {
	Object         string  `json:"object"`
	TotalGranted   float64 `json:"total_granted"`
	TotalUsed      float64 `json:"total_used"`
	TotalAvailable float64 `json:"total_available"`
}

const maxAdvancedCustomBalanceResponseBytes = 256 << 10

type channelBalanceResult struct {
	Balance     float64
	RawResponse string
}

type OpenAIUsageResponse struct {
	Object string `json:"object"`
	//DailyCosts []OpenAIUsageDailyCost `json:"daily_costs"`
	TotalUsage float64 `json:"total_usage"` // unit: 0.01 dollar
}

type OpenAISBUsageResponse struct {
	Msg  string `json:"msg"`
	Data *struct {
		Credit string `json:"credit"`
	} `json:"data"`
}

type AIProxyUserOverviewResponse struct {
	Success   bool   `json:"success"`
	Message   string `json:"message"`
	ErrorCode int    `json:"error_code"`
	Data      struct {
		TotalPoints float64 `json:"totalPoints"`
	} `json:"data"`
}

type API2GPTUsageResponse struct {
	Object         string  `json:"object"`
	TotalGranted   float64 `json:"total_granted"`
	TotalUsed      float64 `json:"total_used"`
	TotalRemaining float64 `json:"total_remaining"`
}

type APGC2DGPTUsageResponse struct {
	//Grants         interface{} `json:"grants"`
	Object         string  `json:"object"`
	TotalAvailable float64 `json:"total_available"`
	TotalGranted   float64 `json:"total_granted"`
	TotalUsed      float64 `json:"total_used"`
}

type SiliconFlowUsageResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Status  bool   `json:"status"`
	Data    struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		Image         string `json:"image"`
		Email         string `json:"email"`
		IsAdmin       bool   `json:"isAdmin"`
		Balance       string `json:"balance"`
		Status        string `json:"status"`
		Introduction  string `json:"introduction"`
		Role          string `json:"role"`
		ChargeBalance string `json:"chargeBalance"`
		TotalBalance  string `json:"totalBalance"`
		Category      string `json:"category"`
	} `json:"data"`
}

type DeepSeekUsageResponse struct {
	IsAvailable  bool `json:"is_available"`
	BalanceInfos []struct {
		Currency        string `json:"currency"`
		TotalBalance    string `json:"total_balance"`
		GrantedBalance  string `json:"granted_balance"`
		ToppedUpBalance string `json:"topped_up_balance"`
	} `json:"balance_infos"`
}

type OpenRouterCreditResponse struct {
	Data struct {
		TotalCredits float64 `json:"total_credits"`
		TotalUsage   float64 `json:"total_usage"`
	} `json:"data"`
}

// GetAuthHeader get auth header
func GetAuthHeader(token string) http.Header {
	h := http.Header{}
	h.Add("Authorization", fmt.Sprintf("Bearer %s", token))
	return h
}

// GetClaudeAuthHeader get claude auth header
func GetClaudeAuthHeader(token string) http.Header {
	h := http.Header{}
	h.Add("x-api-key", token)
	h.Add("anthropic-version", "2023-06-01")
	return h
}

func GetResponseBody(ctx context.Context, method, url string, settings dto.ChannelSettings, headers http.Header) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return nil, err
	}
	for k := range headers {
		req.Header.Add(k, headers.Get(k))
	}
	client, err := service.GetHttpClientWithProxySettings(settings.Proxy, settings)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status code: %d", res.StatusCode)
	}
	return io.ReadAll(res.Body)
}

func fetchChannelCloseAIBalance(ctx context.Context, baseURL, key string, settings dto.ChannelSettings) (float64, error) {
	url := fmt.Sprintf("%s/dashboard/billing/credit_grants", baseURL)
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))

	if err != nil {
		return 0, err
	}
	response := OpenAICreditGrants{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	return response.TotalAvailable, nil
}

func fetchChannelOpenAISBBalance(ctx context.Context, key string, settings dto.ChannelSettings) (float64, error) {
	url := fmt.Sprintf("https://api.openai-sb.com/sb-api/user/status?api_key=%s", key)
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}
	response := OpenAISBUsageResponse{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	if response.Data == nil {
		return 0, errors.New(response.Msg)
	}
	balance, err := strconv.ParseFloat(response.Data.Credit, 64)
	if err != nil {
		return 0, err
	}
	return balance, nil
}

func fetchChannelAIProxyBalance(ctx context.Context, key string, settings dto.ChannelSettings) (float64, error) {
	url := "https://aiproxy.io/api/report/getUserOverview"
	headers := http.Header{}
	headers.Add("Api-Key", key)
	body, err := GetResponseBody(ctx, "GET", url, settings, headers)
	if err != nil {
		return 0, err
	}
	response := AIProxyUserOverviewResponse{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	if !response.Success {
		return 0, fmt.Errorf("code: %d, message: %s", response.ErrorCode, response.Message)
	}
	return response.Data.TotalPoints, nil
}

func fetchChannelAPI2GPTBalance(ctx context.Context, key string, settings dto.ChannelSettings) (float64, error) {
	url := "https://api.api2gpt.com/dashboard/billing/credit_grants"
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))

	if err != nil {
		return 0, err
	}
	response := API2GPTUsageResponse{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	return response.TotalRemaining, nil
}

func fetchChannelSiliconFlowBalance(ctx context.Context, key string, settings dto.ChannelSettings) (float64, error) {
	url := "https://api.siliconflow.cn/v1/user/info"
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}
	response := SiliconFlowUsageResponse{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	if response.Code != 20000 {
		return 0, fmt.Errorf("code: %d, message: %s", response.Code, response.Message)
	}
	balance, err := strconv.ParseFloat(response.Data.TotalBalance, 64)
	if err != nil {
		return 0, err
	}
	return balance, nil
}

func getDeepSeekBalanceUSD(response DeepSeekUsageResponse, usdExchangeRate float64) (float64, error) {
	var usdBalance *string
	var cnyBalance *string

	for i := range response.BalanceInfos {
		balanceInfo := &response.BalanceInfos[i]
		switch balanceInfo.Currency {
		case "USD":
			if usdBalance == nil {
				usdBalance = &balanceInfo.TotalBalance
			}
		case "CNY":
			if cnyBalance == nil {
				cnyBalance = &balanceInfo.TotalBalance
			}
		}
	}

	if usdBalance != nil {
		balance, err := strconv.ParseFloat(*usdBalance, 64)
		if err != nil {
			return 0, err
		}
		if math.IsNaN(balance) || math.IsInf(balance, 0) {
			return 0, errors.New("USD balance must be finite")
		}
		if balance < 0 {
			return 0, errors.New("USD balance must be non-negative")
		}
		if balance > 0 {
			return balance, nil
		}
	}
	if cnyBalance == nil {
		// An empty USD wallet is a valid balance. Only report a missing
		// currency when the response carried neither USD nor CNY.
		if usdBalance != nil {
			return 0, nil
		}
		return 0, errors.New("currency USD or CNY not found")
	}
	if math.IsNaN(usdExchangeRate) || math.IsInf(usdExchangeRate, 0) {
		return 0, errors.New("USD exchange rate must be finite")
	}
	if usdExchangeRate <= 0 {
		return 0, errors.New("USD exchange rate must be greater than zero")
	}

	balanceCNY, err := strconv.ParseFloat(*cnyBalance, 64)
	if err != nil {
		return 0, err
	}
	if math.IsNaN(balanceCNY) || math.IsInf(balanceCNY, 0) {
		return 0, errors.New("CNY balance must be finite")
	}
	if balanceCNY < 0 {
		return 0, errors.New("CNY balance must be non-negative")
	}
	balanceUSD := decimal.NewFromFloat(balanceCNY).Div(decimal.NewFromFloat(usdExchangeRate)).InexactFloat64()
	if math.IsNaN(balanceUSD) || math.IsInf(balanceUSD, 0) {
		return 0, errors.New("converted USD balance must be finite")
	}
	if balanceUSD < 0 {
		return 0, errors.New("converted USD balance must be non-negative")
	}
	return balanceUSD, nil
}

func fetchChannelDeepSeekBalance(ctx context.Context, key string, settings dto.ChannelSettings) (float64, error) {
	url := "https://api.deepseek.com/user/balance"
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}
	response := DeepSeekUsageResponse{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	balance, err := getDeepSeekBalanceUSD(response, operation_setting.USDExchangeRate)
	if err != nil {
		return 0, err
	}
	return balance, nil
}

func fetchChannelAIGC2DBalance(ctx context.Context, key string, settings dto.ChannelSettings) (float64, error) {
	url := "https://api.aigc2d.com/dashboard/billing/credit_grants"
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}
	response := APGC2DGPTUsageResponse{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	return response.TotalAvailable, nil
}

func fetchChannelOpenRouterBalance(ctx context.Context, key string, settings dto.ChannelSettings) (float64, error) {
	url := "https://openrouter.ai/api/v1/credits"
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}
	response := OpenRouterCreditResponse{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	balance := response.Data.TotalCredits - response.Data.TotalUsage
	return balance, nil
}

func fetchChannelMoonshotBalance(ctx context.Context, key string, settings dto.ChannelSettings) (float64, error) {
	url := "https://api.moonshot.cn/v1/users/me/balance"
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}

	type MoonshotBalanceData struct {
		AvailableBalance float64 `json:"available_balance"`
		VoucherBalance   float64 `json:"voucher_balance"`
		CashBalance      float64 `json:"cash_balance"`
	}

	type MoonshotBalanceResponse struct {
		Code   int                 `json:"code"`
		Data   MoonshotBalanceData `json:"data"`
		Scode  string              `json:"scode"`
		Status bool                `json:"status"`
	}

	response := MoonshotBalanceResponse{}
	err = common.Unmarshal(body, &response)
	if err != nil {
		return 0, err
	}
	if !response.Status || response.Code != 0 {
		return 0, fmt.Errorf("failed to update moonshot balance, status: %v, code: %d, scode: %s", response.Status, response.Code, response.Scode)
	}
	availableBalanceCny := response.Data.AvailableBalance
	availableBalanceUsd := decimal.NewFromFloat(availableBalanceCny).Div(decimal.NewFromFloat(operation_setting.Price)).InexactFloat64()
	return availableBalanceUsd, nil
}

func fetchChannelSub2APIBalance(ctx context.Context, baseURL, key string, settings dto.ChannelSettings) (float64, error) {
	if baseURL == "" {
		return 0, errors.New("Sub2API channel is missing base_url")
	}
	url := fmt.Sprintf("%s/v1/usage", strings.TrimRight(baseURL, "/"))
	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}

	type sub2apiUsageResponse struct {
		Balance      *float64 `json:"balance"`
		Remaining    *float64 `json:"remaining"`
		IsValid      *bool    `json:"isValid"`
		Subscription *struct {
			DailyLimitUSD   *float64 `json:"daily_limit_usd"`
			WeeklyLimitUSD  *float64 `json:"weekly_limit_usd"`
			MonthlyLimitUSD *float64 `json:"monthly_limit_usd"`
		} `json:"subscription"`
	}
	usage := sub2apiUsageResponse{}
	if err := common.Unmarshal(body, &usage); err != nil {
		return 0, err
	}
	if usage.IsValid != nil && !*usage.IsValid {
		return 0, errors.New("Sub2API key is invalid (isValid=false)")
	}

	balance := usage.Remaining
	if balance == nil {
		balance = usage.Balance
	}
	if balance == nil {
		return 0, errors.New("Sub2API /v1/usage response is missing remaining and balance fields (the key may belong to a subscription group without an available balance)")
	}
	// Sub2API reports remaining=-1 for a subscription group with no daily, weekly,
	// or monthly limit. A wallet balance can legitimately be negative, so detect
	// the unlimited case from the subscription limits rather than the value.
	subscription := usage.Subscription
	if subscription != nil && subscription.DailyLimitUSD == nil && subscription.WeeklyLimitUSD == nil && subscription.MonthlyLimitUSD == nil {
		return 0, errors.New("Sub2API /v1/usage reports an unlimited subscription without a finite balance")
	}
	return *balance, nil
}

// fetchChannelNewAPIBalance reads the upstream key's remaining quota. When the
// upstream also returns its owner's quota, the smaller of the two is what the
// key can still spend. Quota converts to USD with the upstream's quota_per_unit.
func fetchChannelNewAPIBalance(ctx context.Context, baseURL, key string, settings dto.ChannelSettings) (float64, error) {
	baseURL = strings.TrimRight(baseURL, "/")
	if baseURL == "" {
		return 0, errors.New("New API channel is missing base_url")
	}
	body, err := GetResponseBody(ctx, "GET", baseURL+"/api/usage/token/", settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}
	var usage struct {
		Code    bool   `json:"code"`
		Message string `json:"message"`
		Data    struct {
			TotalAvailable float64 `json:"total_available"`
			UnlimitedQuota bool    `json:"unlimited_quota"`
			UserQuota      *struct {
				TotalAvailable float64 `json:"total_available"`
			} `json:"user_quota"`
		} `json:"data"`
	}
	if err := common.Unmarshal(body, &usage); err != nil {
		return 0, err
	}
	if !usage.Code {
		return 0, fmt.Errorf("New API usage query failed: %s", usage.Message)
	}
	remaining := usage.Data.TotalAvailable
	if usage.Data.UnlimitedQuota {
		remaining = math.Inf(1)
	}
	if userQuota := usage.Data.UserQuota; userQuota != nil {
		remaining = min(remaining, userQuota.TotalAvailable)
	}
	if math.IsInf(remaining, 1) {
		return 0, common.NewMessage(`The upstream key has unlimited quota. Turn on "Allow querying user quota" for this key on the upstream to see the real balance.`)
	}

	body, err = GetResponseBody(ctx, "GET", baseURL+"/api/status", settings, nil)
	if err != nil {
		return 0, err
	}
	var status struct {
		Data struct {
			QuotaPerUnit float64 `json:"quota_per_unit"`
		} `json:"data"`
	}
	if err := common.Unmarshal(body, &status); err != nil {
		return 0, err
	}
	if status.Data.QuotaPerUnit <= 0 {
		return 0, errors.New("New API /api/status response is missing quota_per_unit")
	}
	balance := remaining / status.Data.QuotaPerUnit
	return balance, nil
}

func fetchAdvancedCustomBalance(ctx context.Context, channel *model.Channel, key string, settings channelBalanceSettings) (channelBalanceResult, error) {
	key = strings.TrimSpace(key)
	info := &relaycommon.RelayInfo{
		RelayFormat:    types.RelayFormatOpenAI,
		RelayMode:      relayconstant.RelayModeUnknown,
		RequestURLPath: dto.AdvancedCustomBalancePath,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:          constant.ChannelTypeAdvancedCustom,
			ChannelBaseUrl:       channel.GetBaseURL(),
			ApiKey:               key,
			ChannelOtherSettings: settings.otherSettings,
		},
	}
	requestURL, headers, err := (&advancedcustom.Adaptor{}).BuildBalanceRequest(info)
	if err != nil {
		return channelBalanceResult{}, sanitizeFetchModelsError(err, key)
	}
	if err := applyFetchModelsHeaderOverrides(channel, key, headers); err != nil {
		return channelBalanceResult{}, sanitizeFetchModelsError(err, key)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return channelBalanceResult{}, sanitizeFetchModelsError(err, key)
	}
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
		if strings.EqualFold(name, "Host") {
			request.Host = headers.Get(name)
		}
	}
	client, err := service.GetHttpClientWithProxySettings(settings.transportSettings.Proxy, settings.transportSettings)
	if err != nil {
		return channelBalanceResult{}, sanitizeFetchModelsError(err, key)
	}
	response, err := client.Do(request)
	if err != nil {
		return channelBalanceResult{}, sanitizeAdvancedCustomRequestError(err, key, requestURL)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return channelBalanceResult{}, fmt.Errorf("status code: %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAdvancedCustomBalanceResponseBytes+1))
	if err != nil {
		return channelBalanceResult{}, sanitizeAdvancedCustomRequestError(err, key, requestURL)
	}
	if len(body) > maxAdvancedCustomBalanceResponseBytes {
		return channelBalanceResult{}, fmt.Errorf("balance response exceeds %d bytes", maxAdvancedCustomBalanceResponseBytes)
	}

	var validated json.RawMessage
	if err := common.Unmarshal(body, &validated); err != nil {
		return channelBalanceResult{}, fmt.Errorf("invalid balance JSON response: %w", err)
	}
	if common.GetJsonType(validated) == "object" {
		var creditSummary struct {
			Object         string          `json:"object"`
			TotalAvailable json.RawMessage `json:"total_available"`
		}
		if err := common.Unmarshal(body, &creditSummary); err != nil {
			return channelBalanceResult{}, fmt.Errorf("invalid balance JSON response: %w", err)
		}
		if creditSummary.Object == "credit_summary" &&
			common.GetJsonType(creditSummary.TotalAvailable) == "number" {
			var balance float64
			if err := common.Unmarshal(creditSummary.TotalAvailable, &balance); err == nil &&
				balance >= 0 &&
				!math.IsNaN(balance) &&
				!math.IsInf(balance, 0) {
				return channelBalanceResult{Balance: balance}, nil
			}
		}
	}

	formatted, err := common.IndentJson(body)
	if err != nil {
		return channelBalanceResult{}, fmt.Errorf("invalid balance JSON response: %w", err)
	}
	return channelBalanceResult{RawResponse: string(formatted)}, nil
}

func updateChannelBalance(channel *model.Channel) (channelBalanceResult, error) {
	if channel.BalanceSource == "" {
		channel.BalanceSource = model.ChannelBalanceSourceChannel
	}
	if channel.BalanceSource == model.ChannelBalanceSourceNone {
		return channelBalanceResult{}, common.NewMessage("Balance queries are disabled for this channel")
	}
	if channel.BalanceSource == model.ChannelBalanceSourceUpstream {
		result, err := service.RefreshUpstreamChannelBalances(context.Background(), channel.Id, model.UpstreamTriggerManual)
		if err != nil {
			return channelBalanceResult{}, common.NewMessage("Failed to fetch linked upstream accounts: {{error}}", map[string]any{"error": err.Error()})
		}
		if result == nil || result.Summary == nil {
			return channelBalanceResult{}, common.NewMessage("No upstream account balance was returned")
		}
		if result.Summary.Unit == "MIXED" {
			return channelBalanceResult{}, common.NewMessage("Linked upstream account balances use different units and cannot be summed")
		}
		return channelBalanceResult{Balance: result.Summary.Balance}, nil
	}
	result, err := fetchChannelBalance(context.Background(), channel, channel.Key, readChannelBalanceSettings(channel))
	if err == nil && result.RawResponse == "" {
		channel.UpdateBalance(result.Balance)
	}
	return result, err
}

// errChannelBalanceUnsupported answers a balance query for a channel type
// whose upstream has no balance API this gateway knows.
var errChannelBalanceUnsupported = common.NewMessage("Not implemented yet")

// channelBalanceSettings are the channel settings a balance query uses. The
// channel's setting getters save the whole channel when a setting does not
// parse, so they are read once, before any key is asked, and never on a
// channel holding only the key being asked.
type channelBalanceSettings struct {
	transportSettings dto.ChannelSettings
	otherSettings     dto.ChannelOtherSettings
}

func readChannelBalanceSettings(channel *model.Channel) channelBalanceSettings {
	return channelBalanceSettings{
		transportSettings: channel.GetSetting(),
		otherSettings:     channel.GetOtherSettings(),
	}
}

// fetchChannelBalance asks the upstream for the balance of one key of the
// channel, without saving it. The channel is only read.
func fetchChannelBalance(ctx context.Context, channel *model.Channel, key string, settings channelBalanceSettings) (channelBalanceResult, error) {
	if channel.Type == constant.ChannelTypeAdvancedCustom {
		return fetchAdvancedCustomBalance(ctx, channel, key, settings)
	}
	balance, err := fetchStandardChannelBalance(ctx, channel, key, settings.transportSettings)
	return channelBalanceResult{Balance: balance}, err
}

// channelKeyBalanceRefresh is how reading the balance of every key of a
// multi-key channel went. Failed counts the keys not refreshed, whether
// their upstream refused them or the deadline came first.
type channelKeyBalanceRefresh struct {
	Summary *model.ChannelKeyBalanceSummary
	Failed  int
	Errors  []string
}

const (
	// channelKeyBalanceConcurrency bounds how many keys of one channel are
	// read at once, so their upstream is not flooded.
	channelKeyBalanceConcurrency = 4
	// channelKeyBalanceTimeout bounds a whole refresh, so a channel with many
	// keys answers before a proxy in front gives up on the request. A key
	// not read by then is left as it was.
	channelKeyBalanceTimeout = 40 * time.Second
	// channelKeyBalanceErrorLines bounds the failures a refresh spells out;
	// the rest are only counted.
	channelKeyBalanceErrorLines = 20
)

// refreshChannelKeyBalances reads the balance of every key of a multi-key
// channel and saves them with their total. The channel must be loaded with
// its keys.
func refreshChannelKeyBalances(channel *model.Channel) (*channelKeyBalanceRefresh, error) {
	// Different keys can report the same wallet, so their balances cannot be summed.
	// The caller handles explicitly bound upstream accounts before reaching this path.
	if channel.Type == constant.ChannelTypeNewAPI || channel.Type == constant.ChannelTypeSub2API {
		return nil, common.NewMessage("Multi-key channels may share an upstream balance. Bind upstream accounts to query their balance.")
	}
	keys := channel.GetKeys()
	if len(keys) == 0 {
		return nil, common.NewMessage("The channel has no keys available for balance queries")
	}
	settings := readChannelBalanceSettings(channel)
	ctx, cancel := context.WithTimeout(context.Background(), channelKeyBalanceTimeout)
	defer cancel()
	balances := make([]float64, len(keys))
	failures := make([]error, len(keys))
	reached := make([]bool, len(keys))
	readKey := func(index int) {
		// Unlike the request goroutine, nothing recovers a panic here for the
		// server, so one key must not take it down.
		defer func() {
			if recovered := recover(); recovered != nil {
				reached[index] = true
				failures[index] = fmt.Errorf("查询余额出错: %v", recovered)
			}
		}()
		if ctx.Err() != nil {
			return
		}
		result, err := fetchChannelBalance(ctx, channel, keys[index], settings)
		if errors.Is(err, context.DeadlineExceeded) {
			return
		}
		reached[index] = true
		if err == nil && result.RawResponse != "" {
			err = errors.New("余额响应格式无法识别")
		}
		balances[index] = result.Balance
		failures[index] = err
	}
	// The keys wait in line stalest first, so a refresh the deadline cuts
	// short reaches the keys it left out first next time.
	queue := make(chan int)
	var wg sync.WaitGroup
	for range channelKeyBalanceConcurrency {
		wg.Go(func() {
			for index := range queue {
				readKey(index)
			}
		})
	}
	for _, index := range model.ChannelKeyReadOrder(channel.Id, keys) {
		queue <- index
	}
	close(queue)
	wg.Wait()

	refresh := &channelKeyBalanceRefresh{Errors: []string{}}
	reads := make([]model.ChannelKeyBalanceRead, 0, len(keys))
	skipped := 0
	for index, key := range keys {
		err := failures[index]
		switch {
		case errors.Is(err, errChannelBalanceUnsupported):
			return nil, err
		case !reached[index]:
			skipped++
		case err != nil:
			refresh.Failed++
			if len(refresh.Errors) < channelKeyBalanceErrorLines {
				refresh.Errors = append(refresh.Errors, fmt.Sprintf("#%d: %s", index+1, err.Error()))
			}
			reads = append(reads, model.ChannelKeyBalanceRead{Key: key, Failed: true})
		default:
			reads = append(reads, model.ChannelKeyBalanceRead{Key: key, Balance: balances[index]})
		}
	}
	if unlisted := refresh.Failed - len(refresh.Errors); unlisted > 0 {
		refresh.Errors = append(refresh.Errors, fmt.Sprintf("另有 %d 个密钥刷新失败", unlisted))
	}
	if skipped > 0 {
		refresh.Failed += skipped
		refresh.Errors = append(refresh.Errors, fmt.Sprintf("%d 个密钥未在时限内查询，下次刷新时优先查询", skipped))
	}
	summary, err := model.SaveChannelKeyBalances(channel.Id, reads)
	if err != nil {
		return nil, err
	}
	refresh.Summary = summary
	return refresh, nil
}

func fetchStandardChannelBalance(ctx context.Context, channel *model.Channel, key string, settings dto.ChannelSettings) (float64, error) {
	baseURL := channel.GetBaseURL()
	if baseURL == "" {
		baseURL = constant.GetChannelBaseURL(channel.Type)
	}
	switch channel.Type {
	case constant.ChannelTypeOpenAI, constant.ChannelTypeCustom:
	case constant.ChannelTypeAzure:
		return 0, errChannelBalanceUnsupported
	//case common.ChannelTypeOpenAISB:
	//	return fetchChannelOpenAISBBalance(ctx, key, settings)
	case constant.ChannelTypeAIProxy:
		return fetchChannelAIProxyBalance(ctx, key, settings)
	case constant.ChannelTypeAPI2GPT:
		return fetchChannelAPI2GPTBalance(ctx, key, settings)
	case constant.ChannelTypeAIGC2D:
		return fetchChannelAIGC2DBalance(ctx, key, settings)
	case constant.ChannelTypeSiliconFlow:
		return fetchChannelSiliconFlowBalance(ctx, key, settings)
	case constant.ChannelTypeDeepSeek:
		return fetchChannelDeepSeekBalance(ctx, key, settings)
	case constant.ChannelTypeOpenRouter:
		return fetchChannelOpenRouterBalance(ctx, key, settings)
	case constant.ChannelTypeMoonshot:
		return fetchChannelMoonshotBalance(ctx, key, settings)
	case constant.ChannelTypeSub2API:
		return fetchChannelSub2APIBalance(ctx, baseURL, key, settings)
	case constant.ChannelTypeNewAPI:
		return fetchChannelNewAPIBalance(ctx, baseURL, key, settings)
	default:
		return 0, errChannelBalanceUnsupported
	}
	url := fmt.Sprintf("%s/v1/dashboard/billing/subscription", baseURL)

	body, err := GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}
	subscription := OpenAISubscriptionResponse{}
	err = common.Unmarshal(body, &subscription)
	if err != nil {
		return 0, err
	}
	now := time.Now()
	startDate := fmt.Sprintf("%s-01", now.Format("2006-01"))
	endDate := now.Format("2006-01-02")
	if !subscription.HasPaymentMethod {
		startDate = now.AddDate(0, 0, -100).Format("2006-01-02")
	}
	url = fmt.Sprintf("%s/v1/dashboard/billing/usage?start_date=%s&end_date=%s", baseURL, startDate, endDate)
	body, err = GetResponseBody(ctx, "GET", url, settings, GetAuthHeader(key))
	if err != nil {
		return 0, err
	}
	usage := OpenAIUsageResponse{}
	err = common.Unmarshal(body, &usage)
	if err != nil {
		return 0, err
	}
	balance := subscription.HardLimitUSD - usage.TotalUsage/100
	return balance, nil
}

func UpdateChannelBalance(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	channel, err := model.GetChannelById(id, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if channel.BalanceSource == model.ChannelBalanceSourceUpstream {
		refreshResult, refreshErr := service.RefreshUpstreamChannelBalances(c.Request.Context(), channel.Id, model.UpstreamTriggerManual)
		if refreshErr != nil {
			common.ApiError(c, refreshErr)
			return
		}
		if refreshResult == nil || refreshResult.Summary == nil {
			common.ApiErrorT(c, "No upstream account balance was returned")
			return
		}
		summary := refreshResult.Summary
		if summary.Unit == "MIXED" {
			common.ApiErrorStatus(c, http.StatusOK, common.NewMessage("Linked upstream account balances use different units and cannot be summed"), gin.H{
				"balance_source":   channel.BalanceSource,
				"balance_status":   summary.Status,
				"account_balances": summary.Accounts,
			})
			return
		}
		response := gin.H{
			"success":              true,
			"message":              "",
			"balance":              summary.Balance,
			"currency":             summary.Unit,
			"balance_source":       channel.BalanceSource,
			"balance_status":       summary.Status,
			"balance_updated_time": summary.UpdatedTime,
			"account_count":        summary.AccountCount,
			"account_balances":     summary.Accounts,
			"refresh_failed":       refreshResult.Failed,
			"refresh_errors":       refreshResult.Errors,
		}
		if refreshResult.Failed > 0 {
			message := common.NewMessage("{{count}} upstream accounts failed to refresh; the total includes their most recent balances", map[string]any{"count": refreshResult.Failed})
			response["message"] = message.Error()
			maps.Copy(response, message.Fields())
		}
		c.JSON(http.StatusOK, response)
		return
	}
	if channel.Type == constant.ChannelTypeTaskPlugin {
		common.ApiErrorT(c, "Task Plugin channels do not support balance queries")
		return
	}
	if channel.ChannelInfo.IsMultiKey {
		if channel.BalanceSource == model.ChannelBalanceSourceNone {
			common.ApiErrorT(c, "Balance queries are disabled for this channel")
			return
		}
		refresh, err := refreshChannelKeyBalances(channel)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"success":              true,
			"message":              "",
			"balance":              refresh.Summary.Balance,
			"currency":             "USD",
			"balance_source":       channel.BalanceSource,
			"balance_updated_time": refresh.Summary.UpdatedTime,
			"key_count":            len(refresh.Summary.Keys),
			"key_balances":         refresh.Summary.Keys,
			"refresh_failed":       refresh.Failed,
			"refresh_errors":       refresh.Errors,
		})
		return
	}
	result, err := updateChannelBalance(channel)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	response := gin.H{
		"success": true,
		"message": "",
	}
	if result.RawResponse == "" {
		response["balance"] = result.Balance
		response["currency"] = "USD"
	} else {
		response["raw_response"] = result.RawResponse
	}
	response["balance_source"] = channel.BalanceSource
	response["balance_updated_time"] = common.GetTimestamp()
	c.JSON(http.StatusOK, response)
}

func updateAllChannelsBalance() error {
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		return err
	}
	refreshedUpstreamAccounts := make(map[int]struct{})
	for _, channel := range channels {
		if channel.Status != common.ChannelStatusEnabled {
			continue
		}
		if channel.BalanceSource == model.ChannelBalanceSourceNone {
			continue
		}
		if channel.BalanceSource == model.ChannelBalanceSourceUpstream {
			accounts, accountErr := model.GetUpstreamAccountsForChannel(channel.Id)
			if accountErr != nil {
				continue
			}
			for _, account := range accounts {
				if _, refreshed := refreshedUpstreamAccounts[account.Id]; refreshed {
					continue
				}
				refreshedUpstreamAccounts[account.Id] = struct{}{}
				_, _ = service.RefreshUpstreamAccountBalance(context.Background(), account, model.UpstreamTriggerScheduled)
				time.Sleep(common.RequestInterval)
			}
			continue
		}
		if channel.ChannelInfo.IsMultiKey {
			// A key that runs out is disabled by the request that fails on it,
			// so reading its balance disables nothing. The list is as old as
			// this run, and reading a setting that does not parse saves the
			// channel, so the refresh works on the channel as it is now.
			if current, err := model.GetChannelById(channel.Id, true); err == nil {
				_, _ = refreshChannelKeyBalances(current)
			}
			time.Sleep(common.RequestInterval)
			continue
		}
		// TODO: support Azure
		//if channel.Type != common.ChannelTypeOpenAI && channel.Type != common.ChannelTypeCustom {
		//	continue
		//}
		result, err := updateChannelBalance(channel)
		if err != nil {
			continue
		} else if result.RawResponse == "" {
			// err is nil & balance <= 0 means quota is used up
			if result.Balance <= 0 {
				service.DisableChannel(*types.NewChannelError(channel.Id, channel.Type, channel.Name, channel.ChannelInfo.IsMultiKey, "", channel.GetAutoBan()), "Insufficient balance")
			}
		}
		time.Sleep(common.RequestInterval)
	}
	return nil
}

func UpdateAllChannelsBalance(c *gin.Context) {
	// TODO: make it async
	err := updateAllChannelsBalance()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
	return
}

func AutomaticallyUpdateChannels(frequency int) {
	for {
		time.Sleep(time.Duration(frequency) * time.Minute)
		common.SysLog(common.LogText("updating all channels"))
		_ = updateAllChannelsBalance()
		common.SysLog(common.LogText("channels update done"))
	}
}

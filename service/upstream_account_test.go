package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpstreamAccountBalanceAndCheckinUseRealQuotaConversion(t *testing.T) {
	truncate(t)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		assert.Equal(t, "Bearer dashboard-token", request.Header.Get("Authorization"))
		assert.Equal(t, "42", request.Header.Get("New-Api-User"))
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/status":
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"success": true,
				"data":    map[string]any{"quota_per_unit": 100},
			})
		case "/api/user/self":
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"success": true,
				"data":    map[string]any{"quota": 1234},
			})
		case "/api/user/checkin":
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"success": true,
				"message": "签到成功",
				"data":    map[string]any{"quota_awarded": 25},
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	account := &model.UpstreamAccount{
		Name:            "test upstream",
		BaseURL:         server.URL,
		SiteType:        model.UpstreamSiteTypeNewAPI,
		AuthType:        model.UpstreamAuthTypeToken,
		UserId:          42,
		Credential:      "dashboard-token",
		AutoBalance:     true,
		BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(account))

	balanceResult, err := RefreshUpstreamAccountBalance(context.Background(), account, model.UpstreamTriggerManual)
	require.NoError(t, err)
	assert.Equal(t, "USD", balanceResult.Unit)
	assert.InDelta(t, 12.34, balanceResult.Balance, 0.000001)

	checkinResult, err := CheckinUpstreamAccount(context.Background(), account, model.UpstreamTriggerManual)
	require.NoError(t, err)
	assert.InDelta(t, 25, checkinResult.Reward, 0.000001)

	stored, err := model.GetUpstreamAccountById(account.Id)
	require.NoError(t, err)
	assert.Equal(t, model.UpstreamStatusHealthy, stored.BalanceStatus)
	assert.Equal(t, model.UpstreamStatusHealthy, stored.LastCheckinStatus)
	assert.Equal(t, "USD", stored.BalanceUnit)
	assert.InDelta(t, 12.34, stored.Balance, 0.000001)

	logs, err := model.ListUpstreamAccountLogs(account.Id, 20)
	require.NoError(t, err)
	assert.Len(t, logs, 3) // balance, check-in, post-check-in balance refresh
}

func TestUpstreamAccountCredentialIsEncryptedAndNotSerialized(t *testing.T) {
	truncate(t)
	account := &model.UpstreamAccount{
		Name:            "encrypted",
		BaseURL:         "https://example.com",
		Credential:      "plain-secret",
		AutoBalance:     true,
		BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(account))

	var stored model.UpstreamAccount
	require.NoError(t, model.DB.First(&stored, account.Id).Error)
	assert.NotEmpty(t, stored.CredentialCiphertext)
	assert.NotContains(t, stored.CredentialCiphertext, "plain-secret")

	encoded, err := json.Marshal(account)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "plain-secret")
	assert.NotContains(t, string(encoded), "credential_ciphertext")
}

func TestScheduledUpstreamCheckinRetriesAfterSixHoursAndStopsAtFourAttempts(t *testing.T) {
	truncate(t)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"success": false,
			"message": "temporary upstream failure",
		})
	}))
	defer server.Close()

	account := &model.UpstreamAccount{
		Name:            "retry upstream",
		BaseURL:         server.URL,
		SiteType:        model.UpstreamSiteTypeNewAPI,
		AuthType:        model.UpstreamAuthTypeToken,
		Credential:      "dashboard-token",
		AutoCheckin:     true,
		AutoBalance:     false,
		BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(account))

	for attempt := 1; attempt <= upstreamCheckinMaxAttemptsPerDay; attempt++ {
		before := time.Now().Unix()
		_, err := CheckinUpstreamAccount(context.Background(), account, model.UpstreamTriggerScheduled)
		require.Error(t, err)

		stored, loadErr := model.GetUpstreamAccountById(account.Id)
		require.NoError(t, loadErr)
		assert.Equal(t, attempt, stored.CheckinAttempts)
		assert.Equal(t, time.Now().Format("2006-01-02"), stored.CheckinAttemptDate)
		if attempt < upstreamCheckinMaxAttemptsPerDay {
			minNext := before + int64(upstreamCheckinRetryInterval.Seconds())
			maxNext := before + int64((upstreamCheckinRetryInterval + upstreamCheckinRetryJitter).Seconds()) + 2
			assert.GreaterOrEqual(t, stored.NextCheckinTime, minNext)
			assert.LessOrEqual(t, stored.NextCheckinTime, maxNext)
		} else {
			assert.Equal(t, nextUpstreamCheckinDay(time.Now()), stored.NextCheckinTime)
		}
		account = stored
	}

	logs, err := model.ListUpstreamAccountLogs(account.Id, 20)
	require.NoError(t, err)
	checkinTriggers := make([]string, 0, len(logs))
	for _, log := range logs {
		if log.Type == model.UpstreamLogTypeCheckin {
			checkinTriggers = append(checkinTriggers, log.Trigger)
		}
	}
	assert.Equal(t, []string{
		model.UpstreamTriggerRetry,
		model.UpstreamTriggerRetry,
		model.UpstreamTriggerRetry,
		model.UpstreamTriggerScheduled,
	}, checkinTriggers)
}

func TestUpstreamAccountAdaptersCoverNonNewAPISites(t *testing.T) {
	truncate(t)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/user/sign_in":
			assert.Equal(t, "session=anyrouter", request.Header.Get("Cookie"))
			assert.Equal(t, "XMLHttpRequest", request.Header.Get("X-Requested-With"))
			_ = json.NewEncoder(writer).Encode(map[string]any{"success": true, "message": "签到成功", "data": map[string]any{"quota_awarded": 8}})
		case "/api/user/self":
			_ = json.NewEncoder(writer).Encode(map[string]any{"success": true, "data": map[string]any{"quota": 2000}})
		case "/api/status":
			_ = json.NewEncoder(writer).Encode(map[string]any{"success": true, "data": map[string]any{"quota_per_unit": 100}})
		case "/api/user/info":
			_ = json.NewEncoder(writer).Encode(map[string]any{"code": 0, "data": map[string]any{"basicBalance": 1.25, "bindBalance": 0.75}})
		case "/api/check_in":
			_ = json.NewEncoder(writer).Encode(map[string]any{"code": 1, "message": "今日已签到"})
		case "/credits":
			_ = json.NewEncoder(writer).Encode(map[string]any{"data": map[string]any{"total_credits": 10, "total_usage": 2.5}})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	anyRouter := &model.UpstreamAccount{
		Name: "AnyRouter", BaseURL: server.URL, SiteType: model.UpstreamSiteTypeAnyRouter,
		AuthType: model.UpstreamAuthTypeCookie, Credential: "session=anyrouter", AutoBalance: true, BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(anyRouter))
	anyBalance, err := RefreshUpstreamAccountBalance(context.Background(), anyRouter, model.UpstreamTriggerManual)
	require.NoError(t, err)
	assert.InDelta(t, 20, anyBalance.Balance, 0.000001)
	anyCheckin, err := CheckinUpstreamAccount(context.Background(), anyRouter, model.UpstreamTriggerManual)
	require.NoError(t, err)
	assert.InDelta(t, 8, anyCheckin.Reward, 0.000001)

	voapi := &model.UpstreamAccount{
		Name: "VoAPI v2", BaseURL: server.URL, SiteType: model.UpstreamSiteTypeVoAPIV2,
		AuthType: model.UpstreamAuthTypeToken, Credential: "voapi-token", AutoBalance: true, BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(voapi))
	voBalance, err := RefreshUpstreamAccountBalance(context.Background(), voapi, model.UpstreamTriggerManual)
	require.NoError(t, err)
	assert.InDelta(t, 2, voBalance.Balance, 0.000001)
	voCheckin, err := CheckinUpstreamAccount(context.Background(), voapi, model.UpstreamTriggerManual)
	require.NoError(t, err)
	assert.Equal(t, "今日已签到", voCheckin.Message)

	openRouter := &model.UpstreamAccount{
		Name: "OpenRouter", BaseURL: server.URL, SiteType: model.UpstreamSiteTypeOpenRouter,
		AuthType: model.UpstreamAuthTypeToken, Credential: "openrouter-token", AutoBalance: true, BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(openRouter))
	openBalance, err := RefreshUpstreamAccountBalance(context.Background(), openRouter, model.UpstreamTriggerManual)
	require.NoError(t, err)
	assert.InDelta(t, 7.5, openBalance.Balance, 0.000001)
}

func TestExternalUpstreamAccountDoesNotAttemptBuiltinRequests(t *testing.T) {
	truncate(t)
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		called = true
		http.Error(writer, "must not be called", http.StatusInternalServerError)
	}))
	defer server.Close()
	account := &model.UpstreamAccount{
		Name: "external", BaseURL: server.URL, SiteType: model.UpstreamSiteTypeOctopus,
		AuthType: model.UpstreamAuthTypeToken, Credential: "external-token", AutoBalance: true, BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(account))
	result, err := RefreshUpstreamAccountBalance(context.Background(), account, model.UpstreamTriggerManual)
	require.Error(t, err)
	assert.Equal(t, model.UpstreamStatusManualRequired, result.Status)
	assert.False(t, called)
}

func TestUpstreamAccountMetadataIsNormalizedAndPersisted(t *testing.T) {
	truncate(t)
	account := &model.UpstreamAccount{
		Name: "metadata", BaseURL: "https://example.com/", SiteType: "new-api",
		AuthType: model.UpstreamAuthTypeToken, Credential: "metadata-token",
		Notes: "  personal account  ", Tags: []string{" self ", "自用", "self"},
		ExternalCheckinURL: "https://example.com/checkin", RedeemURL: "https://example.com/redeem",
		OpenRedeemWithCheckin: true, AutoBalance: true, BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(account))
	stored, err := model.GetUpstreamAccountById(account.Id)
	require.NoError(t, err)
	assert.Equal(t, model.UpstreamSiteTypeNewAPI, stored.SiteType)
	assert.Equal(t, "personal account", stored.Notes)
	assert.Equal(t, []string{"self", "自用"}, stored.Tags)
	assert.Equal(t, "https://example.com/checkin", stored.ExternalCheckinURL)
	assert.True(t, stored.OpenRedeemWithCheckin)
}

func TestManyToManyUpstreamAccountChannelBalanceAggregation(t *testing.T) {
	truncate(t)
	seedChannel(t, 101)
	seedChannel(t, 102)

	first := &model.UpstreamAccount{
		Name:            "first account",
		BaseURL:         "https://first.example.com",
		Credential:      "first-token",
		AutoBalance:     false,
		BalanceInterval: 60,
	}
	second := &model.UpstreamAccount{
		Name:            "second account",
		BaseURL:         "https://second.example.com",
		Credential:      "second-token",
		AutoBalance:     false,
		BalanceInterval: 60,
	}
	require.NoError(t, model.CreateUpstreamAccount(first))
	require.NoError(t, model.CreateUpstreamAccount(second))

	require.NoError(t, model.ReplaceUpstreamAccountChannels(first.Id, []int{101, 102}))
	require.NoError(t, model.ReplaceUpstreamAccountChannels(second.Id, []int{101}))
	require.NoError(t, model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", first.Id).Updates(map[string]any{
		"balance": 10, "balance_unit": "USD", "balance_updated_time": 100, "balance_status": model.UpstreamStatusHealthy,
	}).Error)
	require.NoError(t, model.DB.Model(&model.UpstreamAccount{}).Where("id = ?", second.Id).Updates(map[string]any{
		"balance": 20, "balance_unit": "USD", "balance_updated_time": 200, "balance_status": model.UpstreamStatusHealthy,
	}).Error)

	var bindingCount int64
	require.NoError(t, model.DB.Model(&model.UpstreamAccountChannel{}).Where("channel_id = ?", 101).Count(&bindingCount).Error)
	assert.Equal(t, int64(2), bindingCount)

	summary, err := model.GetUpstreamChannelBalanceSummary(101)
	require.NoError(t, err)
	assert.Equal(t, 2, summary.AccountCount)
	assert.Equal(t, []int{first.Id, second.Id}, summary.AccountIds)
	assert.Equal(t, []string{"first account", "second account"}, summary.AccountNames)
	assert.Equal(t, "USD", summary.Unit)
	assert.InDelta(t, 30, summary.Balance, 0.000001)
	assert.Equal(t, int64(100), summary.UpdatedTime)

	channel, err := model.GetChannelById(101, false)
	require.NoError(t, err)
	require.NoError(t, model.HydrateChannelUpstreamBalances([]*model.Channel{channel}))
	require.NotNil(t, channel.UpstreamBalance)
	assert.InDelta(t, 30, *channel.UpstreamBalance, 0.000001)
	assert.Equal(t, 2, channel.UpstreamAccountCount)
	assert.Len(t, channel.UpstreamBalanceDetails, 2)

	require.NoError(t, model.UpdateChannelBalanceSource(101, model.ChannelBalanceSourceUpstream))
	require.NoError(t, model.DeleteUpstreamAccount(first.Id))

	remaining, err := model.GetUpstreamAccountsForChannel(101)
	require.NoError(t, err)
	assert.Len(t, remaining, 1)
	assert.Equal(t, second.Id, remaining[0].Id)
	remaining, err = model.GetUpstreamAccountsForChannel(102)
	assert.Error(t, err)
	assert.Empty(t, remaining)
	summary, err = model.GetUpstreamChannelBalanceSummary(101)
	// Channel 102 no longer has a bound account after deleting the first one.
	_, channelTwoErr := model.GetUpstreamChannelBalanceSummary(102)
	assert.Error(t, channelTwoErr)
	require.NoError(t, err)
	assert.Equal(t, 1, summary.AccountCount)
	assert.InDelta(t, 20, summary.Balance, 0.000001)

	require.NoError(t, model.DeleteUpstreamAccount(second.Id))
	var links int64
	require.NoError(t, model.DB.Model(&model.UpstreamAccountChannel{}).Where("channel_id = ?", 101).Count(&links).Error)
	assert.Equal(t, int64(0), links)
	channel, err = model.GetChannelById(101, false)
	require.NoError(t, err)
	assert.Equal(t, model.ChannelBalanceSourceChannel, channel.BalanceSource)
	channel, err = model.GetChannelById(102, false)
	require.NoError(t, err)
	assert.Equal(t, model.ChannelBalanceSourceChannel, channel.BalanceSource)
}

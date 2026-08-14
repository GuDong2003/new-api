package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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

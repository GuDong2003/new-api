package controller

import (
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const checkinSiteURL = "https://upstream.example.com"

type channelSaveResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// checkinAccount is one entry of the account list the channel editor sends.
func checkinAccount(fields map[string]any) map[string]any {
	entry := map[string]any{
		"enabled":          true,
		"base_url":         checkinSiteURL,
		"site_type":        model.UpstreamSiteTypeNewAPI,
		"auth_type":        model.UpstreamAuthTypeToken,
		"auto_checkin":     true,
		"auto_balance":     true,
		"balance_interval": 60,
	}
	for key, value := range fields {
		entry[key] = value
	}
	return entry
}

func createCheckinChannel(t *testing.T, name, settings string, accounts ...map[string]any) (channelSaveResponse, model.Channel) {
	t.Helper()
	response := createCheckinChannels(t, "single", name, "sk-test", settings, accounts...)
	var saved model.Channel
	if response.Success {
		require.NoError(t, model.DB.Where("name = ?", name).First(&saved).Error)
	}
	return response, saved
}

func createCheckinChannels(t *testing.T, mode, name, key, settings string, accounts ...map[string]any) channelSaveResponse {
	t.Helper()
	channel := map[string]any{
		"type":     1,
		"name":     name,
		"key":      key,
		"models":   "gpt-test",
		"group":    "default",
		"base_url": checkinSiteURL,
		"settings": settings,
	}
	if accounts != nil {
		channel["upstream_account_configs"] = accounts
	}
	var response channelSaveResponse
	modelManagementRequest(t, AddChannel, http.MethodPost, "/api/channel/", map[string]any{"mode": mode, "channel": channel}, &response)
	return response
}

func saveCheckinChannel(t *testing.T, channel model.Channel, fields map[string]any) (channelSaveResponse, string) {
	t.Helper()
	body := map[string]any{
		"id":       channel.Id,
		"type":     channel.Type,
		"name":     channel.Name,
		"models":   channel.Models,
		"group":    channel.Group,
		"base_url": checkinSiteURL,
	}
	for key, value := range fields {
		body[key] = value
	}
	var response channelSaveResponse
	recorder := modelManagementRequest(t, UpdateChannel, http.MethodPut, "/api/channel/", body, &response)
	return response, recorder.Body.String()
}

func checkinAccountsOf(t *testing.T, channelId int) []*model.UpstreamAccount {
	t.Helper()
	accounts, err := model.GetUpstreamAccountsForChannel(channelId)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	require.NoError(t, err)
	return accounts
}

func accountCredential(t *testing.T, account *model.UpstreamAccount) string {
	t.Helper()
	credential, err := account.GetCredential()
	require.NoError(t, err)
	return credential
}

func TestChannelEditorSavesEveryCheckinAccount(t *testing.T) {
	for _, dialect := range []struct{ kind, env string }{{"sqlite", ""}, {"mysql", "TEST_MYSQL_DSN"}, {"postgres", "TEST_POSTGRES_DSN"}} {
		t.Run(dialect.kind, func(t *testing.T) {
			if dialect.env != "" && os.Getenv(dialect.env) == "" {
				t.Skip("set " + dialect.env + " to run this database")
			}
			database := modelManagementDB(t, dialect.kind, os.Getenv(dialect.env))
			require.NoError(t, database.AutoMigrate(&model.UpstreamAccount{}, &model.UpstreamAccountChannel{}, &model.UpstreamAccountLog{}))

			t.Run("a new channel checks in on every listed account", func(t *testing.T) {
				response, channel := createCheckinChannel(t, "多账号渠道", "{}",
					checkinAccount(map[string]any{"user_id": 11, "credential": "token-a"}),
					checkinAccount(map[string]any{"name": "备用号", "credential": "token-b", "auto_checkin": false}),
				)
				require.True(t, response.Success, response.Message)

				accounts := checkinAccountsOf(t, channel.Id)
				require.Len(t, accounts, 2)
				assert.Equal(t, "多账号渠道 · 11", accounts[0].Name)
				assert.Equal(t, "token-a", accountCredential(t, accounts[0]))
				assert.True(t, accounts[0].AutoCheckin)
				assert.Positive(t, accounts[0].NextCheckinTime)
				assert.Equal(t, "备用号", accounts[1].Name)
				assert.Equal(t, "token-b", accountCredential(t, accounts[1]))
				assert.False(t, accounts[1].AutoCheckin)
				assert.Zero(t, accounts[1].NextCheckinTime)
				require.NoError(t, model.DB.First(&channel, channel.Id).Error)
				assert.Equal(t, model.ChannelBalanceSourceUpstream, channel.BalanceSource)

				// The channel API lists every account, and never a credential.
				require.NoError(t, model.HydrateChannelUpstreamBalances([]*model.Channel{&channel}))
				require.NotNil(t, channel.UpstreamAccountConfigs)
				assert.Len(t, *channel.UpstreamAccountConfigs, 2)
				encoded, err := common.Marshal(channel)
				require.NoError(t, err)
				assert.NotContains(t, string(encoded), "token-a")
				assert.NotContains(t, string(encoded), "token-b")
			})

			t.Run("one save updates, adds and removes accounts", func(t *testing.T) {
				response, channel := createCheckinChannel(t, "改账号渠道", "{}",
					checkinAccount(map[string]any{"user_id": 11, "credential": "token-a"}),
					checkinAccount(map[string]any{"user_id": 12, "credential": "token-b"}),
				)
				require.True(t, response.Success, response.Message)
				before := checkinAccountsOf(t, channel.Id)
				require.Len(t, before, 2)
				kept, removed := before[0], before[1]
				require.NoError(t, model.CreateUpstreamAccountLog(&model.UpstreamAccountLog{AccountId: removed.Id, Type: model.UpstreamLogTypeCheckin, Status: model.UpstreamStatusHealthy}))

				response, body := saveCheckinChannel(t, channel, map[string]any{
					"upstream_account_loaded_ids": []int{removed.Id, kept.Id},
					"upstream_account_configs": []map[string]any{
						checkinAccount(map[string]any{"id": kept.Id, "name": "主号", "user_id": 21, "auto_checkin": false}),
						checkinAccount(map[string]any{"user_id": 31, "credential": "token-c"}),
					},
				})
				require.True(t, response.Success, response.Message)
				assert.NotContains(t, body, "token-c", "the saved channel is returned without credentials")

				after := checkinAccountsOf(t, channel.Id)
				require.Len(t, after, 2)
				assert.Equal(t, kept.Id, after[0].Id)
				assert.Equal(t, "主号", after[0].Name)
				assert.Equal(t, 21, after[0].UserId)
				assert.False(t, after[0].AutoCheckin)
				assert.Zero(t, after[0].NextCheckinTime)
				assert.Equal(t, "token-a", accountCredential(t, after[0]), "an empty credential keeps the saved one")
				assert.Equal(t, "改账号渠道 · 31", after[1].Name)
				assert.Equal(t, "token-c", accountCredential(t, after[1]))

				// An account no other channel uses is deleted, so it stops checking in.
				_, err := model.GetUpstreamAccountById(removed.Id)
				assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
				logs, err := model.ListUpstreamAccountLogs(removed.Id, 10)
				require.NoError(t, err)
				assert.Empty(t, logs)
			})

			t.Run("removing an account another channel uses only unbinds it", func(t *testing.T) {
				response, first := createCheckinChannel(t, "共享账号渠道", "{}",
					checkinAccount(map[string]any{"user_id": 11, "credential": "token-a"}),
				)
				require.True(t, response.Success, response.Message)
				response, second := createCheckinChannel(t, "共享账号渠道二", "{}")
				require.True(t, response.Success, response.Message)
				shared := checkinAccountsOf(t, first.Id)[0]
				require.NoError(t, model.BindUpstreamAccountChannel(shared.Id, second.Id))

				response, _ = saveCheckinChannel(t, first, map[string]any{"upstream_account_configs": []map[string]any{}})
				require.True(t, response.Success, response.Message)

				assert.Empty(t, checkinAccountsOf(t, first.Id))
				remaining := checkinAccountsOf(t, second.Id)
				require.Len(t, remaining, 1)
				assert.Equal(t, shared.Id, remaining[0].Id)
				require.NoError(t, model.DB.First(&first, first.Id).Error)
				assert.Equal(t, model.ChannelBalanceSourceChannel, first.BalanceSource)
			})

			t.Run("a save without the account list keeps the accounts", func(t *testing.T) {
				response, channel := createCheckinChannel(t, "不改账号渠道", "{}",
					checkinAccount(map[string]any{"user_id": 11, "credential": "token-a"}),
				)
				require.True(t, response.Success, response.Message)

				response, _ = saveCheckinChannel(t, channel, map[string]any{"remark": "只改备注"})
				require.True(t, response.Success, response.Message)

				accounts := checkinAccountsOf(t, channel.Id)
				require.Len(t, accounts, 1)
				assert.Equal(t, "token-a", accountCredential(t, accounts[0]))
			})

			t.Run("a rejected entry leaves every account as it was", func(t *testing.T) {
				response, channel := createCheckinChannel(t, "拒绝保存渠道", "{}",
					checkinAccount(map[string]any{"name": "原名", "credential": "token-a"}),
				)
				require.True(t, response.Success, response.Message)
				response, other := createCheckinChannel(t, "拒绝保存渠道二", "{}",
					checkinAccount(map[string]any{"credential": "token-d"}),
				)
				require.True(t, response.Success, response.Message)
				own := checkinAccountsOf(t, channel.Id)[0]
				foreign := checkinAccountsOf(t, other.Id)[0]

				for _, entries := range [][]map[string]any{
					{
						checkinAccount(map[string]any{"id": own.Id, "name": "新名"}),
						checkinAccount(map[string]any{"id": foreign.Id}),
					},
					{
						checkinAccount(map[string]any{"id": own.Id, "name": "新名"}),
						checkinAccount(map[string]any{"user_id": 5}),
					},
				} {
					response, _ = saveCheckinChannel(t, channel, map[string]any{"remark": "不该保存", "upstream_account_configs": entries})
					assert.False(t, response.Success)
				}

				accounts := checkinAccountsOf(t, channel.Id)
				require.Len(t, accounts, 1)
				assert.Equal(t, "原名", accounts[0].Name)
				assert.Len(t, checkinAccountsOf(t, other.Id), 1)
				// A refused account list refuses the whole save, channel included.
				require.NoError(t, model.DB.First(&channel, channel.Id).Error)
				assert.Nil(t, channel.Remark)
			})

			t.Run("a save from an editor opened before an account was added changes nothing", func(t *testing.T) {
				response, channel := createCheckinChannel(t, "过期编辑渠道", "{}",
					checkinAccount(map[string]any{"name": "原名", "credential": "token-a"}),
				)
				require.True(t, response.Success, response.Message)
				shown := checkinAccountsOf(t, channel.Id)[0]
				added := &model.UpstreamAccount{Name: "另一页加的", BaseURL: checkinSiteURL, Credential: "token-b", AutoCheckin: true}
				require.NoError(t, model.CreateUpstreamAccount(added))
				require.NoError(t, model.BindUpstreamAccountChannel(added.Id, channel.Id))

				response, _ = saveCheckinChannel(t, channel, map[string]any{
					"remark":                      "不该保存",
					"upstream_account_loaded_ids": []int{shown.Id},
					"upstream_account_configs": []map[string]any{
						checkinAccount(map[string]any{"id": shown.Id, "name": "新名"}),
					},
				})
				assert.False(t, response.Success)
				assert.Contains(t, response.Message, "changed after it was opened")

				accounts := checkinAccountsOf(t, channel.Id)
				require.Len(t, accounts, 2)
				assert.Equal(t, "原名", accounts[0].Name)
				assert.Equal(t, added.Id, accounts[1].Id)
				require.NoError(t, model.DB.First(&channel, channel.Id).Error)
				assert.Nil(t, channel.Remark)
			})

			t.Run("a default account name is cut to what the column holds", func(t *testing.T) {
				name := strings.Repeat("渠", 190)
				response, channel := createCheckinChannel(t, name, "{}",
					checkinAccount(map[string]any{"user_id": 12345, "credential": "token-a"}),
				)
				require.True(t, response.Success, response.Message)

				accounts := checkinAccountsOf(t, channel.Id)
				require.Len(t, accounts, 1)
				assert.Equal(t, 191, utf8.RuneCountInString(accounts[0].Name))
				assert.True(t, strings.HasSuffix(accounts[0].Name, " · 12345"), accounts[0].Name)
			})

			t.Run("an account whose other channel was deleted goes with its last channel", func(t *testing.T) {
				response, kept := createCheckinChannel(t, "留下的渠道", "{}",
					checkinAccount(map[string]any{"credential": "token-a"}),
				)
				require.True(t, response.Success, response.Message)
				response, deleted := createCheckinChannel(t, "删掉的渠道", "{}")
				require.True(t, response.Success, response.Message)
				account := checkinAccountsOf(t, kept.Id)[0]
				require.NoError(t, model.BindUpstreamAccountChannel(account.Id, deleted.Id))
				_, err := model.BatchDeleteChannels([]int{deleted.Id})
				require.NoError(t, err)

				response, _ = saveCheckinChannel(t, kept, map[string]any{"upstream_account_configs": []map[string]any{}})
				require.True(t, response.Success, response.Message)

				_, err = model.GetUpstreamAccountById(account.Id)
				assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			})

			t.Run("channels created from a batch of keys share the accounts", func(t *testing.T) {
				response := createCheckinChannels(t, "batch", "批量渠道", "sk-one\nsk-two", "{}",
					checkinAccount(map[string]any{"credential": "token-a"}),
				)
				require.True(t, response.Success, response.Message)

				var channels []model.Channel
				require.NoError(t, model.DB.Where("name = ?", "批量渠道").Order("id asc").Find(&channels).Error)
				require.Len(t, channels, 2)
				first, second := checkinAccountsOf(t, channels[0].Id), checkinAccountsOf(t, channels[1].Id)
				require.Len(t, first, 1)
				require.Len(t, second, 1)
				assert.Equal(t, first[0].Id, second[0].Id)
			})

			t.Run("an account saved with automatic balance refresh off keeps it off", func(t *testing.T) {
				response, channel := createCheckinChannel(t, "不刷余额渠道", "{}",
					checkinAccount(map[string]any{"credential": "token-a", "auto_balance": false}),
				)
				require.True(t, response.Success, response.Message)

				accounts := checkinAccountsOf(t, channel.Id)
				require.Len(t, accounts, 1)
				assert.False(t, accounts[0].AutoBalance)
				assert.Zero(t, accounts[0].NextBalanceTime)
			})

			t.Run("check-in pages must be web addresses", func(t *testing.T) {
				response, _ := createCheckinChannel(t, "签到页渠道", `{"external_checkin_url":"https://upstream.example.com/checkin","redeem_url":"https://upstream.example.com/redeem"}`)
				require.True(t, response.Success, response.Message)

				response, _ = createCheckinChannel(t, "坏签到页渠道", `{"external_checkin_url":"javascript:alert(1)"}`)
				assert.False(t, response.Success)
				assert.Contains(t, response.Message, "external check-in URL")

				// Every account keeps a copy of the pages, in columns of 1024.
				response, _ = createCheckinChannel(t, "长签到页渠道", `{"redeem_url":"https://upstream.example.com/`+strings.Repeat("r", 1024)+`"}`)
				assert.False(t, response.Success)
				assert.Contains(t, response.Message, "cannot exceed 1024 characters")
			})
		})
	}
}

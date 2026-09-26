package controller

import (
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetDeepSeekBalanceUSD(t *testing.T) {
	tests := []struct {
		name            string
		responseJSON    string
		usdExchangeRate float64
		want            float64
		wantErrContains string
	}{
		{
			name:            "prefers USD when USD precedes CNY",
			responseJSON:    `{"balance_infos":[{"currency":"USD","total_balance":"12.50"},{"currency":"CNY","total_balance":"73.00"}]}`,
			usdExchangeRate: 7.3,
			want:            12.5,
		},
		{
			name:            "prefers USD when CNY precedes USD",
			responseJSON:    `{"balance_infos":[{"currency":"CNY","total_balance":"73.00"},{"currency":"USD","total_balance":"12.50"}]}`,
			usdExchangeRate: 7.3,
			want:            12.5,
		},
		{
			name:            "converts CNY when USD is absent",
			responseJSON:    `{"balance_infos":[{"currency":"CNY","total_balance":"73.00"}]}`,
			usdExchangeRate: 7.3,
			want:            10,
		},
		{
			name:            "returns error when USD and CNY are absent",
			responseJSON:    `{"balance_infos":[{"currency":"EUR","total_balance":"10.00"}]}`,
			usdExchangeRate: 7.3,
			wantErrContains: "currency USD or CNY not found",
		},
		{
			name:            "returns USD parse error instead of falling back to CNY",
			responseJSON:    `{"balance_infos":[{"currency":"USD","total_balance":"invalid"},{"currency":"CNY","total_balance":"73.00"}]}`,
			usdExchangeRate: 7.3,
			wantErrContains: "invalid syntax",
		},
		{
			name:            "rejects NaN USD balance",
			responseJSON:    `{"balance_infos":[{"currency":"USD","total_balance":"NaN"}]}`,
			usdExchangeRate: 7.3,
			wantErrContains: "USD balance must be finite",
		},
		{
			name:            "rejects negative USD balance",
			responseJSON:    `{"balance_infos":[{"currency":"USD","total_balance":"-1.00"}]}`,
			usdExchangeRate: 7.3,
			wantErrContains: "USD balance must be non-negative",
		},
		{
			name:            "rejects positive infinity CNY balance",
			responseJSON:    `{"balance_infos":[{"currency":"CNY","total_balance":"+Inf"}]}`,
			usdExchangeRate: 7.3,
			wantErrContains: "CNY balance must be finite",
		},
		{
			name:            "rejects negative CNY balance",
			responseJSON:    `{"balance_infos":[{"currency":"CNY","total_balance":"-7.30"}]}`,
			usdExchangeRate: 7.3,
			wantErrContains: "CNY balance must be non-negative",
		},
		{
			name:            "returns error for non-positive CNY exchange rate",
			responseJSON:    `{"balance_infos":[{"currency":"CNY","total_balance":"73.00"}]}`,
			usdExchangeRate: 0,
			wantErrContains: "USD exchange rate must be greater than zero",
		},
		{
			name:            "rejects NaN CNY exchange rate",
			responseJSON:    `{"balance_infos":[{"currency":"CNY","total_balance":"73.00"}]}`,
			usdExchangeRate: math.NaN(),
			wantErrContains: "USD exchange rate must be finite",
		},
		{
			name:            "rejects positive infinity CNY exchange rate",
			responseJSON:    `{"balance_infos":[{"currency":"CNY","total_balance":"73.00"}]}`,
			usdExchangeRate: math.Inf(1),
			wantErrContains: "USD exchange rate must be finite",
		},
		{
			name:            "rejects CNY conversion overflow",
			responseJSON:    `{"balance_infos":[{"currency":"CNY","total_balance":"1.7976931348623157e+308"}]}`,
			usdExchangeRate: math.SmallestNonzeroFloat64,
			wantErrContains: "converted USD balance must be finite",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var response DeepSeekUsageResponse
			require.NoError(t, common.Unmarshal([]byte(test.responseJSON), &response))

			balance, err := getDeepSeekBalanceUSD(response, test.usdExchangeRate)
			if test.wantErrContains != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), test.wantErrContains)
				return
			}

			require.NoError(t, err)
			assert.InDelta(t, test.want, balance, 1e-12)
		})
	}
}

type channelKeyBalanceResponse struct {
	Success       bool                            `json:"success"`
	Message       string                          `json:"message"`
	Balance       float64                         `json:"balance"`
	KeyCount      int                             `json:"key_count"`
	KeyBalances   []model.ChannelKeyBalanceDetail `json:"key_balances"`
	RefreshFailed int                             `json:"refresh_failed"`
	RefreshErrors []string                        `json:"refresh_errors"`
}

// A multi-key channel reads the balance of each key, totals them, and keeps
// each balance with its key, so editing the keys moves no balance onto
// another key.
func TestMultiKeyChannelBalance(t *testing.T) {
	for _, dialect := range []struct{ kind, env string }{{"sqlite", ""}, {"mysql", "TEST_MYSQL_DSN"}, {"postgres", "TEST_POSTGRES_DSN"}} {
		t.Run(dialect.kind, func(t *testing.T) {
			if dialect.env != "" && os.Getenv(dialect.env) == "" {
				t.Skip("set " + dialect.env + " to run this database")
			}
			database := modelManagementDB(t, dialect.kind, os.Getenv(dialect.env))
			require.NoError(t, database.AutoMigrate(&model.ChannelKeyBalance{}))

			// Each key has spent $2 of its limit; a key marked failing is refused.
			var mu sync.Mutex
			limits := map[string]float64{"key-a": 12, "key-b": 7, "key-c": 3}
			failing := map[string]bool{"key-c": true}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				mu.Lock()
				limit, refused := limits[key], failing[key]
				mu.Unlock()
				if refused {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				switch r.URL.Path {
				case "/v1/dashboard/billing/subscription":
					fmt.Fprintf(w, `{"has_payment_method":true,"hard_limit_usd":%v}`, limit)
				case "/v1/dashboard/billing/usage":
					fmt.Fprint(w, `{"total_usage":200}`)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			t.Cleanup(upstream.Close)
			baseURL := upstream.URL
			// A setting that no longer parses makes reading it save the channel.
			unreadable := `{"force_format":"yes"}`
			channel := &model.Channel{
				Type:    constant.ChannelTypeOpenAI,
				Name:    "多密钥渠道",
				Key:     "key-a\nkey-b\nkey-c",
				Status:  common.ChannelStatusEnabled,
				BaseURL: &baseURL,
				Setting: &unreadable,
				Models:  "gpt-test",
				Group:   "default",
				ChannelInfo: model.ChannelInfo{
					IsMultiKey:         true,
					MultiKeySize:       3,
					MultiKeyMode:       constant.MultiKeyModePolling,
					MultiKeyStatusList: map[int]int{1: common.ChannelStatusManuallyDisabled},
				},
			}
			require.NoError(t, model.DB.Create(channel).Error)
			refresh := func(t *testing.T) channelKeyBalanceResponse {
				t.Helper()
				recorder := httptest.NewRecorder()
				context, _ := gin.CreateTestContext(recorder)
				context.Request = httptest.NewRequest(http.MethodGet, "/api/channel/update_balance/"+strconv.Itoa(channel.Id), nil)
				context.Params = gin.Params{{Key: "id", Value: strconv.Itoa(channel.Id)}}
				UpdateChannelBalance(context)
				var response channelKeyBalanceResponse
				require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response), recorder.Body.String())
				return response
			}

			// The channel as a request that loaded it before the refresh saves it.
			var loaded model.Channel
			require.NoError(t, model.DB.First(&loaded, channel.Id).Error)

			// A disabled key still counts; a key never read counts nothing.
			response := refresh(t)
			require.True(t, response.Success, response.Message)
			assert.InDelta(t, 15, response.Balance, 1e-9)
			assert.Equal(t, 3, response.KeyCount)
			assert.Equal(t, 1, response.RefreshFailed)
			assert.Equal(t, []string{"#3: status code: 401"}, response.RefreshErrors)
			require.Len(t, response.KeyBalances, 3)
			firstRead := response.KeyBalances[0].UpdatedTime
			assert.Positive(t, firstRead)
			assert.Equal(t, model.ChannelKeyBalanceDetail{Index: 0, Balance: 10, UpdatedTime: firstRead, Status: model.UpstreamStatusHealthy, KeyStatus: common.ChannelStatusEnabled}, response.KeyBalances[0])
			assert.Equal(t, model.ChannelKeyBalanceDetail{Index: 1, Balance: 5, UpdatedTime: firstRead, Status: model.UpstreamStatusHealthy, KeyStatus: common.ChannelStatusManuallyDisabled}, response.KeyBalances[1])
			assert.Equal(t, model.ChannelKeyBalanceDetail{Index: 2, Status: model.UpstreamStatusFailed, KeyStatus: common.ChannelStatusEnabled}, response.KeyBalances[2])
			var stored model.Channel
			require.NoError(t, model.DB.First(&stored, channel.Id).Error)
			assert.Equal(t, "key-a\nkey-b\nkey-c", stored.Key, "reading the keys one by one saves none of them alone")
			assert.InDelta(t, 15, stored.Balance, 1e-9)
			assert.Equal(t, firstRead, stored.BalanceUpdatedTime)

			// A key that fails later keeps the balance it read last, even once
			// the channel was saved from a copy loaded before the refresh.
			require.NoError(t, model.DB.Save(&loaded).Error)
			mu.Lock()
			failing = map[string]bool{"key-a": true}
			mu.Unlock()
			response = refresh(t)
			require.True(t, response.Success, response.Message)
			assert.InDelta(t, 16, response.Balance, 1e-9)
			assert.Equal(t, []string{"#1: status code: 401"}, response.RefreshErrors)
			assert.Equal(t, model.ChannelKeyBalanceDetail{Index: 0, Balance: 10, UpdatedTime: firstRead, Status: model.UpstreamStatusFailed, KeyStatus: common.ChannelStatusEnabled}, response.KeyBalances[0])
			assert.InDelta(t, 1, response.KeyBalances[2].Balance, 1e-9)

			// Removing and reordering keys lists each balance with its key, and
			// the list names no key.
			require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", channel.Id).Update("key", "key-c\nkey-b").Error)
			var list struct {
				Data struct {
					Items []model.Channel `json:"items"`
				} `json:"data"`
			}
			recorder := modelManagementRequest(t, GetAllChannels, http.MethodGet, "/api/channel/?p=1&page_size=10", nil, &list)
			require.Len(t, list.Data.Items, 1)
			details := list.Data.Items[0].KeyBalanceDetails
			require.Len(t, details, 2)
			assert.Equal(t, 0, details[0].Index)
			assert.InDelta(t, 1, details[0].Balance, 1e-9)
			assert.Equal(t, 1, details[1].Index)
			assert.InDelta(t, 5, details[1].Balance, 1e-9)
			assert.Equal(t, common.ChannelStatusManuallyDisabled, details[1].KeyStatus)
			assert.NotContains(t, recorder.Body.String(), "key-b")
		})
	}
}

// A channel with one key still saves the balance its upstream reports.
func TestSingleKeyChannelBalanceIsSaved(t *testing.T) {
	modelManagementDB(t, "sqlite", "")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/dashboard/billing/subscription":
			fmt.Fprint(w, `{"has_payment_method":true,"hard_limit_usd":12}`)
		case "/v1/dashboard/billing/usage":
			fmt.Fprint(w, `{"total_usage":200}`)
		}
	}))
	t.Cleanup(upstream.Close)
	baseURL := upstream.URL
	channel := &model.Channel{Type: constant.ChannelTypeOpenAI, Name: "单密钥渠道", Key: "key-a", Status: common.ChannelStatusEnabled, BaseURL: &baseURL, Models: "gpt-test", Group: "default"}
	require.NoError(t, model.DB.Create(channel).Error)

	result, err := updateChannelBalance(channel)

	require.NoError(t, err)
	assert.InDelta(t, 10, result.Balance, 1e-9)
	var stored model.Channel
	require.NoError(t, model.DB.First(&stored, channel.Id).Error)
	assert.InDelta(t, 10, stored.Balance, 1e-9)
	assert.Positive(t, stored.BalanceUpdatedTime)
}

// A channel with thousands of keys saves the balance of every key, beyond
// what one statement may carry, and forgets those of keys it drops.
func TestChannelKeyBalancesSaveForThousandsOfKeys(t *testing.T) {
	database := modelManagementDB(t, "sqlite", "")
	require.NoError(t, database.AutoMigrate(&model.ChannelKeyBalance{}))
	keys := make([]string, 7000)
	reads := make([]model.ChannelKeyBalanceRead, len(keys))
	for index := range keys {
		keys[index] = "key-" + strconv.Itoa(index)
		reads[index] = model.ChannelKeyBalanceRead{Key: keys[index], Balance: 1}
	}
	channel := &model.Channel{Type: constant.ChannelTypeOpenAI, Name: "大密钥池", Key: strings.Join(keys, "\n"), Status: common.ChannelStatusEnabled, Models: "gpt-test", Group: "default", ChannelInfo: model.ChannelInfo{IsMultiKey: true, MultiKeySize: len(keys)}}
	require.NoError(t, model.DB.Create(channel).Error)

	summary, err := model.SaveChannelKeyBalances(channel.Id, reads)
	require.NoError(t, err)
	assert.InDelta(t, 7000, summary.Balance, 1e-9)

	require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", channel.Id).Update("key", strings.Join(keys[:3000], "\n")).Error)
	summary, err = model.SaveChannelKeyBalances(channel.Id, reads[:3000])
	require.NoError(t, err)
	assert.InDelta(t, 3000, summary.Balance, 1e-9)
	var count int64
	require.NoError(t, model.DB.Model(&model.ChannelKeyBalance{}).Where("channel_id = ?", channel.Id).Count(&count).Error)
	assert.Equal(t, int64(3000), count)
}

// Keys never read come first, then those read longest ago, so a refresh cut
// short reaches next time the keys it left out.
func TestChannelKeysAreReadStalestFirst(t *testing.T) {
	database := modelManagementDB(t, "sqlite", "")
	require.NoError(t, database.AutoMigrate(&model.ChannelKeyBalance{}))
	keys := []string{"key-a", "key-b", "key-c", "key-d"}
	channel := &model.Channel{Type: constant.ChannelTypeOpenAI, Name: "轮换密钥", Key: strings.Join(keys, "\n"), Status: common.ChannelStatusEnabled, Models: "gpt-test", Group: "default", ChannelInfo: model.ChannelInfo{IsMultiKey: true, MultiKeySize: len(keys)}}
	require.NoError(t, model.DB.Create(channel).Error)
	_, err := model.SaveChannelKeyBalances(channel.Id, []model.ChannelKeyBalanceRead{{Key: "key-a", Balance: 1}, {Key: "key-b", Balance: 1}, {Key: "key-c", Balance: 1}})
	require.NoError(t, err)
	var rows []model.ChannelKeyBalance
	require.NoError(t, model.DB.Where("channel_id = ?", channel.Id).Order("id").Find(&rows).Error)
	require.Len(t, rows, 3)
	for index, readAt := range []int64{300, 100, 200} {
		require.NoError(t, model.DB.Model(&rows[index]).Update("updated_time", readAt).Error)
	}

	assert.Equal(t, []int{3, 1, 2, 0}, model.ChannelKeyReadOrder(channel.Id, keys))
}

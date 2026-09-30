package relay

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/model_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestInvalidImageRefundsReservedFunding(t *testing.T) {
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousDialect := common.MainDatabaseType()
	previousRedis, previousBatch, previousLogs := common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled
	common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled = false, false, false
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetMainDatabaseType(previousDialect)
		common.RedisEnabled, common.BatchUpdateEnabled, common.LogConsumeEnabled = previousRedis, previousBatch, previousLogs
	})
	service.InitHttpClient()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"url":"https://platform.openai.com/login?next=private"}],"status":"completed"}`)
	}))
	t.Cleanup(upstream.Close)
	for _, engine := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(engine, func(t *testing.T) {
			var dialector gorm.Dialector
			switch engine {
			case "sqlite":
				dialector = sqlite.Open(t.TempDir() + "/billing.db")
				common.SetMainDatabaseType(common.DatabaseTypeSQLite)
			case "mysql":
				dsn := os.Getenv("IMAGE_REFUND_TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("IMAGE_REFUND_TEST_MYSQL_DSN not configured")
				}
				dialector = mysql.Open(dsn)
				common.SetMainDatabaseType(common.DatabaseTypeMySQL)
			case "postgres":
				dsn := os.Getenv("IMAGE_REFUND_TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("IMAGE_REFUND_TEST_POSTGRES_DSN not configured")
				}
				dialector = postgres.Open(dsn)
				common.SetMainDatabaseType(common.DatabaseTypePostgreSQL)
			}
			db, err := gorm.Open(dialector, &gorm.Config{})
			require.NoError(t, err)
			connection, err := db.DB()
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, connection.Close()) })
			require.NoError(t, db.AutoMigrate(&model.User{}, &model.Channel{}, &model.UserSubscription{}, &model.SubscriptionPlan{}, &model.SubscriptionPreConsumeRecord{}, &model.Log{}))
			model.DB, model.LOG_DB = db, db
			for _, funding := range []string{"wallet_only", "subscription_only"} {
				t.Run(funding, func(t *testing.T) {
					requestID := "image-refund-" + common.GetUUID()
					user := model.User{Username: requestID, AffCode: common.GetUUID(), Quota: 100_000_000, Group: "default"}
					require.NoError(t, db.Create(&user).Error)
					plan := model.SubscriptionPlan{Title: "Image refund test", QuotaResetPeriod: model.SubscriptionResetNever}
					require.NoError(t, db.Create(&plan).Error)
					sub := model.UserSubscription{UserId: user.Id, PlanId: plan.Id, AmountTotal: 100_000_000, Status: "active", StartTime: time.Now().Unix(), EndTime: time.Now().Add(time.Hour).Unix()}
					require.NoError(t, db.Create(&sub).Error)
					recorder := httptest.NewRecorder()
					c, _ := gin.CreateTestContext(recorder)
					c.Request = httptest.NewRequest(http.MethodPost, "/pg/images/generations", nil)
					c.Set(common.RequestIdKey, requestID)
					common.SetContextKey(c, constant.ContextKeyChannelType, constant.ChannelTypeOpenAI)
					common.SetContextKey(c, constant.ContextKeyChannelBaseUrl, upstream.URL)
					common.SetContextKey(c, constant.ContextKeyOriginalModel, "gpt-image-test")
					info := &relaycommon.RelayInfo{UserId: user.Id, IsPlayground: true, ForcePreConsume: true, RelayMode: relayconstant.RelayModeImagesGenerations, OriginModelName: "gpt-image-test", RequestURLPath: "/v1/images/generations", Request: &dto.ImageRequest{Model: "gpt-image-test", N: common.GetPointer(uint(1))}}
					info.UserSetting.BillingPreference = funding
					info.RequestId = requestID
					info.PriceData.UsePrice = true
					info.PriceData.ModelPrice = 10
					require.Nil(t, service.PreConsumeBilling(c, 5_000_000, info))
					var reservedUser model.User
					require.NoError(t, db.First(&reservedUser, user.Id).Error)
					var reservedSub model.UserSubscription
					require.NoError(t, db.First(&reservedSub, sub.Id).Error)
					if funding == "wallet_only" {
						require.Equal(t, 95_000_000, reservedUser.Quota)
					} else {
						require.Equal(t, int64(5_000_000), reservedSub.AmountUsed)
					}
					failure := ImageHelper(c, info)
					require.NotNil(t, failure)
					assert.Equal(t, http.StatusBadGateway, failure.StatusCode)
					assert.Empty(t, recorder.Body.String())
					RefundFailedRequestBilling(c, info, failure)
					RefundFailedRequestBilling(c, info, failure)
					require.Eventually(t, func() bool {
						var afterUser model.User
						var afterSub model.UserSubscription
						return db.First(&afterUser, user.Id).Error == nil && db.First(&afterSub, sub.Id).Error == nil && afterUser.Quota == 100_000_000 && afterSub.AmountUsed == 0
					}, 5*time.Second, 10*time.Millisecond)
					var charges int64
					require.NoError(t, db.Model(&model.Log{}).Where("user_id = ? AND type = ?", user.Id, model.LogTypeConsume).Count(&charges).Error)
					assert.Zero(t, charges)
					if funding == "subscription_only" {
						// A retry after other consumption must not refund that newer use.
						require.NoError(t, model.PostConsumeUserSubscriptionDelta(sub.Id, 2_000_000))
						require.NoError(t, model.RefundSubscriptionPreConsume(requestID))
						var after model.UserSubscription
						require.NoError(t, db.First(&after, sub.Id).Error)
						assert.Equal(t, int64(2_000_000), after.AmountUsed)
						rollbackID := "rollback-" + common.GetUUID()
						_, err := model.PreConsumeUserSubscription(rollbackID, user.Id, "gpt-image-test", 0, 1_000_000)
						require.NoError(t, err)
						require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:refund-marker-failure", func(tx *gorm.DB) {
							if record, ok := tx.Statement.Dest.(*model.SubscriptionPreConsumeRecord); ok && record.RequestId == rollbackID && record.Status == "refunded" {
								tx.AddError(fmt.Errorf("refund marker unavailable"))
							}
						}))
						require.Error(t, model.RefundSubscriptionPreConsume(rollbackID))
						require.NoError(t, db.Callback().Update().Remove("test:refund-marker-failure"))
						require.NoError(t, db.First(&after, sub.Id).Error)
						assert.Equal(t, int64(3_000_000), after.AmountUsed, "failed marker must roll back the funding adjustment")
						require.NoError(t, model.RefundSubscriptionPreConsume(rollbackID))
						require.NoError(t, db.First(&after, sub.Id).Error)
						assert.Equal(t, int64(2_000_000), after.AmountUsed)
					}
				})
			}
		})
	}
}

// The playground sends its routing group inside the request body. Passthrough
// forwards a body verbatim, so without the playground guard the group name
// would be handed to the image provider.
func TestPlaygroundImagesDoNotForwardRoutingFieldsWithPassthroughEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	original := model_setting.GetGlobalSettings().PassThroughRequestEnabled
	t.Cleanup(func() {
		model_setting.GetGlobalSettings().PassThroughRequestEnabled = original
	})

	for _, test := range []struct {
		name                         string
		multipart, globalPassthrough bool
	}{
		{"generation with channel passthrough", false, false},
		{"generation with global passthrough", false, true},
		{"edit with channel passthrough", true, false},
		{"edit with global passthrough", true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			model_setting.GetGlobalSettings().PassThroughRequestEnabled = test.globalPassthrough

			var body bytes.Buffer
			contentType := "application/json"
			path := "/v1/images/generations"
			mode := relayconstant.RelayModeImagesGenerations
			if test.multipart {
				path = "/v1/images/edits"
				mode = relayconstant.RelayModeImagesEdits
				writer := multipart.NewWriter(&body)
				for key, value := range map[string]string{
					"model": "gpt-image-1", "prompt": "A cup", "group": "premium",
					"n": "1", "output_compression": "0",
				} {
					require.NoError(t, writer.WriteField(key, value))
				}
				file, err := writer.CreateFormFile("image", "cup.png")
				require.NoError(t, err)
				_, err = io.WriteString(file, "reference-image")
				require.NoError(t, err)
				require.NoError(t, writer.Close())
				contentType = writer.FormDataContentType()
			} else {
				_, err := io.WriteString(&body, `{"model":"gpt-image-1","prompt":"A cup","group":"premium","n":1,"output_compression":0}`)
				require.NoError(t, err)
			}

			type upstreamRequest struct {
				body              []byte
				contentType, path string
				err               error
			}
			requests := make(chan upstreamRequest, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				data, err := io.ReadAll(r.Body)
				requests <- upstreamRequest{data, r.Header.Get("Content-Type"), r.URL.Path, err}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":{"message":"test upstream rejected image","type":"invalid_request_error"}}`)
			}))
			t.Cleanup(server.Close)

			recorder := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(recorder)
			context.Request = httptest.NewRequest(http.MethodPost, strings.Replace(path, "/v1/", "/pg/", 1), &body)
			context.Request.Header.Set("Content-Type", contentType)
			common.SetContextKey(context, constant.ContextKeyChannelType, constant.ChannelTypeOpenAI)
			common.SetContextKey(context, constant.ContextKeyChannelBaseUrl, server.URL)
			common.SetContextKey(context, constant.ContextKeyOriginalModel, "gpt-image-1")
			common.SetContextKey(context, constant.ContextKeyChannelSetting, dto.ChannelSettings{
				PassThroughBodyEnabled: !test.globalPassthrough,
			})

			n := uint(1)
			info := &relaycommon.RelayInfo{
				IsPlayground:    true,
				RelayMode:       mode,
				OriginModelName: "gpt-image-1",
				RequestURLPath:  path,
				Request: &dto.ImageRequest{
					Model: "gpt-image-1", Prompt: "A cup", N: &n,
					OutputCompression: []byte("0"),
				},
			}

			// The upstream answers 400 on purpose: the request it received is what
			// this test is about, not the relay's success path.
			relayErr := ImageHelper(context, info)
			require.NotNil(t, relayErr)
			require.Equal(t, http.StatusBadRequest, relayErr.StatusCode, relayErr.Error())

			var received upstreamRequest
			select {
			case received = <-requests:
			default:
				t.Fatal("image request did not reach the upstream")
			}
			require.NoError(t, received.err)
			assert.Equal(t, path, received.path)

			if test.multipart {
				forwarded := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(received.body))
				forwarded.Header.Set("Content-Type", received.contentType)
				require.NoError(t, forwarded.ParseMultipartForm(1<<20))
				t.Cleanup(func() { require.NoError(t, forwarded.MultipartForm.RemoveAll()) })
				assert.False(t, forwarded.PostForm.Has("group"))
				assert.Equal(t, "0", forwarded.PostForm.Get("output_compression"))
				assert.Len(t, forwarded.MultipartForm.File["image"], 1)
				return
			}

			var payload map[string]any
			require.NoError(t, common.Unmarshal(received.body, &payload))
			assert.NotContains(t, payload, "group")
			assert.Equal(t, float64(0), payload["output_compression"])
		})
	}
}

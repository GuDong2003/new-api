package middleware

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestModelRedisRateLimitUsesUTCRegardlessOfLocalTimezone(t *testing.T) {
	redisServer, redisClient := useRateLimitMiniRedis(t)
	previousLocation := time.Local
	time.Local = time.FixedZone("test-utc-plus-eight", 8*60*60)
	t.Cleanup(func() { time.Local = previousLocation })

	ctx := context.Background()
	recordKey := "rateLimit:model-utc-record"
	recordRedisRequest(ctx, redisClient, recordKey, 2)
	recorded, err := redisClient.LIndex(ctx, recordKey, 0).Result()
	require.NoError(t, err)
	recordedAt, err := time.Parse(modelRateLimitTimeFormat, recorded)
	require.NoError(t, err)
	assert.WithinDuration(t, time.Now().UTC(), recordedAt, 2*time.Second)

	checkKey := "rateLimit:model-utc-check"
	withinWindow := time.Now().UTC().Add(-30 * time.Second).Format(modelRateLimitTimeFormat)
	_, err = redisServer.Push(checkKey, withinWindow, withinWindow)
	require.NoError(t, err)
	allowed, err := checkRedisRateLimit(ctx, redisClient, checkKey, 2, 60)
	require.NoError(t, err)
	assert.False(t, allowed, "an existing UTC timestamp inside the window must remain limited on a non-UTC host")
}

// modelRateLimitTestUsers hands out user ids no other run in this process used,
// since the in-memory limiter keeps its counters for the whole process.
var modelRateLimitTestUsers atomic.Int64

func TestModelRedisRateLimitKeepsCountingAfterRedisLosesItsScripts(t *testing.T) {
	require.NoError(t, i18n.Init())
	_, redisClient := useRateLimitMiniRedis(t)
	scope := userRequestRateLimitScope(nextModelRateLimitTestUser(), setting.RequestRateLimit{Count: 2, SuccessCount: 10})
	router := gin.New()
	router.GET("/", redisRateLimitHandler(60, scope), func(c *gin.Context) { c.Status(http.StatusOK) })

	require.Equal(t, http.StatusOK, performRateLimitRequest(router, "/", "127.0.0.1:1000").Code)
	require.NoError(t, redisClient.ScriptFlush(context.Background()).Err())
	assert.Equal(t, http.StatusOK, performRateLimitRequest(router, "/", "127.0.0.1:1000").Code)
	assert.Equal(t, http.StatusTooManyRequests, performRateLimitRequest(router, "/", "127.0.0.1:1000").Code)
}

func nextModelRateLimitTestUser() int {
	return 7200000 + int(modelRateLimitTestUsers.Add(1))
}

func TestModelRateLimitStreamFailuresDoNotConsumeSuccessLimit(t *testing.T) {
	require.NoError(t, i18n.Init())
	for _, backend := range []string{"memory", "redis"} {
		for _, totalLimit := range []int{0, 2} {
			t.Run(fmt.Sprintf("%s/total=%d", backend, totalLimit), func(t *testing.T) {
				scope := userRequestRateLimitScope(nextModelRateLimitTestUser(), setting.RequestRateLimit{Count: totalLimit, SuccessCount: 1})
				handler := memoryRateLimitHandler(60, scope)
				if backend == "redis" {
					useRateLimitMiniRedis(t)
					handler = redisRateLimitHandler(60, scope)
				}
				router := gin.New()
				router.GET("/:outcome", handler, func(c *gin.Context) {
					status := relaycommon.NewStreamStatus()
					if c.Param("outcome") == "failed" {
						status.MarkFailed("server_error", "", 0)
					} else {
						status.MarkCompleted()
					}
					common.SetContextKey(c, constant.ContextKeyResponseStreamStatus, status)
					c.Status(http.StatusOK)
				})
				assert.Equal(t, http.StatusOK, performRateLimitRequest(router, "/failed", "127.0.0.1:1000").Code)
				if totalLimit > 0 {
					assert.Equal(t, http.StatusOK, performRateLimitRequest(router, "/failed", "127.0.0.1:1000").Code)
				} else {
					assert.Equal(t, http.StatusOK, performRateLimitRequest(router, "/completed", "127.0.0.1:1000").Code)
				}
				assert.Equal(t, http.StatusTooManyRequests, performRateLimitRequest(router, "/completed", "127.0.0.1:1000").Code)
			})
		}
	}
}

func TestModelMemoryRateLimitReservesConcurrentSuccessAdmission(t *testing.T) {
	require.NoError(t, i18n.Init())
	scope := userRequestRateLimitScope(nextModelRateLimitTestUser(), setting.RequestRateLimit{SuccessCount: 1})
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	router := gin.New()
	router.GET("/:outcome", memoryRateLimitHandler(60, scope), func(c *gin.Context) {
		if c.Param("outcome") == "failed" {
			close(entered)
			<-release
			status := relaycommon.NewStreamStatus()
			status.MarkFailed("server_error", "", 0)
			common.SetContextKey(c, constant.ContextKeyResponseStreamStatus, status)
		}
		c.Status(http.StatusOK)
	})
	go func() {
		defer close(finished)
		assert.Equal(t, http.StatusOK, performRateLimitRequest(router, "/failed", "127.0.0.1:1000").Code)
	}()
	<-entered
	assert.Equal(t, http.StatusTooManyRequests, performRateLimitRequest(router, "/completed", "127.0.0.1:1000").Code)
	close(release)
	<-finished
	assert.Equal(t, http.StatusOK, performRateLimitRequest(router, "/completed", "127.0.0.1:1000").Code)
	assert.Equal(t, http.StatusTooManyRequests, performRateLimitRequest(router, "/completed", "127.0.0.1:1000").Code)
}

// useModelRateLimitSettings gives a test its own rate limit settings and a
// database for the subscriptions that raise a user's limit.
func useModelRateLimitSettings(t *testing.T) {
	t.Helper()
	require.NoError(t, i18n.Init())
	previousDB := model.DB
	previousType := common.MainDatabaseType()
	previousRedisEnabled := common.RedisEnabled
	previousEnabled := setting.ModelRequestRateLimitEnabled
	previousDuration := setting.ModelRequestRateLimitDurationMinutes
	previousCount, previousSuccessCount := setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount
	previousGlobalCount, previousGlobalSuccessCount := setting.ModelRequestRateLimitGlobalCount, setting.ModelRequestRateLimitGlobalSuccessCount
	previousGroups := setting.ModelRequestRateLimitGroup2JSONString()

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_"))
	database, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, database.AutoMigrate(&model.User{}, &model.SubscriptionPlan{}, &model.UserSubscription{}))
	sqlDB, err := database.DB()
	require.NoError(t, err)
	model.DB = database
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	setting.ModelRequestRateLimitDurationMinutes = 1
	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousType)
		common.RedisEnabled = previousRedisEnabled
		_ = sqlDB.Close()
		setting.ModelRequestRateLimitEnabled = previousEnabled
		setting.ModelRequestRateLimitDurationMinutes = previousDuration
		setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount = previousCount, previousSuccessCount
		setting.ModelRequestRateLimitGlobalCount, setting.ModelRequestRateLimitGlobalSuccessCount = previousGlobalCount, previousGlobalSuccessCount
		_ = setting.UpdateModelRequestRateLimitGroupByJSONString(previousGroups)
	})
}

func createModelRateLimitUser(t *testing.T, group string) int {
	t.Helper()
	user := model.User{Id: nextModelRateLimitTestUser(), Group: group, Status: common.UserStatusEnabled}
	user.Username = fmt.Sprintf("rate-limit-%d", user.Id)
	user.AffCode = user.Username
	require.NoError(t, model.DB.Create(&user).Error)
	return user.Id
}

// modelRateLimitRouter serves every request as one user, the way TokenAuth
// and UserAuth leave the context for ModelRequestRateLimit. A request may name
// the token's group in its tokenGroup query.
func modelRateLimitRouter(userID int, group string, userSetting dto.UserSetting) *gin.Engine {
	userSetting.Language = i18n.LangEn
	router := gin.New()
	router.GET("/", func(c *gin.Context) {
		c.Set("id", userID)
		common.SetContextKey(c, constant.ContextKeyUserGroup, group)
		if tokenGroup := c.Query("tokenGroup"); tokenGroup != "" {
			common.SetContextKey(c, constant.ContextKeyTokenGroup, tokenGroup)
		}
		common.SetContextKey(c, constant.ContextKeyUserSetting, userSetting)
	}, ModelRequestRateLimit(), func(c *gin.Context) { c.Status(http.StatusOK) })
	return router
}

func TestModelRequestRateLimitHoldsEachUserToTheirOwnLimitWithTheSwitchOff(t *testing.T) {
	useModelRateLimitSettings(t)
	setting.ModelRequestRateLimitEnabled = false
	setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount = 0, 1
	require.NoError(t, setting.UpdateModelRequestRateLimitGroupByJSONString(`{"limited":[0,2]}`))
	plan := &model.SubscriptionPlan{Title: "Faster", DurationUnit: model.SubscriptionDurationMonth, DurationValue: 1, TotalAmount: 100, Enabled: true, RateLimitSuccessCount: 3}
	require.NoError(t, model.DB.Create(plan).Error)
	model.InvalidateSubscriptionPlanCache(plan.Id)

	cases := []struct {
		name       string
		group      string
		tokenGroup string
		personal   *dto.UserRateLimit
		subscribe  bool
		admitted   int
	}{
		{name: "the default applies to a group without a limit", group: "unlisted", admitted: 1},
		{name: "the group limit applies", group: "limited", admitted: 2},
		{name: "the token's group limit applies", group: "unlisted", tokenGroup: "limited", admitted: 2},
		{name: "the user's group limit applies to a token group without one", group: "limited", tokenGroup: "auto", admitted: 2},
		{name: "a personal limit replaces the group limit", group: "limited", personal: &dto.UserRateLimit{SuccessCount: 4}, admitted: 4},
		{name: "a personal limit can be stricter than the group limit", group: "limited", personal: &dto.UserRateLimit{SuccessCount: 1}, admitted: 1},
		{name: "a subscription raises the group limit", group: "limited", subscribe: true, admitted: 3},
		{name: "a subscription never lowers a looser limit", group: "limited", personal: &dto.UserRateLimit{SuccessCount: 5}, subscribe: true, admitted: 5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			userID := createModelRateLimitUser(t, tc.group)
			if tc.subscribe {
				_, err := model.AdminBindSubscription(userID, plan.Id, "")
				require.NoError(t, err)
			}
			router := modelRateLimitRouter(userID, tc.group, dto.UserSetting{RateLimit: tc.personal})
			path := "/?tokenGroup=" + tc.tokenGroup
			for range tc.admitted {
				require.Equal(t, http.StatusOK, performRateLimitRequest(router, path, "127.0.0.1:1000").Code)
			}
			refused := performRateLimitRequest(router, path, "127.0.0.1:1000")
			assert.Equal(t, http.StatusTooManyRequests, refused.Code)
			assert.Contains(t, refused.Body.String(), "You have reached the request limit")
		})
	}
}

func TestModelRequestRateLimitHoldsUsersToTheirBaseLimitWhenSubscriptionsCannotBeRead(t *testing.T) {
	useModelRateLimitSettings(t)
	setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount = 0, 1
	userID := createModelRateLimitUser(t, "default")
	require.NoError(t, model.DB.Migrator().DropTable(&model.UserSubscription{}))
	router := modelRateLimitRouter(userID, "default", dto.UserSetting{})

	assert.Equal(t, http.StatusOK, performRateLimitRequest(router, "/", "127.0.0.1:1000").Code)
	assert.Equal(t, http.StatusTooManyRequests, performRateLimitRequest(router, "/", "127.0.0.1:1000").Code)
}

func TestModelRequestRateLimitSharesTheSiteCapOnlyWhileTheSwitchIsOn(t *testing.T) {
	useModelRateLimitSettings(t)
	useRateLimitMiniRedis(t)
	setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount = 0, 10
	setting.ModelRequestRateLimitGlobalCount, setting.ModelRequestRateLimitGlobalSuccessCount = 0, 1
	first := modelRateLimitRouter(createModelRateLimitUser(t, "default"), "default", dto.UserSetting{})
	second := modelRateLimitRouter(createModelRateLimitUser(t, "default"), "default", dto.UserSetting{})

	setting.ModelRequestRateLimitEnabled = true
	require.Equal(t, http.StatusOK, performRateLimitRequest(first, "/", "127.0.0.1:1000").Code)
	refused := performRateLimitRequest(second, "/", "127.0.0.1:1000")
	assert.Equal(t, http.StatusTooManyRequests, refused.Code)
	assert.Contains(t, refused.Body.String(), "The site has reached its request limit")

	setting.ModelRequestRateLimitEnabled = false
	assert.Equal(t, http.StatusOK, performRateLimitRequest(second, "/", "127.0.0.1:1000").Code)
}

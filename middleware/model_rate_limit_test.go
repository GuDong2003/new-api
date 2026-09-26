package middleware

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

// useModelRateLimitSettings gives a test its own rate limit settings and the
// in-memory limiter.
func useModelRateLimitSettings(t *testing.T) {
	t.Helper()
	require.NoError(t, i18n.Init())
	previousRedisEnabled := common.RedisEnabled
	previousEnabled := setting.ModelRequestRateLimitEnabled
	previousDuration := setting.ModelRequestRateLimitDurationMinutes
	previousCount, previousSuccessCount := setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount
	previousGlobalCount, previousGlobalSuccessCount := setting.ModelRequestRateLimitGlobalCount, setting.ModelRequestRateLimitGlobalSuccessCount
	previousGroups := setting.ModelRequestRateLimitGroup2JSONString()
	common.RedisEnabled = false
	setting.ModelRequestRateLimitDurationMinutes = 1
	t.Cleanup(func() {
		common.RedisEnabled = previousRedisEnabled
		setting.ModelRequestRateLimitEnabled = previousEnabled
		setting.ModelRequestRateLimitDurationMinutes = previousDuration
		setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount = previousCount, previousSuccessCount
		setting.ModelRequestRateLimitGlobalCount, setting.ModelRequestRateLimitGlobalSuccessCount = previousGlobalCount, previousGlobalSuccessCount
		_ = setting.UpdateModelRequestRateLimitGroupByJSONString(previousGroups)
	})
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

	cases := []struct {
		name       string
		group      string
		tokenGroup string
		personal   *dto.UserRateLimit
		admitted   int
	}{
		{name: "the default applies to a group without a limit", group: "unlisted", admitted: 1},
		{name: "the group limit applies", group: "limited", admitted: 2},
		{name: "the token's group limit applies", group: "unlisted", tokenGroup: "limited", admitted: 2},
		{name: "the user's group limit applies to a token group without one", group: "limited", tokenGroup: "auto", admitted: 2},
		{name: "a personal limit replaces the group limit", group: "limited", personal: &dto.UserRateLimit{Count: 4, SuccessCount: 4}, admitted: 4},
		{name: "a personal limit can be stricter than the group limit", group: "limited", personal: &dto.UserRateLimit{Count: 1, SuccessCount: 1}, admitted: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			router := modelRateLimitRouter(nextModelRateLimitTestUser(), tc.group, dto.UserSetting{RateLimit: tc.personal})
			path := "/?tokenGroup=" + tc.tokenGroup
			for range tc.admitted {
				require.Equal(t, http.StatusOK, performRateLimitRequest(router, path, "127.0.0.1:1000").Code)
			}
			refused := performRateLimitRequest(router, path, "127.0.0.1:1000")
			assert.Equal(t, http.StatusTooManyRequests, refused.Code)
			assert.Contains(t, refused.Body.String(), "You have reached")
		})
	}
}

func TestModelRequestRateLimitSharesTheSiteCapOnlyWhileTheSwitchIsOn(t *testing.T) {
	useModelRateLimitSettings(t)
	useRateLimitMiniRedis(t)
	setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount = 0, 10
	setting.ModelRequestRateLimitGlobalCount, setting.ModelRequestRateLimitGlobalSuccessCount = 0, 1
	first := modelRateLimitRouter(nextModelRateLimitTestUser(), "default", dto.UserSetting{})
	second := modelRateLimitRouter(nextModelRateLimitTestUser(), "default", dto.UserSetting{})

	setting.ModelRequestRateLimitEnabled = true
	require.Equal(t, http.StatusOK, performRateLimitRequest(first, "/", "127.0.0.1:1000").Code)
	refused := performRateLimitRequest(second, "/", "127.0.0.1:1000")
	assert.Equal(t, http.StatusTooManyRequests, refused.Code)
	assert.Contains(t, refused.Body.String(), "The site has reached its request limit")

	setting.ModelRequestRateLimitEnabled = false
	assert.Equal(t, http.StatusOK, performRateLimitRequest(second, "/", "127.0.0.1:1000").Code)
}

package middleware

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/common/limiter"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
)

const (
	ModelRequestRateLimitCountMark        = "MRRL"
	ModelRequestRateLimitSuccessCountMark = "MRRLS"
	modelRateLimitTimeFormat              = "2006-01-02T15:04:05.000Z"
)

// 检查Redis中的请求限制
func checkRedisRateLimit(ctx context.Context, rdb *redis.Client, key string, maxCount int, duration int64) (bool, error) {
	// 如果maxCount为0，表示不限制
	if maxCount == 0 {
		return true, nil
	}

	// 获取当前计数
	length, err := rdb.LLen(ctx, key).Result()
	if err != nil {
		return false, err
	}

	// 如果未达到限制，允许请求
	if length < int64(maxCount) {
		return true, nil
	}

	// 检查时间窗口
	oldTimeStr, _ := rdb.LIndex(ctx, key, -1).Result()
	oldTime, err := time.Parse(modelRateLimitTimeFormat, oldTimeStr)
	if err != nil {
		return false, err
	}

	nowTimeStr := time.Now().UTC().Format(modelRateLimitTimeFormat)
	nowTime, err := time.Parse(modelRateLimitTimeFormat, nowTimeStr)
	if err != nil {
		return false, err
	}
	// 如果在时间窗口内已达到限制，拒绝请求
	subTime := nowTime.Sub(oldTime).Seconds()
	if int64(subTime) < duration {
		rdb.Expire(ctx, key, time.Duration(setting.ModelRequestRateLimitDurationMinutes)*time.Minute)
		return false, nil
	}

	return true, nil
}

// 记录Redis请求
func recordRedisRequest(ctx context.Context, rdb *redis.Client, key string, maxCount int) {
	// 如果maxCount为0，不记录请求
	if maxCount == 0 {
		return
	}

	now := time.Now().UTC().Format(modelRateLimitTimeFormat)
	rdb.LPush(ctx, key, now)
	rdb.LTrim(ctx, key, 0, int64(maxCount-1))
	rdb.Expire(ctx, key, time.Duration(setting.ModelRequestRateLimitDurationMinutes)*time.Minute)
}

// requestRateLimitScope is one set of counters a request has to fit in: a
// user's own, or the one all users' requests share.
type requestRateLimitScope struct {
	// key tells the scope's counters apart from other scopes'.
	key   string
	limit setting.RequestRateLimit
	// reachedMessage and totalReachedMessage are the i18n keys a request is
	// refused with once the scope's success cap or its request cap is reached.
	reachedMessage      string
	totalReachedMessage string
}

// globalRequestRateLimitKey names the counters all users' requests share. User
// scopes are keyed by user id, so it cannot collide with one.
const globalRequestRateLimitKey = "global"

func userRequestRateLimitScope(userId int, limit setting.RequestRateLimit) requestRateLimitScope {
	return requestRateLimitScope{
		key:                 strconv.Itoa(userId),
		limit:               limit,
		reachedMessage:      i18n.MsgRateLimitReached,
		totalReachedMessage: i18n.MsgRateLimitTotalReached,
	}
}

func globalRequestRateLimitScope() requestRateLimitScope {
	return requestRateLimitScope{
		key: globalRequestRateLimitKey,
		limit: setting.RequestRateLimit{
			Count:        setting.ModelRequestRateLimitGlobalCount,
			SuccessCount: setting.ModelRequestRateLimitGlobalSuccessCount,
		},
		reachedMessage:      i18n.MsgRateLimitSiteReached,
		totalReachedMessage: i18n.MsgRateLimitSiteTotalReached,
	}
}

func abortRateLimited(c *gin.Context, message string, max int) {
	abortWithOpenAiMessage(c, http.StatusTooManyRequests, i18n.T(c, message, map[string]any{
		"Minutes": setting.ModelRequestRateLimitDurationMinutes,
		"Max":     max,
	}))
}

// Redis限流处理器。按顺序检查每个范围，前面的范围拒绝时不再占用后面范围的名额。
func redisRateLimitHandler(duration int64, scopes ...requestRateLimitScope) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := context.Background()
		rdb := common.RDB

		for _, scope := range scopes {
			// 1. 检查成功请求数限制
			successKey := fmt.Sprintf("rateLimit:%s:%s", ModelRequestRateLimitSuccessCountMark, scope.key)
			allowed, err := checkRedisRateLimit(ctx, rdb, successKey, scope.limit.SuccessCount, duration)
			if err != nil {
				fmt.Println("检查成功请求数限制失败:", err.Error())
				abortWithOpenAiMessage(c, http.StatusInternalServerError, "rate_limit_check_failed")
				return
			}
			if !allowed {
				abortRateLimited(c, scope.reachedMessage, scope.limit.SuccessCount)
				return
			}

			// 2. 检查总请求数限制并记录总请求（为0时跳过），使用令牌桶限流器
			if scope.limit.Count > 0 {
				totalKey := fmt.Sprintf("rateLimit:%s", scope.key)
				tb := limiter.New(rdb)
				allowed, err = tb.Allow(
					ctx,
					totalKey,
					limiter.WithCapacity(rateLimitCapacity(scope.limit.Count, duration)),
					limiter.WithRate(int64(scope.limit.Count)),
					limiter.WithRequested(duration),
				)
				if err != nil {
					fmt.Println("检查总请求数限制失败:", err.Error())
					abortWithOpenAiMessage(c, http.StatusInternalServerError, "rate_limit_check_failed")
					return
				}
				if !allowed {
					abortRateLimited(c, scope.totalReachedMessage, scope.limit.Count)
					return
				}
			}
		}

		// 3. 处理请求
		c.Next()

		// 4. 如果请求成功，在每个范围记录成功请求
		if modelRequestSucceeded(c) {
			for _, scope := range scopes {
				successKey := fmt.Sprintf("rateLimit:%s:%s", ModelRequestRateLimitSuccessCountMark, scope.key)
				recordRedisRequest(ctx, rdb, successKey, scope.limit.SuccessCount)
			}
		}
	}
}

// 内存限流处理器。按顺序检查每个范围，前面的范围拒绝时不再占用后面范围的名额。
func memoryRateLimitHandler(duration int64, scopes ...requestRateLimitScope) gin.HandlerFunc {
	inMemoryRateLimiter.Init(time.Duration(setting.ModelRequestRateLimitDurationMinutes) * time.Minute)

	return func(c *gin.Context) {
		reservations := make([]*common.RateLimitReservation, 0, len(scopes))
		defer func() {
			for _, reservation := range reservations {
				reservation.Complete(false)
			}
		}()

		for _, scope := range scopes {
			// 1. 检查总请求数限制（为0时跳过）
			totalKey := ModelRequestRateLimitCountMark + scope.key
			if scope.limit.Count > 0 && !inMemoryRateLimiter.Request(totalKey, scope.limit.Count, duration) {
				abortRateLimited(c, scope.totalReachedMessage, scope.limit.Count)
				return
			}

			// 2. 预占成功请求名额，请求结束时按结果记入或释放
			if scope.limit.SuccessCount > 0 {
				successKey := ModelRequestRateLimitSuccessCountMark + scope.key
				reservation := inMemoryRateLimiter.Reserve(successKey, scope.limit.SuccessCount, duration)
				if reservation == nil {
					abortRateLimited(c, scope.reachedMessage, scope.limit.SuccessCount)
					return
				}
				reservations = append(reservations, reservation)
			}
		}

		// 3. 处理请求
		c.Next()

		// 4. 如果请求成功，记录到实际的成功请求计数中
		succeeded := modelRequestSucceeded(c)
		for _, reservation := range reservations {
			reservation.Complete(succeeded)
		}
	}
}

func modelRequestSucceeded(c *gin.Context) bool {
	status, _ := common.GetContextKeyType[*relaycommon.StreamStatus](c, constant.ContextKeyResponseStreamStatus)
	return c.Writer.Status() < 400 && !status.ResponseFailed()
}

// ModelRequestRateLimit 模型请求限流中间件。
// 每个用户始终受自己的限制：管理员单独设置的，否则是分组的，否则是默认值，再由有效订阅提升。
// 开关打开时，所有用户的请求还要共同遵守全站总量限制。
func ModelRequestRateLimit() func(c *gin.Context) {
	return func(c *gin.Context) {
		duration := rateLimitDurationSeconds(setting.ModelRequestRateLimitDurationMinutes)

		// 令牌指定的分组没有限制时（如 auto），按用户自己的分组
		tokenGroup := common.GetContextKeyString(c, constant.ContextKeyTokenGroup)
		userGroup := common.GetContextKeyString(c, constant.ContextKeyUserGroup)
		userId := c.GetInt("id")
		userSetting, _ := common.GetContextKeyType[dto.UserSetting](c, constant.ContextKeyUserSetting)
		limit, err := service.RequestRateLimitFor(userId, userSetting, tokenGroup, userGroup)
		if err != nil {
			// 订阅只会放宽限制，读不到订阅时按用户自己的基础限制处理，不拒绝请求。
			common.SysError(fmt.Sprintf("failed to read the subscriptions raising the request limit of user %d: %v", userId, err))
		}

		scopes := []requestRateLimitScope{userRequestRateLimitScope(userId, limit)}
		if setting.ModelRequestRateLimitEnabled {
			scopes = append(scopes, globalRequestRateLimitScope())
		}

		// 根据存储类型选择并执行限流处理器
		if common.RedisEnabled && common.RDB != nil {
			redisRateLimitHandler(duration, scopes...)(c)
		} else {
			memoryRateLimitHandler(duration, scopes...)(c)
		}
	}
}

func rateLimitDurationSeconds(durationMinutes int) int64 {
	if durationMinutes <= 0 {
		return 0
	}
	minutes := int64(durationMinutes)
	if minutes > math.MaxInt64/60 {
		return math.MaxInt64
	}
	return minutes * 60
}

func rateLimitCapacity(count int, durationSeconds int64) int64 {
	if count <= 0 || durationSeconds <= 0 {
		return 0
	}
	c := int64(count)
	if c > math.MaxInt64/durationSeconds {
		return math.MaxInt64
	}
	return c * durationSeconds
}

package limiter

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func useLimiterMiniRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()

	redisServer := miniredis.RunT(t)
	redisServer.SetTime(time.Unix(1700000000, 0))
	redisClient := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	require.NoError(t, redisClient.Ping(context.Background()).Err())

	t.Cleanup(func() {
		assert.NoError(t, redisClient.Close())
	})

	return redisServer, redisClient
}

func TestAllowFallsBackToEvalAfterScriptFlush(t *testing.T) {
	ctx := context.Background()
	_, redisClient := useLimiterMiniRedis(t)

	redisLimiter := New(redisClient)

	allowed, err := redisLimiter.Allow(
		ctx,
		"rateLimit:test-before-flush",
		WithCapacity(2),
		WithRate(1),
		WithRequested(1),
	)
	require.NoError(t, err)
	assert.True(t, allowed)

	require.NoError(t, redisClient.ScriptFlush(ctx).Err())

	allowed, err = redisLimiter.Allow(
		ctx,
		"rateLimit:test-before-flush",
		WithCapacity(2),
		WithRate(1),
		WithRequested(1),
	)
	require.NoError(t, err)
	assert.True(t, allowed)

	allowed, err = redisLimiter.Allow(ctx, "rateLimit:test-before-flush", WithCapacity(2), WithRate(1), WithRequested(1))
	require.NoError(t, err)
	assert.False(t, allowed, "reloading the script must preserve the exhausted bucket")
}

package controller

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type interruptedLogExportWriter struct {
	*httptest.ResponseRecorder
	failAt int
	writes int
	cancel context.CancelFunc
}

func (w *interruptedLogExportWriter) Write(body []byte) (int, error) {
	w.writes++
	if w.writes == w.failAt {
		return 0, errors.New("export connection interrupted")
	}
	n, err := w.ResponseRecorder.Write(body)
	if w.cancel != nil {
		w.cancel()
	}
	return n, err
}

func TestLogExportAccessTokenAuditRecordsStreamOutcome(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failAt  int
		success bool
		cancel  bool
	}{
		{name: "completed export", success: true},
		{name: "failure after a log was sent", failAt: 2},
		{name: "failure sending the final result", failAt: 3},
		{name: "client cancellation after a log was sent", cancel: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			user, _ := setupAccessTokenAudit(t)
			pat, _ := createScopedAccessToken(t, user.Id, time.Now().Unix()+3600, "usage:read")
			now := time.Now().Unix()
			require.NoError(t, model.LOG_DB.Create(&[]model.Log{
				{UserId: user.Id, CreatedAt: now, Type: model.LogTypeConsume, RequestId: "export-first"},
				{UserId: user.Id, CreatedAt: now, Type: model.LogTypeConsume, RequestId: "export-second"},
			}).Error)
			router := gin.New()
			router.Use(middleware.RequestId(), middleware.AccessTokenAudit())
			router.GET("/api/log/self/export", middleware.UserAuth(), ExportUserLogs)
			request := httptest.NewRequest(http.MethodGet, "/api/log/self/export", nil)
			ctx, cancel := context.WithCancel(request.Context())
			defer cancel()
			request = request.WithContext(ctx)
			request.Header.Set("Authorization", "Bearer "+pat)
			writer := &interruptedLogExportWriter{ResponseRecorder: httptest.NewRecorder(), failAt: tc.failAt}
			if tc.cancel {
				writer.cancel = cancel
			}
			router.ServeHTTP(writer, request)

			require.Equal(t, http.StatusOK, writer.Code)
			require.Contains(t, writer.Body.String(), "export-second", "a log must have been sent before the failure")
			var entry model.AuditLog
			require.NoError(t, model.LOG_DB.Where("request_id = ? AND category = ?", writer.Header().Get(common.RequestIdKey), model.AuditCategoryAccessToken).First(&entry).Error)
			assert.Equal(t, tc.success, entry.Success)
			assert.Equal(t, http.StatusOK, entry.Status)
			encoded, err := common.Marshal(entry)
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), pat)
			assert.NotContains(t, string(encoded), "export-second")
		})
	}
}

func TestLogExportAccessTokenAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name, path, scope, code string
		role                    int
	}{
		{name: "own export requires usage scope", path: "/api/log/self/export", scope: "profile:read", role: common.RoleAdminUser, code: "ACCESS_TOKEN_SCOPE_DENIED"},
		{name: "log scope does not elevate a regular user", path: "/api/log/export", scope: "log:read", role: common.RoleCommonUser, code: "AUTH_INSUFFICIENT_PRIVILEGE"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			user, _ := setupAccessTokenAudit(t)
			pat, _ := createScopedAccessToken(t, user.Id, time.Now().Unix()+3600, tc.scope)
			// The fixture disables Redis, so authentication reads the current role.
			require.NoError(t, model.DB.Model(user).Update("role", tc.role).Error)
			require.NoError(t, model.LOG_DB.Create(&model.Log{UserId: user.Id, CreatedAt: time.Now().Unix(), Type: model.LogTypeConsume, RequestId: "private-export-log", Content: "private export payload"}).Error)
			router := gin.New()
			router.Use(middleware.RequestId(), middleware.AccessTokenAudit())
			router.GET("/api/log/self/export", middleware.UserAuth(), ExportUserLogs)
			router.GET("/api/log/export", middleware.AdminAuth(), ExportAllLogs)
			response := accessTokenRequest(router, http.MethodGet, tc.path, pat, "", "")
			require.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
			var result struct {
				Success bool   `json:"success"`
				Code    string `json:"code"`
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			assert.False(t, result.Success)
			assert.Equal(t, tc.code, result.Code)
			assert.NotContains(t, response.Body.String(), "private-export-log")
			assert.NotContains(t, response.Body.String(), "private export payload")
		})
	}
}

// callLogHandler runs a log handler as the given user and returns the JSON
// lines of the response.
func callLogHandler(t *testing.T, handler gin.HandlerFunc, userId int, role int, query string) []map[string]any {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/log?"+query, nil)
	ctx.Set("id", userId)
	ctx.Set("role", role)
	handler(ctx)
	var lines []map[string]any
	for line := range strings.SplitSeq(strings.TrimSpace(recorder.Body.String()), "\n") {
		var value map[string]any
		require.NoError(t, common.UnmarshalJsonStr(line, &value))
		lines = append(lines, value)
	}
	return lines
}

func exportedRequestIds(lines []map[string]any) []any {
	ids := make([]any, 0, len(lines))
	for _, line := range lines[:len(lines)-1] {
		ids = append(ids, line["request_id"])
	}
	return ids
}

// seedExportLogs stores logs of two users: three in the last hour and one
// from 400 days ago.
func seedExportLogs(t *testing.T, mainDB *gorm.DB, logDB *gorm.DB, now int64) {
	t.Helper()
	require.NoError(t, mainDB.Create(&model.Channel{Id: 9, Name: "primary"}).Error)
	logs := []model.Log{
		{UserId: 1, Username: "alice", CreatedAt: now - 3600, Type: model.LogTypeConsume, ModelName: "gpt-a", ChannelId: 9, Quota: 10, RequestId: "a-1", Other: `{"admin_info":{"use_channel":["9"]}}`},
		{UserId: 2, Username: "bob", CreatedAt: now - 1800, Type: model.LogTypeConsume, ModelName: "gpt-b", ChannelId: 9, Quota: 20, RequestId: "b-1"},
		{UserId: 1, Username: "alice", CreatedAt: now - 60, Type: model.LogTypeError, ModelName: "gpt-a", RequestId: "a-2"},
		{UserId: 1, Username: "alice", CreatedAt: now - 400*24*3600, Type: model.LogTypeConsume, ModelName: "gpt-a", RequestId: "a-old"},
	}
	for i := range logs {
		require.NoError(t, logDB.Create(&logs[i]).Error)
	}
}

func useLogExportDatabases(t *testing.T, mainDB *gorm.DB, logDB *gorm.DB, mainType common.DatabaseType, logType common.DatabaseType) {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedis, previousMemory := common.RedisEnabled, common.MemoryCacheEnabled
	model.DB, model.LOG_DB = mainDB, logDB
	common.SetDatabaseTypes(mainType, logType)
	common.RedisEnabled, common.MemoryCacheEnabled = false, false
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.RedisEnabled, common.MemoryCacheEnabled = previousRedis, previousMemory
	})
}

func TestLogExportDatabaseMatrix(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previousMaster := common.IsMasterNode
	common.IsMasterNode = true
	t.Cleanup(func() { common.IsMasterNode = previousMaster })
	for _, tc := range []struct {
		kind, env string
		typ       common.DatabaseType
	}{
		{"sqlite", "", common.DatabaseTypeSQLite},
		{"mysql", "AUDIT_MYSQL_DSN", common.DatabaseTypeMySQL},
		{"postgres", "AUDIT_POSTGRES_DSN", common.DatabaseTypePostgreSQL},
		{"clickhouse", "AUDIT_CLICKHOUSE_DSN", common.DatabaseTypeClickHouse},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if tc.env != "" && dsn == "" {
				t.Skip(tc.env + " is not configured")
			}
			db, isolatedDSN := newAuditTestDatabase(t, tc.kind, dsn)
			mainDB, mainType := db, tc.typ
			if tc.kind == "clickhouse" {
				mainDB, _ = newAuditTestDatabase(t, "sqlite", "")
				mainType = common.DatabaseTypeSQLite
			}
			useLogExportDatabases(t, mainDB, db, mainType, tc.typ)
			require.NoError(t, mainDB.AutoMigrate(&model.Channel{}))
			if tc.kind == "clickhouse" {
				t.Setenv("LOG_SQL_DSN", isolatedDSN)
				require.NoError(t, model.InitLogDB())
			} else {
				require.NoError(t, db.AutoMigrate(&model.Log{}))
			}
			versionSQL := "SELECT version()"
			if tc.kind == "sqlite" {
				versionSQL = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, model.LOG_DB.Raw(versionSQL).Scan(&version).Error)
			t.Logf("log database: %s %s", tc.kind, version)
			now := time.Now().Unix()
			seedExportLogs(t, mainDB, model.LOG_DB, now)
			query := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", now-2*24*3600, now+3600)

			listed := callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, query)[0]
			require.Equal(t, true, listed["success"])
			assert.EqualValues(t, 2, listed["data"].(map[string]any)["total"])
			listed = callLogHandler(t, GetAllLogs, 3, common.RoleAdminUser, query+"&username=alice")[0]
			require.Equal(t, true, listed["success"])
			assert.EqualValues(t, 2, listed["data"].(map[string]any)["total"])

			own := callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, query)
			require.Len(t, own, 3)
			assert.Equal(t, []any{"a-2", "a-1"}, exportedRequestIds(own))
			assert.Equal(t, map[string]any{"success": true, "message": "", "data": map[string]any{"count": float64(2)}}, own[2])
			assert.Equal(t, float64(1), own[0]["id"], "user exports carry list positions, not row ids")
			assert.Empty(t, own[1]["channel_name"])
			assert.NotContains(t, own[1]["other"], "admin_info")

			all := callLogHandler(t, ExportAllLogs, 3, common.RoleAdminUser, query+"&model_name=gpt-%25")
			require.Len(t, all, 4)
			assert.Equal(t, []any{"a-2", "b-1", "a-1"}, exportedRequestIds(all))
			assert.Equal(t, "primary", all[2]["channel_name"])
			assert.Contains(t, all[2]["other"], "admin_info")
			assert.Equal(t, true, all[3]["success"])
		})
	}
}

func TestLogExportRules(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, _ := newAuditTestDatabase(t, "sqlite", "")
	useLogExportDatabases(t, db, db, common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Log{}, &model.QuotaData{}))
	now := time.Now().Unix()
	seedExportLogs(t, db, db, now)
	logSetting := operation_setting.GetLogSetting()
	previousSetting := *logSetting
	t.Cleanup(func() { *logSetting = previousSetting })
	recent := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", now-2*24*3600, now)
	tooLong := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", now-366*24*3600, now)

	t.Run("time range", func(t *testing.T) {
		rejected := callLogHandler(t, ExportAllLogs, 3, common.RoleAdminUser, tooLong)
		require.Len(t, rejected, 1)
		assert.Equal(t, false, rejected[0]["success"])
		assert.Equal(t, "The time range cannot exceed {{days}} days", rejected[0]["message_key"])
		assert.Equal(t, map[string]any{"days": float64(365)}, rejected[0]["message_params"])

		assert.Equal(t, false, callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, tooLong)[0]["success"])
		assert.Equal(t, false, callLogHandler(t, GetLogsSelfStat, 1, common.RoleCommonUser, tooLong)[0]["success"])
		assert.Equal(t, true, callLogHandler(t, GetUserLogs, 3, common.RoleAdminUser, tooLong)[0]["success"], "administrators search their own logs without a limit")

		// The dashboard follows the same range instead of its old one-month limit.
		fortyDays := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", now-40*24*3600, now)
		for _, handler := range []gin.HandlerFunc{GetUserQuotaDates, GetUserFlowQuotaDates} {
			assert.Equal(t, "The time range cannot exceed {{days}} days", callLogHandler(t, handler, 1, common.RoleCommonUser, tooLong)[0]["message_key"])
			assert.Equal(t, true, callLogHandler(t, handler, 1, common.RoleCommonUser, fortyDays)[0]["success"])
		}

		// Without a start, a user's search reaches back the whole range.
		listed := callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, "")[0]
		assert.Equal(t, true, listed["success"])
		assert.EqualValues(t, 2, listed["data"].(map[string]any)["total"])

		logSetting.MaxRangeDays = 400
		assert.Equal(t, true, callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, tooLong)[0]["success"])
		logSetting.MaxRangeDays = previousSetting.MaxRangeDays
	})

	t.Run("user export switch", func(t *testing.T) {
		logSetting.UserExportEnabled = false
		t.Cleanup(func() { logSetting.UserExportEnabled = previousSetting.UserExportEnabled })
		disabled := callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, recent)
		require.Len(t, disabled, 1)
		assert.Equal(t, "Log export is disabled", disabled[0]["message_key"])
		assert.Equal(t, true, callLogHandler(t, ExportUserLogs, 3, common.RoleAdminUser, recent)[0]["success"], "administrators export their own logs even when users cannot")
	})

	t.Run("one export per user", func(t *testing.T) {
		release, ok, err := service.AcquireLogExportLock(1)
		require.NoError(t, err)
		require.True(t, ok)
		busy := callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, recent)
		require.Len(t, busy, 1)
		assert.Equal(t, "Another log export is running. Try again after it finishes.", busy[0]["message_key"])
		other := callLogHandler(t, ExportUserLogs, 2, common.RoleCommonUser, recent)
		assert.Equal(t, true, other[len(other)-1]["success"], "other users are not blocked")
		release()
		assert.Len(t, callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, recent), 3)
	})
}

func TestLogExportTimeRangeBounds(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, _ := newAuditTestDatabase(t, "sqlite", "")
	useLogExportDatabases(t, db, db, common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Log{}))
	now := time.Now().Unix()
	seedExportLogs(t, db, db, now)
	setting := operation_setting.GetLogSetting()
	previous := *setting
	t.Cleanup(func() { *setting = previous })
	const day = 24 * 60 * 60
	for _, tc := range []struct {
		name       string
		start, end int64
		maxDays    int
		allowed    bool
		ids        []any
	}{
		{name: "negative start", start: -1, end: now},
		{name: "negative end", end: -1},
		{name: "minimum start cannot overflow the range check", start: math.MinInt64, end: now},
		{name: "minimum end cannot overflow the default start", end: math.MinInt64},
		{name: "opposite integer extremes", start: math.MinInt64, end: math.MaxInt64},
		{name: "inverted range", start: now, end: now - 1},
		{name: "maximum start with an earlier end", start: math.MaxInt64, end: now},
		{name: "maximum start with implicit end remains empty", start: math.MaxInt64, allowed: true, ids: []any{}},
		{name: "one second beyond the configured range", start: now - 365*day - 1, end: now},
		{name: "normal range", start: now - 2*day, end: now, allowed: true, ids: []any{"a-2", "a-1"}},
		{name: "exact configured boundary", start: now - 365*day, end: now, allowed: true, ids: []any{"a-2", "a-1"}},
		{name: "future end does not extend the counted span", start: now - 2*day, end: math.MaxInt64, allowed: true, ids: []any{"a-2", "a-1"}},
		{name: "ordered future range remains empty", start: now + day, end: math.MaxInt64, allowed: true, ids: []any{}},
		{name: "huge configured range with an omitted start", end: now, maxDays: int(^uint(0) >> 1), allowed: true, ids: []any{"a-old", "a-2", "a-1"}},
		{name: "huge configured range with an explicit start", start: now - 401*day, end: now, maxDays: int(^uint(0) >> 1), allowed: true, ids: []any{"a-old", "a-2", "a-1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setting.MaxRangeDays = 365
			setting.UserExportEnabled = true
			if tc.maxDays != 0 {
				setting.MaxRangeDays = tc.maxDays
			}
			query := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", tc.start, tc.end)
			lines := callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, query)
			if !tc.allowed {
				require.Len(t, lines, 1, "invalid ranges must be rejected before any log is exported")
				assert.Equal(t, false, lines[0]["success"])
				return
			}
			require.Equal(t, true, lines[len(lines)-1]["success"])
			assert.Equal(t, tc.ids, exportedRequestIds(lines))
		})
	}
}

func TestLogExportWithSingleDatabaseConnection(t *testing.T) {
	for _, tc := range []struct {
		kind, env string
		typ       common.DatabaseType
	}{
		{"sqlite", "", common.DatabaseTypeSQLite},
		{"mysql", "AUDIT_MYSQL_DSN", common.DatabaseTypeMySQL},
		{"postgres", "AUDIT_POSTGRES_DSN", common.DatabaseTypePostgreSQL},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if tc.env != "" && dsn == "" {
				t.Skip(tc.env + " is not configured")
			}
			db, _ := newAuditTestDatabase(t, tc.kind, dsn)
			useLogExportDatabases(t, db, db, tc.typ, tc.typ)
			require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Log{}))
			seedExportLogs(t, db, db, time.Now().Unix())
			connection, err := db.DB()
			require.NoError(t, err)
			connection.SetMaxOpenConns(1)
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			var logs []*model.Log
			err = model.StreamAllLogs(ctx, model.LogFilter{}, common.RoleAdminUser, func(log *model.Log) error {
				logs = append(logs, log)
				return nil
			})
			require.NoError(t, err, "looking up channel names must not wait for the connection held by the log cursor")
			require.Len(t, logs, 4)
			assert.Equal(t, "primary", logs[1].ChannelName)
			assert.Equal(t, "primary", logs[2].ChannelName)
		})
	}
}

func TestAcquireLogExportLock(t *testing.T) {
	for _, useRedis := range []bool{false, true} {
		t.Run(fmt.Sprintf("redis=%v", useRedis), func(t *testing.T) {
			previousRedis, previousClient := common.RedisEnabled, common.RDB
			common.RedisEnabled = useRedis
			if useRedis {
				server := miniredis.RunT(t)
				common.RDB = redis.NewClient(&redis.Options{Addr: server.Addr()})
				require.NoError(t, common.RDB.Ping(context.Background()).Err())
			}
			t.Cleanup(func() { common.RedisEnabled, common.RDB = previousRedis, previousClient })

			release, ok, err := service.AcquireLogExportLock(1)
			require.NoError(t, err)
			require.True(t, ok)
			_, ok, err = service.AcquireLogExportLock(1)
			require.NoError(t, err)
			assert.False(t, ok, "a second export of the same user must wait")
			releaseOther, ok, err := service.AcquireLogExportLock(2)
			require.NoError(t, err)
			assert.True(t, ok)
			releaseOther()
			release()
			releaseAgain, ok, err := service.AcquireLogExportLock(1)
			require.NoError(t, err)
			assert.True(t, ok, "a finished export frees the user")
			releaseAgain()
		})
	}
}

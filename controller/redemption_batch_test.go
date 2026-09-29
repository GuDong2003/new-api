package controller

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// useRedemptionAPITestDB points the model package at empty main and log
// databases of the dialect and returns them. MySQL and PostgreSQL run when
// TEST_MYSQL_DSN / TEST_POSTGRES_DSN name throwaway databases.
func useRedemptionAPITestDB(t *testing.T, dialect string) (*gorm.DB, *gorm.DB) {
	t.Helper()
	var driver, logDriver gorm.Dialector
	dbType := common.DatabaseTypeSQLite
	switch dialect {
	case "sqlite":
		driver = sqlite.Open(":memory:")
		logDriver = sqlite.Open(":memory:")
	case "mysql":
		dsn := os.Getenv("TEST_MYSQL_DSN")
		if dsn == "" {
			t.Skip("TEST_MYSQL_DSN is not configured")
		}
		driver = mysql.Open(dsn)
		logDSN := os.Getenv("TEST_MYSQL_LOG_DSN")
		if logDSN == "" {
			logDSN = dsn
		}
		logDriver = mysql.Open(logDSN)
		dbType = common.DatabaseTypeMySQL
	case "postgres":
		dsn := os.Getenv("TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Skip("TEST_POSTGRES_DSN is not configured")
		}
		driver = postgres.Open(dsn)
		logDSN := os.Getenv("TEST_POSTGRES_LOG_DSN")
		if logDSN == "" {
			logDSN = dsn
		}
		logDriver = postgres.Open(logDSN)
		dbType = common.DatabaseTypePostgreSQL
	}
	db, err := gorm.Open(driver, &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	var version string
	query := "SELECT version()"
	if dialect == "sqlite" {
		query = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(query).Scan(&version).Error)
	t.Logf("database version: %s", version)

	logDB, err := gorm.Open(logDriver, &gorm.Config{})
	require.NoError(t, err)
	logSQL, err := logDB.DB()
	require.NoError(t, err)
	logSQL.SetMaxOpenConns(1)
	t.Cleanup(func() { require.NoError(t, logSQL.Close()) })
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedis := common.RedisEnabled
	model.DB, model.LOG_DB = db, logDB
	common.SetDatabaseTypes(dbType, dbType)
	common.RedisEnabled = false
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.RedisEnabled = previousRedis
	})
	for _, table := range []any{&model.User{}, &model.Redemption{}, &model.RedemptionRecord{}} {
		require.False(t, db.Migrator().HasTable(table), "use an empty test database")
		require.NoError(t, db.AutoMigrate(table))
		t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(table)) })
	}
	require.False(t, logDB.Migrator().HasTable(&model.AuditLog{}), "use an empty test log database")
	require.NoError(t, logDB.AutoMigrate(&model.AuditLog{}))
	t.Cleanup(func() { require.NoError(t, logDB.Migrator().DropTable(&model.AuditLog{})) })
	return db, logDB
}

func TestDeleteRedemptionBatch(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, logDB := useRedemptionAPITestDB(t, dialect)
			token := "redemption-audit-test-token"
			admin := model.User{Username: "redemption-audit-admin", Password: "unused", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default", AccessToken: &token}
			require.NoError(t, db.Create(&admin).Error)
			codes := make([]model.Redemption, 16)
			for index := range codes {
				codes[index] = model.Redemption{Name: "selected", Key: fmt.Sprintf("%032d", index+1), Quota: 100, Status: common.RedemptionCodeStatusEnabled}
			}
			codes[1].Status = common.RedemptionCodeStatusUsed
			codes[15].Name = "unselected"
			codes[15].Status = common.RedemptionCodeStatusDisabled
			require.NoError(t, model.DB.Create(&codes).Error)
			router := gin.New()
			router.Use(middleware.RequestId())
			router.POST("/api/redemption/batch", middleware.AdminAuth(), DeleteRedemptionBatch)

			overLimit := make([]int, 1001)
			for index := range overLimit {
				overLimit[index] = codes[0].Id
			}
			oversized, err := common.Marshal(map[string]any{"ids": overLimit})
			require.NoError(t, err)
			for _, body := range []string{"{}", `{"ids":[]}`, `{"ids":null}`, `{"ids":[0]}`, `{"ids":[1,-1]}`, `{"ids":["1"]}`, "{", string(oversized)} {
				t.Run("invalid_"+body[:min(len(body), 30)], func(t *testing.T) {
					response := httptest.NewRecorder()
					request := httptest.NewRequest(http.MethodPost, "/api/redemption/batch", bytes.NewBufferString(body))
					request.Header.Set("Authorization", "Bearer "+token)
					router.ServeHTTP(response, request)
					var result struct {
						Success bool `json:"success"`
					}
					require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
					assert.False(t, result.Success)
					var count int64
					require.NoError(t, model.DB.Model(&model.Redemption{}).Count(&count).Error)
					assert.EqualValues(t, 16, count)
					var events []model.AuditLog
					require.NoError(t, logDB.Where("request_id = ? AND category = ?", response.Header().Get(common.RequestIdKey), model.AuditCategoryOperation).Find(&events).Error)
					require.Len(t, events, 1)
					assert.False(t, events[0].Success)
					assert.Equal(t, "redemption.delete_batch", events[0].Action)
				})
			}
			_, err = model.BatchDeleteRedemptions(nil)
			require.Error(t, err)
			requestedIDs := make([]int, 0, 17)
			for _, code := range codes[:15] {
				requestedIDs = append(requestedIDs, code.Id)
			}
			requestedIDs = append(requestedIDs, codes[0].Id, 999999)
			payload, err := common.Marshal(map[string]any{"ids": requestedIDs})
			require.NoError(t, err)
			for _, expectedCount := range []int64{15, 0} {
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, "/api/redemption/batch", bytes.NewReader(payload))
				request.Header.Set("Authorization", "Bearer "+token)
				router.ServeHTTP(response, request)
				assert.Equal(t, http.StatusOK, response.Code)
				var result struct {
					Success bool  `json:"success"`
					Data    int64 `json:"data"`
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
				assert.True(t, result.Success)
				assert.Equal(t, expectedCount, result.Data)
				var events []model.AuditLog
				require.NoError(t, logDB.Where("request_id = ? AND category = ?", response.Header().Get(common.RequestIdKey), model.AuditCategoryOperation).Find(&events).Error)
				require.Len(t, events, 1, "one operation event, without a duplicate single-delete fallback")
				event := events[0]
				assert.Equal(t, "redemption.delete_batch", event.Action)
				assert.Equal(t, fmt.Sprintf("Batch deleted %d redemption codes", expectedCount), event.Content)
				assert.True(t, event.Success)
				assert.Equal(t, admin.Id, event.UserId)
				assert.Equal(t, "/api/redemption/batch", event.Route)
				require.NotNil(t, event.Other.Op)
				encoded, err := common.Marshal(event.Other.Op.Params)
				require.NoError(t, err)
				var params struct {
					Count int64 `json:"count"`
					Total int   `json:"total"`
					IDs   []int `json:"requested_redemption_ids"`
				}
				require.NoError(t, common.Unmarshal(encoded, &params))
				assert.Equal(t, expectedCount, params.Count)
				assert.Equal(t, len(requestedIDs), params.Total)
				assert.Equal(t, requestedIDs, params.IDs)
				encoded, err = common.Marshal(event)
				require.NoError(t, err)
				assert.NotContains(t, string(encoded), token)
				for _, code := range codes {
					assert.NotContains(t, string(encoded), code.Key)
				}
			}
			var active []model.Redemption
			require.NoError(t, model.DB.Find(&active).Error)
			require.Len(t, active, 1)
			assert.Equal(t, codes[15], active[0])
			var all []model.Redemption
			require.NoError(t, model.DB.Unscoped().Order("id").Find(&all).Error)
			require.Len(t, all, 16)
			for _, code := range all[:15] {
				assert.True(t, code.DeletedAt.Valid)
			}
			assert.False(t, all[15].DeletedAt.Valid)
		})
	}
}

type redemptionAPIResult struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func TestRedemptionAdminAPI(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, logDB := useRedemptionAPITestDB(t, dialect)
			confirmPaymentComplianceForTest(t)
			token := "redemption-api-test-token"
			admin := model.User{Username: "redemption-api-admin", Password: "unused", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default", AccessToken: &token, AffCode: "redemption-api-admin"}
			require.NoError(t, db.Create(&admin).Error)
			router := gin.New()
			router.Use(middleware.RequestId())
			redemptions := router.Group("/api/redemption", middleware.AdminAuth())
			redemptions.POST("/", AddRedemption)
			redemptions.PUT("/", UpdateRedemption)
			redemptions.GET("/:id", GetRedemption)
			redemptions.GET("/:id/records", GetRedemptionRecords)
			call := func(t *testing.T, method, path string, body any) redemptionAPIResult {
				t.Helper()
				var payload io.Reader
				if body != nil {
					encoded, err := common.Marshal(body)
					require.NoError(t, err)
					payload = bytes.NewReader(encoded)
				}
				response := httptest.NewRecorder()
				request := httptest.NewRequest(method, path, payload)
				request.Header.Set("Authorization", "Bearer "+token)
				request.Header.Set("Content-Type", "application/json")
				router.ServeHTTP(response, request)
				require.Equal(t, http.StatusOK, response.Code)
				var result redemptionAPIResult
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
				return result
			}
			codesNamed := func(t *testing.T, name string) []model.Redemption {
				t.Helper()
				var codes []model.Redemption
				require.NoError(t, db.Where("name = ?", name).Order("id").Find(&codes).Error)
				return codes
			}

			t.Run("each creation request makes its own batch", func(t *testing.T) {
				batches := map[string]bool{}
				for _, tt := range []struct {
					name           string
					body           map[string]any
					wantCodes      int
					wantMaxUses    int
					wantOnePerUser bool
				}{
					{name: "legacy", body: map[string]any{"name": "legacy", "quota": 100, "count": 2}, wantCodes: 2, wantMaxUses: 1},
					{name: "one-time", body: map[string]any{"name": "giveaway", "quota": 100, "count": 3, "batch_one_per_user": true}, wantCodes: 3, wantMaxUses: 1, wantOnePerUser: true},
					{name: "shared", body: map[string]any{"name": "shared", "quota": 100, "count": 1, "max_uses": 50}, wantCodes: 1, wantMaxUses: 50},
				} {
					result := call(t, http.MethodPost, "/api/redemption/", tt.body)
					require.True(t, result.Success, "%s: %s", tt.name, result.Message)
					codes := codesNamed(t, tt.body["name"].(string))
					require.Len(t, codes, tt.wantCodes, tt.name)
					for _, code := range codes {
						assert.Len(t, code.BatchId, 32, tt.name)
						assert.Equal(t, codes[0].BatchId, code.BatchId, tt.name)
						assert.Equal(t, tt.wantMaxUses, code.MaxUses, tt.name)
						assert.Equal(t, tt.wantOnePerUser, code.BatchOnePerUser, tt.name)
						assert.Zero(t, code.UsedCount, tt.name)
					}
					batches[codes[0].BatchId] = true
				}
				assert.Len(t, batches, 3)
			})

			t.Run("creation refuses shared codes it cannot make", func(t *testing.T) {
				for _, body := range []map[string]any{
					{"name": "refused", "quota": 100, "count": 2, "max_uses": 5},
					{"name": "refused", "quota": 100, "count": 1, "max_uses": 100001},
					{"name": "refused", "quota": 100, "count": 1, "max_uses": -1},
					{"name": "refused", "quota": 100, "count": 1, "max_uses": 5, "batch_one_per_user": true},
				} {
					result := call(t, http.MethodPost, "/api/redemption/", body)
					assert.False(t, result.Success, "%v", body)
				}
				assert.Empty(t, codesNamed(t, "refused"))
			})

			t.Run("editing a shared code moves its status with the limit", func(t *testing.T) {
				code := model.Redemption{Name: "shared-edit", Key: fmt.Sprintf("%032d", 101), Quota: 100, Status: common.RedemptionCodeStatusUsed,
					BatchId: "batch-shared-edit", MaxUses: 2, UsedCount: 2}
				require.NoError(t, db.Create(&code).Error)
				edit := func(maxUses int) redemptionAPIResult {
					return call(t, http.MethodPut, "/api/redemption/", map[string]any{"id": code.Id, "name": code.Name, "quota": 100, "max_uses": maxUses})
				}
				assert.False(t, edit(1).Success, "fewer uses than accounts that redeemed it")
				assert.False(t, edit(100001).Success)

				require.True(t, edit(5).Success)
				saved := codesNamed(t, "shared-edit")[0]
				assert.Equal(t, 5, saved.MaxUses)
				assert.Equal(t, common.RedemptionCodeStatusEnabled, saved.Status, "room again for more accounts")

				require.True(t, edit(2).Success)
				saved = codesNamed(t, "shared-edit")[0]
				assert.Equal(t, common.RedemptionCodeStatusUsed, saved.Status, "used up again")
			})

			t.Run("a shared code keeps room for the accounts that redeemed it", func(t *testing.T) {
				code := model.Redemption{Name: "shared-floor", Key: fmt.Sprintf("%032d", 111), Quota: 100, Status: common.RedemptionCodeStatusEnabled,
					BatchId: "batch-shared-floor", MaxUses: 10, UsedCount: 4}
				require.NoError(t, db.Create(&code).Error)
				for _, maxUses := range []int{3, 1} {
					result := call(t, http.MethodPut, "/api/redemption/", map[string]any{"id": code.Id, "name": code.Name, "quota": 100, "max_uses": maxUses})
					assert.False(t, result.Success, "max_uses %d", maxUses)
				}
				assert.Equal(t, 10, codesNamed(t, "shared-floor")[0].MaxUses)
			})

			t.Run("an edit that echoes a one-time code back keeps working", func(t *testing.T) {
				code := model.Redemption{Name: "echoed", Key: fmt.Sprintf("%032d", 121), Quota: 100, Status: common.RedemptionCodeStatusEnabled,
					BatchId: "batch-echoed", MaxUses: 1}
				require.NoError(t, db.Create(&code).Error)
				result := call(t, http.MethodGet, fmt.Sprintf("/api/redemption/%d", code.Id), nil)
				require.True(t, result.Success, result.Message)
				var echoed map[string]any
				require.NoError(t, common.Unmarshal(result.Data, &echoed))
				echoed["name"] = "echoed-renamed"

				result = call(t, http.MethodPut, "/api/redemption/", echoed)
				require.True(t, result.Success, result.Message)
				saved := codesNamed(t, "echoed-renamed")
				require.Len(t, saved, 1)
				assert.Equal(t, 1, saved[0].MaxUses)
			})

			t.Run("an edit is audited with what it changed", func(t *testing.T) {
				code := model.Redemption{Name: "audited", Key: fmt.Sprintf("%032d", 131), Quota: 100, Status: common.RedemptionCodeStatusEnabled,
					BatchId: "batch-audited", MaxUses: 1}
				require.NoError(t, db.Create(&code).Error)
				body, err := common.Marshal(map[string]any{"id": code.Id, "name": "audited", "quota": 100, "batch_one_per_user": true})
				require.NoError(t, err)
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPut, "/api/redemption/", bytes.NewReader(body))
				request.Header.Set("Authorization", "Bearer "+token)
				router.ServeHTTP(response, request)
				require.Equal(t, http.StatusOK, response.Code)

				var events []model.AuditLog
				require.NoError(t, logDB.Where("request_id = ? AND category = ?", response.Header().Get(common.RequestIdKey), model.AuditCategoryOperation).Find(&events).Error)
				require.Len(t, events, 1)
				assert.Equal(t, "redemption.update", events[0].Action)
				require.NotNil(t, events[0].Other.Op)
				encoded, err := common.Marshal(events[0].Other.Op.Params)
				require.NoError(t, err)
				var params struct {
					Id              int    `json:"id"`
					BatchId         string `json:"batch_id"`
					BatchOnePerUser *bool  `json:"batch_one_per_user"`
				}
				require.NoError(t, common.Unmarshal(encoded, &params))
				assert.Equal(t, code.Id, params.Id)
				assert.Equal(t, "batch-audited", params.BatchId)
				require.NotNil(t, params.BatchOnePerUser)
				assert.True(t, *params.BatchOnePerUser)
			})

			t.Run("the batch rule applies to the whole batch", func(t *testing.T) {
				codes := []model.Redemption{
					{Name: "batch-edit", Key: fmt.Sprintf("%032d", 201), Quota: 100, Status: common.RedemptionCodeStatusEnabled, BatchId: "batch-edit", MaxUses: 1},
					{Name: "batch-edit", Key: fmt.Sprintf("%032d", 202), Quota: 100, Status: common.RedemptionCodeStatusEnabled, BatchId: "batch-edit", MaxUses: 1},
					{Name: "batch-other", Key: fmt.Sprintf("%032d", 203), Quota: 100, Status: common.RedemptionCodeStatusEnabled, BatchId: "batch-other", MaxUses: 1},
				}
				require.NoError(t, db.Create(&codes).Error)

				result := call(t, http.MethodGet, fmt.Sprintf("/api/redemption/%d", codes[0].Id), nil)
				require.True(t, result.Success, result.Message)
				var loaded model.Redemption
				require.NoError(t, common.Unmarshal(result.Data, &loaded))
				assert.EqualValues(t, 2, loaded.BatchSize)

				result = call(t, http.MethodPut, "/api/redemption/", map[string]any{"id": codes[0].Id, "name": "batch-edit", "quota": 100, "batch_one_per_user": true})
				require.True(t, result.Success, result.Message)
				for _, code := range codesNamed(t, "batch-edit") {
					assert.True(t, code.BatchOnePerUser)
				}
				assert.False(t, codesNamed(t, "batch-other")[0].BatchOnePerUser)

				result = call(t, http.MethodPut, "/api/redemption/", map[string]any{"id": codes[1].Id, "name": "batch-edit", "quota": 200})
				require.True(t, result.Success, result.Message)
				for _, code := range codesNamed(t, "batch-edit") {
					assert.True(t, code.BatchOnePerUser, "an edit without the rule keeps it")
				}
			})

			t.Run("a used-up code cannot be enabled again", func(t *testing.T) {
				codes := []model.Redemption{
					{Name: "exhausted", Key: fmt.Sprintf("%032d", 301), Quota: 100, Status: common.RedemptionCodeStatusDisabled, BatchId: "batch-exhausted", MaxUses: 1, UsedCount: 1},
					{Name: "room-left", Key: fmt.Sprintf("%032d", 302), Quota: 100, Status: common.RedemptionCodeStatusDisabled, BatchId: "batch-room-left", MaxUses: 3, UsedCount: 1},
				}
				require.NoError(t, db.Create(&codes).Error)
				enable := func(id int) redemptionAPIResult {
					return call(t, http.MethodPut, "/api/redemption/?status_only=true", map[string]any{"id": id, "status": common.RedemptionCodeStatusEnabled})
				}
				assert.False(t, enable(codes[0].Id).Success)
				assert.Equal(t, common.RedemptionCodeStatusDisabled, codesNamed(t, "exhausted")[0].Status)
				require.True(t, enable(codes[1].Id).Success)
				assert.Equal(t, common.RedemptionCodeStatusEnabled, codesNamed(t, "room-left")[0].Status)
			})

			t.Run("records list who redeemed a code, newest first", func(t *testing.T) {
				users := []model.User{
					{Username: "redeemer-one", Password: "unused", Status: common.UserStatusEnabled, AffCode: "redeemer-one"},
					{Username: "redeemer-two", Password: "unused", Status: common.UserStatusEnabled, AffCode: "redeemer-two"},
				}
				require.NoError(t, db.Create(&users).Error)
				code := model.Redemption{Name: "recorded", Key: fmt.Sprintf("%032d", 401), Quota: 100, Status: common.RedemptionCodeStatusEnabled, BatchId: "batch-recorded", MaxUses: 10, UsedCount: 2}
				require.NoError(t, db.Create(&code).Error)
				require.NoError(t, db.Create(&[]model.RedemptionRecord{
					{RedemptionId: code.Id, UserId: users[0].Id, BatchId: code.BatchId, Quota: 100, CreatedTime: 1790000000},
					{RedemptionId: code.Id, UserId: users[1].Id, BatchId: code.BatchId, Quota: 100, CreatedTime: 1790000100},
				}).Error)

				result := call(t, http.MethodGet, fmt.Sprintf("/api/redemption/%d/records?p=1&page_size=10", code.Id), nil)
				require.True(t, result.Success, result.Message)
				var page struct {
					Total int `json:"total"`
					Items []struct {
						UserId      int    `json:"user_id"`
						Username    string `json:"username"`
						Quota       int    `json:"quota"`
						CreatedTime int64  `json:"created_time"`
					} `json:"items"`
				}
				require.NoError(t, common.Unmarshal(result.Data, &page))
				assert.Equal(t, 2, page.Total)
				require.Len(t, page.Items, 2)
				assert.Equal(t, users[1].Id, page.Items[0].UserId)
				assert.Equal(t, "redeemer-two", page.Items[0].Username)
				assert.Equal(t, int64(1790000100), page.Items[0].CreatedTime)
				assert.Equal(t, "redeemer-one", page.Items[1].Username)
				assert.Equal(t, 100, page.Items[1].Quota)
			})
		})
	}
}

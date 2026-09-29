package model

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestSearchRedemptionsFiltersAndPaginates(t *testing.T) {
	require.NoError(t, DB.AutoMigrate(&Redemption{}))
	require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
	})

	now := common.GetTimestamp()
	redemptions := []Redemption{
		{Id: 1, Name: "alpha-active", Key: "00000000000000000000000000000001", Status: common.RedemptionCodeStatusEnabled, ExpiredTime: 0},
		{Id: 2, Name: "alpha-future", Key: "00000000000000000000000000000002", Status: common.RedemptionCodeStatusEnabled, ExpiredTime: now + 3600},
		{Id: 3, Name: "alpha-expired", Key: "00000000000000000000000000000003", Status: common.RedemptionCodeStatusEnabled, ExpiredTime: now - 10},
		{Id: 4, Name: "beta-disabled", Key: "00000000000000000000000000000004", Status: common.RedemptionCodeStatusDisabled, ExpiredTime: 0},
		{Id: 5, Name: "beta-used", Key: "00000000000000000000000000000005", Status: common.RedemptionCodeStatusUsed, ExpiredTime: 0},
	}
	require.NoError(t, DB.Create(&redemptions).Error)

	tests := []struct {
		name      string
		keyword   string
		status    string
		startIdx  int
		num       int
		wantTotal int64
		wantIds   []int
	}{
		{
			name:      "no filters returns all rows",
			num:       10,
			wantTotal: 5,
			wantIds:   []int{5, 4, 3, 2, 1},
		},
		{
			name:      "keyword filters by name prefix",
			keyword:   "alpha",
			num:       10,
			wantTotal: 3,
			wantIds:   []int{3, 2, 1},
		},
		{
			name:      "enabled status excludes expired rows",
			status:    "1",
			num:       10,
			wantTotal: 2,
			wantIds:   []int{2, 1},
		},
		{
			name:      "expired status returns enabled expired rows",
			status:    "expired",
			num:       10,
			wantTotal: 1,
			wantIds:   []int{3},
		},
		{
			name:      "disabled status",
			status:    "2",
			num:       10,
			wantTotal: 1,
			wantIds:   []int{4},
		},
		{
			name:      "used status",
			status:    "3",
			num:       10,
			wantTotal: 1,
			wantIds:   []int{5},
		},
		{
			name:      "pagination keeps unpaged total",
			startIdx:  1,
			num:       2,
			wantTotal: 5,
			wantIds:   []int{4, 3},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows, total, err := SearchRedemptions(tt.keyword, tt.status, tt.startIdx, tt.num)
			require.NoError(t, err)
			assert.Equal(t, tt.wantTotal, total)
			gotIds := make([]int, 0, len(rows))
			for _, row := range rows {
				gotIds = append(gotIds, row.Id)
			}
			assert.Equal(t, tt.wantIds, gotIds)
		})
	}
}

func setupRedeemFixture(t *testing.T, quota int) (userId int, key string) {
	t.Helper()
	require.NoError(t, DB.AutoMigrate(&Redemption{}, &RedemptionRecord{}))
	require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
		DB.Exec("DELETE FROM redemption_records")
		DB.Exec("DELETE FROM users")
		DB.Exec("DELETE FROM logs")
	})

	user := &User{Username: "redeem-user", Password: "password", Status: common.UserStatusEnabled, Quota: 0}
	require.NoError(t, DB.Create(user).Error)

	key = "10000000000000000000000000000001"
	redemption := &Redemption{
		Name:        "redeem-test",
		Key:         key,
		Status:      common.RedemptionCodeStatusEnabled,
		Quota:       quota,
		CreatedTime: common.GetTimestamp(),
	}
	require.NoError(t, DB.Create(redemption).Error)
	return user.Id, key
}

func TestRedeemCreditsQuotaExactlyOnce(t *testing.T) {
	userId, key := setupRedeemFixture(t, 500)

	quota, err := Redeem(key, userId)
	require.NoError(t, err)
	assert.Equal(t, 500, quota)

	var user User
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, 500, user.Quota)

	var redemption Redemption
	require.NoError(t, DB.First(&redemption, "name = ?", "redeem-test").Error)
	assert.Equal(t, common.RedemptionCodeStatusUsed, redemption.Status)
	assert.Equal(t, userId, redemption.UsedUserId)

	// Redeeming the same code again must fail and must not credit quota.
	_, err = Redeem(key, userId)
	require.Error(t, err)
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, 500, user.Quota)
}

func TestRedeemRejectsWalletOverflow(t *testing.T) {
	userId, key := setupRedeemFixture(t, 11)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", userId).Update("quota", common.MaxWalletQuota-10).Error)

	_, err := Redeem(key, userId)
	require.ErrorIs(t, err, ErrRedeemFailed)

	var user User
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, common.MaxWalletQuota-10, user.Quota)

	var redemption Redemption
	require.NoError(t, DB.First(&redemption, "key = ?", key).Error)
	assert.Equal(t, common.RedemptionCodeStatusEnabled, redemption.Status)
}

func TestRedemptionQuotaRejectsWalletOverflow(t *testing.T) {
	setupRedeemFixture(t, 500)

	redemption := &Redemption{
		Name:        "overflow-redemption",
		Key:         "10000000000000000000000000000002",
		Status:      common.RedemptionCodeStatusEnabled,
		Quota:       common.MaxWalletQuota + 1,
		CreatedTime: common.GetTimestamp(),
	}
	require.Error(t, redemption.Insert())
}

// Exactly one of several concurrent redeems of the same code may win, and
// quota must be credited exactly once.
func TestRedeemConcurrentSingleSuccess(t *testing.T) {
	userId, key := setupRedeemFixture(t, 300)

	const goroutines = 5
	successes := make([]bool, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := range goroutines {
		go func(idx int) {
			defer wg.Done()
			if _, err := Redeem(key, userId); err == nil {
				successes[idx] = true
			}
		}(i)
	}
	wg.Wait()

	successCount := 0
	for _, ok := range successes {
		if ok {
			successCount++
		}
	}
	assert.Equal(t, 1, successCount, "exactly one concurrent redeem should succeed")

	var user User
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, 300, user.Quota, "quota must be credited exactly once")
}

var redemptionTestDialects = []string{"sqlite", "mysql", "postgres"}

// openRedemptionTestDB opens one database of the dialect matrix: SQLite in a
// temporary file with the production connection settings, and MySQL or
// PostgreSQL when TEST_MYSQL_DSN or TEST_POSTGRES_DSN names a throwaway
// database.
func openRedemptionTestDB(t *testing.T, dialect string) (*gorm.DB, common.DatabaseType) {
	t.Helper()
	dsn := "local"
	switch dialect {
	case "sqlite":
		previousPath := common.SQLitePath
		common.SQLitePath = filepath.Join(t.TempDir(), "redemption.db") + "?" + common.SQLiteConcurrencyParams
		t.Cleanup(func() { common.SQLitePath = previousPath })
	case "mysql":
		dsn = os.Getenv("TEST_MYSQL_DSN")
	case "postgres":
		dsn = os.Getenv("TEST_POSTGRES_DSN")
	}
	if dsn == "" {
		t.Skip("test database DSN is not configured")
	}
	t.Setenv("REDEMPTION_TEST_DSN", dsn)
	db, dbType, err := chooseDB("REDEMPTION_TEST_DSN", false)
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { _ = sqlDB.Close() })
	return db, dbType
}

// useRedemptionTestDB points the package at an empty database of the dialect
// for the rest of the test, so Redeem runs its real transaction there.
func useRedemptionTestDB(t *testing.T, dialect string) {
	t.Helper()
	db, dbType := openRedemptionTestDB(t, dialect)
	previousDB, previousLogDB := DB, LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	DB, LOG_DB = db, db
	common.SetDatabaseTypes(dbType, dbType)
	initCol()
	t.Cleanup(func() {
		DB, LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		initCol()
	})
	for _, table := range []any{&User{}, &Log{}, &Redemption{}, &RedemptionRecord{}} {
		if !db.Migrator().HasTable(table) {
			require.NoError(t, db.AutoMigrate(table))
			t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(table)) })
			continue
		}
		require.NoError(t, db.AutoMigrate(table))
		emptyTable := func() {
			require.NoError(t, db.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(table).Error)
		}
		emptyTable()
		t.Cleanup(emptyTable)
	}
}

func testRedemptionKey(n int) string {
	return fmt.Sprintf("%032d", n)
}

func createRedeemUsers(t *testing.T, count int) []int {
	t.Helper()
	ids := make([]int, 0, count)
	for i := range count {
		user := &User{Username: fmt.Sprintf("redeemer-%d", i), Password: "password", Status: common.UserStatusEnabled, AffCode: fmt.Sprintf("redeem-aff-%d", i)}
		require.NoError(t, DB.Create(user).Error)
		ids = append(ids, user.Id)
	}
	return ids
}

func createBatchRedemptions(t *testing.T, batchId string, onePerUser bool, keys ...int) {
	t.Helper()
	for _, key := range keys {
		require.NoError(t, DB.Create(&Redemption{
			Name:            batchId,
			Key:             testRedemptionKey(key),
			Status:          common.RedemptionCodeStatusEnabled,
			Quota:           100,
			CreatedTime:     common.GetTimestamp(),
			BatchId:         batchId,
			MaxUses:         1,
			BatchOnePerUser: onePerUser,
		}).Error)
	}
}

func userQuotas(t *testing.T, userIds []int) []int {
	t.Helper()
	quotas := make([]int, 0, len(userIds))
	for _, id := range userIds {
		var user User
		require.NoError(t, DB.First(&user, "id = ?", id).Error)
		quotas = append(quotas, user.Quota)
	}
	return quotas
}

func redemptionRecordUsers(t *testing.T, redemptionId int) []int {
	t.Helper()
	var userIds []int
	require.NoError(t, DB.Model(&RedemptionRecord{}).Where("redemption_id = ?", redemptionId).Order("id").Pluck("user_id", &userIds).Error)
	return userIds
}

func TestRedeemRules(t *testing.T) {
	for _, dialect := range redemptionTestDialects {
		t.Run(dialect, func(t *testing.T) {
			t.Run("shared code credits each account once up to its limit", func(t *testing.T) {
				useRedemptionTestDB(t, dialect)
				users := createRedeemUsers(t, 3)
				require.NoError(t, DB.Create(&Redemption{
					Name: "shared", Key: testRedemptionKey(1), Status: common.RedemptionCodeStatusEnabled,
					Quota: 100, CreatedTime: common.GetTimestamp(), BatchId: "batch-shared", MaxUses: 2,
				}).Error)

				_, err := Redeem(testRedemptionKey(1), users[0])
				require.NoError(t, err)
				_, err = Redeem(testRedemptionKey(1), users[0])
				require.ErrorIs(t, err, ErrRedeemFailed, "an account redeems a shared code once")
				_, err = Redeem(testRedemptionKey(1), users[1])
				require.NoError(t, err)
				_, err = Redeem(testRedemptionKey(1), users[2])
				require.ErrorIs(t, err, ErrRedeemFailed, "the code stops at its limit")

				assert.Equal(t, []int{100, 100, 0}, userQuotas(t, users))
				var code Redemption
				require.NoError(t, DB.First(&code, "id > 0").Error)
				assert.Equal(t, 2, code.UsedCount)
				assert.Equal(t, common.RedemptionCodeStatusUsed, code.Status)
				assert.Equal(t, users[:2], redemptionRecordUsers(t, code.Id))
			})

			for _, tt := range []struct {
				name           string
				onePerUser     bool
				secondCodeWins bool
			}{
				{name: "one-per-user batch refuses a second code", onePerUser: true},
				{name: "unrestricted batch lets an account redeem several codes", secondCodeWins: true},
			} {
				t.Run(tt.name, func(t *testing.T) {
					useRedemptionTestDB(t, dialect)
					users := createRedeemUsers(t, 2)
					createBatchRedemptions(t, "batch-a", tt.onePerUser, 1, 2, 3)

					_, err := Redeem(testRedemptionKey(1), users[0])
					require.NoError(t, err)
					// The batch key on the record is what lets the unique index
					// refuse a concurrent second code of a one-per-user batch.
					var record RedemptionRecord
					require.NoError(t, DB.First(&record, "user_id = ?", users[0]).Error)
					if tt.onePerUser {
						require.NotNil(t, record.OnePerUserBatchId)
						assert.Equal(t, "batch-a", *record.OnePerUserBatchId)
					} else {
						assert.Nil(t, record.OnePerUserBatchId)
					}
					_, err = Redeem(testRedemptionKey(2), users[0])
					if tt.secondCodeWins {
						require.NoError(t, err)
						assert.Equal(t, []int{200, 0}, userQuotas(t, users))
						return
					}
					require.ErrorIs(t, err, ErrRedeemFailed)
					_, err = Redeem(testRedemptionKey(2), users[1])
					require.NoError(t, err, "another account still gets a code of the batch")
					assert.Equal(t, []int{100, 100}, userQuotas(t, users))
				})
			}

			t.Run("turning the batch rule on counts earlier redemptions", func(t *testing.T) {
				useRedemptionTestDB(t, dialect)
				users := createRedeemUsers(t, 1)
				createBatchRedemptions(t, "batch-b", false, 1, 2)

				_, err := Redeem(testRedemptionKey(1), users[0])
				require.NoError(t, err)
				require.NoError(t, DB.Model(&Redemption{}).Where("batch_id = ?", "batch-b").Update("batch_one_per_user", true).Error)
				_, err = Redeem(testRedemptionKey(2), users[0])
				require.ErrorIs(t, err, ErrRedeemFailed)
				assert.Equal(t, []int{100}, userQuotas(t, users))
			})

			t.Run("clearing used codes keeps the batch limit", func(t *testing.T) {
				useRedemptionTestDB(t, dialect)
				users := createRedeemUsers(t, 1)
				createBatchRedemptions(t, "batch-c", true, 1, 2)

				_, err := Redeem(testRedemptionKey(1), users[0])
				require.NoError(t, err)
				cleared, err := DeleteInvalidRedemptions()
				require.NoError(t, err)
				require.EqualValues(t, 1, cleared)
				_, err = Redeem(testRedemptionKey(2), users[0])
				require.ErrorIs(t, err, ErrRedeemFailed)
				assert.Equal(t, []int{100}, userQuotas(t, users))
			})

			t.Run("a record the unique index refuses rolls the whole redemption back", func(t *testing.T) {
				useRedemptionTestDB(t, dialect)
				users := createRedeemUsers(t, 1)
				createBatchRedemptions(t, "batch-d", true, 1)
				// The batch key collides, but the batch id hides the record from
				// the pre-check, so only the unique index can refuse this redeem.
				batch := "batch-d"
				require.NoError(t, DB.Create(&RedemptionRecord{RedemptionId: 999, UserId: users[0], BatchId: "elsewhere", OnePerUserBatchId: &batch}).Error)

				_, err := Redeem(testRedemptionKey(1), users[0])
				require.ErrorIs(t, err, ErrRedeemFailed)
				assert.Equal(t, []int{0}, userQuotas(t, users))
				var code Redemption
				require.NoError(t, DB.First(&code, "id > 0").Error)
				assert.Zero(t, code.UsedCount)
				assert.Equal(t, common.RedemptionCodeStatusEnabled, code.Status)
				assert.Empty(t, redemptionRecordUsers(t, code.Id))
			})

			t.Run("concurrent redeems of a shared code by one account credit once", func(t *testing.T) {
				useRedemptionTestDB(t, dialect)
				users := createRedeemUsers(t, 1)
				require.NoError(t, DB.Create(&Redemption{
					Name: "shared", Key: testRedemptionKey(1), Status: common.RedemptionCodeStatusEnabled,
					Quota: 100, CreatedTime: common.GetTimestamp(), BatchId: "batch-shared", MaxUses: 5,
				}).Error)

				const attempts = 4
				errs := make([]error, attempts)
				var wg sync.WaitGroup
				for i := range attempts {
					wg.Go(func() { _, errs[i] = Redeem(testRedemptionKey(1), users[0]) })
				}
				wg.Wait()

				successes := 0
				for _, err := range errs {
					if err == nil {
						successes++
					}
				}
				assert.Equal(t, 1, successes)
				assert.Equal(t, []int{100}, userQuotas(t, users))
				var code Redemption
				require.NoError(t, DB.First(&code, "id > 0").Error)
				assert.Equal(t, 1, code.UsedCount)
				assert.Equal(t, common.RedemptionCodeStatusEnabled, code.Status)
			})
		})
	}
}

func TestRedemptionListsNameTheRedeemer(t *testing.T) {
	for _, dialect := range redemptionTestDialects {
		t.Run(dialect, func(t *testing.T) {
			useRedemptionTestDB(t, dialect)
			users := createRedeemUsers(t, 2)
			// A deleted account still names the codes it redeemed.
			require.NoError(t, DB.Delete(&User{}, users[1]).Error)
			codes := []Redemption{
				{Name: "list", Key: testRedemptionKey(1), Status: common.RedemptionCodeStatusUsed, Quota: 100, UsedUserId: users[0], BatchId: "batch-list", MaxUses: 1, UsedCount: 1},
				{Name: "list", Key: testRedemptionKey(2), Status: common.RedemptionCodeStatusUsed, Quota: 100, UsedUserId: users[1], BatchId: "batch-list", MaxUses: 1, UsedCount: 1},
				{Name: "list", Key: testRedemptionKey(3), Status: common.RedemptionCodeStatusEnabled, Quota: 100, BatchId: "batch-list", MaxUses: 1},
			}
			require.NoError(t, DB.Create(&codes).Error)
			want := map[int]string{codes[0].Id: "redeemer-0", codes[1].Id: "redeemer-1", codes[2].Id: ""}

			listed, _, err := GetAllRedemptions(0, 10)
			require.NoError(t, err)
			require.Len(t, listed, 3)
			for _, code := range listed {
				assert.Equal(t, want[code.Id], code.UsedUsername, "code %d", code.Id)
			}
			found, _, err := SearchRedemptions("list", strconv.Itoa(common.RedemptionCodeStatusUsed), 0, 10)
			require.NoError(t, err)
			require.Len(t, found, 2)
			for _, code := range found {
				assert.Equal(t, want[code.Id], code.UsedUsername, "code %d", code.Id)
			}
		})
	}
}

func TestRedemptionRecordsRefuseRepeatRedemptions(t *testing.T) {
	for _, dialect := range redemptionTestDialects {
		t.Run(dialect, func(t *testing.T) {
			db, _ := openRedemptionTestDB(t, dialect)
			dropTables := func() { require.NoError(t, db.Migrator().DropTable(&RedemptionRecord{}, &Redemption{})) }
			dropTables()
			t.Cleanup(dropTables)
			require.NoError(t, db.AutoMigrate(&Redemption{}, &RedemptionRecord{}))

			batch := "batch-guard"
			require.NoError(t, db.Create(&RedemptionRecord{RedemptionId: 1, UserId: 1, BatchId: batch, OnePerUserBatchId: &batch}).Error)
			assert.Error(t, db.Create(&RedemptionRecord{RedemptionId: 1, UserId: 1, BatchId: batch}).Error, "an account redeems a code once")
			assert.Error(t, db.Create(&RedemptionRecord{RedemptionId: 2, UserId: 1, BatchId: batch, OnePerUserBatchId: &batch}).Error, "a one-per-user batch gives an account one code")
			assert.NoError(t, db.Create(&RedemptionRecord{RedemptionId: 2, UserId: 2, BatchId: batch, OnePerUserBatchId: &batch}).Error)
			assert.NoError(t, db.Create(&RedemptionRecord{RedemptionId: 3, UserId: 1, BatchId: batch}).Error, "unrestricted redemptions leave the batch key empty")
			assert.NoError(t, db.Create(&RedemptionRecord{RedemptionId: 4, UserId: 1, BatchId: batch}).Error)
		})
	}
}

// legacyRedemption is the redemptions table as releases before batches
// created it.
type legacyRedemption struct {
	Id           int
	UserId       int
	Key          string `gorm:"type:char(32);uniqueIndex"`
	Status       int    `gorm:"default:1"`
	Name         string `gorm:"index"`
	Quota        int    `gorm:"default:100"`
	CreatedTime  int64  `gorm:"bigint"`
	RedeemedTime int64  `gorm:"bigint"`
	UsedUserId   int
	DeletedAt    gorm.DeletedAt `gorm:"index"`
	ExpiredTime  int64          `gorm:"bigint"`
}

func (legacyRedemption) TableName() string { return "redemptions" }

func TestMigrateRedemptionBatchesUpgradesLegacyCodes(t *testing.T) {
	for _, dialect := range redemptionTestDialects {
		t.Run(dialect, func(t *testing.T) {
			db, _ := openRedemptionTestDB(t, dialect)
			dropTables := func() { require.NoError(t, db.Migrator().DropTable(&RedemptionRecord{}, &Redemption{})) }
			dropTables()
			t.Cleanup(dropTables)

			require.NoError(t, db.AutoMigrate(&legacyRedemption{}))
			const created = int64(1790000000)
			legacy := []legacyRedemption{
				{Id: 1, UserId: 1, Key: testRedemptionKey(1), Status: common.RedemptionCodeStatusEnabled, Name: "gift", Quota: 100, CreatedTime: created},
				{Id: 2, UserId: 1, Key: testRedemptionKey(2), Status: common.RedemptionCodeStatusUsed, Name: "gift", Quota: 100, CreatedTime: created, RedeemedTime: created + 5, UsedUserId: 7},
				{Id: 3, UserId: 1, Key: testRedemptionKey(3), Status: common.RedemptionCodeStatusEnabled, Name: "gift", Quota: 100, CreatedTime: created + 1},
				// More than a minute after the previous code: another request.
				{Id: 4, UserId: 1, Key: testRedemptionKey(4), Status: common.RedemptionCodeStatusEnabled, Name: "gift", Quota: 100, CreatedTime: created + 120},
				{Id: 5, UserId: 1, Key: testRedemptionKey(5), Status: common.RedemptionCodeStatusEnabled, Name: "sale", Quota: 100, CreatedTime: created + 121},
				// Cleared after use; it keeps its batch and its redemption.
				{Id: 6, UserId: 1, Key: testRedemptionKey(6), Status: common.RedemptionCodeStatusUsed, Name: "sale", Quota: 100, CreatedTime: created + 130, RedeemedTime: created + 150, UsedUserId: 8,
					DeletedAt: gorm.DeletedAt{Time: time.Unix(created+200, 0), Valid: true}},
				// Same name a second later, but another admin created it.
				{Id: 7, UserId: 2, Key: testRedemptionKey(7), Status: common.RedemptionCodeStatusEnabled, Name: "sale", Quota: 100, CreatedTime: created + 131},
			}
			require.NoError(t, db.Create(&legacy).Error)

			require.NoError(t, db.AutoMigrate(&Redemption{}, &RedemptionRecord{}))
			require.NoError(t, migrateRedemptionBatches(db))

			loadCodes := func() []Redemption {
				var codes []Redemption
				require.NoError(t, db.Unscoped().Order("id").Find(&codes).Error)
				return codes
			}
			loadRecords := func() []RedemptionRecord {
				var records []RedemptionRecord
				require.NoError(t, db.Order("redemption_id").Find(&records).Error)
				return records
			}
			codes := loadCodes()
			require.Len(t, codes, 7)
			batchOf := func(id int) string { return codes[id-1].BatchId }
			assert.NotEmpty(t, batchOf(1))
			assert.Equal(t, batchOf(1), batchOf(2))
			assert.Equal(t, batchOf(1), batchOf(3))
			assert.Equal(t, batchOf(5), batchOf(6))
			batches := map[string]bool{batchOf(1): true, batchOf(4): true, batchOf(5): true, batchOf(7): true}
			assert.Len(t, batches, 4, "gift, later gift, sale and the other admin's sale are separate batches")
			for _, code := range codes {
				assert.Equal(t, 1, code.MaxUses, "code %d", code.Id)
				assert.False(t, code.BatchOnePerUser, "code %d", code.Id)
			}
			assert.Equal(t, []int{0, 1, 0, 0, 0, 1, 0}, []int{codes[0].UsedCount, codes[1].UsedCount, codes[2].UsedCount, codes[3].UsedCount, codes[4].UsedCount, codes[5].UsedCount, codes[6].UsedCount})
			var unsetFlags int64
			require.NoError(t, db.Unscoped().Model(&Redemption{}).Where("batch_one_per_user IS NULL").Count(&unsetFlags).Error)
			assert.Zero(t, unsetFlags)

			records := loadRecords()
			require.Len(t, records, 2)
			for i, want := range []struct{ code, user int }{{2, 7}, {6, 8}} {
				assert.Equal(t, want.code, records[i].RedemptionId)
				assert.Equal(t, want.user, records[i].UserId)
				assert.Equal(t, batchOf(want.code), records[i].BatchId)
				assert.Equal(t, 100, records[i].Quota)
				assert.Equal(t, codes[want.code-1].RedeemedTime, records[i].CreatedTime)
				assert.Nil(t, records[i].OnePerUserBatchId)
			}

			recorder := &migrationSQLRecorder{}
			require.NoError(t, db.Session(&gorm.Session{Logger: recorder}).AutoMigrate(&Redemption{}, &RedemptionRecord{}))
			assert.Empty(t, recorder.schemaMutations(), "a second start changes no schema")
			require.NoError(t, migrateRedemptionBatches(db))
			assert.Equal(t, codes, loadCodes(), "a second backfill changes no code")
			assert.Equal(t, records, loadRecords(), "a second backfill adds no record")
		})
	}
}

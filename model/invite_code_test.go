package model

import (
	"errors"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupInviteCodeTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB := DB
	previousType := common.MainDatabaseType()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&InviteCode{}, &InviteCodeUsage{}))
	DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		DB = previousDB
		common.SetMainDatabaseType(previousType)
	})
	return db
}

func TestInviteCodeGenerationStoresOnlyHashAndSupportsNormalizedInput(t *testing.T) {
	db := setupInviteCodeTestDB(t)

	generated, err := CreateInviteCodes(7, "early access", 1, 2, 0)
	require.NoError(t, err)
	require.Len(t, generated, 1)
	rawCode := generated[0].Code
	assert.True(t, strings.HasPrefix(rawCode, "NAPI-"))
	assert.NotEqual(t, rawCode, generated[0].InviteCode.CodeHash)
	assert.Equal(t, rawCode[:9], generated[0].InviteCode.CodePrefix)

	var stored InviteCode
	require.NoError(t, db.First(&stored, generated[0].InviteCode.Id).Error)
	assert.Len(t, stored.CodeHash, 64)
	assert.NotContains(t, stored.CodeHash, rawCode)

	compactLowercase := strings.ToLower(strings.ReplaceAll(rawCode, "-", ""))
	normalizedHash, err := HashInviteCode(compactLowercase)
	require.NoError(t, err)
	assert.Equal(t, stored.CodeHash, normalizedHash)

	encoded, err := common.Marshal(stored)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "code_hash")
	assert.NotContains(t, string(encoded), stored.CodeHash)
}

func TestInviteCodeUsageHonorsLimitAndRecordsEachRegistration(t *testing.T) {
	db := setupInviteCodeTestDB(t)
	generated, err := CreateInviteCodes(1, "two seats", 1, 2, 0)
	require.NoError(t, err)
	codeHash, err := HashInviteCode(generated[0].Code)
	require.NoError(t, err)

	require.NoError(t, db.Transaction(func(tx *gorm.DB) error {
		return ConsumeInviteCodeHashWithTx(tx, codeHash, 101, "password")
	}))
	require.NoError(t, db.Transaction(func(tx *gorm.DB) error {
		return ConsumeInviteCodeHashWithTx(tx, codeHash, 102, "oauth:github")
	}))
	err = db.Transaction(func(tx *gorm.DB) error {
		return ConsumeInviteCodeHashWithTx(tx, codeHash, 103, "password")
	})
	assert.ErrorIs(t, err, ErrInviteCodeUnavailable)

	var inviteCode InviteCode
	require.NoError(t, db.First(&inviteCode, generated[0].InviteCode.Id).Error)
	assert.Equal(t, 2, inviteCode.UsedCount)
	var usages []InviteCodeUsage
	require.NoError(t, db.Order("user_id").Find(&usages).Error)
	require.Len(t, usages, 2)
	assert.Equal(t, 101, usages[0].UserId)
	assert.Equal(t, "password", usages[0].RegistrationMethod)
	assert.Equal(t, 102, usages[1].UserId)
}

func TestInviteCodeConsumptionRollsBackWithRegistrationTransaction(t *testing.T) {
	db := setupInviteCodeTestDB(t)
	generated, err := CreateInviteCodes(1, "rollback", 1, 1, 0)
	require.NoError(t, err)
	codeHash, err := HashInviteCode(generated[0].Code)
	require.NoError(t, err)

	err = db.Transaction(func(tx *gorm.DB) error {
		require.NoError(t, ConsumeInviteCodeHashWithTx(tx, codeHash, 201, "password"))
		return errors.New("registration failed")
	})
	require.EqualError(t, err, "registration failed")

	var inviteCode InviteCode
	require.NoError(t, db.First(&inviteCode, generated[0].InviteCode.Id).Error)
	assert.Zero(t, inviteCode.UsedCount)
	var usageCount int64
	require.NoError(t, db.Model(&InviteCodeUsage{}).Count(&usageCount).Error)
	assert.Zero(t, usageCount)
}

func TestInviteCodeUsageLimitCannotBeReducedBelowUsedCount(t *testing.T) {
	db := setupInviteCodeTestDB(t)
	generated, err := CreateInviteCodes(1, "editable", 1, 3, 0)
	require.NoError(t, err)
	codeHash, err := HashInviteCode(generated[0].Code)
	require.NoError(t, err)
	for _, userId := range []int{401, 402} {
		require.NoError(t, db.Transaction(func(tx *gorm.DB) error {
			return ConsumeInviteCodeHashWithTx(tx, codeHash, userId, "password")
		}))
	}

	_, err = UpdateInviteCode(generated[0].InviteCode.Id, "too small", common.InviteCodeStatusEnabled, 1, 0)
	assert.ErrorIs(t, err, ErrInviteCodeInvalid)
	var unchanged InviteCode
	require.NoError(t, db.First(&unchanged, generated[0].InviteCode.Id).Error)
	assert.Equal(t, 3, unchanged.MaxUses)
	assert.Equal(t, "editable", unchanged.Name)

	updated, err := UpdateInviteCode(generated[0].InviteCode.Id, "closed", common.InviteCodeStatusDisabled, 2, 0)
	require.NoError(t, err)
	assert.Equal(t, 2, updated.MaxUses)
	assert.Equal(t, common.InviteCodeStatusDisabled, updated.Status)
}

func TestInviteCodeRejectsExpiredDisabledAndMissingCodes(t *testing.T) {
	db := setupInviteCodeTestDB(t)
	expired, err := CreateInviteCodes(1, "expired", 1, 1, common.GetTimestamp()-1)
	require.NoError(t, err)
	disabled, err := CreateInviteCodes(1, "disabled", 1, 1, 0)
	require.NoError(t, err)
	require.NoError(t, db.Model(&InviteCode{}).Where("id = ?", disabled[0].InviteCode.Id).Update("status", common.InviteCodeStatusDisabled).Error)

	expiredHash, err := HashInviteCode(expired[0].Code)
	require.NoError(t, err)
	disabledHash, err := HashInviteCode(disabled[0].Code)
	require.NoError(t, err)
	for _, codeHash := range []string{expiredHash, disabledHash, strings.Repeat("0", 64)} {
		err = db.Transaction(func(tx *gorm.DB) error {
			return ConsumeInviteCodeHashWithTx(tx, codeHash, 301, "password")
		})
		assert.ErrorIs(t, err, ErrInviteCodeUnavailable)
	}
	assert.ErrorIs(t, ConsumeInviteCodeHashWithTx(db, "", 301, "password"), ErrInviteCodeRequired)
}

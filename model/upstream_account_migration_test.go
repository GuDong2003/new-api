package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestMigrateUpstreamAccountChannelIndexesSQLiteDropsLegacyUniqueIndex(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:upstream-index-migration?mode=memory&cache=shared"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&UpstreamAccountChannel{}))
	require.NoError(t, db.Exec("CREATE UNIQUE INDEX legacy_channel_id_unique ON upstream_account_channels(channel_id)").Error)
	require.NoError(t, db.Create(&UpstreamAccountChannel{AccountId: 7, ChannelId: 11, CreatedAt: 1}).Error)

	oldDB := DB
	oldMain := common.MainDatabaseType()
	oldLog := common.LogDatabaseType()
	DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.SetLogDatabaseType(common.DatabaseTypeSQLite)
	initCol()
	t.Cleanup(func() {
		DB = oldDB
		common.SetMainDatabaseType(oldMain)
		common.SetLogDatabaseType(oldLog)
		_ = sqlDB.Close()
	})

	require.NoError(t, migrateUpstreamAccountChannelIndexes())
	require.NoError(t, migrateUpstreamAccountChannelIndexes())

	var indexes []struct {
		Name string `gorm:"column:name"`
	}
	require.NoError(t, db.Raw("PRAGMA index_list(`upstream_account_channels`)").Scan(&indexes).Error)
	names := make([]string, 0, len(indexes))
	for _, index := range indexes {
		names = append(names, index.Name)
	}
	assert.NotContains(t, names, "legacy_channel_id_unique")
	assert.Contains(t, names, "idx_upstream_account_channel")
	var count int64
	require.NoError(t, db.Model(&UpstreamAccountChannel{}).Where("account_id = ? AND channel_id = ?", 7, 11).Count(&count).Error)
	assert.Equal(t, int64(1), count)
}

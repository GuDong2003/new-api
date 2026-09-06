package model

import (
	"fmt"
	"strings"
)

// migrateUpstreamAccountChannelIndexes removes the legacy single-channel
// unique index before AutoMigrate creates the composite account/channel index.
// The data rows themselves are intentionally untouched: a fresh installation
// and an installation with existing bindings both end up with the same
// many-to-many schema.
func migrateUpstreamAccountChannelIndexes() error {
	if DB == nil || !DB.Migrator().HasTable(&UpstreamAccountChannel{}) {
		return nil
	}
	if DB.Dialector.Name() == "sqlite" {
		return migrateSQLiteUpstreamAccountChannelIndexes()
	}

	indexes, err := DB.Migrator().GetIndexes(&UpstreamAccountChannel{})
	if err != nil {
		return err
	}
	for _, index := range indexes {
		unique, ok := index.Unique()
		if !ok || !unique {
			continue
		}
		columns := index.Columns()
		if len(columns) != 1 || columns[0] != "channel_id" {
			continue
		}
		if err := DB.Migrator().DropIndex(&UpstreamAccountChannel{}, index.Name()); err != nil {
			return err
		}
	}
	return nil
}

type sqliteUpstreamAccountChannelIndex struct {
	Name   string `gorm:"column:name"`
	Unique int    `gorm:"column:unique"`
}

type sqliteUpstreamAccountChannelIndexColumn struct {
	Name string `gorm:"column:name"`
}

func migrateSQLiteUpstreamAccountChannelIndexes() error {
	var indexes []sqliteUpstreamAccountChannelIndex
	if err := DB.Raw("PRAGMA index_list(`upstream_account_channels`)").Scan(&indexes).Error; err != nil {
		return fmt.Errorf("inspect upstream account channel indexes: %w", err)
	}

	for _, index := range indexes {
		if index.Unique != 1 {
			continue
		}
		escapedName := strings.ReplaceAll(index.Name, "'", "''")
		var columns []sqliteUpstreamAccountChannelIndexColumn
		if err := DB.Raw("PRAGMA index_info('" + escapedName + "')").Scan(&columns).Error; err != nil {
			return fmt.Errorf("inspect upstream account channel index %q: %w", index.Name, err)
		}
		if len(columns) != 1 || columns[0].Name != "channel_id" {
			continue
		}
		if err := DB.Migrator().DropIndex(&UpstreamAccountChannel{}, index.Name); err != nil {
			return fmt.Errorf("drop legacy upstream account channel index %q: %w", index.Name, err)
		}
	}
	return nil
}

package model

// migrateUpstreamAccountChannelIndexes removes the legacy single-channel
// unique index before AutoMigrate creates the composite account/channel index.
// The data rows themselves are intentionally untouched: a fresh installation
// and an installation with existing bindings both end up with the same
// many-to-many schema.
func migrateUpstreamAccountChannelIndexes() error {
	if DB == nil || !DB.Migrator().HasTable(&UpstreamAccountChannel{}) {
		return nil
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

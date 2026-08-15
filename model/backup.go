package model

// BackupSettings stores the singleton configuration and the last known state
// for the PostgreSQL full-backup integration. Secrets are stored as ciphertext
// and are intentionally not included in any JSON response.
type BackupSettings struct {
	ID int `json:"id" gorm:"primaryKey"`

	Enabled         bool   `json:"enabled"`
	IntervalHours   int    `json:"interval_hours"`
	GistID          string `json:"gist_id" gorm:"type:varchar(128)"`
	GistDescription string `json:"gist_description" gorm:"type:varchar(255)"`

	GitHubTokenCiphertext string `json:"-" gorm:"type:text"`
	AgeIdentityCiphertext string `json:"-" gorm:"type:text"`
	AgeRecipient          string `json:"age_recipient" gorm:"type:varchar(255)"`

	LastBackupHash     string `json:"last_backup_hash" gorm:"type:varchar(64)"`
	LastBackupRevision string `json:"last_backup_revision" gorm:"type:varchar(128)"`
	LastBackupAt       int64  `json:"last_backup_at" gorm:"index"`
	LastBackupSize     int64  `json:"last_backup_size"`
	LastBackupStatus   string `json:"last_backup_status" gorm:"type:varchar(32)"`
	LastBackupError    string `json:"last_backup_error" gorm:"type:text"`
	LastCheckedAt      int64  `json:"last_checked_at"`
}

const BackupSettingsID = 1

func GetBackupSettings() (*BackupSettings, error) {
	settings := &BackupSettings{ID: BackupSettingsID}
	if err := DB.FirstOrCreate(settings, BackupSettings{ID: BackupSettingsID}).Error; err != nil {
		return nil, err
	}
	dirty := false
	if settings.IntervalHours <= 0 {
		settings.IntervalHours = 24
		dirty = true
	}
	if settings.GistDescription == "" {
		settings.GistDescription = "New-API Auto Backup"
		dirty = true
	}
	if dirty {
		if err := DB.Save(settings).Error; err != nil {
			return nil, err
		}
	}
	return settings, nil
}

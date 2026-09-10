package model

import (
	"context"
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrGalleryDisabled    = errors.New("Gallery storage is disabled.")
	ErrGalleryCapacity    = errors.New("Gallery storage limit reached.")
	ErrGalleryUnavailable = errors.New("Gallery storage is unavailable.")
	ErrGalleryInvalid     = errors.New("The gallery image is invalid.")
	ErrGallerySettings    = errors.New("Gallery settings are invalid.")
	ErrGallerySave        = errors.New("The gallery image could not be saved.")
)

type GallerySettings struct {
	ID            int   `json:"-" gorm:"primaryKey;autoIncrement:false"`
	Enabled       bool  `json:"enabled"`
	RetentionDays int   `json:"retention_days"`
	UserMaxImages int   `json:"user_max_images"`
	UserMaxBytes  int64 `json:"user_max_bytes"`
	TotalMaxBytes int64 `json:"total_max_bytes"`
}

func (s GallerySettings) Valid() bool {
	return s.RetentionDays >= 1 && s.RetentionDays <= 3650 && s.UserMaxImages >= 1 && s.UserMaxImages <= 100000 && s.UserMaxBytes >= 1<<20 && s.UserMaxBytes <= 1<<40 && s.TotalMaxBytes >= 1<<20 && s.TotalMaxBytes <= 1<<40
}

type GalleryImage struct {
	ID             string         `json:"id" gorm:"type:varchar(36);primaryKey"`
	UserID         int            `json:"-" gorm:"uniqueIndex:idx_gallery_owner_source,priority:1;index"`
	SourceID       string         `json:"source_id" gorm:"type:varchar(191);uniqueIndex:idx_gallery_owner_source,priority:2"`
	Source         string         `json:"source" gorm:"type:varchar(16)"`
	Model          string         `json:"model" gorm:"type:varchar(255)"`
	Prompt         string         `json:"prompt" gorm:"type:text"`
	NegativePrompt string         `json:"negative_prompt" gorm:"type:text"`
	Parameters     map[string]any `json:"parameters" gorm:"-"`
	ParametersJSON string         `json:"-" gorm:"type:text"`
	Width          int            `json:"width"`
	Height         int            `json:"height"`
	MIMEType       string         `json:"mime_type" gorm:"type:varchar(32)"`
	Bytes          int64          `json:"bytes"`
	CreatedAt      int64          `json:"created_at" gorm:"autoCreateTime:false"`
	ExpiresAt      int64          `json:"expires_at" gorm:"index"`
	HasThumbnail   bool           `json:"has_thumbnail"`
	StorageBytes   int64          `json:"-"`
	State          string         `json:"-" gorm:"type:varchar(16);index"`
}

func (i *GalleryImage) AfterFind(_ *gorm.DB) error {
	i.Parameters = map[string]any{}
	if i.ParametersJSON != "" {
		return common.UnmarshalJsonStr(i.ParametersJSON, &i.Parameters)
	}
	return nil
}

// Gallery metadata lives exclusively in the primary database. This migration
// is also exported for fresh/released-schema database matrix verification.
func MigrateGallery(db *gorm.DB) error {
	if err := db.AutoMigrate(&GallerySettings{}, &GalleryImage{}); err != nil {
		return err
	}
	defaults := GallerySettings{ID: 1, Enabled: true, RetentionDays: 7, UserMaxImages: 100, UserMaxBytes: 209715200, TotalMaxBytes: 536870912}
	return db.Clauses(clause.OnConflict{DoNothing: true}).Create(&defaults).Error
}

func ReadGallerySettings(ctx context.Context) (*GallerySettings, error) {
	var settings GallerySettings
	err := DB.WithContext(ctx).First(&settings, 1).Error
	return &settings, err
}

func WriteGallerySettings(ctx context.Context, settings GallerySettings) error {
	settings.ID = 1
	return DB.WithContext(ctx).Save(&settings).Error
}

func OwnedGalleryImage(ctx context.Context, user int, id string, now int64) (*GalleryImage, error) {
	var image GalleryImage
	err := DB.WithContext(ctx).Where("id = ? AND user_id = ? AND state = ? AND expires_at > ?", id, user, "ready", now).First(&image).Error
	return &image, err
}

func GalleryTotals(ctx context.Context, user int) (count, userBytes, totalBytes int64, err error) {
	var totals struct {
		Count int64
		Bytes int64
	}
	err = DB.WithContext(ctx).Model(&GalleryImage{}).Where("user_id = ?", user).Select("COUNT(*) AS count, COALESCE(SUM(storage_bytes), 0) AS bytes").Scan(&totals).Error
	if err != nil {
		return
	}
	count, userBytes = totals.Count, totals.Bytes
	err = DB.WithContext(ctx).Model(&GalleryImage{}).Select("COALESCE(SUM(storage_bytes), 0)").Scan(&totalBytes).Error
	return
}

package model

import (
	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// GalleryCanvas publishes one complete private document revision. Physical
// images remain GalleryImages; StorageBytes accounts for this record's metadata.
type GalleryCanvas struct {
	ID                  string         `json:"id" gorm:"type:varchar(36);primaryKey"`
	UserID              int            `json:"-" gorm:"index"`
	Kind                string         `json:"kind" gorm:"type:varchar(16)"`
	Name                string         `json:"name" gorm:"type:varchar(255)"`
	DocumentVersion     int            `json:"-"`
	Revision            int64          `json:"revision"`
	State               string         `json:"state" gorm:"type:varchar(16);index"`
	UpdatedAt           int64          `json:"updated_at" gorm:"autoUpdateTime:false"`
	ExpiresAt           int64          `json:"expires_at" gorm:"index"`
	MutationID          string         `json:"-" gorm:"type:varchar(36)"`
	Document            map[string]any `json:"document" gorm:"-"`
	DocumentJSON        string         `json:"-" gorm:"size:-1"`
	ContentHash         string         `json:"-" gorm:"type:varchar(64)"`
	StorageBytes        int64          `json:"-"`
	RemovedAssetIDs     []string       `json:"removed_asset_ids" gorm:"-"`
	RemovedAssetIDsJSON string         `json:"-" gorm:"size:-1"`
}

func (c *GalleryCanvas) AfterFind(_ *gorm.DB) error {
	c.Document = nil
	c.RemovedAssetIDs = []string{}
	if c.RemovedAssetIDsJSON != "" {
		if err := common.UnmarshalJsonStr(c.RemovedAssetIDsJSON, &c.RemovedAssetIDs); err != nil {
			return err
		}
		if c.RemovedAssetIDs == nil {
			c.RemovedAssetIDs = []string{}
		}
	}
	if c.State == "ready" && c.DocumentJSON != "" {
		return common.UnmarshalJsonStr(c.DocumentJSON, &c.Document)
	}
	return nil
}

// GalleryRemoval records only reconciliation identifiers, never document/image
// content. An empty AssetID denotes removal of the whole canvas.
type GalleryRemoval struct {
	ID        int64  `json:"-" gorm:"primaryKey"`
	UserID    int    `json:"-" gorm:"uniqueIndex:idx_gallery_removal_owner_asset,priority:1"`
	CanvasID  string `json:"canvas_id" gorm:"type:varchar(36);uniqueIndex:idx_gallery_removal_owner_asset,priority:2"`
	AssetID   string `json:"asset_id" gorm:"type:varchar(36);uniqueIndex:idx_gallery_removal_owner_asset,priority:3"`
	Revision  int64  `json:"revision"`
	Reason    string `json:"reason" gorm:"type:varchar(16)"`
	CreatedAt int64  `json:"created_at" gorm:"autoCreateTime:false"`
}

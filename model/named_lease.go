package model

import (
	"errors"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// NamedLease provides a small cross-node lease for periodic work that is
// scoped more narrowly than a system-task type. Queue warming uses one lease
// per channel so multiple master-capable nodes cannot warm the same channel at
// the same time.
type NamedLease struct {
	Name      string `json:"name" gorm:"type:varchar(128);primaryKey"`
	Holder    string `json:"holder" gorm:"type:varchar(128);index"`
	ExpiresAt int64  `json:"expires_at" gorm:"bigint;index"`
	UpdatedAt int64  `json:"updated_at" gorm:"bigint"`
}

func GetNamedLease(name string) (*NamedLease, error) {
	var lease NamedLease
	if err := DB.Where("name = ?", name).First(&lease).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &lease, nil
}

// AcquireNamedLease creates a lease or takes over one that expired before now.
// Expiration exactly at now is still treated as active, which keeps the
// scheduler cadence consistent across nodes.
func AcquireNamedLease(name, holder string, now, expires int64) (bool, error) {
	lease := &NamedLease{Name: name, Holder: holder, ExpiresAt: expires, UpdatedAt: now}
	result := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(lease)
	if result.Error != nil {
		return false, result.Error
	}
	if result.RowsAffected == 1 {
		return true, nil
	}
	result = DB.Model(&NamedLease{}).
		Where("name = ? AND expires_at < ?", name, now).
		Updates(map[string]any{
			"holder":     holder,
			"expires_at": expires,
			"updated_at": now,
		})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

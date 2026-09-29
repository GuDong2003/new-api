package model

import (
	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// legacyRedemptionBatchWindow bounds, in seconds, how far apart two codes
// created by one request can be. The request inserts its codes one by one.
const legacyRedemptionBatchWindow = 60

// migrateRedemptionBatches upgrades codes created before batches, use counts
// and redemption records existed. Each step skips rows it already handled, so
// it runs at every start and also covers codes an older release redeemed.
func migrateRedemptionBatches(db *gorm.DB) error {
	// Group codes without a batch the way one creation request made them:
	// in id order, the same creator, name, quota and expiry, created at most
	// a minute after the previous code.
	var legacy []Redemption
	err := db.Unscoped().
		Select("id", "user_id", "name", "quota", "expired_time", "created_time").
		Where("batch_id IS NULL OR batch_id = ?", "").
		Order("id").
		Find(&legacy).Error
	if err != nil {
		return err
	}
	// One transaction for all groups, so a large table is not one commit per
	// batch on SQLite.
	err = db.Transaction(func(tx *gorm.DB) error {
		for start := 0; start < len(legacy); {
			end := start + 1
			for end < len(legacy) {
				previous, code := legacy[end-1], legacy[end]
				gap := code.CreatedTime - previous.CreatedTime
				if code.UserId != previous.UserId || code.Name != previous.Name || code.Quota != previous.Quota ||
					code.ExpiredTime != previous.ExpiredTime || gap < 0 || gap > legacyRedemptionBatchWindow {
					break
				}
				end++
			}
			err := tx.Unscoped().Model(&Redemption{}).
				Where("id BETWEEN ? AND ? AND (batch_id IS NULL OR batch_id = ?)", legacy[start].Id, legacy[end-1].Id, "").
				Update("batch_id", common.GetUUID()).Error
			if err != nil {
				return err
			}
			start = end
		}
		return nil
	})
	if err != nil {
		return err
	}

	fills := []struct {
		where  string
		args   []any
		column string
		value  any
	}{
		{where: "max_uses IS NULL OR max_uses < ?", args: []any{1}, column: "max_uses", value: 1},
		{where: "batch_one_per_user IS NULL", column: "batch_one_per_user", value: false},
		{where: "used_count IS NULL", column: "used_count", value: 0},
		// A used code was redeemed once before counts existed.
		{where: "status = ? AND used_count = ?", args: []any{common.RedemptionCodeStatusUsed, 0}, column: "used_count", value: 1},
	}
	for _, fill := range fills {
		err = db.Unscoped().Model(&Redemption{}).Where(fill.where, fill.args...).Update(fill.column, fill.value).Error
		if err != nil {
			return err
		}
	}

	// Record who redeemed each code before records existed, so batch rules
	// count those accounts too.
	var redeemed []Redemption
	err = db.Unscoped().
		Where("used_user_id > ?", 0).
		Where("NOT EXISTS (SELECT 1 FROM redemption_records WHERE redemption_records.redemption_id = redemptions.id)").
		Order("id").
		Find(&redeemed).Error
	if err != nil || len(redeemed) == 0 {
		return err
	}
	records := make([]RedemptionRecord, 0, len(redeemed))
	for _, code := range redeemed {
		records = append(records, RedemptionRecord{
			RedemptionId: code.Id,
			UserId:       code.UsedUserId,
			BatchId:      code.BatchId,
			Quota:        code.Quota,
			CreatedTime:  code.RedeemedTime,
		})
	}
	// Another instance starting at the same time may record the same codes.
	return db.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(records, 100).Error
}

package model

// RedemptionRecord is one account redeeming one code.
type RedemptionRecord struct {
	Id           int    `json:"id"`
	RedemptionId int    `json:"redemption_id" gorm:"uniqueIndex:idx_redemption_record_code_user,priority:1"`
	UserId       int    `json:"user_id" gorm:"uniqueIndex:idx_redemption_record_code_user,priority:2;uniqueIndex:idx_redemption_record_batch_user,priority:2"`
	BatchId      string `json:"batch_id" gorm:"type:varchar(32);index"`
	// OnePerUserBatchId repeats BatchId when the batch gives each account one
	// code, so the unique index refuses a second code of that batch. It stays
	// NULL otherwise, and NULLs never collide in a unique index.
	OnePerUserBatchId *string `json:"-" gorm:"type:varchar(32);uniqueIndex:idx_redemption_record_batch_user,priority:1"`
	Quota             int     `json:"quota"`
	CreatedTime       int64   `json:"created_time" gorm:"bigint"`
}

// RedemptionRecordDetail is a redemption record with the account's names.
type RedemptionRecordDetail struct {
	RedemptionRecord
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

// GetRedemptionRecords pages the accounts that redeemed a code, newest first.
func GetRedemptionRecords(redemptionId int, startIdx int, num int) ([]RedemptionRecordDetail, int64, error) {
	query := DB.Model(&RedemptionRecord{}).Where("redemption_id = ?", redemptionId)
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var records []RedemptionRecordDetail
	err := query.
		Select("redemption_records.*, users.username, users.display_name").
		Joins("LEFT JOIN users ON users.id = redemption_records.user_id").
		Order("redemption_records.id desc").
		Limit(num).
		Offset(startIdx).
		Scan(&records).Error
	return records, total, err
}

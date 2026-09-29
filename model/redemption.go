package model

import (
	"errors"
	"fmt"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"

	"gorm.io/gorm"
)

type Redemption struct {
	Id           int            `json:"id"`
	UserId       int            `json:"user_id"`
	Key          string         `json:"key" gorm:"type:char(32);uniqueIndex"`
	Status       int            `json:"status" gorm:"default:1"`
	Name         string         `json:"name" gorm:"index"`
	Quota        int            `json:"quota" gorm:"default:100"`
	CreatedTime  int64          `json:"created_time" gorm:"bigint"`
	RedeemedTime int64          `json:"redeemed_time" gorm:"bigint"`
	Count        int            `json:"count" gorm:"-:all"` // only for api request
	UsedUserId   int            `json:"used_user_id"`
	DeletedAt    gorm.DeletedAt `gorm:"index"`
	ExpiredTime  int64          `json:"expired_time" gorm:"bigint"` // 过期时间，0 表示不过期
	// Codes created by one request form a batch. With BatchOnePerUser an
	// account may redeem only one code of the batch.
	BatchId         string `json:"batch_id" gorm:"type:varchar(32);index"`
	BatchOnePerUser bool   `json:"batch_one_per_user"`
	// MaxUses is how many accounts may redeem the code, each of them once.
	MaxUses   int   `json:"max_uses" gorm:"default:1"`
	UsedCount int   `json:"used_count" gorm:"default:0"`
	BatchSize int64 `json:"batch_size,omitempty" gorm:"-:all"` // only in GET /api/redemption/:id
	// UsedUsername names the latest account to redeem the code, in lists.
	UsedUsername string `json:"used_username,omitempty" gorm:"-:all"`
}

func GetAllRedemptions(startIdx int, num int) (redemptions []*Redemption, total int64, err error) {
	// 开始事务
	tx := DB.Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	// 获取总数
	err = tx.Model(&Redemption{}).Count(&total).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// 获取分页数据
	err = tx.Order("id desc").Limit(num).Offset(startIdx).Find(&redemptions).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// 提交事务
	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}

	if err = nameRedemptionRedeemers(redemptions); err != nil {
		return nil, 0, err
	}
	return redemptions, total, nil
}

func SearchRedemptions(keyword string, status string, startIdx int, num int) (redemptions []*Redemption, total int64, err error) {
	tx := DB.Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	query := tx.Model(&Redemption{})

	if keyword != "" {
		if id, err := strconv.Atoi(keyword); err == nil {
			query = query.Where("id = ? OR name LIKE ?", id, keyword+"%")
		} else {
			query = query.Where("name LIKE ?", keyword+"%")
		}
	}

	if status != "" {
		now := common.GetTimestamp()
		switch status {
		case "expired":
			query = query.Where(
				"status = ? AND expired_time != 0 AND expired_time < ?",
				common.RedemptionCodeStatusEnabled,
				now,
			)
		case strconv.Itoa(common.RedemptionCodeStatusEnabled):
			query = query.Where(
				"status = ? AND (expired_time = 0 OR expired_time >= ?)",
				common.RedemptionCodeStatusEnabled,
				now,
			)
		case strconv.Itoa(common.RedemptionCodeStatusDisabled):
			query = query.Where("status = ?", common.RedemptionCodeStatusDisabled)
		case strconv.Itoa(common.RedemptionCodeStatusUsed):
			query = query.Where("status = ?", common.RedemptionCodeStatusUsed)
		}
	}

	// Get total count
	err = query.Count(&total).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// Get paginated data
	err = query.Order("id desc").Limit(num).Offset(startIdx).Find(&redemptions).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}

	if err = nameRedemptionRedeemers(redemptions); err != nil {
		return nil, 0, err
	}
	return redemptions, total, nil
}

// nameRedemptionRedeemers fills in the username of the latest account to
// redeem each listed code, deleted accounts included.
func nameRedemptionRedeemers(redemptions []*Redemption) error {
	userIds := make([]int, 0, len(redemptions))
	for _, redemption := range redemptions {
		if redemption.UsedUserId > 0 {
			userIds = append(userIds, redemption.UsedUserId)
		}
	}
	if len(userIds) == 0 {
		return nil
	}
	var users []User
	if err := DB.Unscoped().Select("id", "username").Where("id IN ?", userIds).Find(&users).Error; err != nil {
		return err
	}
	usernames := make(map[int]string, len(users))
	for _, user := range users {
		usernames[user.Id] = user.Username
	}
	for _, redemption := range redemptions {
		redemption.UsedUsername = usernames[redemption.UsedUserId]
	}
	return nil
}

func GetRedemptionById(id int) (*Redemption, error) {
	if id == 0 {
		return nil, errors.New("id 为空！")
	}
	redemption := Redemption{Id: id}
	var err error = nil
	err = DB.First(&redemption, "id = ?", id).Error
	return &redemption, err
}

func Redeem(key string, userId int) (quota int, err error) {
	if key == "" {
		return 0, errors.New("未提供兑换码")
	}
	if userId == 0 {
		return 0, errors.New("无效的 user id")
	}
	redemption := &Redemption{}

	keyCol := "`key`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		keyCol = `"key"`
	}
	common.RandomSleep()
	err = DB.Transaction(func(tx *gorm.DB) error {
		err := lockForUpdate(tx).Where(keyCol+" = ?", key).First(redemption).Error
		if err != nil {
			return errors.New("无效的兑换码")
		}
		if redemption.Status != common.RedemptionCodeStatusEnabled {
			return errors.New("该兑换码已被使用")
		}
		if redemption.ExpiredTime != 0 && redemption.ExpiredTime < common.GetTimestamp() {
			return errors.New("该兑换码已过期")
		}
		maxUses := max(redemption.MaxUses, 1)
		if redemption.UsedCount >= maxUses {
			return errors.New("该兑换码已用完")
		}
		var redeemed int64
		err = tx.Model(&RedemptionRecord{}).Where("redemption_id = ? AND user_id = ?", redemption.Id, userId).Count(&redeemed).Error
		if err != nil {
			return err
		}
		if redeemed > 0 {
			return errors.New("该用户已兑换过这个兑换码")
		}
		record := &RedemptionRecord{
			RedemptionId: redemption.Id,
			UserId:       userId,
			BatchId:      redemption.BatchId,
			Quota:        redemption.Quota,
		}
		if redemption.BatchOnePerUser && redemption.BatchId != "" {
			// Redemptions made before the batch rule was turned on count too.
			err = tx.Model(&RedemptionRecord{}).Where("batch_id = ? AND user_id = ?", redemption.BatchId, userId).Count(&redeemed).Error
			if err != nil {
				return err
			}
			if redeemed > 0 {
				return errors.New("该用户已兑换过同一批次的兑换码")
			}
			record.OnePerUserBatchId = &redemption.BatchId
		}
		now := common.GetTimestamp()
		usedCount := redemption.UsedCount + 1
		status := common.RedemptionCodeStatusEnabled
		if usedCount >= maxUses {
			status = common.RedemptionCodeStatusUsed
		}
		// Compare-and-swap on the count read above: only one of several
		// concurrent redeems of the code moves it on, even without a row
		// lock (e.g. on SQLite).
		result := tx.Model(&Redemption{}).
			Where("id = ? AND status = ? AND used_count = ?", redemption.Id, common.RedemptionCodeStatusEnabled, redemption.UsedCount).
			Updates(map[string]any{
				"redeemed_time": now,
				"status":        status,
				"used_count":    usedCount,
				"used_user_id":  userId,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return errors.New("该兑换码已被使用")
		}
		// When two redeems pass the checks above together, the unique indexes
		// on the records refuse the second one.
		record.CreatedTime = now
		if err := tx.Create(record).Error; err != nil {
			return err
		}
		return creditTopUpQuota(tx, userId, redemption.Quota, nil)
	})
	if err != nil {
		common.SysError("redemption failed: " + err.Error())
		return 0, ErrRedeemFailed
	}
	syncCreditUserQuotaCache(userId, redemption.Quota, "redemption")
	RecordLog(userId, LogTypeTopup, fmt.Sprintf("通过兑换码充值 %s，兑换码ID %d", logger.LogQuota(redemption.Quota), redemption.Id))
	return redemption.Quota, nil
}

// RedemptionMaxUsesLimit caps how many accounts one shared code can serve.
const RedemptionMaxUsesLimit = 100000

// ErrRedemptionMaxUsesInvalid means an edit would let a shared code serve
// fewer than 2 accounts, fewer than already redeemed it, or more than
// RedemptionMaxUsesLimit.
var ErrRedemptionMaxUsesInvalid = errors.New("redemption max uses out of range")

// RedemptionEdit is an admin's edit of a code. A nil MaxUses or
// BatchOnePerUser leaves that setting as it is, so an editor that does not
// know a setting keeps it.
type RedemptionEdit struct {
	Name            string
	Quota           int
	ExpiredTime     int64
	MaxUses         *int
	BatchOnePerUser *bool
}

// UpdateRedemptionDetails saves an edit under the code's row lock, so the
// status it derives from the use count cannot race a redeem. MaxUses changes
// only shared codes, and a one-time code ignores it, so an edit that echoes
// max_uses 1 back still works. BatchOnePerUser changes only batches of
// one-time codes, and every code of the batch.
func UpdateRedemptionDetails(id int, edit RedemptionEdit) (*Redemption, error) {
	if edit.Quota <= 0 {
		return nil, errors.New("redemption quota must be positive")
	}
	if err := common.ValidateWalletQuota(edit.Quota); err != nil {
		return nil, err
	}
	redemption := &Redemption{}
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).First(redemption, "id = ?", id).Error; err != nil {
			return err
		}
		shared := redemption.MaxUses > 1
		updates := map[string]any{
			"name":         edit.Name,
			"quota":        edit.Quota,
			"expired_time": edit.ExpiredTime,
		}
		if edit.MaxUses != nil && shared {
			if *edit.MaxUses < max(2, redemption.UsedCount) || *edit.MaxUses > RedemptionMaxUsesLimit {
				return ErrRedemptionMaxUsesInvalid
			}
			updates["max_uses"] = *edit.MaxUses
			if redemption.Status != common.RedemptionCodeStatusDisabled {
				updates["status"] = common.RedemptionCodeStatusEnabled
				if redemption.UsedCount >= *edit.MaxUses {
					updates["status"] = common.RedemptionCodeStatusUsed
				}
			}
		}
		if err := tx.Model(redemption).Updates(updates).Error; err != nil {
			return err
		}
		if edit.BatchOnePerUser != nil && !shared && redemption.BatchId != "" {
			err := tx.Unscoped().Model(&Redemption{}).
				Where("batch_id = ?", redemption.BatchId).
				Update("batch_one_per_user", *edit.BatchOnePerUser).Error
			if err != nil {
				return err
			}
		}
		return tx.First(redemption, "id = ?", id).Error
	})
	return redemption, err
}

// CountRedemptionBatch counts the codes of a batch that are not deleted.
func CountRedemptionBatch(batchId string) (int64, error) {
	var count int64
	err := DB.Model(&Redemption{}).Where("batch_id = ?", batchId).Count(&count).Error
	return count, err
}

func (redemption *Redemption) Insert() error {
	if redemption.Quota <= 0 {
		return errors.New("redemption quota must be positive")
	}
	if err := common.ValidateWalletQuota(redemption.Quota); err != nil {
		return err
	}
	var err error
	err = DB.Create(redemption).Error
	return err
}

func (redemption *Redemption) SelectUpdate() error {
	// This can update zero values
	return DB.Model(redemption).Select("redeemed_time", "status").Updates(redemption).Error
}

// Update Make sure your token's fields is completed, because this will update non-zero values
func (redemption *Redemption) Update() error {
	if redemption.Quota <= 0 {
		return errors.New("redemption quota must be positive")
	}
	if err := common.ValidateWalletQuota(redemption.Quota); err != nil {
		return err
	}
	var err error
	err = DB.Model(redemption).Select("name", "status", "quota", "redeemed_time", "expired_time").Updates(redemption).Error
	return err
}

func (redemption *Redemption) Delete() error {
	var err error
	err = DB.Delete(redemption).Error
	return err
}

func DeleteRedemptionById(id int) (err error) {
	if id == 0 {
		return errors.New("id 为空！")
	}
	redemption := Redemption{Id: id}
	err = DB.Where(redemption).First(&redemption).Error
	if err != nil {
		return err
	}
	return redemption.Delete()
}

func DeleteInvalidRedemptions() (int64, error) {
	now := common.GetTimestamp()
	result := DB.Where("status IN ? OR (status = ? AND expired_time != 0 AND expired_time < ?)", []int{common.RedemptionCodeStatusUsed, common.RedemptionCodeStatusDisabled}, common.RedemptionCodeStatusEnabled, now).Delete(&Redemption{})
	return result.RowsAffected, result.Error
}

// BatchDeleteRedemptions soft-deletes the selected codes in one statement.
func BatchDeleteRedemptions(ids []int) (int64, error) {
	if len(ids) == 0 || len(ids) > 1000 {
		return 0, errors.New("select between 1 and 1000 redemption codes")
	}
	for _, id := range ids {
		if id <= 0 {
			return 0, errors.New("redemption IDs must be positive")
		}
	}
	result := DB.Where("id IN ?", ids).Delete(&Redemption{})
	return result.RowsAffected, result.Error
}

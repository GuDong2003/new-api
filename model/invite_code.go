package model

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

const (
	inviteCodeAlphabet  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	inviteCodePartCount = 4
	inviteCodePartSize  = 4
)

var (
	ErrInviteCodeRequired    = errors.New("invitation code is required")
	ErrInviteCodeInvalid     = errors.New("invitation code is invalid")
	ErrInviteCodeUnavailable = errors.New("invitation code is unavailable")
)

type InviteCode struct {
	Id          int    `json:"id"`
	CodeHash    string `json:"-" gorm:"type:char(64);uniqueIndex"`
	CodePrefix  string `json:"code_prefix" gorm:"type:varchar(16);index"`
	Name        string `json:"name" gorm:"type:varchar(191);index"`
	Status      int    `json:"status" gorm:"index"`
	MaxUses     int    `json:"max_uses"`
	UsedCount   int    `json:"used_count"`
	CreatedBy   int    `json:"created_by" gorm:"index"`
	CreatedTime int64  `json:"created_time" gorm:"bigint"`
	UpdatedTime int64  `json:"updated_time" gorm:"bigint"`
	ExpiredTime int64  `json:"expired_time" gorm:"bigint;index"`
}

type InviteCodeUsage struct {
	Id                 int    `json:"id"`
	InviteCodeId       int    `json:"invite_code_id" gorm:"index"`
	UserId             int    `json:"user_id" gorm:"uniqueIndex"`
	UsedTime           int64  `json:"used_time" gorm:"bigint"`
	RegistrationMethod string `json:"registration_method" gorm:"type:varchar(32)"`
}

type GeneratedInviteCode struct {
	Code       string      `json:"code"`
	InviteCode *InviteCode `json:"invite_code"`
}

func generateInviteCode() (string, error) {
	parts := make([]string, inviteCodePartCount)
	alphabetSize := big.NewInt(int64(len(inviteCodeAlphabet)))
	for partIndex := range parts {
		part := make([]byte, inviteCodePartSize)
		for charIndex := range part {
			index, err := rand.Int(rand.Reader, alphabetSize)
			if err != nil {
				return "", err
			}
			part[charIndex] = inviteCodeAlphabet[index.Int64()]
		}
		parts[partIndex] = string(part)
	}
	return "NAPI-" + strings.Join(parts, "-"), nil
}

func normalizeInviteCode(rawCode string) (string, error) {
	compact := strings.NewReplacer("-", "", " ", "").Replace(strings.ToUpper(strings.TrimSpace(rawCode)))
	if len(compact) != 4+inviteCodePartCount*inviteCodePartSize || !strings.HasPrefix(compact, "NAPI") {
		return "", ErrInviteCodeInvalid
	}
	codeBody := compact[4:]
	for _, char := range codeBody {
		if !strings.ContainsRune(inviteCodeAlphabet, char) {
			return "", ErrInviteCodeInvalid
		}
	}
	parts := []string{"NAPI"}
	for start := 0; start < len(codeBody); start += inviteCodePartSize {
		parts = append(parts, codeBody[start:start+inviteCodePartSize])
	}
	return strings.Join(parts, "-"), nil
}

func HashInviteCode(rawCode string) (string, error) {
	if strings.TrimSpace(rawCode) == "" {
		return "", ErrInviteCodeRequired
	}
	canonicalCode, err := normalizeInviteCode(rawCode)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(canonicalCode))
	return hex.EncodeToString(hash[:]), nil
}

func CreateInviteCodes(createdBy int, name string, count int, maxUses int, expiredTime int64) ([]GeneratedInviteCode, error) {
	if createdBy <= 0 || count <= 0 || maxUses <= 0 {
		return nil, ErrInviteCodeInvalid
	}
	generated := make([]GeneratedInviteCode, 0, count)
	err := DB.Transaction(func(tx *gorm.DB) error {
		for range count {
			rawCode, err := generateInviteCode()
			if err != nil {
				return err
			}
			codeHash, err := HashInviteCode(rawCode)
			if err != nil {
				return err
			}
			now := common.GetTimestamp()
			inviteCode := &InviteCode{
				CodeHash:    codeHash,
				CodePrefix:  rawCode[:9],
				Name:        strings.TrimSpace(name),
				Status:      common.InviteCodeStatusEnabled,
				MaxUses:     maxUses,
				CreatedBy:   createdBy,
				CreatedTime: now,
				UpdatedTime: now,
				ExpiredTime: expiredTime,
			}
			if err := tx.Create(inviteCode).Error; err != nil {
				return err
			}
			generated = append(generated, GeneratedInviteCode{Code: rawCode, InviteCode: inviteCode})
		}
		return nil
	})
	return generated, err
}

func GetInviteCodes(keyword string, startIdx int, num int) ([]*InviteCode, int64, error) {
	query := DB.Model(&InviteCode{})
	keyword = strings.TrimSpace(keyword)
	if keyword != "" {
		if id, err := strconv.Atoi(keyword); err == nil {
			query = query.Where("id = ? OR name LIKE ? OR code_prefix LIKE ?", id, "%"+keyword+"%", strings.ToUpper(keyword)+"%")
		} else {
			query = query.Where("name LIKE ? OR code_prefix LIKE ?", "%"+keyword+"%", strings.ToUpper(keyword)+"%")
		}
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var inviteCodes []*InviteCode
	if err := query.Order("id desc").Limit(num).Offset(startIdx).Find(&inviteCodes).Error; err != nil {
		return nil, 0, err
	}
	return inviteCodes, total, nil
}

func UpdateInviteCode(id int, name string, status int, maxUses int, expiredTime int64) (*InviteCode, error) {
	if id <= 0 || maxUses <= 0 || (status != common.InviteCodeStatusEnabled && status != common.InviteCodeStatusDisabled) {
		return nil, ErrInviteCodeInvalid
	}
	inviteCode := &InviteCode{}
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).First(inviteCode, id).Error; err != nil {
			return err
		}
		if maxUses < inviteCode.UsedCount {
			return fmt.Errorf("%w: max uses cannot be less than used count", ErrInviteCodeInvalid)
		}
		updates := map[string]interface{}{
			"name":         strings.TrimSpace(name),
			"status":       status,
			"max_uses":     maxUses,
			"expired_time": expiredTime,
			"updated_time": common.GetTimestamp(),
		}
		if err := tx.Model(inviteCode).Updates(updates).Error; err != nil {
			return err
		}
		return tx.First(inviteCode, id).Error
	})
	return inviteCode, err
}

func ConsumeInviteCodeHashWithTx(tx *gorm.DB, codeHash string, userId int, registrationMethod string) error {
	if strings.TrimSpace(codeHash) == "" {
		return ErrInviteCodeRequired
	}
	if userId <= 0 {
		return ErrInviteCodeInvalid
	}
	inviteCode := &InviteCode{}
	if err := lockForUpdate(tx).Where("code_hash = ?", codeHash).First(inviteCode).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrInviteCodeUnavailable
		}
		return err
	}
	now := common.GetTimestamp()
	if inviteCode.Status != common.InviteCodeStatusEnabled ||
		inviteCode.UsedCount >= inviteCode.MaxUses ||
		(inviteCode.ExpiredTime != 0 && inviteCode.ExpiredTime <= now) {
		return ErrInviteCodeUnavailable
	}
	result := tx.Model(&InviteCode{}).
		Where("id = ? AND status = ? AND used_count = ? AND used_count < max_uses", inviteCode.Id, common.InviteCodeStatusEnabled, inviteCode.UsedCount).
		Updates(map[string]interface{}{
			"used_count":   gorm.Expr("used_count + ?", 1),
			"updated_time": now,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrInviteCodeUnavailable
	}
	usage := &InviteCodeUsage{
		InviteCodeId:       inviteCode.Id,
		UserId:             userId,
		UsedTime:           now,
		RegistrationMethod: strings.TrimSpace(registrationMethod),
	}
	methodRunes := []rune(usage.RegistrationMethod)
	if len(methodRunes) > 32 {
		usage.RegistrationMethod = string(methodRunes[:32])
	}
	return tx.Create(usage).Error
}

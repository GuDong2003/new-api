package model

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

const (
	inviteCodeAlphabet  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	inviteCodePartCount = 4
	inviteCodePartSize  = 4
	inviteCodeCipherV1  = "v1."
)

var inviteCodeCipherAAD = []byte("new-api-invite-code-v1")

var (
	ErrInviteCodeRequired    = errors.New("invitation code is required")
	ErrInviteCodeInvalid     = errors.New("invitation code is invalid")
	ErrInviteCodeUnavailable = errors.New("invitation code is unavailable")
)

type InviteCode struct {
	Id             int    `json:"id"`
	CodeHash       string `json:"-" gorm:"type:char(64);uniqueIndex"`
	CodeCiphertext string `json:"-" gorm:"type:text"`
	CodePrefix     string `json:"code_prefix" gorm:"type:varchar(16);index"`
	Code           string `json:"code" gorm:"-:all"`
	CodeAvailable  bool   `json:"code_available" gorm:"-:all"`
	Name           string `json:"name" gorm:"type:varchar(191);index"`
	Status         int    `json:"status" gorm:"index"`
	MaxUses        int    `json:"max_uses"`
	UsedCount      int    `json:"used_count"`
	CreatedBy      int    `json:"created_by" gorm:"index"`
	CreatedTime    int64  `json:"created_time" gorm:"bigint"`
	UpdatedTime    int64  `json:"updated_time" gorm:"bigint"`
	ExpiredTime    int64  `json:"expired_time" gorm:"bigint;index"`
}

type InviteCodeUsage struct {
	Id                 int    `json:"id"`
	InviteCodeId       int    `json:"invite_code_id" gorm:"index"`
	UserId             int    `json:"user_id" gorm:"uniqueIndex"`
	UsedTime           int64  `json:"used_time" gorm:"bigint"`
	RegistrationMethod string `json:"registration_method" gorm:"type:varchar(32)"`
}

type InviteCodeUsageDetail struct {
	InviteCodeUsage
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
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

func inviteCodeCipherKey() [32]byte {
	secret := strings.TrimSpace(os.Getenv("INVITE_CODE_ENCRYPTION_KEY"))
	if secret == "" {
		secret = common.CryptoSecret
	}
	return sha256.Sum256([]byte("invite-code-encryption-v1:" + secret))
}

func encryptInviteCode(rawCode string) (string, error) {
	key := inviteCodeCipherKey()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(rawCode), inviteCodeCipherAAD)
	return inviteCodeCipherV1 + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decryptInviteCode(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}
	if !strings.HasPrefix(ciphertext, inviteCodeCipherV1) {
		return "", ErrInviteCodeInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(ciphertext, inviteCodeCipherV1))
	if err != nil {
		return "", err
	}
	key := inviteCodeCipherKey()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", ErrInviteCodeInvalid
	}
	nonce, encryptedCode := payload[:gcm.NonceSize()], payload[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, encryptedCode, inviteCodeCipherAAD)
	if err != nil {
		return "", err
	}
	return normalizeInviteCode(string(plaintext))
}

func hydrateInviteCode(inviteCode *InviteCode) error {
	code, err := decryptInviteCode(inviteCode.CodeCiphertext)
	if err != nil {
		return err
	}
	inviteCode.Code = code
	inviteCode.CodeAvailable = code != ""
	return nil
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
			codeCiphertext, err := encryptInviteCode(rawCode)
			if err != nil {
				return err
			}
			now := common.GetTimestamp()
			inviteCode := &InviteCode{
				CodeHash:       codeHash,
				CodeCiphertext: codeCiphertext,
				CodePrefix:     rawCode[:9],
				Code:           rawCode,
				CodeAvailable:  true,
				Name:           strings.TrimSpace(name),
				Status:         common.InviteCodeStatusEnabled,
				MaxUses:        maxUses,
				CreatedBy:      createdBy,
				CreatedTime:    now,
				UpdatedTime:    now,
				ExpiredTime:    expiredTime,
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
		codeHash, codeHashErr := HashInviteCode(keyword)
		if id, err := strconv.Atoi(keyword); err == nil {
			query = query.Where("id = ? OR name LIKE ? OR code_prefix LIKE ?", id, "%"+keyword+"%", strings.ToUpper(keyword)+"%")
		} else if codeHashErr == nil {
			query = query.Where("code_hash = ? OR name LIKE ? OR code_prefix LIKE ?", codeHash, "%"+keyword+"%", strings.ToUpper(keyword)+"%")
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
	for _, inviteCode := range inviteCodes {
		if err := hydrateInviteCode(inviteCode); err != nil {
			return nil, 0, fmt.Errorf("decrypt invitation code %d: %w", inviteCode.Id, err)
		}
	}
	return inviteCodes, total, nil
}

func GetInviteCodeUsages(inviteCodeId int, startIdx int, num int) ([]InviteCodeUsageDetail, int64, error) {
	if inviteCodeId <= 0 {
		return nil, 0, ErrInviteCodeInvalid
	}
	query := DB.Model(&InviteCodeUsage{}).Where("invite_code_id = ?", inviteCodeId)
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var usages []InviteCodeUsageDetail
	err := query.
		Select("invite_code_usages.*, users.username, users.display_name").
		Joins("LEFT JOIN users ON users.id = invite_code_usages.user_id").
		Order("invite_code_usages.id desc").
		Limit(num).
		Offset(startIdx).
		Scan(&usages).Error
	return usages, total, err
}

func ValidateInviteCodeHash(codeHash string) error {
	if strings.TrimSpace(codeHash) == "" {
		return ErrInviteCodeRequired
	}
	inviteCode := &InviteCode{}
	if err := DB.Where("code_hash = ?", codeHash).First(inviteCode).Error; err != nil {
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
	return nil
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
		if err := tx.First(inviteCode, id).Error; err != nil {
			return err
		}
		return hydrateInviteCode(inviteCode)
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

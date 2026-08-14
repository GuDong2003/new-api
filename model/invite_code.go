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
	"gorm.io/gorm/clause"
)

const (
	inviteCodeLegacyAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	inviteCodeLegacyPrefix   = "NAPI"
	inviteCodeLegacyParts    = 4
	inviteCodeLegacyPartSize = 4
	inviteCodeRandomAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	inviteCodeRandomLength   = 16
	inviteCodeCustomMin      = 8
	inviteCodeCustomMax      = 64
	inviteCodeCipherV1       = "v1."
)

var inviteCodeCipherAAD = []byte("new-api-invite-code-v1")

var (
	ErrInviteCodeRequired    = errors.New("invitation code is required")
	ErrInviteCodeInvalid     = errors.New("invitation code is invalid")
	ErrInviteCodeUnavailable = errors.New("invitation code is unavailable")
	ErrInviteCodeUsed        = errors.New("invitation code has usage records")
	ErrInviteCodeExists      = errors.New("invitation code already exists")
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

type InviteCodeQueryOptions struct {
	Keyword    string
	Status     string
	Usage      string
	Expiration string
	Sort       string
	Now        int64
}

func generateRandomInviteCode() (string, error) {
	alphabetSize := big.NewInt(int64(len(inviteCodeRandomAlphabet)))
	code := make([]byte, inviteCodeRandomLength)
	for index := range code {
		charIndex, err := rand.Int(rand.Reader, alphabetSize)
		if err != nil {
			return "", err
		}
		code[index] = inviteCodeRandomAlphabet[charIndex.Int64()]
	}
	return string(code), nil
}

func normalizeInviteCode(rawCode string) (string, error) {
	trimmed := strings.TrimSpace(rawCode)
	legacyCompact := strings.NewReplacer("-", "", " ", "").Replace(strings.ToUpper(trimmed))
	legacyLength := len(inviteCodeLegacyPrefix) + inviteCodeLegacyParts*inviteCodeLegacyPartSize
	if len(legacyCompact) == legacyLength && strings.HasPrefix(legacyCompact, inviteCodeLegacyPrefix) {
		codeBody := legacyCompact[len(inviteCodeLegacyPrefix):]
		for _, char := range codeBody {
			if !strings.ContainsRune(inviteCodeLegacyAlphabet, char) {
				return "", ErrInviteCodeInvalid
			}
		}
		parts := []string{inviteCodeLegacyPrefix}
		for start := 0; start < len(codeBody); start += inviteCodeLegacyPartSize {
			parts = append(parts, codeBody[start:start+inviteCodeLegacyPartSize])
		}
		return strings.Join(parts, "-"), nil
	}

	customCode := strings.ToLower(trimmed)
	if len(customCode) < inviteCodeCustomMin || len(customCode) > inviteCodeCustomMax {
		return "", ErrInviteCodeInvalid
	}
	for index := 0; index < len(customCode); index++ {
		char := customCode[index]
		isAlphaNumeric := (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')
		isSeparator := char == '-' || char == '_'
		if !isAlphaNumeric && !isSeparator {
			return "", ErrInviteCodeInvalid
		}
		if isSeparator && (index == 0 || index == len(customCode)-1) {
			return "", ErrInviteCodeInvalid
		}
	}
	return customCode, nil
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
	return CreateInviteCodesWithCustomCode(createdBy, name, count, maxUses, expiredTime, "")
}

func inviteCodePrefix(code string) string {
	if strings.HasPrefix(code, inviteCodeLegacyPrefix+"-") && len(code) >= 9 {
		return code[:9]
	}
	if len(code) > 16 {
		return code[:16]
	}
	return code
}

func CreateInviteCodesWithCustomCode(createdBy int, name string, count int, maxUses int, expiredTime int64, customCode string) ([]GeneratedInviteCode, error) {
	if createdBy <= 0 || count <= 0 || maxUses <= 0 {
		return nil, ErrInviteCodeInvalid
	}
	customCode = strings.TrimSpace(customCode)
	if customCode != "" {
		if count != 1 {
			return nil, ErrInviteCodeInvalid
		}
		var err error
		customCode, err = normalizeInviteCode(customCode)
		if err != nil {
			return nil, err
		}
	}
	generated := make([]GeneratedInviteCode, 0, count)
	err := DB.Transaction(func(tx *gorm.DB) error {
		for generatedCount := 0; generatedCount < count; {
			rawCode := customCode
			if rawCode == "" {
				var err error
				rawCode, err = generateRandomInviteCode()
				if err != nil {
					return err
				}
			}
			codeHash, err := HashInviteCode(rawCode)
			if err != nil {
				return err
			}
			var existing InviteCode
			lookupErr := tx.Select("id").Where("code_hash = ?", codeHash).First(&existing).Error
			if lookupErr == nil {
				if customCode != "" {
					return ErrInviteCodeExists
				}
				continue
			}
			if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
				return lookupErr
			}
			codeCiphertext, err := encryptInviteCode(rawCode)
			if err != nil {
				return err
			}
			now := common.GetTimestamp()
			inviteCode := &InviteCode{
				CodeHash:       codeHash,
				CodeCiphertext: codeCiphertext,
				CodePrefix:     inviteCodePrefix(rawCode),
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
			generatedCount++
		}
		return nil
	})
	return generated, err
}

func GetInviteCodes(keyword string, startIdx int, num int) ([]*InviteCode, int64, error) {
	return GetInviteCodesWithOptions(InviteCodeQueryOptions{Keyword: keyword}, startIdx, num)
}

func GetInviteCodesWithOptions(options InviteCodeQueryOptions, startIdx int, num int) ([]*InviteCode, int64, error) {
	query := DB.Model(&InviteCode{})
	keyword := strings.TrimSpace(options.Keyword)
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

	now := options.Now
	if now <= 0 {
		now = common.GetTimestamp()
	}
	switch strings.ToLower(strings.TrimSpace(options.Status)) {
	case "", "all":
	case "enabled":
		query = query.Where("status = ? AND (expired_time = 0 OR expired_time > ?) AND used_count < max_uses", common.InviteCodeStatusEnabled, now)
	case "disabled":
		query = query.Where("status <> ?", common.InviteCodeStatusEnabled)
	case "expired":
		query = query.Where("status = ? AND expired_time <> 0 AND expired_time <= ?", common.InviteCodeStatusEnabled, now)
	case "exhausted":
		query = query.Where("status = ? AND (expired_time = 0 OR expired_time > ?) AND used_count >= max_uses", common.InviteCodeStatusEnabled, now)
	default:
		return nil, 0, ErrInviteCodeInvalid
	}

	switch strings.ToLower(strings.TrimSpace(options.Usage)) {
	case "", "all":
	case "unused":
		query = query.Where("used_count = 0")
	case "used":
		query = query.Where("used_count > 0")
	default:
		return nil, 0, ErrInviteCodeInvalid
	}

	switch strings.ToLower(strings.TrimSpace(options.Expiration)) {
	case "", "all":
	case "never":
		query = query.Where("expired_time = 0")
	case "scheduled":
		query = query.Where("expired_time <> 0")
	default:
		return nil, 0, ErrInviteCodeInvalid
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	switch strings.ToLower(strings.TrimSpace(options.Sort)) {
	case "", "newest":
		query = query.Order("created_time DESC").Order("id DESC")
	case "oldest":
		query = query.Order("created_time ASC").Order("id ASC")
	case "remaining":
		query = query.Order("max_uses - used_count DESC").Order("id DESC")
	case "expiring":
		query = query.
			Order(clause.Expr{
				SQL:                "CASE WHEN expired_time > ? THEN 0 WHEN expired_time = 0 THEN 2 ELSE 1 END ASC",
				Vars:               []interface{}{now},
				WithoutParentheses: true,
			}).
			Order(clause.Expr{
				SQL:                "CASE WHEN expired_time > ? THEN expired_time ELSE 0 END ASC",
				Vars:               []interface{}{now},
				WithoutParentheses: true,
			}).
			Order("id DESC")
	default:
		return nil, 0, ErrInviteCodeInvalid
	}

	var inviteCodes []*InviteCode
	if err := query.Limit(num).Offset(startIdx).Find(&inviteCodes).Error; err != nil {
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

func DeleteUnusedInviteCode(id int) error {
	if id <= 0 {
		return ErrInviteCodeInvalid
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		inviteCode := &InviteCode{}
		if err := lockForUpdate(tx).First(inviteCode, id).Error; err != nil {
			return err
		}
		if inviteCode.UsedCount > 0 {
			return ErrInviteCodeUsed
		}
		var usageCount int64
		if err := tx.Model(&InviteCodeUsage{}).Where("invite_code_id = ?", id).Count(&usageCount).Error; err != nil {
			return err
		}
		if usageCount > 0 {
			return ErrInviteCodeUsed
		}
		return tx.Delete(inviteCode).Error
	})
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

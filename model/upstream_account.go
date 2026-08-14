package model

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

const (
	UpstreamSiteTypeNewAPI = "new_api"

	UpstreamAuthTypeToken  = "token"
	UpstreamAuthTypeCookie = "cookie"

	UpstreamStatusUnknown        = "unknown"
	UpstreamStatusHealthy        = "healthy"
	UpstreamStatusFailed         = "failed"
	UpstreamStatusManualRequired = "manual_required"

	UpstreamLogTypeCheckin = "checkin"
	UpstreamLogTypeBalance = "balance"
	UpstreamLogTypeHealth  = "health"

	UpstreamTriggerManual    = "manual"
	UpstreamTriggerScheduled = "scheduled"

	ChannelBalanceSourceChannel  = "channel"
	ChannelBalanceSourceUpstream = "upstream"
	ChannelBalanceSourceNone     = "none"

	upstreamCredentialCipherV1 = "v1."
)

var upstreamCredentialAAD = []byte("new-api-upstream-account-credential-v1")

// UpstreamAccount stores a dashboard account for a compatible New API site.
// CredentialCiphertext is never serialized; Credential is write-only at the
// API boundary and exists here only to simplify validated create/update flows.
type UpstreamAccount struct {
	Id                   int     `json:"id"`
	Name                 string  `json:"name" gorm:"type:varchar(191);index"`
	BaseURL              string  `json:"base_url" gorm:"type:varchar(512)"`
	SiteType             string  `json:"site_type" gorm:"type:varchar(32);default:'new_api'"`
	AuthType             string  `json:"auth_type" gorm:"type:varchar(32);default:'token'"`
	UserId               int     `json:"user_id"`
	CredentialCiphertext string  `json:"-" gorm:"type:text"`
	Credential           string  `json:"credential,omitempty" gorm:"-:all"`
	CredentialConfigured bool    `json:"credential_configured" gorm:"-:all"`
	AutoCheckin          bool    `json:"auto_checkin" gorm:"default:false"`
	AutoBalance          bool    `json:"auto_balance" gorm:"default:true"`
	BalanceInterval      int     `json:"balance_interval" gorm:"default:60"`
	Balance              float64 `json:"balance"`
	BalanceUnit          string  `json:"balance_unit" gorm:"type:varchar(16)"`
	RawQuota             float64 `json:"raw_quota"`
	QuotaPerUnit         float64 `json:"quota_per_unit"`
	BalanceUpdatedTime   int64   `json:"balance_updated_time" gorm:"bigint;index"`
	BalanceStatus        string  `json:"balance_status" gorm:"type:varchar(32);default:'unknown'"`
	LastCheckinTime      int64   `json:"last_checkin_time" gorm:"bigint"`
	LastCheckinStatus    string  `json:"last_checkin_status" gorm:"type:varchar(32);default:'unknown'"`
	LastCheckinMessage   string  `json:"last_checkin_message" gorm:"type:text"`
	LastHealthTime       int64   `json:"last_health_time" gorm:"bigint"`
	HealthStatus         string  `json:"health_status" gorm:"type:varchar(32);default:'unknown'"`
	LastError            string  `json:"last_error" gorm:"type:text"`
	NextCheckinTime      int64   `json:"next_checkin_time" gorm:"bigint;index"`
	NextBalanceTime      int64   `json:"next_balance_time" gorm:"bigint;index"`
	CreatedTime          int64   `json:"created_time" gorm:"bigint"`
	UpdatedTime          int64   `json:"updated_time" gorm:"bigint"`
	ChannelIds           []int   `json:"channel_ids" gorm:"-:all"`
}

type UpstreamAccountChannel struct {
	Id        int   `json:"id"`
	AccountId int   `json:"account_id" gorm:"uniqueIndex:idx_upstream_account_channel;index"`
	ChannelId int   `json:"channel_id" gorm:"uniqueIndex:idx_upstream_account_channel;uniqueIndex"`
	CreatedAt int64 `json:"created_at" gorm:"bigint"`
}

type UpstreamAccountLog struct {
	Id         int     `json:"id"`
	AccountId  int     `json:"account_id" gorm:"index"`
	Type       string  `json:"type" gorm:"type:varchar(32);index"`
	Trigger    string  `json:"trigger" gorm:"type:varchar(32);index"`
	Status     string  `json:"status" gorm:"type:varchar(32);index"`
	Message    string  `json:"message" gorm:"type:text"`
	Reward     float64 `json:"reward"`
	Balance    float64 `json:"balance"`
	Unit       string  `json:"unit" gorm:"type:varchar(16)"`
	HttpStatus int     `json:"http_status"`
	DurationMs int64   `json:"duration_ms"`
	CreatedAt  int64   `json:"created_at" gorm:"bigint;index"`
}

func upstreamCredentialCipherKey() [32]byte {
	return sha256.Sum256([]byte("upstream-account-credential-v1:" + common.CryptoSecret))
}

func encryptUpstreamCredential(plaintext string) (string, error) {
	key := upstreamCredentialCipherKey()
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
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), upstreamCredentialAAD)
	return upstreamCredentialCipherV1 + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decryptUpstreamCredential(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", errors.New("upstream account credential is not configured")
	}
	if !strings.HasPrefix(ciphertext, upstreamCredentialCipherV1) {
		return "", errors.New("invalid upstream account credential")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(ciphertext, upstreamCredentialCipherV1))
	if err != nil {
		return "", err
	}
	key := upstreamCredentialCipherKey()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", errors.New("invalid upstream account credential")
	}
	plaintext, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], upstreamCredentialAAD)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func (account *UpstreamAccount) SetCredential(credential string) error {
	credential = strings.TrimSpace(credential)
	if credential == "" {
		return errors.New("upstream account credential is required")
	}
	ciphertext, err := encryptUpstreamCredential(credential)
	if err != nil {
		return err
	}
	account.CredentialCiphertext = ciphertext
	account.Credential = ""
	account.CredentialConfigured = true
	return nil
}

func (account *UpstreamAccount) GetCredential() (string, error) {
	return decryptUpstreamCredential(account.CredentialCiphertext)
}

func NormalizeUpstreamAccount(account *UpstreamAccount) error {
	account.Name = strings.TrimSpace(account.Name)
	account.BaseURL = strings.TrimRight(strings.TrimSpace(account.BaseURL), "/")
	account.SiteType = strings.ToLower(strings.TrimSpace(account.SiteType))
	account.AuthType = strings.ToLower(strings.TrimSpace(account.AuthType))
	if account.Name == "" || account.BaseURL == "" {
		return errors.New("name and base URL are required")
	}
	if !strings.HasPrefix(account.BaseURL, "http://") && !strings.HasPrefix(account.BaseURL, "https://") {
		return errors.New("base URL must use http or https")
	}
	if account.SiteType == "" {
		account.SiteType = UpstreamSiteTypeNewAPI
	}
	if account.SiteType != UpstreamSiteTypeNewAPI {
		return errors.New("unsupported upstream site type")
	}
	if account.AuthType == "" {
		account.AuthType = UpstreamAuthTypeToken
	}
	if account.AuthType != UpstreamAuthTypeToken && account.AuthType != UpstreamAuthTypeCookie {
		return errors.New("unsupported upstream authentication type")
	}
	if account.BalanceInterval <= 0 {
		account.BalanceInterval = 60
	}
	if account.BalanceInterval < 5 {
		return errors.New("balance interval cannot be less than 5 minutes")
	}
	return nil
}

func hydrateUpstreamAccount(account *UpstreamAccount) {
	account.CredentialConfigured = account.CredentialCiphertext != ""
}

func ListUpstreamAccounts() ([]*UpstreamAccount, error) {
	accounts := make([]*UpstreamAccount, 0)
	if err := DB.Order("id desc").Find(&accounts).Error; err != nil {
		return nil, err
	}
	for _, account := range accounts {
		hydrateUpstreamAccount(account)
		var channelIds []int
		if err := DB.Table("upstream_account_channels").
			Joins("JOIN channels ON channels.id = upstream_account_channels.channel_id").
			Where("upstream_account_channels.account_id = ?", account.Id).
			Order("upstream_account_channels.channel_id asc").
			Pluck("upstream_account_channels.channel_id", &channelIds).Error; err != nil {
			return nil, err
		}
		account.ChannelIds = channelIds
	}
	return accounts, nil
}

func GetUpstreamAccountById(id int) (*UpstreamAccount, error) {
	var account UpstreamAccount
	if err := DB.First(&account, id).Error; err != nil {
		return nil, err
	}
	hydrateUpstreamAccount(&account)
	return &account, nil
}

func GetUpstreamAccountForChannel(channelId int) (*UpstreamAccount, error) {
	var account UpstreamAccount
	err := DB.Table("upstream_accounts").
		Joins("JOIN upstream_account_channels ON upstream_account_channels.account_id = upstream_accounts.id").
		Where("upstream_account_channels.channel_id = ?", channelId).
		First(&account).Error
	if err != nil {
		return nil, err
	}
	hydrateUpstreamAccount(&account)
	return &account, nil
}

func CreateUpstreamAccount(account *UpstreamAccount) error {
	if err := NormalizeUpstreamAccount(account); err != nil {
		return err
	}
	if err := account.SetCredential(account.Credential); err != nil {
		return err
	}
	now := common.GetTimestamp()
	account.CreatedTime = now
	account.UpdatedTime = now
	account.BalanceStatus = UpstreamStatusUnknown
	account.LastCheckinStatus = UpstreamStatusUnknown
	account.HealthStatus = UpstreamStatusUnknown
	if account.AutoCheckin {
		account.NextCheckinTime = now
	}
	if account.AutoBalance {
		account.NextBalanceTime = now
	}
	return DB.Create(account).Error
}

func UpdateUpstreamAccount(account *UpstreamAccount) error {
	if err := NormalizeUpstreamAccount(account); err != nil {
		return err
	}
	existing, err := GetUpstreamAccountById(account.Id)
	if err != nil {
		return err
	}
	credentialCiphertext := existing.CredentialCiphertext
	if strings.TrimSpace(account.Credential) != "" {
		if err := account.SetCredential(account.Credential); err != nil {
			return err
		}
		credentialCiphertext = account.CredentialCiphertext
	}
	now := common.GetTimestamp()
	updates := map[string]any{
		"name":                  account.Name,
		"base_url":              account.BaseURL,
		"site_type":             account.SiteType,
		"auth_type":             account.AuthType,
		"user_id":               account.UserId,
		"credential_ciphertext": credentialCiphertext,
		"auto_checkin":          account.AutoCheckin,
		"auto_balance":          account.AutoBalance,
		"balance_interval":      account.BalanceInterval,
		"updated_time":          now,
	}
	if account.AutoCheckin && (!existing.AutoCheckin || existing.NextCheckinTime == 0) {
		updates["next_checkin_time"] = now
	}
	if !account.AutoCheckin {
		updates["next_checkin_time"] = int64(0)
	}
	if account.AutoBalance && (!existing.AutoBalance || existing.NextBalanceTime == 0) {
		updates["next_balance_time"] = now
	}
	if !account.AutoBalance {
		updates["next_balance_time"] = int64(0)
	}
	return DB.Model(&UpstreamAccount{}).Where("id = ?", account.Id).Updates(updates).Error
}

func DeleteUpstreamAccount(id int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var links []UpstreamAccountChannel
		if err := tx.Where("account_id = ?", id).Find(&links).Error; err != nil {
			return err
		}
		for _, link := range links {
			if err := tx.Model(&Channel{}).
				Where("id = ? AND balance_source = ?", link.ChannelId, ChannelBalanceSourceUpstream).
				Update("balance_source", ChannelBalanceSourceChannel).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("account_id = ?", id).Delete(&UpstreamAccountChannel{}).Error; err != nil {
			return err
		}
		if err := tx.Where("account_id = ?", id).Delete(&UpstreamAccountLog{}).Error; err != nil {
			return err
		}
		result := tx.Delete(&UpstreamAccount{}, id)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
}

func ReplaceUpstreamAccountChannels(accountId int, channelIds []int) error {
	seen := make(map[int]struct{}, len(channelIds))
	cleanIds := make([]int, 0, len(channelIds))
	for _, channelId := range channelIds {
		if channelId <= 0 {
			continue
		}
		if _, ok := seen[channelId]; ok {
			continue
		}
		seen[channelId] = struct{}{}
		cleanIds = append(cleanIds, channelId)
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var accountCount int64
		if err := tx.Model(&UpstreamAccount{}).Where("id = ?", accountId).Count(&accountCount).Error; err != nil {
			return err
		}
		if accountCount == 0 {
			return gorm.ErrRecordNotFound
		}
		if len(cleanIds) > 0 {
			var channelCount int64
			if err := tx.Model(&Channel{}).Where("id IN ?", cleanIds).Count(&channelCount).Error; err != nil {
				return err
			}
			if channelCount != int64(len(cleanIds)) {
				return errors.New("one or more channels do not exist")
			}
		}
		var oldLinks []UpstreamAccountChannel
		if err := tx.Where("account_id = ?", accountId).Find(&oldLinks).Error; err != nil {
			return err
		}
		retainedChannels := make(map[int]struct{}, len(oldLinks))
		for _, oldLink := range oldLinks {
			retainedChannels[oldLink.ChannelId] = struct{}{}
		}
		if err := tx.Where("account_id = ?", accountId).Delete(&UpstreamAccountChannel{}).Error; err != nil {
			return err
		}
		for _, oldLink := range oldLinks {
			if _, retained := seen[oldLink.ChannelId]; retained {
				continue
			}
			if err := tx.Model(&Channel{}).
				Where("id = ? AND balance_source = ?", oldLink.ChannelId, ChannelBalanceSourceUpstream).
				Update("balance_source", ChannelBalanceSourceChannel).Error; err != nil {
				return err
			}
		}
		now := common.GetTimestamp()
		for _, channelId := range cleanIds {
			// A channel has one deterministic balance account. Rebinding it moves
			// the channel away from any previous account.
			if err := tx.Where("channel_id = ?", channelId).Delete(&UpstreamAccountChannel{}).Error; err != nil {
				return err
			}
			link := &UpstreamAccountChannel{AccountId: accountId, ChannelId: channelId, CreatedAt: now}
			if err := tx.Create(link).Error; err != nil {
				return err
			}
			if _, retained := retainedChannels[channelId]; !retained {
				if err := tx.Model(&Channel{}).Where("id = ?", channelId).
					Update("balance_source", ChannelBalanceSourceUpstream).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func UpdateChannelBalanceSource(channelId int, source string) error {
	source = strings.ToLower(strings.TrimSpace(source))
	if source != ChannelBalanceSourceChannel && source != ChannelBalanceSourceUpstream && source != ChannelBalanceSourceNone {
		return errors.New("invalid channel balance source")
	}
	if source == ChannelBalanceSourceUpstream {
		var count int64
		if err := DB.Model(&UpstreamAccountChannel{}).Where("channel_id = ?", channelId).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			return errors.New("channel is not bound to an upstream account")
		}
	}
	result := DB.Model(&Channel{}).Where("id = ?", channelId).Update("balance_source", source)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func ListUpstreamAccountLogs(accountId, limit int) ([]*UpstreamAccountLog, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	logs := make([]*UpstreamAccountLog, 0)
	query := DB.Order("id desc").Limit(limit)
	if accountId > 0 {
		query = query.Where("account_id = ?", accountId)
	}
	return logs, query.Find(&logs).Error
}

func CreateUpstreamAccountLog(log *UpstreamAccountLog) error {
	if log.CreatedAt == 0 {
		log.CreatedAt = common.GetTimestamp()
	}
	return DB.Create(log).Error
}

func GetDueUpstreamAccountIds(now int64) ([]int, error) {
	var ids []int
	err := DB.Model(&UpstreamAccount{}).
		Where("(auto_checkin = ? AND next_checkin_time > 0 AND next_checkin_time <= ?) OR (auto_balance = ? AND next_balance_time > 0 AND next_balance_time <= ?)", true, now, true, now).
		Order("id asc").Pluck("id", &ids).Error
	return ids, err
}

func HydrateChannelUpstreamBalances(channels []*Channel) error {
	if len(channels) == 0 {
		return nil
	}
	if !DB.Migrator().HasTable(&UpstreamAccountChannel{}) || !DB.Migrator().HasTable(&UpstreamAccount{}) {
		return nil
	}
	ids := make([]int, 0, len(channels))
	byId := make(map[int]*Channel, len(channels))
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		ids = append(ids, channel.Id)
		byId[channel.Id] = channel
	}
	type row struct {
		ChannelId          int
		AccountId          int
		AccountName        string
		Balance            float64
		BalanceUnit        string
		BalanceUpdatedTime int64
		BalanceStatus      string
	}
	var rows []row
	err := DB.Table("upstream_account_channels").
		Select("upstream_account_channels.channel_id, upstream_accounts.id AS account_id, upstream_accounts.name AS account_name, upstream_accounts.balance, upstream_accounts.balance_unit, upstream_accounts.balance_updated_time, upstream_accounts.balance_status").
		Joins("JOIN upstream_accounts ON upstream_accounts.id = upstream_account_channels.account_id").
		Where("upstream_account_channels.channel_id IN ?", ids).
		Scan(&rows).Error
	if err != nil {
		return err
	}
	for _, item := range rows {
		channel := byId[item.ChannelId]
		if channel == nil {
			continue
		}
		balance := item.Balance
		channel.UpstreamAccountId = item.AccountId
		channel.UpstreamAccountName = item.AccountName
		channel.UpstreamBalance = &balance
		channel.UpstreamBalanceUnit = item.BalanceUnit
		channel.UpstreamBalanceUpdatedTime = item.BalanceUpdatedTime
		channel.UpstreamBalanceStatus = item.BalanceStatus
	}
	return nil
}

func ValidateChannelBalanceSource(channel *Channel) error {
	if channel.BalanceSource == "" {
		channel.BalanceSource = ChannelBalanceSourceChannel
	}
	if channel.BalanceSource != ChannelBalanceSourceChannel && channel.BalanceSource != ChannelBalanceSourceUpstream && channel.BalanceSource != ChannelBalanceSourceNone {
		return fmt.Errorf("invalid channel balance source: %s", channel.BalanceSource)
	}
	return nil
}

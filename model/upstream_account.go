package model

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

const (
	// UpstreamSiteTypeNewAPI is kept as the canonical value for existing rows.
	// The all-api-hub compatible alias "new-api" is normalized to this value.
	UpstreamSiteTypeNewAPI        = "new_api"
	UpstreamSiteTypeOneAPI        = "one-api"
	UpstreamSiteTypeAnyRouter     = "anyrouter"
	UpstreamSiteTypeVeloera       = "Veloera"
	UpstreamSiteTypeOneHub        = "one-hub"
	UpstreamSiteTypeDoneHub       = "done-hub"
	UpstreamSiteTypeVAPI          = "v-api"
	UpstreamSiteTypeVoAPIV2       = "voapi-v2"
	UpstreamSiteTypeVoAPI         = "VoAPI"
	UpstreamSiteTypeSuperAPI      = "Super-API"
	UpstreamSiteTypeRixAPI        = "Rix-Api"
	UpstreamSiteTypeNeoAPI        = "neo-Api"
	UpstreamSiteTypeWongGongyi    = "wong-gongyi"
	UpstreamSiteTypeSub2API       = "sub2api"
	UpstreamSiteTypeAIHubMix      = "AIHubMix"
	UpstreamSiteTypeSharedChat    = "sharedchat"
	UpstreamSiteTypeOpenRouter    = "openrouter"
	UpstreamSiteTypeUnknown       = "unknown"
	UpstreamSiteTypeOctopus       = "octopus"
	UpstreamSiteTypeAxonHub       = "axonhub"
	UpstreamSiteTypeClaudeCodeHub = "claude-code-hub"

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
	UpstreamTriggerRetry     = "retry"

	ChannelBalanceSourceChannel  = "channel"
	ChannelBalanceSourceUpstream = "upstream"
	ChannelBalanceSourceNone     = "none"

	upstreamCredentialCipherV1 = "v1."
)

// UpstreamSiteTypeOption describes the account capabilities exposed by the
// admin UI.  A site can be saved even when it only has external links; in
// that case SupportsCheckin/SupportsBalance are false and the UI does not
// pretend that server-side automation is available.
type UpstreamSiteTypeOption struct {
	Value           string   `json:"value"`
	Label           string   `json:"label"`
	AuthTypes       []string `json:"auth_types"`
	SupportsCheckin bool     `json:"supports_checkin"`
	SupportsBalance bool     `json:"supports_balance"`
	ExternalOnly    bool     `json:"external_only"`
	CheckinPath     string   `json:"checkin_path,omitempty"`
	RedeemPath      string   `json:"redeem_path,omitempty"`
	BalancePath     string   `json:"balance_path,omitempty"`
}

var upstreamSiteTypeOptions = []UpstreamSiteTypeOption{
	{Value: UpstreamSiteTypeOneAPI, Label: "One API", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeNewAPI, Label: "New API", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeAnyRouter, Label: "AnyRouter", AuthTypes: []string{UpstreamAuthTypeCookie, UpstreamAuthTypeToken}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/sign_in", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeVeloera, Label: "Veloera", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/check_in", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeOneHub, Label: "One Hub", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeDoneHub, Label: "Done Hub", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeVAPI, Label: "v-api", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeVoAPIV2, Label: "VoAPI v2", AuthTypes: []string{UpstreamAuthTypeToken}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/check_in", BalancePath: "/api/user/info"},
	{Value: UpstreamSiteTypeVoAPI, Label: "VoAPI", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeSuperAPI, Label: "Super-API", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeRixAPI, Label: "Rix-Api", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeNeoAPI, Label: "neo-Api", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeWongGongyi, Label: "Wong 公益站", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: true, CheckinPath: "/api/user/checkin", BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeSub2API, Label: "Sub2API", AuthTypes: []string{UpstreamAuthTypeToken}, SupportsBalance: true, SupportsCheckin: false, BalancePath: "/api/v1/auth/me"},
	{Value: UpstreamSiteTypeAIHubMix, Label: "AIHubMix", AuthTypes: []string{UpstreamAuthTypeToken}, SupportsBalance: true, SupportsCheckin: false, BalancePath: "/api/user/self"},
	{Value: UpstreamSiteTypeSharedChat, Label: "SharedChat", AuthTypes: []string{UpstreamAuthTypeCookie}, SupportsBalance: true, SupportsCheckin: false, BalancePath: "/frontend-api/vibe-code/quota"},
	{Value: UpstreamSiteTypeOpenRouter, Label: "OpenRouter", AuthTypes: []string{UpstreamAuthTypeToken}, SupportsBalance: true, SupportsCheckin: false, BalancePath: "/credits"},
	{Value: UpstreamSiteTypeUnknown, Label: "未知/自定义站点", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, SupportsBalance: false, SupportsCheckin: false, ExternalOnly: true},
	{Value: UpstreamSiteTypeOctopus, Label: "Octopus（外部管理）", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, ExternalOnly: true},
	{Value: UpstreamSiteTypeAxonHub, Label: "AxonHub（外部管理）", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, ExternalOnly: true},
	{Value: UpstreamSiteTypeClaudeCodeHub, Label: "Claude Code Hub（外部管理）", AuthTypes: []string{UpstreamAuthTypeToken, UpstreamAuthTypeCookie}, ExternalOnly: true},
}

// GetUpstreamSiteTypeOptions returns a defensive copy for API consumers.
func GetUpstreamSiteTypeOptions() []UpstreamSiteTypeOption {
	options := make([]UpstreamSiteTypeOption, len(upstreamSiteTypeOptions))
	for index, option := range upstreamSiteTypeOptions {
		options[index] = option
		options[index].AuthTypes = append([]string(nil), option.AuthTypes...)
	}
	return options
}

func upstreamSiteTypeOption(siteType string) (UpstreamSiteTypeOption, bool) {
	for _, option := range upstreamSiteTypeOptions {
		if option.Value == siteType {
			return option, true
		}
	}
	return UpstreamSiteTypeOption{}, false
}

func normalizeUpstreamSiteType(value string) string {
	normalized := strings.TrimSpace(value)
	switch strings.ToLower(normalized) {
	case "new-api", "newapi", "new_api":
		return UpstreamSiteTypeNewAPI
	case "one_api":
		return UpstreamSiteTypeOneAPI
	case "veloera":
		return UpstreamSiteTypeVeloera
	case "onehub":
		return UpstreamSiteTypeOneHub
	case "donehub":
		return UpstreamSiteTypeDoneHub
	case "voapi":
		return UpstreamSiteTypeVoAPI
	case "super-api", "super_api":
		return UpstreamSiteTypeSuperAPI
	case "rix-api", "rix_api":
		return UpstreamSiteTypeRixAPI
	case "neo-api", "neo_api":
		return UpstreamSiteTypeNeoAPI
	case "wong_gongyi":
		return UpstreamSiteTypeWongGongyi
	case "aihubmix":
		return UpstreamSiteTypeAIHubMix
	case "shared-chat", "shared_chat":
		return UpstreamSiteTypeSharedChat
	case "open-router", "open_router":
		return UpstreamSiteTypeOpenRouter
	default:
		return normalized
	}
}

var upstreamCredentialAAD = []byte("new-api-upstream-account-credential-v1")

// UpstreamAccount stores a dashboard account for a compatible New API site.
// CredentialCiphertext is never serialized; Credential is write-only at the
// API boundary and exists here only to simplify validated create/update flows.
type UpstreamAccount struct {
	Id                    int      `json:"id"`
	Name                  string   `json:"name" gorm:"type:varchar(191);index"`
	BaseURL               string   `json:"base_url" gorm:"type:varchar(512)"`
	SiteType              string   `json:"site_type" gorm:"type:varchar(32);default:'new_api'"`
	Notes                 string   `json:"notes" gorm:"type:text"`
	TagsJSON              string   `json:"-" gorm:"column:tags;type:text"`
	Tags                  []string `json:"tags" gorm:"-:all"`
	ExternalCheckinURL    string   `json:"external_checkin_url" gorm:"type:varchar(1024)"`
	RedeemURL             string   `json:"redeem_url" gorm:"type:varchar(1024)"`
	OpenRedeemWithCheckin bool     `json:"open_redeem_with_checkin"`
	AuthType              string   `json:"auth_type" gorm:"type:varchar(32);default:'token'"`
	UserId                int      `json:"user_id"`
	CredentialCiphertext  string   `json:"-" gorm:"type:text"`
	Credential            string   `json:"credential,omitempty" gorm:"-:all"`
	CredentialConfigured  bool     `json:"credential_configured" gorm:"-:all"`
	AutoCheckin           bool     `json:"auto_checkin" gorm:"default:false"`
	AutoBalance           bool     `json:"auto_balance" gorm:"default:true"`
	BalanceInterval       int      `json:"balance_interval" gorm:"default:60"`
	Balance               float64  `json:"balance"`
	BalanceUnit           string   `json:"balance_unit" gorm:"type:varchar(16)"`
	RawQuota              float64  `json:"raw_quota"`
	QuotaPerUnit          float64  `json:"quota_per_unit"`
	BalanceUpdatedTime    int64    `json:"balance_updated_time" gorm:"bigint;index"`
	BalanceStatus         string   `json:"balance_status" gorm:"type:varchar(32);default:'unknown'"`
	LastCheckinTime       int64    `json:"last_checkin_time" gorm:"bigint"`
	LastCheckinStatus     string   `json:"last_checkin_status" gorm:"type:varchar(32);default:'unknown'"`
	LastCheckinMessage    string   `json:"last_checkin_message" gorm:"type:text"`
	CheckinAttemptDate    string   `json:"checkin_attempt_date" gorm:"type:varchar(10);index"`
	CheckinAttempts       int      `json:"checkin_attempts" gorm:"default:0"`
	LastHealthTime        int64    `json:"last_health_time" gorm:"bigint"`
	HealthStatus          string   `json:"health_status" gorm:"type:varchar(32);default:'unknown'"`
	LastError             string   `json:"last_error" gorm:"type:text"`
	NextCheckinTime       int64    `json:"next_checkin_time" gorm:"bigint;index"`
	NextBalanceTime       int64    `json:"next_balance_time" gorm:"bigint;index"`
	CreatedTime           int64    `json:"created_time" gorm:"bigint"`
	UpdatedTime           int64    `json:"updated_time" gorm:"bigint"`
	ChannelIds            []int    `json:"channel_ids" gorm:"-:all"`
}

type UpstreamAccountChannel struct {
	Id        int   `json:"id"`
	AccountId int   `json:"account_id" gorm:"uniqueIndex:idx_upstream_account_channel;index"`
	ChannelId int   `json:"channel_id" gorm:"uniqueIndex:idx_upstream_account_channel;index"`
	CreatedAt int64 `json:"created_at" gorm:"bigint"`
}

// UpstreamAccountBalance is the balance snapshot of one upstream account
// contributing to a channel's aggregate balance.
type UpstreamAccountBalance struct {
	AccountId   int     `json:"account_id"`
	AccountName string  `json:"account_name"`
	Balance     float64 `json:"balance"`
	Unit        string  `json:"unit"`
	UpdatedTime int64   `json:"updated_time"`
	Status      string  `json:"status"`
}

// UpstreamChannelBalanceSummary is the aggregate balance exposed for a
// channel. Accounts remain independently refreshable and independently
// visible in the account page; this summary only combines their snapshots.
type UpstreamChannelBalanceSummary struct {
	Balance      float64                  `json:"balance"`
	Unit         string                   `json:"unit"`
	UpdatedTime  int64                    `json:"updated_time"`
	Status       string                   `json:"status"`
	AccountIds   []int                    `json:"account_ids"`
	AccountNames []string                 `json:"account_names"`
	AccountCount int                      `json:"account_count"`
	Accounts     []UpstreamAccountBalance `json:"accounts"`
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
	account.SiteType = normalizeUpstreamSiteType(account.SiteType)
	account.AuthType = strings.ToLower(strings.TrimSpace(account.AuthType))
	if account.Name == "" || account.BaseURL == "" {
		return errors.New("name and base URL are required")
	}
	parsedBaseURL, err := url.Parse(account.BaseURL)
	if err != nil || parsedBaseURL.Host == "" || (parsedBaseURL.Scheme != "http" && parsedBaseURL.Scheme != "https") {
		return errors.New("base URL must use http or https")
	}
	if account.SiteType == "" {
		account.SiteType = UpstreamSiteTypeNewAPI
	}
	option, supported := upstreamSiteTypeOption(account.SiteType)
	if !supported {
		return errors.New("unsupported upstream site type")
	}
	if account.AuthType == "" {
		account.AuthType = UpstreamAuthTypeToken
	}
	if account.AuthType != UpstreamAuthTypeToken && account.AuthType != UpstreamAuthTypeCookie {
		return errors.New("unsupported upstream authentication type")
	}
	if !containsString(option.AuthTypes, account.AuthType) {
		return fmt.Errorf("site type %s does not support %s authentication", option.Label, account.AuthType)
	}
	if !option.SupportsCheckin {
		account.AutoCheckin = false
	}
	if !option.SupportsBalance {
		account.AutoBalance = false
	}
	account.Notes = strings.TrimSpace(account.Notes)
	if len(account.Notes) > 4000 {
		return errors.New("notes cannot exceed 4000 characters")
	}
	account.ExternalCheckinURL, err = normalizeOptionalHTTPURL(account.ExternalCheckinURL, "external check-in URL")
	if err != nil {
		return err
	}
	account.RedeemURL, err = normalizeOptionalHTTPURL(account.RedeemURL, "redeem URL")
	if err != nil {
		return err
	}
	account.Tags = normalizeUpstreamTags(account.Tags)
	tagsJSON, err := common.Marshal(account.Tags)
	if err != nil {
		return err
	}
	account.TagsJSON = string(tagsJSON)
	if account.BalanceInterval <= 0 {
		account.BalanceInterval = 60
	}
	if account.BalanceInterval < 5 {
		return errors.New("balance interval cannot be less than 5 minutes")
	}
	return nil
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func normalizeOptionalHTTPURL(value, label string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("%s must use http or https", label)
	}
	return value, nil
}

func normalizeUpstreamTags(tags []string) []string {
	seen := make(map[string]struct{}, len(tags))
	result := make([]string, 0, len(tags))
	for _, raw := range tags {
		tag := strings.TrimSpace(raw)
		if tag == "" || len(tag) > 64 {
			continue
		}
		key := strings.ToLower(tag)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, tag)
		if len(result) >= 32 {
			break
		}
	}
	return result
}

func hydrateUpstreamAccount(account *UpstreamAccount) {
	account.CredentialConfigured = account.CredentialCiphertext != ""
	account.SiteType = normalizeUpstreamSiteType(account.SiteType)
	if account.SiteType == "" {
		account.SiteType = UpstreamSiteTypeNewAPI
	}
	account.Tags = []string{}
	if strings.TrimSpace(account.TagsJSON) != "" {
		_ = common.Unmarshal([]byte(account.TagsJSON), &account.Tags)
		account.Tags = normalizeUpstreamTags(account.Tags)
	}
}

func ListUpstreamAccounts() ([]*UpstreamAccount, error) {
	accounts := make([]*UpstreamAccount, 0)
	if err := DB.Order("id desc").Find(&accounts).Error; err != nil {
		return nil, err
	}
	for _, account := range accounts {
		hydrateUpstreamAccount(account)
		channelIds := make([]int, 0)
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

func GetUpstreamAccountsForChannel(channelId int) ([]*UpstreamAccount, error) {
	accounts := make([]*UpstreamAccount, 0)
	err := DB.Table("upstream_accounts").
		Joins("JOIN upstream_account_channels ON upstream_account_channels.account_id = upstream_accounts.id").
		Where("upstream_account_channels.channel_id = ?", channelId).
		Order("upstream_accounts.id asc").
		Find(&accounts).Error
	if err != nil {
		return nil, err
	}
	if len(accounts) == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	for _, account := range accounts {
		hydrateUpstreamAccount(account)
	}
	return accounts, nil
}

// GetUpstreamAccountForChannel keeps the legacy single-account call sites
// compatible while the binding table supports multiple accounts per channel.
// New code that needs the full aggregate should use GetUpstreamAccountsForChannel.
func GetUpstreamAccountForChannel(channelId int) (*UpstreamAccount, error) {
	accounts, err := GetUpstreamAccountsForChannel(channelId)
	if err != nil {
		return nil, err
	}
	return accounts[0], nil
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
		"name":                     account.Name,
		"base_url":                 account.BaseURL,
		"site_type":                account.SiteType,
		"notes":                    account.Notes,
		"tags":                     account.TagsJSON,
		"external_checkin_url":     account.ExternalCheckinURL,
		"redeem_url":               account.RedeemURL,
		"open_redeem_with_checkin": account.OpenRedeemWithCheckin,
		"auth_type":                account.AuthType,
		"user_id":                  account.UserId,
		"credential_ciphertext":    credentialCiphertext,
		"auto_checkin":             account.AutoCheckin,
		"auto_balance":             account.AutoBalance,
		"balance_interval":         account.BalanceInterval,
		"updated_time":             now,
	}
	if account.AutoCheckin && (!existing.AutoCheckin || existing.NextCheckinTime == 0) {
		updates["next_checkin_time"] = now
		updates["checkin_attempt_date"] = ""
		updates["checkin_attempts"] = 0
	}
	if !account.AutoCheckin {
		updates["next_checkin_time"] = int64(0)
		updates["checkin_attempt_date"] = ""
		updates["checkin_attempts"] = 0
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
		if err := tx.Where("account_id = ?", id).Delete(&UpstreamAccountChannel{}).Error; err != nil {
			return err
		}
		for _, link := range links {
			var remaining int64
			if err := tx.Model(&UpstreamAccountChannel{}).
				Where("channel_id = ?", link.ChannelId).
				Count(&remaining).Error; err != nil {
				return err
			}
			if remaining == 0 {
				if err := tx.Model(&Channel{}).
					Where("id = ? AND balance_source = ?", link.ChannelId, ChannelBalanceSourceUpstream).
					Update("balance_source", ChannelBalanceSourceChannel).Error; err != nil {
					return err
				}
			}
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
		if err := tx.Where("account_id = ?", accountId).Delete(&UpstreamAccountChannel{}).Error; err != nil {
			return err
		}
		for _, oldLink := range oldLinks {
			if _, retained := seen[oldLink.ChannelId]; retained {
				continue
			}
			var remaining int64
			if err := tx.Model(&UpstreamAccountChannel{}).
				Where("channel_id = ?", oldLink.ChannelId).
				Count(&remaining).Error; err != nil {
				return err
			}
			if remaining == 0 {
				if err := tx.Model(&Channel{}).
					Where("id = ? AND balance_source = ?", oldLink.ChannelId, ChannelBalanceSourceUpstream).
					Update("balance_source", ChannelBalanceSourceChannel).Error; err != nil {
					return err
				}
			}
		}
		now := common.GetTimestamp()
		for _, channelId := range cleanIds {
			link := &UpstreamAccountChannel{AccountId: accountId, ChannelId: channelId, CreatedAt: now}
			if err := tx.Where("account_id = ? AND channel_id = ?", accountId, channelId).
				FirstOrCreate(link).Error; err != nil {
				return err
			}
			if err := tx.Model(&Channel{}).Where("id = ?", channelId).
				Update("balance_source", ChannelBalanceSourceUpstream).Error; err != nil {
				return err
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
	byChannel := make(map[int][]UpstreamAccountBalance)
	for _, item := range rows {
		byChannel[item.ChannelId] = append(byChannel[item.ChannelId], UpstreamAccountBalance{
			AccountId:   item.AccountId,
			AccountName: item.AccountName,
			Balance:     item.Balance,
			Unit:        item.BalanceUnit,
			UpdatedTime: item.BalanceUpdatedTime,
			Status:      item.BalanceStatus,
		})
	}
	for channelId, channel := range byId {
		channel.UpstreamAccountId = 0
		channel.UpstreamAccountName = ""
		channel.UpstreamAccountIds = nil
		channel.UpstreamAccountNames = nil
		channel.UpstreamAccountCount = 0
		channel.UpstreamBalance = nil
		channel.UpstreamBalanceUnit = ""
		channel.UpstreamBalanceUpdatedTime = 0
		channel.UpstreamBalanceStatus = ""
		channel.UpstreamBalanceDetails = nil
		items := byChannel[channelId]
		if len(items) == 0 {
			continue
		}
		summary := aggregateUpstreamAccountBalances(items)
		channel.UpstreamAccountIds = summary.AccountIds
		channel.UpstreamAccountNames = summary.AccountNames
		channel.UpstreamAccountCount = summary.AccountCount
		channel.UpstreamBalanceDetails = summary.Accounts
		// Keep the first account fields populated for older clients while the
		// plural fields expose the complete many-to-many relationship.
		channel.UpstreamAccountId = summary.AccountIds[0]
		channel.UpstreamAccountName = summary.AccountNames[0]
		balance := summary.Balance
		channel.UpstreamBalance = &balance
		channel.UpstreamBalanceUnit = summary.Unit
		channel.UpstreamBalanceUpdatedTime = summary.UpdatedTime
		channel.UpstreamBalanceStatus = summary.Status
	}
	return nil
}

// GetUpstreamChannelBalanceSummary returns the persisted balance snapshots of
// every account bound to a channel and their aggregate. It does not perform
// network requests; callers that need a fresh value should refresh the
// accounts first.
func GetUpstreamChannelBalanceSummary(channelId int) (*UpstreamChannelBalanceSummary, error) {
	var rows []struct {
		AccountId          int
		AccountName        string
		Balance            float64
		BalanceUnit        string
		BalanceUpdatedTime int64
		BalanceStatus      string
	}
	err := DB.Table("upstream_account_channels").
		Select("upstream_accounts.id AS account_id, upstream_accounts.name AS account_name, upstream_accounts.balance, upstream_accounts.balance_unit, upstream_accounts.balance_updated_time, upstream_accounts.balance_status").
		Joins("JOIN upstream_accounts ON upstream_accounts.id = upstream_account_channels.account_id").
		Where("upstream_account_channels.channel_id = ?", channelId).
		Order("upstream_accounts.id asc").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	items := make([]UpstreamAccountBalance, 0, len(rows))
	for _, row := range rows {
		items = append(items, UpstreamAccountBalance{
			AccountId:   row.AccountId,
			AccountName: row.AccountName,
			Balance:     row.Balance,
			Unit:        row.BalanceUnit,
			UpdatedTime: row.BalanceUpdatedTime,
			Status:      row.BalanceStatus,
		})
	}
	summary := aggregateUpstreamAccountBalances(items)
	return &summary, nil
}

func aggregateUpstreamAccountBalances(items []UpstreamAccountBalance) UpstreamChannelBalanceSummary {
	summary := UpstreamChannelBalanceSummary{Status: UpstreamStatusUnknown, Accounts: items}
	if len(items) == 0 {
		return summary
	}
	summary.AccountCount = len(items)
	summary.AccountIds = make([]int, 0, len(items))
	summary.AccountNames = make([]string, 0, len(items))
	unit := strings.TrimSpace(items[0].Unit)
	if unit == "" {
		unit = "QUOTA"
	}
	unitMismatch := false
	oldestUpdate := int64(0)
	for _, item := range items {
		summary.AccountIds = append(summary.AccountIds, item.AccountId)
		summary.AccountNames = append(summary.AccountNames, item.AccountName)
		itemUnit := strings.TrimSpace(item.Unit)
		if itemUnit == "" {
			itemUnit = "QUOTA"
		}
		if itemUnit != unit {
			unitMismatch = true
		}
		if item.UpdatedTime > 0 && (oldestUpdate == 0 || item.UpdatedTime < oldestUpdate) {
			oldestUpdate = item.UpdatedTime
		}
		if upstreamBalanceStatusRank(item.Status) > upstreamBalanceStatusRank(summary.Status) {
			summary.Status = item.Status
		}
	}
	summary.UpdatedTime = oldestUpdate
	if unitMismatch {
		summary.Unit = "MIXED"
		summary.Balance = 0
		summary.Status = UpstreamStatusFailed
		return summary
	}
	summary.Unit = unit
	for _, item := range items {
		summary.Balance += item.Balance
	}
	return summary
}

func upstreamBalanceStatusRank(status string) int {
	switch status {
	case UpstreamStatusManualRequired:
		return 3
	case UpstreamStatusFailed:
		return 2
	case UpstreamStatusUnknown:
		return 1
	case UpstreamStatusHealthy:
		return 0
	default:
		return 1
	}
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

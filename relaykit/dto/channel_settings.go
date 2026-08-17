package dto

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/relaykit/types"
)

type ChannelSettings struct {
	ForceFormat            bool   `json:"force_format,omitempty"`
	ThinkingToContent      bool   `json:"thinking_to_content,omitempty"`
	Proxy                  string `json:"proxy"`
	PassThroughBodyEnabled bool   `json:"pass_through_body_enabled,omitempty"`
	SystemPrompt           string `json:"system_prompt,omitempty"`
	SystemPromptOverride   bool   `json:"system_prompt_override,omitempty"`
	// HTTPProtocol controls outbound HTTP version negotiation for this channel.
	// Accepted values: "", "auto" (default), "http1".
	HTTPProtocol string `json:"http_protocol,omitempty"`
	// HTTP2ConnectionShards spreads HTTP/2 traffic across N independent transports
	// (1-8). Zero/unset means 1. Ignored when HTTPProtocol is "http1".
	HTTP2ConnectionShards int `json:"http2_connection_shards,omitempty"`
	// Queue configures the optional background upstream queue warmer for this
	// channel. The host module owns validation and execution; keeping this DTO
	// here lets the channel setting travel through relaykit without a root-module
	// dependency.
	Queue *ChannelQueueSettings `json:"queue,omitempty"`
}

// ChannelQueueSettings configures a lightweight, per-channel upstream warm-up
// request. It does not reserve a reusable slot and never replaces a user's
// request; it only keeps the channel's upstream path exercised and records its
// health independently from consumption logs.
type ChannelQueueSettings struct {
	Enabled       bool   `json:"enabled,omitempty"`
	Model         string `json:"model,omitempty"`
	Interval      int    `json:"interval,omitempty"`      // seconds between warm-ups
	EndpointType  string `json:"endpoint_type,omitempty"` // empty/auto = detect
	WarmupMessage string `json:"warmup_message,omitempty"`
	MaxTokens     *uint  `json:"max_tokens,omitempty"` // cap warm-up output
	Timeout       int    `json:"timeout,omitempty"`    // per-call timeout seconds

	CircuitBreakerEnabled  bool  `json:"circuit_breaker_enabled,omitempty"`
	MaxConsecutiveFailures int   `json:"max_consecutive_failures,omitempty"`
	CooldownSeconds        int   `json:"cooldown_seconds,omitempty"`
	MaxQueueAttempts       int   `json:"max_queue_attempts,omitempty"`
	BackoffSeconds         int   `json:"backoff_seconds,omitempty"`
	QueueBusyStatusCodes   []int `json:"queue_busy_status_codes,omitempty"`
}

const (
	HTTPProtocolAuto         = "auto"
	HTTPProtocolHTTP1        = "http1"
	MaxHTTP2ConnectionShards = 8
)

// Client identity channel type values intentionally mirror the root module's
// channel constants. relaykit must stay independently buildable and therefore
// cannot import github.com/QuantumNous/new-api/constant.
const (
	ClientIdentityChannelTypeOpenAI          = 1
	ClientIdentityChannelTypeAnthropic       = 14
	ClientIdentityChannelTypeCodexLegacy     = 57
	ClientIdentityChannelTypeCodexCompatible = 61
	ClientIdentityChannelTypeClaudeCode      = 62
	ClientIdentityChannelTypeCodeBuddy       = 63
	ClientIdentityClientTypeNone             = "none"
	ClientIdentityClientTypeCodex            = "codex"
	ClientIdentityClientTypeClaude           = "claude"
	ClientIdentityClientTypeClaudeCode       = "claude_code"
	ClientIdentityClientTypeCodeBuddy        = "codebuddy"
	ClientIdentityClientTypeWorkBuddy        = "workbuddy"
	ClientIdentityProfileNone                = "none"
	ClientIdentityProfileCodexLegacy         = "codex_legacy"
	ClientIdentityProfileCodexCompatibility  = "codex_compatibility"
	ClientIdentityProfileClaudeCode          = "claude_code"
	ClientIdentityProfileCodeBuddy           = "codebuddy"
	ClientIdentityProfileCodexCLI            = "codex_cli"
	ClientIdentityProfileClaudeCLI           = "claude_cli"
	ClientIdentityProfileCodeBuddyCLI        = "codebuddy_cli"
	ClientIdentityProfileWorkBuddyDesktop    = "workbuddy_desktop"
	ClientIdentitySourceNPM                  = "npm"
	ClientIdentitySourceWorkBuddy            = "workbuddy"
	ClientIdentitySourceManual               = "manual"
	ClientIdentitySourceOfficial             = "official"
	ClientIdentitySourceCommunity            = "community"
	ClientIdentityNPMCodexPackage            = "@openai/codex"
	ClientIdentityNPMClaudeCodePackage       = "@anthropic-ai/claude-code"
	ClientIdentityPlatformWindowsX64         = "windows-x64"
	ClientIdentityPlatformMacOSX64           = "macos-x64"
	ClientIdentityPlatformMacOSArm64         = "macos-arm64"
	ClientIdentityPlatformLinuxX64           = "linux-x64"
	ClientIdentityPlatformLinuxArm64         = "linux-arm64"
)

// ClientIdentitySourceMetadata records where a selected version came from.
// It is deliberately limited to safe provenance data; client identity settings
// never contain arbitrary request headers or transport options.
type ClientIdentitySourceMetadata struct {
	Kind      string `json:"kind,omitempty"`
	Package   string `json:"package,omitempty"`
	Platform  string `json:"platform,omitempty"`
	CheckedAt int64  `json:"checked_at,omitempty"`
}

// ClientIdentityConfig is the persisted, channel-scoped client identity
// contract. An absent client_identity object, or an object with only empty
// values, keeps the legacy runtime defaults unchanged.
type ClientIdentityConfig struct {
	ClientType       string                        `json:"client_type,omitempty"`
	Profile          string                        `json:"profile,omitempty"`
	Version          string                        `json:"version,omitempty"`
	Platform         string                        `json:"platform,omitempty"`
	Context1MEnabled bool                          `json:"context_1m_enabled,omitempty"`
	Source           *ClientIdentitySourceMetadata `json:"source,omitempty"`
}

func (c ClientIdentityConfig) isEmpty() bool {
	return strings.TrimSpace(c.ClientType) == "" &&
		strings.TrimSpace(c.Profile) == "" &&
		strings.TrimSpace(c.Version) == "" &&
		strings.TrimSpace(c.Platform) == "" &&
		!c.Context1MEnabled &&
		(c.Source == nil || c.Source.isEmpty())
}

// IsZero reports whether the config carries no identity or provenance data.
// It is useful to preserve the exact legacy runtime behavior for absent
// settings.
func (c ClientIdentityConfig) IsZero() bool {
	return c.isEmpty()
}

func (s *ClientIdentitySourceMetadata) isEmpty() bool {
	return s == nil || (strings.TrimSpace(s.Kind) == "" &&
		strings.TrimSpace(s.Package) == "" &&
		strings.TrimSpace(s.Platform) == "" &&
		s.CheckedAt == 0)
}

// DefaultClientIdentityConfig returns the profile associated with a supported
// channel. Standard channels intentionally default to no client so their
// normal protocol/adaptor behavior remains unchanged.
func DefaultClientIdentityConfig(channelType int) ClientIdentityConfig {
	switch channelType {
	case ClientIdentityChannelTypeOpenAI:
		return ClientIdentityConfig{
			ClientType: ClientIdentityClientTypeNone,
			Profile:    ClientIdentityProfileNone,
		}
	case ClientIdentityChannelTypeAnthropic:
		return ClientIdentityConfig{
			ClientType: ClientIdentityClientTypeNone,
			Profile:    ClientIdentityProfileNone,
		}
	case ClientIdentityChannelTypeCodexLegacy:
		return ClientIdentityConfig{
			ClientType: ClientIdentityClientTypeCodex,
			Profile:    ClientIdentityProfileCodexLegacy,
		}
	case ClientIdentityChannelTypeCodexCompatible:
		return ClientIdentityConfig{
			ClientType: ClientIdentityClientTypeCodex,
			Profile:    ClientIdentityProfileCodexCompatibility,
		}
	case ClientIdentityChannelTypeClaudeCode:
		return ClientIdentityConfig{
			ClientType: ClientIdentityClientTypeClaudeCode,
			Profile:    ClientIdentityProfileClaudeCode,
		}
	case ClientIdentityChannelTypeCodeBuddy:
		return ClientIdentityConfig{
			ClientType: ClientIdentityClientTypeCodeBuddy,
			Profile:    ClientIdentityProfileCodeBuddy,
		}
	default:
		return ClientIdentityConfig{}
	}
}

// SupportsClientIdentityChannelType reports whether a channel has a built-in
// client identity profile.
func SupportsClientIdentityChannelType(channelType int) bool {
	return channelType == ClientIdentityChannelTypeOpenAI ||
		channelType == ClientIdentityChannelTypeAnthropic ||
		channelType == ClientIdentityChannelTypeCodexLegacy ||
		channelType == ClientIdentityChannelTypeCodexCompatible ||
		channelType == ClientIdentityChannelTypeClaudeCode ||
		channelType == ClientIdentityChannelTypeCodeBuddy
}

// SupportsChannelType reports whether this config is valid for channelType.
// An empty config is considered supported for a supported channel because it
// represents the legacy default.
func (c ClientIdentityConfig) SupportsChannelType(channelType int) bool {
	if !SupportsClientIdentityChannelType(channelType) {
		return false
	}
	return c.Validate(channelType) == nil
}

// ClientIdentityProfileForChannelType returns the explicit profile for a
// channel. The two Codex profiles intentionally remain distinct.
func ClientIdentityProfileForChannelType(channelType int) string {
	return DefaultClientIdentityConfig(channelType).Profile
}

// ClientIdentityChannelTypeForProfile returns the canonical compatibility
// channel used to validate a profile for the version-source API. Standard
// OpenAI and Anthropic channels reuse those same profiles at runtime.
func ClientIdentityChannelTypeForProfile(profile string) int {
	switch profile {
	case ClientIdentityProfileNone,
		ClientIdentityProfileCodexCLI,
		ClientIdentityProfileClaudeCLI,
		ClientIdentityProfileCodeBuddyCLI,
		ClientIdentityProfileWorkBuddyDesktop:
		return ClientIdentityChannelTypeOpenAI
	case ClientIdentityProfileCodexLegacy:
		return ClientIdentityChannelTypeCodexLegacy
	case ClientIdentityProfileCodexCompatibility:
		return ClientIdentityChannelTypeCodexCompatible
	case ClientIdentityProfileClaudeCode:
		return ClientIdentityChannelTypeClaudeCode
	case ClientIdentityProfileCodeBuddy:
		return ClientIdentityChannelTypeCodeBuddy
	default:
		return 0
	}
}

func clientIdentityClientTypeForProfile(profile string) string {
	switch profile {
	case ClientIdentityProfileNone:
		return ClientIdentityClientTypeNone
	case ClientIdentityProfileCodexLegacy, ClientIdentityProfileCodexCompatibility:
		return ClientIdentityClientTypeCodex
	case ClientIdentityProfileCodexCLI:
		return ClientIdentityClientTypeCodex
	case ClientIdentityProfileClaudeCLI:
		return ClientIdentityClientTypeClaude
	case ClientIdentityProfileClaudeCode:
		return ClientIdentityClientTypeClaudeCode
	case ClientIdentityProfileCodeBuddy, ClientIdentityProfileCodeBuddyCLI:
		return ClientIdentityClientTypeCodeBuddy
	case ClientIdentityProfileWorkBuddyDesktop:
		return ClientIdentityClientTypeWorkBuddy
	default:
		return ""
	}
}

// NormalizeClientIdentityProfile validates and canonicalizes a profile used by
// the version-source API.
func NormalizeClientIdentityProfile(profile string) (string, error) {
	profile = strings.ToLower(strings.TrimSpace(profile))
	switch profile {
	case ClientIdentityProfileNone,
		ClientIdentityProfileCodexLegacy,
		ClientIdentityProfileCodexCompatibility,
		ClientIdentityProfileClaudeCode,
		ClientIdentityProfileCodeBuddy,
		ClientIdentityProfileCodexCLI,
		ClientIdentityProfileClaudeCLI,
		ClientIdentityProfileCodeBuddyCLI,
		ClientIdentityProfileWorkBuddyDesktop:
		return profile, nil
	default:
		return "", fmt.Errorf("invalid client identity profile: %s", profile)
	}
}

// NormalizeClientIdentityPlatform validates and canonicalizes the safe
// platform vocabulary. Official WorkBuddy platform identifiers are accepted as
// input aliases and normalized to the product-neutral values persisted in a
// channel setting.
func NormalizeClientIdentityPlatform(platform string) (string, error) {
	platform = strings.ToLower(strings.TrimSpace(platform))
	switch platform {
	case "":
		return "", nil
	case ClientIdentityPlatformWindowsX64, "win32-x64-user", "workbuddy-win32-x64-user":
		return ClientIdentityPlatformWindowsX64, nil
	case ClientIdentityPlatformMacOSX64, "darwin-x64-user", "workbuddy-darwin-x64-user":
		return ClientIdentityPlatformMacOSX64, nil
	case ClientIdentityPlatformMacOSArm64, "darwin-arm64-user", "workbuddy-darwin-arm64-user":
		return ClientIdentityPlatformMacOSArm64, nil
	case ClientIdentityPlatformLinuxX64, ClientIdentityPlatformLinuxArm64:
		return platform, nil
	default:
		return "", fmt.Errorf("invalid client identity platform: %s", platform)
	}
}

// WorkBuddyUpdatePlatform maps a normalized platform to the official update
// API query value. There is intentionally no CodeBuddy npm fallback for this
// product version source.
func WorkBuddyUpdatePlatform(platform string) (string, error) {
	normalized, err := NormalizeClientIdentityPlatform(platform)
	if err != nil {
		return "", err
	}
	if normalized == "" {
		normalized = ClientIdentityPlatformWindowsX64
	}
	switch normalized {
	case ClientIdentityPlatformWindowsX64:
		return "workbuddy-win32-x64-user", nil
	default:
		return "", fmt.Errorf("client identity platform %s is not supported by WorkBuddy update service", normalized)
	}
}

// ClientIdentityPlatformRuntime returns the conventional OS and architecture
// labels used by the supported client identity headers.
func ClientIdentityPlatformRuntime(platform string) (string, string, bool) {
	normalized, err := NormalizeClientIdentityPlatform(platform)
	if err != nil {
		return "", "", false
	}
	switch normalized {
	case ClientIdentityPlatformWindowsX64:
		return "Windows", "x64", true
	case ClientIdentityPlatformMacOSX64:
		return "macOS", "x64", true
	case ClientIdentityPlatformMacOSArm64:
		return "macOS", "arm64", true
	case ClientIdentityPlatformLinuxX64:
		return "Linux", "x64", true
	case ClientIdentityPlatformLinuxArm64:
		return "Linux", "arm64", true
	default:
		return "", "", false
	}
}

var (
	clientIdentityNPMVersionPattern     = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$`)
	clientIdentityWorkBuddyVersionRegex = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2,3}$`)
)

func isClientIdentityNPMProfile(profile string) bool {
	switch profile {
	case ClientIdentityProfileCodexLegacy,
		ClientIdentityProfileCodexCompatibility,
		ClientIdentityProfileCodexCLI,
		ClientIdentityProfileClaudeCode,
		ClientIdentityProfileClaudeCLI:
		return true
	default:
		return false
	}
}

type clientIdentityNPMVersionParts struct {
	prerelease    []string
	buildMetadata []string
}

func parseClientIdentityNPMVersion(version string) clientIdentityNPMVersionParts {
	version = strings.TrimSpace(version)
	parsed := clientIdentityNPMVersionParts{}
	if plus := strings.IndexByte(version, '+'); plus >= 0 {
		parsed.buildMetadata = strings.Split(version[plus+1:], ".")
		version = version[:plus]
	}
	if dash := strings.IndexByte(version, '-'); dash >= 0 {
		parsed.prerelease = strings.Split(version[dash+1:], ".")
	}
	return parsed
}

func npmPlatformForPrerelease(prerelease []string) (string, bool) {
	if len(prerelease) != 1 {
		return "", false
	}
	switch strings.ToLower(prerelease[0]) {
	case "win32-x64":
		return ClientIdentityPlatformWindowsX64, true
	case "darwin-x64":
		return ClientIdentityPlatformMacOSX64, true
	case "darwin-arm64":
		return ClientIdentityPlatformMacOSArm64, true
	case "linux-x64":
		return ClientIdentityPlatformLinuxX64, true
	case "linux-arm64":
		return ClientIdentityPlatformLinuxArm64, true
	default:
		return "", false
	}
}

func validateClientIdentityNPMVersionForPlatform(
	profile string,
	version string,
	platform string,
) error {
	if !isClientIdentityNPMProfile(profile) || version == "" {
		return nil
	}

	parsed := parseClientIdentityNPMVersion(version)
	if len(parsed.prerelease) == 0 {
		return nil
	}

	buildPlatform, isPlatformBuild := npmPlatformForPrerelease(parsed.prerelease)
	if !isPlatformBuild {
		return fmt.Errorf("prerelease client identity version is not allowed: %s", version)
	}
	if platform == "" {
		return fmt.Errorf("platform build client identity version requires an explicit platform: %s", version)
	}
	if buildPlatform != platform {
		return fmt.Errorf("client identity version platform %s does not match platform %s", buildPlatform, platform)
	}
	return nil
}

func validateClientIdentityVersion(profile, version string) error {
	if version == "" {
		return nil
	}
	if len(version) > 64 {
		return fmt.Errorf("client identity version is too long")
	}
	if profile == ClientIdentityProfileCodeBuddy ||
		profile == ClientIdentityProfileCodeBuddyCLI ||
		profile == ClientIdentityProfileWorkBuddyDesktop {
		if !clientIdentityWorkBuddyVersionRegex.MatchString(version) {
			return fmt.Errorf("invalid WorkBuddy product version: %s", version)
		}
		return nil
	}
	if !clientIdentityNPMVersionPattern.MatchString(version) {
		return fmt.Errorf("invalid client identity version: %s", version)
	}
	return nil
}

// ValidateClientIdentityVersion validates an explicitly selected version for a
// profile without requiring a complete channel settings object.
func ValidateClientIdentityVersion(profile, version string) error {
	profile, err := NormalizeClientIdentityProfile(profile)
	if err != nil {
		return err
	}
	return validateClientIdentityVersion(profile, strings.TrimSpace(version))
}

// Normalize trims and fills the profile fields while preserving empty version
// and platform values as the legacy defaults.
func (c *ClientIdentityConfig) Normalize(channelType int) error {
	if c == nil {
		return nil
	}
	if !SupportsClientIdentityChannelType(channelType) {
		if c.isEmpty() {
			return nil
		}
		return fmt.Errorf("client identity is not supported for channel type %d", channelType)
	}

	defaults := DefaultClientIdentityConfig(channelType)
	c.ClientType = strings.ToLower(strings.TrimSpace(c.ClientType))
	c.Profile = strings.ToLower(strings.TrimSpace(c.Profile))
	c.Version = strings.TrimSpace(c.Version)
	if normalized, err := NormalizeClientIdentityPlatform(c.Platform); err != nil {
		return err
	} else {
		c.Platform = normalized
	}

	if c.Profile == "" {
		c.Profile = defaults.Profile
	}
	expectedClientType := clientIdentityClientTypeForProfile(c.Profile)
	if expectedClientType == "" {
		return fmt.Errorf("invalid client identity profile: %s", c.Profile)
	}
	if c.ClientType == "" {
		if c.Profile == defaults.Profile {
			c.ClientType = defaults.ClientType
		} else {
			c.ClientType = expectedClientType
		}
	}
	if c.ClientType != expectedClientType {
		return fmt.Errorf("client identity client_type %s does not match profile %s", c.ClientType, c.Profile)
	}
	if !clientIdentityProfileAllowedForChannel(c.Profile, channelType, defaults.Profile) {
		return fmt.Errorf("client identity profile %s is not supported for channel type %d", c.Profile, channelType)
	}
	if c.Context1MEnabled && c.Profile != ClientIdentityProfileClaudeCode {
		return fmt.Errorf("client identity context_1m_enabled requires claude_code profile")
	}
	if c.Profile == ClientIdentityProfileNone {
		if c.Version != "" || c.Platform != "" || c.Source != nil {
			return fmt.Errorf("client identity version, platform, and source require a client profile")
		}
	}
	if err := validateClientIdentityVersion(c.Profile, c.Version); err != nil {
		return err
	}
	if err := validateClientIdentityNPMVersionForPlatform(c.Profile, c.Version, c.Platform); err != nil {
		return err
	}
	if c.Source != nil {
		if c.Source.isEmpty() {
			c.Source = nil
		} else {
			c.Source.Kind = strings.ToLower(strings.TrimSpace(c.Source.Kind))
			c.Source.Package = strings.TrimSpace(c.Source.Package)
			if normalized, err := NormalizeClientIdentityPlatform(c.Source.Platform); err != nil {
				return fmt.Errorf("invalid client identity source platform: %w", err)
			} else {
				c.Source.Platform = normalized
			}
			if c.Source.CheckedAt < 0 {
				return fmt.Errorf("client identity source checked_at cannot be negative")
			}
			if !isClientIdentitySourceKind(c.Source.Kind) {
				return fmt.Errorf("invalid client identity source kind: %s", c.Source.Kind)
			}
			if c.Source.Kind == ClientIdentitySourceNPM || c.Source.Kind == ClientIdentitySourceWorkBuddy {
				sourceKind, sourcePackage, err := ClientIdentitySourceForProfile(c.Profile)
				if err != nil {
					return err
				}
				if c.Source.Kind != sourceKind {
					return fmt.Errorf("invalid client identity source kind: %s", c.Source.Kind)
				}
				if sourcePackage != "" && c.Source.Package != sourcePackage {
					return fmt.Errorf("invalid client identity source package: %s", c.Source.Package)
				}
				if sourcePackage == "" && c.Source.Package != "" {
					return fmt.Errorf("client identity source package is not allowed for %s", c.Profile)
				}
			}
			if c.Source.Platform != "" && c.Platform != "" && c.Source.Platform != c.Platform {
				return fmt.Errorf("client identity source platform does not match platform")
			}
		}
	}
	return nil
}

func clientIdentityProfileAllowedForChannel(profile string, channelType int, defaultProfile string) bool {
	if channelType == ClientIdentityChannelTypeOpenAI || channelType == ClientIdentityChannelTypeAnthropic {
		switch profile {
		case ClientIdentityProfileNone,
			ClientIdentityProfileCodexCLI,
			ClientIdentityProfileClaudeCLI,
			ClientIdentityProfileCodeBuddyCLI,
			ClientIdentityProfileWorkBuddyDesktop:
			return true
		default:
			return false
		}
	}
	return profile == defaultProfile
}

func isClientIdentitySourceKind(kind string) bool {
	switch kind {
	case ClientIdentitySourceNPM,
		ClientIdentitySourceWorkBuddy,
		ClientIdentitySourceManual,
		ClientIdentitySourceOfficial,
		ClientIdentitySourceCommunity:
		return true
	default:
		return false
	}
}

// Validate checks the complete persisted contract without modifying the
// caller's value.
func (c ClientIdentityConfig) Validate(channelType int) error {
	copy := c
	if c.Source != nil {
		sourceCopy := *c.Source
		copy.Source = &sourceCopy
	}
	return copy.Normalize(channelType)
}

// ClientIdentitySourceForProfile returns the only official source allowed for
// a profile. CodeBuddy deliberately resolves the WorkBuddy product endpoint.
func ClientIdentitySourceForProfile(profile string) (kind string, name string, err error) {
	profile, err = NormalizeClientIdentityProfile(profile)
	if err != nil {
		return "", "", err
	}
	switch profile {
	case ClientIdentityProfileNone,
		ClientIdentityProfileCodeBuddyCLI,
		ClientIdentityProfileWorkBuddyDesktop:
		return ClientIdentitySourceManual, "", nil
	case ClientIdentityProfileCodexCLI:
		return ClientIdentitySourceNPM, ClientIdentityNPMCodexPackage, nil
	case ClientIdentityProfileClaudeCLI:
		return ClientIdentitySourceNPM, ClientIdentityNPMClaudeCodePackage, nil
	case ClientIdentityProfileCodexLegacy, ClientIdentityProfileCodexCompatibility:
		return ClientIdentitySourceNPM, ClientIdentityNPMCodexPackage, nil
	case ClientIdentityProfileClaudeCode:
		return ClientIdentitySourceNPM, ClientIdentityNPMClaudeCodePackage, nil
	case ClientIdentityProfileCodeBuddy:
		return ClientIdentitySourceWorkBuddy, "", nil
	default:
		return "", "", fmt.Errorf("unsupported client identity profile: %s", profile)
	}
}

// ValidateHTTPTransport validates save-time HTTP transport channel settings.
func (s *ChannelSettings) ValidateHTTPTransport() error {
	if s == nil {
		return nil
	}
	protocol := strings.ToLower(strings.TrimSpace(s.HTTPProtocol))
	switch protocol {
	case "", HTTPProtocolAuto, HTTPProtocolHTTP1:
	default:
		return fmt.Errorf("invalid http_protocol: %s", s.HTTPProtocol)
	}
	if s.HTTP2ConnectionShards < 0 || s.HTTP2ConnectionShards > MaxHTTP2ConnectionShards {
		return fmt.Errorf("invalid http2_connection_shards: %d", s.HTTP2ConnectionShards)
	}
	if protocol == HTTPProtocolHTTP1 && s.HTTP2ConnectionShards > 1 {
		return fmt.Errorf("http2_connection_shards must be 1 when http_protocol is http1")
	}
	return nil
}

type VertexKeyType string

const (
	VertexKeyTypeJSON   VertexKeyType = "json"
	VertexKeyTypeAPIKey VertexKeyType = "api_key"
)

type AwsKeyType string

const (
	AwsKeyTypeAKSK   AwsKeyType = "ak_sk" // 默认
	AwsKeyTypeApiKey AwsKeyType = "api_key"
)

type ChannelOtherSettings struct {
	ClientIdentity                        *ClientIdentityConfig `json:"client_identity,omitempty"`
	AzureResponsesVersion                 string                `json:"azure_responses_version,omitempty"`
	VertexKeyType                         VertexKeyType         `json:"vertex_key_type,omitempty"` // "json" or "api_key"
	OpenRouterEnterprise                  *bool                 `json:"openrouter_enterprise,omitempty"`
	ClaudeBetaQuery                       bool                  `json:"claude_beta_query,omitempty"`          // Claude 渠道是否强制追加 ?beta=true
	AllowServiceTier                      bool                  `json:"allow_service_tier,omitempty"`         // 是否允许 service_tier 透传（默认过滤以避免额外计费）
	AllowInferenceGeo                     bool                  `json:"allow_inference_geo,omitempty"`        // 是否允许 inference_geo 透传（仅 Claude，默认过滤以满足数据驻留合规
	AllowSpeed                            bool                  `json:"allow_speed,omitempty"`                // 是否允许 speed 透传（仅 Claude，默认过滤以避免意外切换推理速度模式）
	AllowSafetyIdentifier                 bool                  `json:"allow_safety_identifier,omitempty"`    // 是否允许 safety_identifier 透传（默认过滤以保护用户隐私）
	DisableStore                          bool                  `json:"disable_store,omitempty"`              // 是否禁用 store 透传（默认允许透传，禁用后可能导致 Codex 无法使用）
	AllowIncludeObfuscation               bool                  `json:"allow_include_obfuscation,omitempty"`  // 是否允许 stream_options.include_obfuscation 透传（默认过滤以避免关闭流混淆保护）
	DisableTaskPollingSleep               bool                  `json:"disable_task_polling_sleep,omitempty"` // 是否跳过异步任务轮询间隔
	AwsKeyType                            AwsKeyType            `json:"aws_key_type,omitempty"`
	UpstreamModelUpdateCheckEnabled       bool                  `json:"upstream_model_update_check_enabled,omitempty"`        // 是否检测上游模型更新
	UpstreamModelUpdateAutoSyncEnabled    bool                  `json:"upstream_model_update_auto_sync_enabled,omitempty"`    // 是否自动同步上游模型更新
	UpstreamModelUpdateLastCheckTime      int64                 `json:"upstream_model_update_last_check_time,omitempty"`      // 上次检测时间
	UpstreamModelUpdateLastDetectedModels []string              `json:"upstream_model_update_last_detected_models,omitempty"` // 上次检测到的可加入模型
	UpstreamModelUpdateLastRemovedModels  []string              `json:"upstream_model_update_last_removed_models,omitempty"`  // 上次检测到的可删除模型
	UpstreamModelUpdateIgnoredModels      []string              `json:"upstream_model_update_ignored_models,omitempty"`       // 手动忽略的模型
	AdvancedCustom                        *AdvancedCustomConfig `json:"advanced_custom,omitempty"`
}

func (s *ChannelOtherSettings) IsOpenRouterEnterprise() bool {
	if s == nil || s.OpenRouterEnterprise == nil {
		return false
	}
	return *s.OpenRouterEnterprise
}

const (
	advancedCustomConverterNone                        = "none"
	advancedCustomConverterClaudeMessagesToOpenAIChat  = "anthropic_messages_to_openai_chat_completions"
	advancedCustomConverterOpenAIChatToClaudeMessages  = "openai_chat_completions_to_anthropic_messages"
	advancedCustomConverterOpenAIChatToOpenAIResponses = "openai_chat_completions_to_openai_responses"
	advancedCustomConverterOpenAIResponsesToOpenAIChat = "openai_responses_to_openai_chat_completions"
	advancedCustomConverterOpenAIResponsesToGemini     = "openai_responses_to_gemini_generate_content"
	advancedCustomConverterGeminiContentToOpenAIChat   = "gemini_generate_content_to_openai_chat_completions"
	advancedCustomConverterOpenAIChatToGeminiContent   = "openai_chat_completions_to_gemini_generate_content"
)

const (
	AdvancedCustomAuthTypeNone   = "none"
	AdvancedCustomAuthTypeHeader = "header"
	AdvancedCustomAuthTypeQuery  = "query"
)

type AdvancedCustomConfig struct {
	Routes []AdvancedCustomRoute `json:"advanced_routes,omitempty"`
}

type AdvancedCustomRoute struct {
	IncomingPath string                   `json:"incoming_path,omitempty"`
	UpstreamPath string                   `json:"upstream_path,omitempty"`
	Converter    string                   `json:"converter,omitempty"`
	Models       []string                 `json:"models,omitempty"`
	Auth         *AdvancedCustomRouteAuth `json:"auth,omitempty"`
}

type AdvancedCustomRouteAuth struct {
	Type  string `json:"type,omitempty"`
	Name  string `json:"name,omitempty"`
	Value string `json:"value,omitempty"`
}

const (
	advancedCustomModelPlaceholder = "{model}"
	advancedCustomModelRegexPrefix = "re:"
)

const (
	advancedCustomEndpointPathOpenAIChat             = "/v1/chat/completions"
	advancedCustomEndpointPathOpenAIResponses        = "/v1/responses"
	advancedCustomEndpointPathOpenAIResponsesCompact = "/v1/responses/compact"
	advancedCustomEndpointPathOpenAIAlphaSearch      = "/v1/alpha/search"
	advancedCustomEndpointPathClaudeMessages         = "/v1/messages"
	advancedCustomEndpointPathJinaRerank             = "/v1/rerank"
	advancedCustomEndpointPathImageGeneration        = "/v1/images/generations"
	advancedCustomEndpointPathEmbeddings             = "/v1/embeddings"
)

// AdvancedCustomModelListPath identifies the optional OpenAI Models discovery route.
const AdvancedCustomModelListPath = "/v1/models"

// MatchPath returns the first route whose IncomingPath matches requestPath.
// Matching mirrors the relay adaptor: exact match, {model} placeholder, and
// :generateContent <-> :streamGenerateContent equivalence.
func (c *AdvancedCustomConfig) MatchPath(requestPath string) (AdvancedCustomRoute, bool) {
	if c == nil {
		return AdvancedCustomRoute{}, false
	}
	for _, route := range c.Routes {
		if matchAdvancedCustomIncomingPath(strings.TrimSpace(route.IncomingPath), requestPath) {
			return route, true
		}
	}
	return AdvancedCustomRoute{}, false
}

// MatchPathForModel returns the first route whose IncomingPath and Models match.
// An empty Models list is a catch-all fallback for that incoming path.
func (c *AdvancedCustomConfig) MatchPathForModel(requestPath string, model string) (AdvancedCustomRoute, bool) {
	if c == nil {
		return AdvancedCustomRoute{}, false
	}
	model = strings.TrimSpace(model)
	for _, route := range c.Routes {
		if matchAdvancedCustomIncomingPath(strings.TrimSpace(route.IncomingPath), requestPath) &&
			matchAdvancedCustomRouteModel(route.Models, model) {
			return route, true
		}
	}
	return AdvancedCustomRoute{}, false
}

// ModelListRoute returns the explicitly configured OpenAI Models discovery route.
// Template routes that merely happen to match /v1/models are not discovery routes.
func (c *AdvancedCustomConfig) ModelListRoute() (AdvancedCustomRoute, bool) {
	if c == nil {
		return AdvancedCustomRoute{}, false
	}
	for _, route := range c.Routes {
		if strings.TrimSpace(route.IncomingPath) == AdvancedCustomModelListPath {
			return route, true
		}
	}
	return AdvancedCustomRoute{}, false
}

// SupportsPath reports whether any route matches requestPath.
func (c *AdvancedCustomConfig) SupportsPath(requestPath string) bool {
	_, ok := c.MatchPath(requestPath)
	return ok
}

// SupportsPathForModel reports whether any route matches requestPath and model.
func (c *AdvancedCustomConfig) SupportsPathForModel(requestPath string, model string) bool {
	_, ok := c.MatchPathForModel(requestPath, model)
	return ok
}

func (c *AdvancedCustomConfig) SupportedEndpointTypesForModel(model string) []types.EndpointType {
	if c == nil {
		return nil
	}
	model = strings.TrimSpace(model)
	endpoints := make([]types.EndpointType, 0, len(c.Routes))
	seen := make(map[types.EndpointType]struct{}, len(c.Routes))
	for _, route := range c.Routes {
		if !matchAdvancedCustomRouteModel(route.Models, model) {
			continue
		}
		endpointType, ok := advancedCustomEndpointTypeFromIncomingPath(strings.TrimSpace(route.IncomingPath))
		if !ok {
			continue
		}
		if _, exists := seen[endpointType]; exists {
			continue
		}
		seen[endpointType] = struct{}{}
		endpoints = append(endpoints, endpointType)
	}
	return endpoints
}

func advancedCustomEndpointTypeFromIncomingPath(incomingPath string) (types.EndpointType, bool) {
	switch incomingPath {
	case advancedCustomEndpointPathOpenAIChat:
		return types.EndpointTypeOpenAI, true
	case advancedCustomEndpointPathOpenAIResponses:
		return types.EndpointTypeOpenAIResponse, true
	case advancedCustomEndpointPathOpenAIResponsesCompact:
		return types.EndpointTypeOpenAIResponseCompact, true
	case advancedCustomEndpointPathOpenAIAlphaSearch:
		return types.EndpointTypeOpenAIAlphaSearch, true
	case advancedCustomEndpointPathClaudeMessages:
		return types.EndpointTypeAnthropic, true
	case advancedCustomEndpointPathJinaRerank:
		return types.EndpointTypeJinaRerank, true
	case advancedCustomEndpointPathImageGeneration:
		return types.EndpointTypeImageGeneration, true
	case advancedCustomEndpointPathEmbeddings:
		return types.EndpointTypeEmbeddings, true
	default:
		if isAdvancedCustomGeminiIncomingPath(incomingPath) {
			return types.EndpointTypeGemini, true
		}
		return "", false
	}
}

func isAdvancedCustomGeminiIncomingPath(incomingPath string) bool {
	if !strings.HasPrefix(incomingPath, "/v1beta/models/") {
		return false
	}
	return strings.Contains(incomingPath, ":generateContent") || strings.Contains(incomingPath, ":streamGenerateContent")
}

func matchAdvancedCustomRouteModel(models []string, model string) bool {
	normalizedModels := normalizeAdvancedCustomRouteModels(models)
	if len(normalizedModels) == 0 {
		return true
	}
	for _, allowedModel := range normalizedModels {
		if matchAdvancedCustomRouteModelRule(allowedModel, model) {
			return true
		}
	}
	return false
}

// advancedCustomModelRegexCache caches compiled route model patterns. Route model
// matching runs on the request hot path (distributor affinity, ability filtering,
// channel cache filtering, adaptor resolve), so patterns must not be recompiled per
// request. Invalid patterns are cached as nil to avoid recompiling them as well.
var advancedCustomModelRegexCache sync.Map // pattern string -> *regexp.Regexp (nil when invalid)

func compileAdvancedCustomModelRegex(pattern string) *regexp.Regexp {
	if cached, ok := advancedCustomModelRegexCache.Load(pattern); ok {
		re, _ := cached.(*regexp.Regexp)
		return re
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		re = nil
	}
	advancedCustomModelRegexCache.Store(pattern, re)
	return re
}

func matchAdvancedCustomRouteModelRule(rule string, model string) bool {
	if !strings.HasPrefix(rule, advancedCustomModelRegexPrefix) {
		return rule == model
	}
	pattern := strings.TrimPrefix(rule, advancedCustomModelRegexPrefix)
	if pattern == "" {
		return false
	}
	re := compileAdvancedCustomModelRegex(pattern)
	return re != nil && re.MatchString(model)
}

func matchAdvancedCustomIncomingPath(configuredPath string, requestPath string) bool {
	if matchAdvancedCustomIncomingPathTemplate(configuredPath, requestPath) {
		return true
	}
	if strings.Contains(configuredPath, ":generateContent") {
		streamPath := strings.Replace(configuredPath, ":generateContent", ":streamGenerateContent", 1)
		return matchAdvancedCustomIncomingPathTemplate(streamPath, requestPath)
	}
	return false
}

func matchAdvancedCustomIncomingPathTemplate(configuredPath string, requestPath string) bool {
	if !strings.Contains(configuredPath, advancedCustomModelPlaceholder) {
		return configuredPath == requestPath
	}

	parts := strings.Split(configuredPath, advancedCustomModelPlaceholder)
	if len(parts) != 2 {
		return false
	}
	if !strings.HasPrefix(requestPath, parts[0]) || !strings.HasSuffix(requestPath, parts[1]) {
		return false
	}

	model := strings.TrimSuffix(strings.TrimPrefix(requestPath, parts[0]), parts[1])
	return model != "" && !strings.Contains(model, "/")
}

func IsAdvancedCustomConverterAllowed(converter string) bool {
	switch converter {
	case advancedCustomConverterNone,
		advancedCustomConverterClaudeMessagesToOpenAIChat,
		advancedCustomConverterOpenAIChatToClaudeMessages,
		advancedCustomConverterOpenAIChatToOpenAIResponses,
		advancedCustomConverterOpenAIResponsesToOpenAIChat,
		advancedCustomConverterOpenAIResponsesToGemini,
		advancedCustomConverterGeminiContentToOpenAIChat,
		advancedCustomConverterOpenAIChatToGeminiContent:
		return true
	default:
		return false
	}
}

func (c *AdvancedCustomConfig) Validate() error {
	if c == nil {
		return fmt.Errorf("advanced_custom is required")
	}
	if len(c.Routes) == 0 {
		return fmt.Errorf("advanced_custom requires at least one route")
	}

	paths := make(map[string]*advancedCustomPathModelState, len(c.Routes))
	modelListRouteIndex := -1
	for i := range c.Routes {
		route := c.Routes[i]
		route.IncomingPath = strings.TrimSpace(route.IncomingPath)
		upstreamPath := strings.TrimSpace(route.UpstreamPath)
		route.Converter = strings.TrimSpace(route.Converter)
		if route.Converter == "" {
			route.Converter = advancedCustomConverterNone
		}

		if route.IncomingPath == "" {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].incoming_path is required", i)
		}
		if !strings.HasPrefix(route.IncomingPath, "/") {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].incoming_path must start with /", i)
		}
		if strings.Contains(route.IncomingPath, "?") {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].incoming_path must not include query", i)
		}
		if route.IncomingPath == AdvancedCustomModelListPath {
			if modelListRouteIndex >= 0 {
				return fmt.Errorf("advanced_custom.advanced_routes[%d] duplicates the /v1/models route at advanced_routes[%d]", i, modelListRouteIndex)
			}
			modelListRouteIndex = i
			if len(normalizeAdvancedCustomRouteModels(route.Models)) > 0 {
				return fmt.Errorf("advanced_custom.advanced_routes[%d].models must be empty for /v1/models", i)
			}
			if route.Converter != advancedCustomConverterNone {
				return fmt.Errorf("advanced_custom.advanced_routes[%d].converter must be none for /v1/models", i)
			}
			if strings.Contains(upstreamPath, advancedCustomModelPlaceholder) {
				return fmt.Errorf("advanced_custom.advanced_routes[%d].upstream_path must not contain %s for /v1/models", i, advancedCustomModelPlaceholder)
			}
		}
		if err := validateAdvancedCustomRouteModels(i, route.IncomingPath, route.Models, paths); err != nil {
			return err
		}

		if upstreamPath == "" {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].upstream_path is required", i)
		}
		if err := validateAdvancedCustomUpstreamTarget(i, upstreamPath); err != nil {
			return err
		}

		if !IsAdvancedCustomConverterAllowed(route.Converter) {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].converter is not registered: %s", i, route.Converter)
		}
		if err := validateAdvancedCustomConverterPath(i, route.IncomingPath, route.Converter); err != nil {
			return err
		}
		if err := validateAdvancedCustomRouteAuth(i, route.Auth); err != nil {
			return err
		}
	}

	return nil
}

type advancedCustomPathModelState struct {
	catchAllIndex int
	modelIndexes  map[string]int
}

func validateAdvancedCustomRouteModels(index int, incomingPath string, models []string, paths map[string]*advancedCustomPathModelState) error {
	state := paths[incomingPath]
	if state == nil {
		state = &advancedCustomPathModelState{
			catchAllIndex: -1,
			modelIndexes:  make(map[string]int),
		}
		paths[incomingPath] = state
	}

	normalizedModels := normalizeAdvancedCustomRouteModels(models)
	if len(normalizedModels) == 0 {
		if state.catchAllIndex >= 0 {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].models catch-all already exists for incoming_path: %s", index, incomingPath)
		}
		state.catchAllIndex = index
		return nil
	}

	if state.catchAllIndex >= 0 {
		return fmt.Errorf("advanced_custom.advanced_routes[%d].models catch-all route must be last for incoming_path: %s", index, incomingPath)
	}

	seenInRoute := make(map[string]struct{}, len(normalizedModels))
	for _, model := range normalizedModels {
		if err := validateAdvancedCustomRouteModelRule(index, incomingPath, model); err != nil {
			return err
		}
		if _, exists := seenInRoute[model]; exists {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].models contains duplicate model for incoming_path %s: %s", index, incomingPath, model)
		}
		seenInRoute[model] = struct{}{}
		if existingIndex, exists := state.modelIndexes[model]; exists {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].models overlaps with advanced_routes[%d] for incoming_path %s: %s", index, existingIndex, incomingPath, model)
		}
		state.modelIndexes[model] = index
	}
	return nil
}

func validateAdvancedCustomRouteModelRule(index int, incomingPath string, model string) error {
	if !strings.HasPrefix(model, advancedCustomModelRegexPrefix) {
		return nil
	}
	pattern := strings.TrimPrefix(model, advancedCustomModelRegexPrefix)
	if pattern == "" {
		return fmt.Errorf("advanced_custom.advanced_routes[%d].models regex is empty for incoming_path %s: %s", index, incomingPath, model)
	}
	if _, err := regexp.Compile(pattern); err != nil {
		return fmt.Errorf("advanced_custom.advanced_routes[%d].models regex is invalid for incoming_path %s: %s", index, incomingPath, model)
	}
	return nil
}

func normalizeAdvancedCustomRouteModels(models []string) []string {
	if len(models) == 0 {
		return nil
	}
	normalized := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model != "" {
			normalized = append(normalized, model)
		}
	}
	return normalized
}

func validateAdvancedCustomUpstreamTarget(index int, upstreamPath string) error {
	if strings.HasPrefix(upstreamPath, "/") {
		if strings.HasPrefix(upstreamPath, "//") {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].upstream_path must be a full URL or a path starting with /", index)
		}
		return nil
	}

	parsedURL, err := url.Parse(upstreamPath)
	if err != nil || parsedURL.Scheme == "" || parsedURL.Host == "" {
		return fmt.Errorf("advanced_custom.advanced_routes[%d].upstream_path must be a full URL or a path starting with /", index)
	}
	if !strings.EqualFold(parsedURL.Scheme, "http") && !strings.EqualFold(parsedURL.Scheme, "https") {
		return fmt.Errorf("advanced_custom.advanced_routes[%d].upstream_path must use http or https", index)
	}
	return nil
}

func validateAdvancedCustomConverterPath(index int, incomingPath string, converter string) error {
	if incomingPath == advancedCustomEndpointPathOpenAIAlphaSearch {
		if converter == advancedCustomConverterNone {
			return nil
		}
		return fmt.Errorf("advanced_custom.advanced_routes[%d].converter does not match incoming_path: %s", index, converter)
	}
	switch converter {
	case advancedCustomConverterNone:
		return nil
	case advancedCustomConverterClaudeMessagesToOpenAIChat:
		if incomingPath == "/v1/messages" {
			return nil
		}
	case advancedCustomConverterOpenAIChatToClaudeMessages,
		advancedCustomConverterOpenAIChatToOpenAIResponses,
		advancedCustomConverterOpenAIChatToGeminiContent:
		if incomingPath == "/v1/chat/completions" {
			return nil
		}
	case advancedCustomConverterOpenAIResponsesToOpenAIChat:
		if incomingPath == "/v1/responses" {
			return nil
		}
	case advancedCustomConverterOpenAIResponsesToGemini:
		if incomingPath == "/v1/responses" {
			return nil
		}
	case advancedCustomConverterGeminiContentToOpenAIChat:
		if strings.Contains(incomingPath, ":generateContent") || strings.Contains(incomingPath, ":streamGenerateContent") {
			return nil
		}
	}
	return fmt.Errorf("advanced_custom.advanced_routes[%d].converter does not match incoming_path: %s", index, converter)
}

func validateAdvancedCustomRouteAuth(index int, auth *AdvancedCustomRouteAuth) error {
	if auth == nil {
		return nil
	}
	authType := strings.TrimSpace(auth.Type)
	switch authType {
	case AdvancedCustomAuthTypeNone:
		return nil
	case AdvancedCustomAuthTypeHeader, AdvancedCustomAuthTypeQuery:
		if strings.TrimSpace(auth.Name) == "" {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].auth.name is required", index)
		}
		if strings.TrimSpace(auth.Value) == "" {
			return fmt.Errorf("advanced_custom.advanced_routes[%d].auth.value is required", index)
		}
		return nil
	default:
		return fmt.Errorf("advanced_custom.advanced_routes[%d].auth.type is invalid: %s", index, auth.Type)
	}
}

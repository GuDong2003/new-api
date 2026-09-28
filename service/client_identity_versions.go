package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/bytedance/gopkg/util/gopool"
)

const (
	defaultNPMRegistryURL      = "https://registry.npmjs.org"
	defaultWorkBuddyUpdateURL  = "https://www.codebuddy.cn/v2/update"
	clientIdentityVersionTTL   = 24 * time.Hour
	clientIdentityRequestLimit = 10 * time.Second
	clientIdentityMaxBodyBytes = 8 << 20
	clientIdentityMaxVersions  = 64
	// clientIdentityCheckRetry is how long a source that did not answer is
	// left alone before it is asked again, whether or not a version checked
	// before is cached.
	clientIdentityCheckRetry = 10 * time.Minute
)

// ClientIdentityVersionServiceOptions is intentionally limited to testable
// source/client settings. Production callers use the fixed official URLs.
type ClientIdentityVersionServiceOptions struct {
	HTTPClient         *http.Client
	NPMRegistryURL     string
	WorkBuddyUpdateURL string
	CacheTTL           time.Duration
	RequestTimeout     time.Duration
	MaxBodyBytes       int64
	Now                func() time.Time
	// BackgroundChecks lets LatestVersion check the official source by
	// itself. The shared service turns it on when the gateway starts.
	BackgroundChecks bool
}

type clientIdentityVersionCacheEntry struct {
	lookup    ClientIdentityVersionLookup
	expiresAt time.Time
}

// ClientIdentityVersionLookup contains only validated official version data.
// Cached and stale flags let an admin distinguish an old safe value from a
// successful refresh without exposing upstream response bodies.
type ClientIdentityVersionLookup struct {
	ClientType string                           `json:"client_type"`
	Profile    string                           `json:"profile"`
	Platform   string                           `json:"platform,omitempty"`
	Versions   []string                         `json:"versions"`
	Latest     string                           `json:"latest"`
	Source     dto.ClientIdentitySourceMetadata `json:"source"`
	Cached     bool                             `json:"cached"`
	Stale      bool                             `json:"stale"`
}

// ClientIdentityVersionRefreshSummary describes one scheduled refresh pass.
// Failed entries keep their previous cached value and are counted separately
// so a temporary upstream outage does not make the whole task unusable.
type ClientIdentityVersionRefreshSummary struct {
	Checked   int `json:"checked"`
	Refreshed int `json:"refreshed"`
	Failed    int `json:"failed"`
}

type ClientIdentityVersionService struct {
	client         *http.Client
	npmRegistryURL string
	workBuddyURL   string
	cacheTTL       time.Duration
	requestTimeout time.Duration
	maxBodyBytes   int64
	now            func() time.Time

	mu               sync.Mutex
	cache            map[string]clientIdentityVersionCacheEntry
	backgroundChecks bool
	checking         map[string]struct{}
	retryAt          map[string]time.Time
	// background tracks the checks LatestVersion starts, so tests can wait
	// for them.
	background sync.WaitGroup
}

func NewClientIdentityVersionService(options ClientIdentityVersionServiceOptions) *ClientIdentityVersionService {
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	npmRegistryURL := strings.TrimRight(strings.TrimSpace(options.NPMRegistryURL), "/")
	if npmRegistryURL == "" {
		npmRegistryURL = defaultNPMRegistryURL
	}
	workBuddyURL := strings.TrimSpace(options.WorkBuddyUpdateURL)
	if workBuddyURL == "" {
		workBuddyURL = defaultWorkBuddyUpdateURL
	}
	cacheTTL := options.CacheTTL
	if cacheTTL <= 0 {
		cacheTTL = clientIdentityVersionTTL
	}
	requestTimeout := options.RequestTimeout
	if requestTimeout <= 0 {
		requestTimeout = clientIdentityRequestLimit
	}
	maxBodyBytes := options.MaxBodyBytes
	if maxBodyBytes <= 0 {
		maxBodyBytes = clientIdentityMaxBodyBytes
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &ClientIdentityVersionService{
		client:           client,
		npmRegistryURL:   npmRegistryURL,
		workBuddyURL:     workBuddyURL,
		cacheTTL:         cacheTTL,
		requestTimeout:   requestTimeout,
		maxBodyBytes:     maxBodyBytes,
		now:              now,
		cache:            make(map[string]clientIdentityVersionCacheEntry),
		backgroundChecks: options.BackgroundChecks,
		checking:         make(map[string]struct{}),
		retryAt:          make(map[string]time.Time),
	}
}

var defaultClientIdentityVersionService = NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{})

func GetClientIdentityVersions(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	return defaultClientIdentityVersionService.ListVersions(ctx, profile, platform)
}

func RefreshClientIdentityVersions(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	return defaultClientIdentityVersionService.RefreshVersions(ctx, profile, platform)
}

func HasDueCachedClientIdentityVersions() bool {
	return defaultClientIdentityVersionService.HasDueVersions()
}

func RefreshCachedClientIdentityVersions(ctx context.Context) (ClientIdentityVersionRefreshSummary, error) {
	return defaultClientIdentityVersionService.RefreshCachedVersions(ctx)
}

// LatestClientIdentityVersion returns the newest official version the gateway
// has checked for a client profile and platform, or "" when none is known
// yet. It never waits on the official source.
func LatestClientIdentityVersion(profile, platform string) string {
	return defaultClientIdentityVersionService.LatestVersion(profile, platform)
}

// StartClientIdentityVersionChecks lets client identities without a pinned
// version follow the latest official client version. It also checks the
// versions that enabled channels follow, so their first requests after a
// restart do not fall back to the built-in versions.
func StartClientIdentityVersionChecks() {
	versions := defaultClientIdentityVersionService
	versions.mu.Lock()
	versions.backgroundChecks = true
	versions.mu.Unlock()
	gopool.Go(versions.checkChannelVersions)
}

// checkChannelVersions starts a background check for each version that an
// enabled channel follows. A channel follows the latest version when its
// client identity, or the default identity of its type, pins no version.
// Codex channels send no client identity until one is saved.
func (s *ClientIdentityVersionService) checkChannelVersions() {
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		common.SysError("failed to load channels for client identity version checks: " + err.Error())
		return
	}
	for _, channel := range channels {
		if channel.Status != common.ChannelStatusEnabled || !dto.SupportsClientIdentityChannelType(channel.Type) {
			continue
		}
		identity := dto.DefaultClientIdentityConfig(channel.Type)
		if settings := channel.GetOtherSettings(); settings.ClientIdentity != nil && !settings.ClientIdentity.IsZero() {
			identity = *settings.ClientIdentity
		} else if channel.Type == constant.ChannelTypeCodex {
			continue
		}
		if identity.Normalize(channel.Type) != nil || identity.Version != "" {
			continue
		}
		s.LatestVersion(identity.Profile, identity.Platform)
	}
}

func (s *ClientIdentityVersionService) HasDueVersions() bool {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.cache {
		if !now.Before(entry.expiresAt) {
			return true
		}
	}
	return false
}

// RefreshCachedVersions refreshes only profiles/platforms that have already
// been looked up. This keeps the daily task quiet for unused client types while
// ensuring actively configured clients are checked once per day.
func (s *ClientIdentityVersionService) RefreshCachedVersions(ctx context.Context) (ClientIdentityVersionRefreshSummary, error) {
	s.mu.Lock()
	keys := make([]string, 0, len(s.cache))
	for key := range s.cache {
		keys = append(keys, key)
	}
	s.mu.Unlock()
	sort.Strings(keys)

	var summary ClientIdentityVersionRefreshSummary
	for _, key := range keys {
		if ctx != nil {
			select {
			case <-ctx.Done():
				return summary, ctx.Err()
			default:
			}
		}

		parts := strings.SplitN(key, "|", 2)
		if len(parts) != 2 {
			continue
		}
		summary.Checked++
		if _, err := s.lookup(ctx, parts[0], parts[1], true); err != nil {
			summary.Failed++
			continue
		}
		summary.Refreshed++
	}
	return summary, nil
}

func (s *ClientIdentityVersionService) ListVersions(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	return s.lookup(ctx, profile, platform, false)
}

func (s *ClientIdentityVersionService) RefreshVersions(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	return s.lookup(ctx, profile, platform, true)
}

// LatestVersion returns the newest official version already checked for a
// profile and platform, or "" when none is known. It never waits on the
// official source. With background checks on, a version that was never
// checked, or was checked a cache period ago, starts one check, and later
// calls return its result; until then a day-old version is still returned.
func (s *ClientIdentityVersionService) LatestVersion(profile, platform string) string {
	profile, err := dto.NormalizeClientIdentityProfile(profile)
	if err != nil {
		return ""
	}
	platform, err = dto.NormalizeClientIdentityPlatform(platform)
	if err != nil {
		return ""
	}
	kind, _, err := dto.ClientIdentitySourceForProfile(profile)
	if err != nil || (kind != dto.ClientIdentitySourceNPM && kind != dto.ClientIdentitySourceWorkBuddy) {
		return ""
	}
	if profile == dto.ClientIdentityProfileCodeBuddy {
		if _, err := dto.WorkBuddyUpdatePlatform(platform); err != nil {
			return ""
		}
	}

	key := profile + "|" + platform
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, cached := s.cache[key]
	_, checking := s.checking[key]
	due := !cached || !now.Before(entry.expiresAt)
	if s.backgroundChecks && due && !checking && !now.Before(s.retryAt[key]) {
		s.checking[key] = struct{}{}
		s.background.Go(func() {
			_, err := s.lookup(context.Background(), profile, platform, false)
			if err != nil {
				common.SysError(fmt.Sprintf("failed to check client identity version: profile=%s platform=%s err=%v", profile, platform, err))
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			delete(s.checking, key)
			if err != nil {
				s.retryAt[key] = s.now().Add(clientIdentityCheckRetry)
				return
			}
			delete(s.retryAt, key)
		})
	}
	return entry.lookup.Latest
}

func (s *ClientIdentityVersionService) lookup(ctx context.Context, profile, platform string, forceRefresh bool) (ClientIdentityVersionLookup, error) {
	profile, err := dto.NormalizeClientIdentityProfile(profile)
	if err != nil {
		return ClientIdentityVersionLookup{}, err
	}
	platform, err = dto.NormalizeClientIdentityPlatform(platform)
	if err != nil {
		return ClientIdentityVersionLookup{}, err
	}
	if profile == dto.ClientIdentityProfileCodeBuddy {
		if _, err := dto.WorkBuddyUpdatePlatform(platform); err != nil {
			return ClientIdentityVersionLookup{}, err
		}
	}
	key := profile + "|" + platform
	now := s.now()

	s.mu.Lock()
	entry, cached := s.cache[key]
	s.mu.Unlock()
	if !forceRefresh && cached && now.Before(entry.expiresAt) {
		lookup := cloneClientIdentityVersionLookup(entry.lookup)
		lookup.Cached = true
		return lookup, nil
	}

	lookup, err := s.fetch(ctx, profile, platform)
	if err == nil {
		lookup.Cached = false
		lookup.Stale = false
		s.mu.Lock()
		s.cache[key] = clientIdentityVersionCacheEntry{
			lookup:    cloneClientIdentityVersionLookup(lookup),
			expiresAt: now.Add(s.cacheTTL),
		}
		s.mu.Unlock()
		return lookup, nil
	}

	if cached && len(entry.lookup.Versions) > 0 {
		fallback := cloneClientIdentityVersionLookup(entry.lookup)
		fallback.Cached = true
		fallback.Stale = true
		// Avoid retrying the same unavailable upstream on every subsequent
		// request. The next normal lookup, and the next request following this
		// version, try again after clientIdentityCheckRetry, while an explicit
		// refresh still bypasses this value immediately.
		common.SysError(fmt.Sprintf("failed to check client identity version, keeping the version checked before: profile=%s platform=%s err=%v", profile, platform, err))
		s.mu.Lock()
		if current, ok := s.cache[key]; ok && current.expiresAt.Equal(entry.expiresAt) {
			current.expiresAt = now.Add(min(s.cacheTTL, clientIdentityCheckRetry))
			s.cache[key] = current
		}
		s.mu.Unlock()
		return fallback, nil
	}
	return ClientIdentityVersionLookup{}, err
}

func (s *ClientIdentityVersionService) fetch(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	kind, sourceName, err := dto.ClientIdentitySourceForProfile(profile)
	if err != nil {
		return ClientIdentityVersionLookup{}, err
	}
	requestCtx := ctx
	if requestCtx == nil {
		requestCtx = context.Background()
	}
	requestCtx, cancel := context.WithTimeout(requestCtx, s.requestTimeout)
	defer cancel()

	var versions []string
	sourcePlatform := platform
	switch kind {
	case dto.ClientIdentitySourceNPM:
		versions, err = s.fetchNPMVersions(requestCtx, sourceName, profile, platform)
	case dto.ClientIdentitySourceWorkBuddy:
		var version string
		version, sourcePlatform, err = s.fetchWorkBuddyVersion(requestCtx, platform, profile)
		if err == nil {
			versions = []string{version}
		}
	case dto.ClientIdentitySourceManual,
		dto.ClientIdentitySourceOfficial,
		dto.ClientIdentitySourceCommunity:
		// These profiles intentionally expose manual version/source metadata
		// until a verified built-in upstream source is registered.
		versions = nil
	default:
		err = fmt.Errorf("unsupported client identity source: %s", kind)
	}
	if err != nil {
		return ClientIdentityVersionLookup{}, err
	}
	if len(versions) == 0 && kind != dto.ClientIdentitySourceManual &&
		kind != dto.ClientIdentitySourceOfficial && kind != dto.ClientIdentitySourceCommunity {
		return ClientIdentityVersionLookup{}, fmt.Errorf("official client identity source returned no versions")
	}
	latest := ""
	if len(versions) > 0 {
		latest = versions[0]
	}
	return ClientIdentityVersionLookup{
		ClientType: clientTypeForClientIdentityProfile(profile),
		Profile:    profile,
		Platform:   sourcePlatform,
		Versions:   versions,
		Latest:     latest,
		Source: dto.ClientIdentitySourceMetadata{
			Kind:      kind,
			Package:   sourceName,
			Platform:  sourcePlatform,
			CheckedAt: s.now().Unix(),
		},
	}, nil
}

func clientTypeForClientIdentityProfile(profile string) string {
	switch profile {
	case dto.ClientIdentityProfileCodexLegacy, dto.ClientIdentityProfileCodexCompatibility:
		return dto.ClientIdentityClientTypeCodex
	case dto.ClientIdentityProfileCodexCLI:
		return dto.ClientIdentityClientTypeCodex
	case dto.ClientIdentityProfileClaudeCLI:
		return dto.ClientIdentityClientTypeClaude
	case dto.ClientIdentityProfileClaudeCode:
		return dto.ClientIdentityClientTypeClaudeCode
	case dto.ClientIdentityProfileCodeBuddy, dto.ClientIdentityProfileCodeBuddyCLI:
		return dto.ClientIdentityClientTypeCodeBuddy
	case dto.ClientIdentityProfileWorkBuddyDesktop:
		return dto.ClientIdentityClientTypeWorkBuddy
	case dto.ClientIdentityProfileNone:
		return dto.ClientIdentityClientTypeNone
	default:
		return ""
	}
}

func (s *ClientIdentityVersionService) fetchNPMVersions(ctx context.Context, packageName, profile, platform string) ([]string, error) {
	packagePath := strings.ReplaceAll(packageName, "/", "%2f")
	endpoint := strings.TrimRight(s.npmRegistryURL, "/") + "/" + packagePath
	// The full npm packument for active CLI packages can exceed 10 MiB. The
	// abbreviated packument keeps the official dist-tags and version keys while
	// avoiding package metadata that this endpoint does not need.
	body, err := s.fetchBody(ctx, endpoint, "application/vnd.npm.install-v1+json")
	if err != nil {
		return nil, err
	}

	var payload struct {
		Name     string            `json:"name"`
		Version  string            `json:"version"`
		DistTags map[string]string `json:"dist-tags"`
		// Only the version names are read; struct{} skips each version's
		// metadata instead of allocating it.
		Versions map[string]struct{} `json:"versions"`
	}
	if err := common.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("invalid npm metadata: %w", err)
	}
	if payload.Name != "" && payload.Name != packageName {
		return nil, fmt.Errorf("npm metadata package mismatch")
	}
	versions := make([]string, 0, len(payload.Versions)+1)
	seen := make(map[string]struct{}, len(payload.Versions)+1)
	appendVersion := func(version string) error {
		version = strings.TrimSpace(version)
		if version == "" {
			return nil
		}
		if err := dto.ValidateClientIdentityVersion(profile, version); err != nil {
			return err
		}
		if !isNPMVersionStable(version) {
			return nil
		}
		if !isNPMVersionAllowedForPlatform(version, platform) {
			return nil
		}
		if _, ok := seen[version]; ok {
			return nil
		}
		seen[version] = struct{}{}
		versions = append(versions, version)
		return nil
	}

	latest := ""
	if payload.DistTags != nil {
		latest = strings.TrimSpace(payload.DistTags["latest"])
	}
	if latest == "" {
		latest = strings.TrimSpace(payload.Version)
	}
	if latest != "" {
		if err := appendVersion(latest); err != nil {
			return nil, fmt.Errorf("invalid npm latest version: %w", err)
		}
	}
	allVersions := make([]string, 0, len(payload.Versions))
	for version := range payload.Versions {
		if err := dto.ValidateClientIdentityVersion(profile, version); err != nil {
			continue
		}
		if !isNPMVersionStable(version) || !isNPMVersionAllowedForPlatform(version, platform) {
			continue
		}
		allVersions = append(allVersions, version)
	}
	sort.SliceStable(allVersions, func(i, j int) bool {
		comparison := compareClientIdentityVersions(allVersions[i], allVersions[j])
		if comparison != 0 {
			return comparison > 0
		}
		return allVersions[i] > allVersions[j]
	})
	for _, version := range allVersions {
		if len(versions) >= clientIdentityMaxVersions {
			break
		}
		if err := appendVersion(version); err != nil {
			return nil, err
		}
	}
	return versions, nil
}

type clientIdentitySemver struct {
	major         int64
	minor         int64
	patch         int64
	prerelease    []string
	buildMetadata []string
}

func parseClientIdentitySemver(version string) clientIdentitySemver {
	version = strings.TrimSpace(version)
	parsed := clientIdentitySemver{}
	if plus := strings.IndexByte(version, '+'); plus >= 0 {
		parsed.buildMetadata = strings.Split(version[plus+1:], ".")
		version = version[:plus]
	}
	if dash := strings.IndexByte(version, '-'); dash >= 0 {
		parsed.prerelease = strings.Split(version[dash+1:], ".")
		version = version[:dash]
	}
	parts := strings.Split(version, ".")
	if len(parts) == 3 {
		parsed.major, _ = strconv.ParseInt(parts[0], 10, 64)
		parsed.minor, _ = strconv.ParseInt(parts[1], 10, 64)
		parsed.patch, _ = strconv.ParseInt(parts[2], 10, 64)
	}
	return parsed
}

func compareClientIdentityVersions(left, right string) int {
	a := parseClientIdentitySemver(left)
	b := parseClientIdentitySemver(right)
	if a.major != b.major {
		return compareInt64(a.major, b.major)
	}
	if a.minor != b.minor {
		return compareInt64(a.minor, b.minor)
	}
	if a.patch != b.patch {
		return compareInt64(a.patch, b.patch)
	}
	if len(a.prerelease) == 0 || len(b.prerelease) == 0 {
		if len(a.prerelease) == len(b.prerelease) {
			return 0
		}
		if len(a.prerelease) == 0 {
			return 1
		}
		return -1
	}
	for index := 0; index < len(a.prerelease) && index < len(b.prerelease); index++ {
		leftPart := a.prerelease[index]
		rightPart := b.prerelease[index]
		leftNumber, leftErr := strconv.ParseInt(leftPart, 10, 64)
		rightNumber, rightErr := strconv.ParseInt(rightPart, 10, 64)
		if leftErr == nil && rightErr == nil {
			if leftNumber != rightNumber {
				return compareInt64(leftNumber, rightNumber)
			}
			continue
		}
		if leftErr == nil {
			return -1
		}
		if rightErr == nil {
			return 1
		}
		if leftPart != rightPart {
			if leftPart < rightPart {
				return -1
			}
			return 1
		}
	}
	return compareInt64(int64(len(a.prerelease)), int64(len(b.prerelease)))
}

func compareInt64(left, right int64) int {
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}

func isNPMVersionStable(version string) bool {
	parsed := parseClientIdentitySemver(version)
	if len(parsed.prerelease) == 0 {
		return true
	}

	// Platform builds use a dash too, but are stable product builds when the
	// platform suffix is the complete prerelease portion. Keep those builds
	// available for an explicitly selected matching platform.
	_, ok := npmPlatformBuildPlatform(parsed)
	return ok
}

func isNPMVersionAllowedForPlatform(version, platform string) bool {
	parsed := parseClientIdentitySemver(version)
	buildPlatform, isPlatformBuild := npmPlatformBuildPlatform(parsed)
	if !isPlatformBuild {
		// A version with an ordinary prerelease is not available for any
		// platform. Build metadata is intentionally ignored here: a suffix
		// after '+' is not a platform build suffix.
		return len(parsed.prerelease) == 0
	}

	platform = strings.TrimSpace(platform)
	if platform == "" {
		return false
	}
	return buildPlatform == platform
}

func npmPlatformBuildPlatform(version clientIdentitySemver) (string, bool) {
	if len(version.prerelease) != 1 {
		return "", false
	}

	parts := strings.Split(strings.ToLower(version.prerelease[0]), "-")
	if len(parts) != 2 {
		return "", false
	}

	switch parts[0] + "-" + parts[1] {
	case "win32-x64":
		return dto.ClientIdentityPlatformWindowsX64, true
	case "darwin-x64":
		return dto.ClientIdentityPlatformMacOSX64, true
	case "darwin-arm64":
		return dto.ClientIdentityPlatformMacOSArm64, true
	case "linux-x64":
		return dto.ClientIdentityPlatformLinuxX64, true
	case "linux-arm64":
		return dto.ClientIdentityPlatformLinuxArm64, true
	default:
		return "", false
	}
}

func (s *ClientIdentityVersionService) fetchWorkBuddyVersion(ctx context.Context, platform, profile string) (string, string, error) {
	platformQuery, err := dto.WorkBuddyUpdatePlatform(platform)
	if err != nil {
		return "", "", err
	}
	normalizedPlatform, err := dto.NormalizeClientIdentityPlatform(platform)
	if err != nil {
		return "", "", err
	}
	if normalizedPlatform == "" {
		normalizedPlatform = dto.ClientIdentityPlatformWindowsX64
	}
	endpoint, err := url.Parse(s.workBuddyURL)
	if err != nil {
		return "", "", fmt.Errorf("invalid WorkBuddy update URL")
	}
	query := endpoint.Query()
	query.Set("platform", platformQuery)
	endpoint.RawQuery = query.Encode()
	body, err := s.fetchBody(ctx, endpoint.String(), "application/json")
	if err != nil {
		return "", "", err
	}
	var payload struct {
		ProductVersion string `json:"productVersion"`
	}
	if err := common.Unmarshal(body, &payload); err != nil {
		return "", "", fmt.Errorf("invalid WorkBuddy update metadata: %w", err)
	}
	version := strings.TrimSpace(payload.ProductVersion)
	if err := dto.ValidateClientIdentityVersion(profile, version); err != nil {
		return "", "", err
	}
	return version, normalizedPlatform, nil
}

func (s *ClientIdentityVersionService) fetchBody(ctx context.Context, endpoint, accept string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("official client identity request failed")
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "new-api-client-identity")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("official client identity source unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("official client identity source returned status %d", resp.StatusCode)
	}
	limited := io.LimitReader(resp.Body, s.maxBodyBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("failed to read official client identity source")
	}
	if int64(len(body)) > s.maxBodyBytes {
		return nil, fmt.Errorf("official client identity response is too large")
	}
	return body, nil
}

func cloneClientIdentityVersionLookup(lookup ClientIdentityVersionLookup) ClientIdentityVersionLookup {
	lookup.Versions = append([]string(nil), lookup.Versions...)
	return lookup
}

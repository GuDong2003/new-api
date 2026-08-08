package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

const (
	defaultNPMRegistryURL      = "https://registry.npmjs.org"
	defaultWorkBuddyUpdateURL  = "https://www.codebuddy.cn/v2/update"
	clientIdentityVersionTTL   = time.Hour
	clientIdentityRequestLimit = 10 * time.Second
	clientIdentityMaxBodyBytes = 8 << 20
	clientIdentityMaxVersions  = 64
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

type ClientIdentityVersionService struct {
	client         *http.Client
	npmRegistryURL string
	workBuddyURL   string
	cacheTTL       time.Duration
	requestTimeout time.Duration
	maxBodyBytes   int64
	now            func() time.Time

	mu    sync.Mutex
	cache map[string]clientIdentityVersionCacheEntry
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
		client:         client,
		npmRegistryURL: npmRegistryURL,
		workBuddyURL:   workBuddyURL,
		cacheTTL:       cacheTTL,
		requestTimeout: requestTimeout,
		maxBodyBytes:   maxBodyBytes,
		now:            now,
		cache:          make(map[string]clientIdentityVersionCacheEntry),
	}
}

var defaultClientIdentityVersionService = NewClientIdentityVersionService(ClientIdentityVersionServiceOptions{})

var npmPlatformBuildPattern = regexp.MustCompile(`(?i)-(win32|linux|darwin)-([a-z0-9]+)(?:[-.]|$)`)

func GetClientIdentityVersions(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	return defaultClientIdentityVersionService.ListVersions(ctx, profile, platform)
}

func RefreshClientIdentityVersions(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	return defaultClientIdentityVersionService.RefreshVersions(ctx, profile, platform)
}

func (s *ClientIdentityVersionService) ListVersions(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	return s.lookup(ctx, profile, platform, false)
}

func (s *ClientIdentityVersionService) RefreshVersions(ctx context.Context, profile, platform string) (ClientIdentityVersionLookup, error) {
	return s.lookup(ctx, profile, platform, true)
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
		Versions map[string]any    `json:"versions"`
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
	major      int64
	minor      int64
	patch      int64
	prerelease []string
}

func parseClientIdentitySemver(version string) clientIdentitySemver {
	version = strings.TrimSpace(version)
	if plus := strings.IndexByte(version, '+'); plus >= 0 {
		version = version[:plus]
	}
	parsed := clientIdentitySemver{}
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

func isNPMVersionAllowedForPlatform(version, platform string) bool {
	platform = strings.TrimSpace(platform)
	if platform == "" {
		return npmPlatformBuildPattern.FindStringSubmatch(strings.ToLower(version)) == nil
	}

	match := npmPlatformBuildPattern.FindStringSubmatch(strings.ToLower(version))
	if len(match) == 0 {
		// A version without a platform build suffix is the base product version
		// and is valid for every selected platform.
		return true
	}

	expectedOS, expectedArchitecture := npmPlatformBuildTarget(platform)
	if expectedOS == "" || expectedArchitecture == "" {
		return false
	}
	return match[1] == expectedOS && match[2] == expectedArchitecture
}

func npmPlatformBuildTarget(platform string) (string, string) {
	switch platform {
	case dto.ClientIdentityPlatformWindowsX64:
		return "win32", "x64"
	case dto.ClientIdentityPlatformMacOSX64:
		return "darwin", "x64"
	case dto.ClientIdentityPlatformMacOSArm64:
		return "darwin", "arm64"
	case dto.ClientIdentityPlatformLinuxX64:
		return "linux", "x64"
	case dto.ClientIdentityPlatformLinuxArm64:
		return "linux", "arm64"
	default:
		return "", ""
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

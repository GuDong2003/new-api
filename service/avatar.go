package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	_ "golang.org/x/image/webp"
)

const (
	MaxAvatarBytes      = 2 << 20
	maxAvatarDimension  = 4096
	maxAvatarPixels     = 16 * 1024 * 1024
	maxSVGNodes         = 5000
	maxSVGDepth         = 64
	maxSVGAnimations    = 128
	managedAvatarPrefix = "/api/avatar/"
)

var (
	managedAvatarFilenamePattern = regexp.MustCompile(`^[a-f0-9]{32}\.(?:jpg|png|webp|svg)$`)
	cssCommentPattern            = regexp.MustCompile(`(?s)/\*.*?\*/`)
	cssURLPattern                = regexp.MustCompile(`url\s*\(`)
	safeFragmentPattern          = regexp.MustCompile(`^#[A-Za-z_][A-Za-z0-9_.:-]*$`)
	safeClockValuePattern        = regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d+)?(?:ms|s|min|h)|\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$`)
	safeSyncbasePattern          = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.:-]*\.(?:begin|end)(?:[+-]\d+(?:\.\d+)?(?:ms|s|min|h))?$`)
)

type PreparedAvatar struct {
	Data      []byte
	Extension string
	MIMEType  string
}

var allowedSVGElements = map[string]string{
	"svg": "svg", "g": "g", "defs": "defs", "desc": "desc", "title": "title",
	"symbol": "symbol", "use": "use", "path": "path", "rect": "rect", "circle": "circle",
	"ellipse": "ellipse", "line": "line", "polyline": "polyline", "polygon": "polygon",
	"text": "text", "tspan": "tspan", "clippath": "clipPath", "mask": "mask",
	"lineargradient": "linearGradient", "radialgradient": "radialGradient", "stop": "stop",
	"pattern": "pattern", "marker": "marker", "style": "style", "animate": "animate",
	"animatetransform": "animateTransform", "animatemotion": "animateMotion", "set": "set",
	"mpath": "mpath",
}

var allowedSVGAttributes = map[string]string{
	"id": "id", "class": "class", "style": "style", "viewbox": "viewBox",
	"preserveaspectratio": "preserveAspectRatio", "width": "width", "height": "height",
	"x": "x", "y": "y", "x1": "x1", "y1": "y1", "x2": "x2", "y2": "y2",
	"cx": "cx", "cy": "cy", "r": "r", "rx": "rx", "ry": "ry", "d": "d",
	"points": "points", "pathlength": "pathLength", "transform": "transform",
	"fill": "fill", "fill-opacity": "fill-opacity", "fill-rule": "fill-rule",
	"stroke": "stroke", "stroke-width": "stroke-width", "stroke-linecap": "stroke-linecap",
	"stroke-linejoin": "stroke-linejoin", "stroke-miterlimit": "stroke-miterlimit",
	"stroke-dasharray": "stroke-dasharray", "stroke-dashoffset": "stroke-dashoffset",
	"stroke-opacity": "stroke-opacity", "opacity": "opacity", "color": "color",
	"display": "display", "visibility": "visibility", "overflow": "overflow",
	"vector-effect": "vector-effect", "paint-order": "paint-order", "shape-rendering": "shape-rendering",
	"text-rendering": "text-rendering", "clip-path": "clip-path", "clip-rule": "clip-rule",
	"mask": "mask", "mask-type": "mask-type", "marker-start": "marker-start",
	"marker-mid": "marker-mid", "marker-end": "marker-end", "markerwidth": "markerWidth",
	"markerheight": "markerHeight", "markerunits": "markerUnits", "orient": "orient",
	"refx": "refX", "refy": "refY", "gradientunits": "gradientUnits",
	"gradienttransform": "gradientTransform", "spreadmethod": "spreadMethod", "offset": "offset",
	"stop-color": "stop-color", "stop-opacity": "stop-opacity", "fx": "fx", "fy": "fy",
	"fr": "fr", "patternunits": "patternUnits", "patterncontentunits": "patternContentUnits",
	"patterntransform": "patternTransform", "font-family": "font-family", "font-size": "font-size",
	"font-weight": "font-weight", "font-style": "font-style", "text-anchor": "text-anchor",
	"dominant-baseline": "dominant-baseline", "letter-spacing": "letter-spacing",
	"word-spacing": "word-spacing", "dx": "dx", "dy": "dy", "rotate": "rotate",
	"textlength": "textLength", "lengthadjust": "lengthAdjust", "href": "href",
	"attributename": "attributeName", "attributetype": "attributeType", "begin": "begin",
	"dur": "dur", "end": "end", "min": "min", "max": "max", "restart": "restart",
	"repeatcount": "repeatCount", "repeatdur": "repeatDur", "calcmode": "calcMode",
	"values": "values", "keytimes": "keyTimes", "keysplines": "keySplines",
	"keypoints": "keyPoints", "from": "from", "to": "to", "by": "by",
	"additive": "additive", "accumulate": "accumulate", "type": "type",
	"path": "path", "origin": "origin", "version": "version", "role": "role",
	"focusable": "focusable",
}

var safeAnimatableAttributes = map[string]bool{
	"x": true, "y": true, "x1": true, "y1": true, "x2": true, "y2": true,
	"cx": true, "cy": true, "r": true, "rx": true, "ry": true, "d": true,
	"points": true, "pathLength": true, "transform": true, "fill": true,
	"fill-opacity": true, "stroke": true, "stroke-width": true, "stroke-opacity": true,
	"stroke-dasharray": true, "stroke-dashoffset": true, "opacity": true,
	"color": true, "visibility": true, "display": true, "offset": true,
	"stop-color": true, "stop-opacity": true, "font-size": true, "letter-spacing": true,
	"word-spacing": true, "viewBox": true,
}

func PrepareAvatar(data []byte) (*PreparedAvatar, error) {
	if len(data) == 0 {
		return nil, errors.New("avatar file is empty")
	}
	if len(data) > MaxAvatarBytes {
		return nil, fmt.Errorf("avatar must not exceed %d MiB", MaxAvatarBytes>>20)
	}

	trimmed := bytes.TrimSpace(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}))
	if bytes.HasPrefix(trimmed, []byte("<")) {
		sanitized, err := SanitizeSVG(trimmed)
		if err != nil {
			return nil, fmt.Errorf("invalid SVG avatar: %w", err)
		}
		return &PreparedAvatar{Data: sanitized, Extension: "svg", MIMEType: "image/svg+xml"}, nil
	}

	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("only JPEG, PNG, WebP, and SVG avatars are supported")
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > maxAvatarDimension || config.Height > maxAvatarDimension || config.Width*config.Height > maxAvatarPixels {
		return nil, fmt.Errorf("avatar dimensions must be at most %dx%d", maxAvatarDimension, maxAvatarDimension)
	}

	extension := ""
	mimeType := ""
	switch format {
	case "jpeg":
		extension, mimeType = "jpg", "image/jpeg"
	case "png":
		extension, mimeType = "png", "image/png"
	case "webp":
		extension, mimeType = "webp", "image/webp"
	default:
		return nil, errors.New("only JPEG, PNG, WebP, and SVG avatars are supported")
	}
	return &PreparedAvatar{Data: data, Extension: extension, MIMEType: mimeType}, nil
}

func FetchAvatarURL(ctx context.Context, rawURL string) ([]byte, error) {
	parsedURL, err := validateAvatarRemoteURL(rawURL)
	if err != nil {
		return nil, err
	}

	transport := &http.Transport{
		Proxy:                 nil,
		DisableCompression:    true,
		ResponseHeaderTimeout: 8 * time.Second,
		DialContext: func(dialContext context.Context, network, address string) (net.Conn, error) {
			host, port, splitErr := net.SplitHostPort(address)
			if splitErr != nil {
				return nil, splitErr
			}
			addresses, lookupErr := net.DefaultResolver.LookupIP(dialContext, "ip", host)
			if lookupErr != nil {
				return nil, lookupErr
			}
			var lastErr error
			for _, addressIP := range addresses {
				if !isSafeRemoteIP(addressIP) {
					lastErr = errors.New("image host resolves to a private or reserved address")
					continue
				}
				connection, dialErr := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(
					dialContext,
					network,
					net.JoinHostPort(addressIP.String(), port),
				)
				if dialErr == nil {
					return connection, nil
				}
				lastErr = dialErr
			}
			if lastErr == nil {
				lastErr = errors.New("image host has no usable address")
			}
			return nil, lastErr
		},
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   12 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many image URL redirects")
			}
			_, redirectErr := validateAvatarRemoteURL(request.URL.String())
			return redirectErr
		},
	}
	defer transport.CloseIdleConnections()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsedURL.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "image/avif,image/webp,image/svg+xml,image/png,image/jpeg;q=0.9,*/*;q=0.1")
	request.Header.Set("User-Agent", "new-api-avatar-import/1.0")
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("failed to download avatar: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("image host returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > MaxAvatarBytes {
		return nil, fmt.Errorf("avatar must not exceed %d MiB", MaxAvatarBytes>>20)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxAvatarBytes+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read avatar: %w", err)
	}
	if len(data) > MaxAvatarBytes {
		return nil, fmt.Errorf("avatar must not exceed %d MiB", MaxAvatarBytes>>20)
	}
	return data, nil
}

func StoreAvatar(avatar *PreparedAvatar) (string, error) {
	if avatar == nil || len(avatar.Data) == 0 {
		return "", errors.New("avatar is empty")
	}
	directory := avatarStorageDir()
	if err := os.MkdirAll(directory, 0755); err != nil {
		return "", err
	}

	randomBytes := make([]byte, 16)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	filename := hex.EncodeToString(randomBytes) + "." + avatar.Extension
	temporaryFile, err := os.CreateTemp(directory, ".avatar-*")
	if err != nil {
		return "", err
	}
	temporaryPath := temporaryFile.Name()
	committed := false
	defer func() {
		_ = temporaryFile.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporaryFile.Chmod(0644); err != nil {
		return "", err
	}
	if _, err := temporaryFile.Write(avatar.Data); err != nil {
		return "", err
	}
	if err := temporaryFile.Sync(); err != nil {
		return "", err
	}
	if err := temporaryFile.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, filepath.Join(directory, filename)); err != nil {
		return "", err
	}
	committed = true
	return managedAvatarPrefix + filename, nil
}

func DeleteManagedAvatar(avatarURL string) error {
	filename, ok := ManagedAvatarFilename(avatarURL)
	if !ok {
		return nil
	}
	err := os.Remove(filepath.Join(avatarStorageDir(), filename))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func ManagedAvatarFilename(avatarURL string) (string, bool) {
	if !strings.HasPrefix(avatarURL, managedAvatarPrefix) {
		return "", false
	}
	filename := strings.TrimPrefix(avatarURL, managedAvatarPrefix)
	if filename != filepath.Base(filename) || !managedAvatarFilenamePattern.MatchString(filename) {
		return "", false
	}
	return filename, true
}

func AvatarFilePath(filename string) (string, bool) {
	if !managedAvatarFilenamePattern.MatchString(filename) || filename != filepath.Base(filename) {
		return "", false
	}
	return filepath.Join(avatarStorageDir(), filename), true
}

func AvatarMIMEType(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".jpg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	default:
		return "application/octet-stream"
	}
}

func SanitizeSVG(data []byte) ([]byte, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	var output bytes.Buffer
	encoder := xml.NewEncoder(&output)
	depth := 0
	skipDepth := 0
	nodeCount := 0
	animationCount := 0
	rootSeen := false
	rootClosed := false
	allowedStack := make([]string, 0, 16)
	var styleContent strings.Builder

	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}

		switch typedToken := token.(type) {
		case xml.StartElement:
			depth++
			if depth > maxSVGDepth {
				return nil, errors.New("SVG nesting is too deep")
			}
			if rootClosed {
				return nil, errors.New("SVG contains multiple root elements")
			}
			if skipDepth > 0 {
				skipDepth++
				continue
			}
			canonicalElement, allowed := allowedSVGElements[strings.ToLower(typedToken.Name.Local)]
			if !rootSeen {
				if !allowed || canonicalElement != "svg" {
					return nil, errors.New("root element must be svg")
				}
				rootSeen = true
			} else if !allowed {
				skipDepth = 1
				continue
			}

			nodeCount++
			if nodeCount > maxSVGNodes {
				return nil, errors.New("SVG contains too many elements")
			}
			if canonicalElement == "animate" || canonicalElement == "animateTransform" || canonicalElement == "animateMotion" || canonicalElement == "set" {
				animationCount++
				if animationCount > maxSVGAnimations {
					return nil, errors.New("SVG contains too many animations")
				}
			}

			cleanElement := xml.StartElement{Name: xml.Name{Local: canonicalElement}}
			if canonicalElement == "svg" {
				cleanElement.Attr = append(cleanElement.Attr, xml.Attr{Name: xml.Name{Local: "xmlns"}, Value: "http://www.w3.org/2000/svg"})
			}
			if canonicalElement == "style" {
				styleContent.Reset()
			}
			for _, attribute := range typedToken.Attr {
				attributeName := strings.ToLower(attribute.Name.Local)
				if strings.HasPrefix(attributeName, "on") {
					continue
				}
				if strings.HasPrefix(attributeName, "aria-") {
					cleanElement.Attr = append(cleanElement.Attr, xml.Attr{Name: xml.Name{Local: attribute.Name.Local}, Value: attribute.Value})
					continue
				}
				canonicalAttribute, allowedAttribute := allowedSVGAttributes[attributeName]
				if !allowedAttribute {
					continue
				}
				value := strings.TrimSpace(attribute.Value)
				if canonicalAttribute == "href" {
					if !safeFragmentPattern.MatchString(value) {
						continue
					}
				}
				if canonicalAttribute == "style" {
					if !isSafeCSS(value) {
						continue
					}
				}
				if canonicalAttribute == "attributeName" && !safeAnimatableAttributes[value] {
					continue
				}
				if (canonicalAttribute == "begin" || canonicalAttribute == "end") && !isSafeAnimationTiming(value) {
					continue
				}
				if hasUnsafeResourceReference(value) {
					continue
				}
				cleanElement.Attr = append(cleanElement.Attr, xml.Attr{Name: xml.Name{Local: canonicalAttribute}, Value: value})
			}
			if err := encoder.EncodeToken(cleanElement); err != nil {
				return nil, err
			}
			allowedStack = append(allowedStack, canonicalElement)

		case xml.EndElement:
			if skipDepth > 0 {
				skipDepth--
				depth--
				continue
			}
			if len(allowedStack) == 0 {
				return nil, errors.New("SVG element nesting is invalid")
			}
			canonicalElement := allowedStack[len(allowedStack)-1]
			allowedStack = allowedStack[:len(allowedStack)-1]
			if canonicalElement == "style" {
				content := styleContent.String()
				if !isSafeCSS(content) {
					return nil, errors.New("SVG stylesheet contains an unsafe resource reference")
				}
				if err := encoder.EncodeToken(xml.CharData([]byte(content))); err != nil {
					return nil, err
				}
			}
			if err := encoder.EncodeToken(xml.EndElement{Name: xml.Name{Local: canonicalElement}}); err != nil {
				return nil, err
			}
			if canonicalElement == "svg" {
				rootClosed = true
			}
			depth--

		case xml.CharData:
			if skipDepth > 0 {
				continue
			}
			content := string(typedToken)
			if !utf8.ValidString(content) {
				return nil, errors.New("SVG contains invalid UTF-8")
			}
			if len(allowedStack) > 0 && allowedStack[len(allowedStack)-1] == "style" {
				styleContent.WriteString(content)
				continue
			}
			if err := encoder.EncodeToken(xml.CharData([]byte(content))); err != nil {
				return nil, err
			}

		case xml.Directive:
			return nil, errors.New("SVG directives are not allowed")
		case xml.ProcInst:
			if !rootSeen && strings.EqualFold(typedToken.Target, "xml") {
				continue
			}
			return nil, errors.New("SVG processing instructions are not allowed")
		case xml.Comment:
			// Comments are intentionally removed.
		}
	}
	if !rootSeen || !rootClosed || depth != 0 || len(allowedStack) != 0 {
		return nil, errors.New("SVG document is incomplete")
	}
	if err := encoder.Flush(); err != nil {
		return nil, err
	}
	if output.Len() > MaxAvatarBytes {
		return nil, fmt.Errorf("sanitized SVG must not exceed %d MiB", MaxAvatarBytes>>20)
	}
	return output.Bytes(), nil
}

func avatarStorageDir() string {
	if configured := strings.TrimSpace(os.Getenv("AVATAR_STORAGE_DIR")); configured != "" {
		return configured
	}
	return "avatars"
}

func validateAvatarRemoteURL(rawURL string) (*url.URL, error) {
	parsedURL, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsedURL.Hostname() == "" {
		return nil, errors.New("invalid image URL")
	}
	if parsedURL.Scheme != "https" {
		return nil, errors.New("image URL must use HTTPS")
	}
	if parsedURL.User != nil || parsedURL.Fragment != "" {
		return nil, errors.New("image URL must not contain credentials or fragments")
	}
	if port := parsedURL.Port(); port != "" {
		parsedPort, parseErr := strconv.Atoi(port)
		if parseErr != nil || parsedPort < 1 || parsedPort > 65535 {
			return nil, errors.New("invalid image URL port")
		}
	}
	return parsedURL, nil
}

func isSafeRemoteIP(address net.IP) bool {
	if address == nil || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsUnspecified() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() || address.IsMulticast() {
		return false
	}
	blockedPrefixes := []net.IPNet{
		{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)},
		{IP: net.IPv4(192, 0, 0, 0), Mask: net.CIDRMask(24, 32)},
		{IP: net.IPv4(198, 18, 0, 0), Mask: net.CIDRMask(15, 32)},
	}
	for _, blockedPrefix := range blockedPrefixes {
		if blockedPrefix.Contains(address) {
			return false
		}
	}
	return true
}

func isSafeAnimationTiming(value string) bool {
	if value == "" {
		return false
	}
	for _, part := range strings.Split(value, ";") {
		part = strings.TrimSpace(part)
		if part == "indefinite" || safeClockValuePattern.MatchString(part) || safeSyncbasePattern.MatchString(part) {
			continue
		}
		return false
	}
	return true
}

func hasUnsafeResourceReference(value string) bool {
	normalized := normalizeCSSSecurityValue(value)
	if strings.Contains(normalized, "javascript:") || strings.Contains(normalized, "vbscript:") || strings.Contains(normalized, "data:") || strings.Contains(normalized, "https:") || strings.Contains(normalized, "http:") || strings.Contains(normalized, "//") {
		return true
	}
	return !allCSSURLsAreFragments(normalized)
}

func isSafeCSS(value string) bool {
	normalized := normalizeCSSSecurityValue(value)
	for _, forbidden := range []string{"@import", "@font-face", "@namespace", "expression(", "javascript:", "vbscript:", "data:", "-moz-binding", "behavior:", "image-set("} {
		if strings.Contains(normalized, forbidden) {
			return false
		}
	}
	return allCSSURLsAreFragments(normalized)
}

func allCSSURLsAreFragments(normalized string) bool {
	remaining := normalized
	for {
		location := cssURLPattern.FindStringIndex(remaining)
		if location == nil {
			return true
		}
		afterOpen := remaining[location[1]:]
		closingIndex := strings.IndexByte(afterOpen, ')')
		if closingIndex < 0 {
			return false
		}
		target := strings.Trim(strings.TrimSpace(afterOpen[:closingIndex]), "\"'")
		if !safeFragmentPattern.MatchString(target) {
			return false
		}
		remaining = afterOpen[closingIndex+1:]
	}
}

func normalizeCSSSecurityValue(value string) string {
	withoutComments := cssCommentPattern.ReplaceAllString(value, "")
	var normalized strings.Builder
	for index := 0; index < len(withoutComments); {
		if withoutComments[index] != '\\' {
			normalized.WriteByte(withoutComments[index])
			index++
			continue
		}
		index++
		if index < len(withoutComments) && (withoutComments[index] == '\n' || withoutComments[index] == '\r' || withoutComments[index] == '\f') {
			if withoutComments[index] == '\r' && index+1 < len(withoutComments) && withoutComments[index+1] == '\n' {
				index++
			}
			index++
			continue
		}
		start := index
		for index < len(withoutComments) && index-start < 6 && isHexDigit(withoutComments[index]) {
			index++
		}
		if index > start {
			codePoint, err := strconv.ParseInt(withoutComments[start:index], 16, 32)
			if err == nil && codePoint > 0 {
				normalized.WriteRune(rune(codePoint))
			}
			if index < len(withoutComments) && isCSSWhitespace(withoutComments[index]) {
				index++
			}
			continue
		}
		if index < len(withoutComments) {
			normalized.WriteByte(withoutComments[index])
			index++
		}
	}
	return strings.ToLower(normalized.String())
}

func isHexDigit(value byte) bool {
	return value >= '0' && value <= '9' || value >= 'a' && value <= 'f' || value >= 'A' && value <= 'F'
}

func isCSSWhitespace(value byte) bool {
	return value == ' ' || value == '\n' || value == '\r' || value == '\t' || value == '\f'
}

package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"github.com/QuantumNous/new-api/model"
	"hash/crc32"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	contentAuditMaxImageBytes     = 10 << 20
	contentAuditMaxBase64Bytes    = ((contentAuditMaxImageBytes + 2) / 3) * 4
	contentAuditMaxThumbnailBytes = 300 << 10
)

var errContentAuditImage = errors.New("content_audit_image_unavailable")
var contentAuditDecodeSlot = make(chan struct{}, 1)

// This client has an unconditional SSRF policy. It intentionally does not use
// the configurable relay fetch client, environment proxy, cookies, or credentials.
var contentAuditBlockedNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
}

func contentAuditPublicIP(address netip.Addr) bool {
	if !address.IsValid() || address.Is4In6() || address.Zone() != "" || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	if address.Is6() && !netip.MustParsePrefix("2000::/3").Contains(address) {
		return false
	}
	for _, network := range contentAuditBlockedNetworks {
		if network.Contains(address) {
			return false
		}
	}
	return true
}

func contentAuditImageURL(raw string) (*url.URL, error) {
	if len(raw) > 8192 {
		return nil, errContentAuditImage
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return nil, errContentAuditImage
	}
	if port := u.Port(); port != "" && port != "80" && port != "443" {
		return nil, errContentAuditImage
	}
	host := u.Hostname()
	if address, err := netip.ParseAddr(host); err == nil {
		if !contentAuditPublicIP(address) {
			return nil, errContentAuditImage
		}
		return u, nil
	}
	if len(host) > 253 || strings.Trim(host, "0123456789.") == "" || strings.ContainsAny(host, ":%\\") {
		return nil, errContentAuditImage
	}
	// Reject legacy numeric/hex IPv4 spellings before they reach a resolver.
	for label := range strings.SplitSeq(strings.TrimSuffix(host, "."), ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(strings.ToLower(label), "0x") || label[0] == '-' || label[len(label)-1] == '-' {
			return nil, errContentAuditImage
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-') {
				return nil, errContentAuditImage
			}
		}
	}
	return u, nil
}

func contentAuditDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || (port != "80" && port != "443") {
		return nil, errContentAuditImage
	}
	var addresses []netip.Addr
	if literal, parseErr := netip.ParseAddr(host); parseErr == nil {
		addresses = []netip.Addr{literal}
	} else {
		addresses, err = net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}
	if err != nil {
		return nil, errContentAuditImage
	}
	return contentAuditPinnedDial(ctx, network, port, addresses, (&net.Dialer{Timeout: 5 * time.Second}).DialContext)
}

func contentAuditPinnedDial(ctx context.Context, network, port string, addresses []netip.Addr, dial func(context.Context, string, string) (net.Conn, error)) (net.Conn, error) {
	if len(addresses) == 0 || len(addresses) > 16 || (port != "80" && port != "443") {
		return nil, errContentAuditImage
	}
	// Reject the ENTIRE answer if even one candidate is forbidden. Connect to
	// the validated IP itself; TLS still verifies the original hostname.
	for _, ip := range addresses {
		if !contentAuditPublicIP(ip) {
			return nil, errContentAuditImage
		}
	}
	for _, ip := range addresses {
		connection, err := dial(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return connection, nil
		}
		if ctx.Err() != nil {
			break
		}
	}
	return nil, errContentAuditImage
}

func contentAuditImageRedirect(request *http.Request, via []*http.Request) error {
	if len(via) > 3 {
		return errContentAuditImage
	}
	if _, err := contentAuditImageURL(request.URL.String()); err != nil {
		return err
	}
	if len(via) > 0 && via[len(via)-1].URL.Scheme == "https" && request.URL.Scheme != "https" {
		return errContentAuditImage
	}
	return nil
}

func newContentAuditImageClient() *http.Client {
	transport := &http.Transport{Proxy: nil, DisableCompression: true, DialContext: contentAuditDial, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 8 * time.Second, MaxResponseHeaderBytes: 32 << 10}
	return &http.Client{Transport: transport, Timeout: 12 * time.Second, CheckRedirect: contentAuditImageRedirect}
}

func streamContentAuditImage(ctx context.Context, client *http.Client, raw string, target io.Writer, contentType *string) error {
	u, err := contentAuditImageURL(raw)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return errContentAuditImage
	}
	request.Header.Set("Accept", "image/jpeg, image/png, image/webp")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "new-api-content-audit/1")
	response, err := client.Do(request)
	if err != nil {
		return errContentAuditImage
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || (response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity") {
		return errContentAuditImage
	}
	*contentType, _, err = mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || (*contentType != "image/png" && *contentType != "image/jpeg" && *contentType != "image/webp") {
		return errContentAuditFile
	}
	n, err := io.CopyBuffer(target, response.Body, make([]byte, contentAuditOriginalBlock))
	if err != nil {
		if errors.Is(err, model.ErrContentAuditCapacity) {
			return err
		}
		return errContentAuditImage
	}
	if response.ContentLength >= 0 && response.ContentLength != n {
		return errContentAuditFile
	}
	return nil
}

// Container validation is independent of preview pixel/decoder budgets. It
// checks chunk framing and checksums, not the safety of arbitrary pixel decode.
func (s *contentAuditStore) validateOriginalImage(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, file contentAuditOriginalFile, declared string) (string, error) {
	source, err := s.openOriginal(ctx, state, record, file)
	if err != nil {
		return "", err
	}
	defer source.Close()
	r := bufio.NewReaderSize(source, 32<<10)
	header, err := r.Peek(12)
	if err != nil {
		return "", errContentAuditFile
	}
	format := ""
	if bytes.Equal(header[:8], []byte("\x89PNG\r\n\x1a\n")) {
		format = "image/png"
	} else if header[0] == 0xff && header[1] == 0xd8 {
		format = "image/jpeg"
	} else if string(header[:4]) == "RIFF" && string(header[8:12]) == "WEBP" {
		format = "image/webp"
	}
	if format == "" || (declared != "" && declared != format) {
		return "", errContentAuditFile
	}
	buffer := make([]byte, contentAuditOriginalBlock)
	switch format {
	case "image/png":
		_, _ = r.Discard(8)
		first, pixels, done := true, false, false
		for !done {
			var chunk [8]byte
			if _, err := io.ReadFull(r, chunk[:]); err != nil {
				return "", errContentAuditFile
			}
			n := int64(binary.BigEndian.Uint32(chunk[:4]))
			kind := string(chunk[4:])
			if n > file.PlainBytes || (first && (kind != "IHDR" || n != 13)) || (!first && kind == "IHDR") || (kind == "IEND" && (n != 0 || !pixels)) {
				return "", errContentAuditFile
			}
			checksum := crc32.NewIEEE()
			_, _ = checksum.Write(chunk[4:])
			if first {
				var ihdr [13]byte
				if _, err := io.ReadFull(r, ihdr[:]); err != nil || binary.BigEndian.Uint32(ihdr[:4]) == 0 || binary.BigEndian.Uint32(ihdr[4:8]) == 0 || ihdr[10] != 0 || ihdr[11] != 0 || ihdr[12] > 1 {
					return "", errContentAuditFile
				}
				_, _ = checksum.Write(ihdr[:])
			} else if copied, err := io.CopyBuffer(checksum, io.LimitReader(r, n), buffer); err != nil || copied != n {
				return "", errContentAuditFile
			}
			var expected [4]byte
			if _, err := io.ReadFull(r, expected[:]); err != nil || binary.BigEndian.Uint32(expected[:]) != checksum.Sum32() {
				return "", errContentAuditFile
			}
			pixels = pixels || kind == "IDAT"
			done, first = kind == "IEND", false
		}
	case "image/webp":
		remaining := int64(binary.LittleEndian.Uint32(header[4:8])) - 4
		if remaining < 0 || remaining+12 != file.PlainBytes {
			return "", errContentAuditFile
		}
		_, _ = r.Discard(12)
		pixels := false
		for remaining > 0 {
			var chunk [8]byte
			if remaining < 8 {
				return "", errContentAuditFile
			}
			if _, err := io.ReadFull(r, chunk[:]); err != nil {
				return "", errContentAuditFile
			}
			n := int64(binary.LittleEndian.Uint32(chunk[4:]))
			padded := n + n%2
			if padded > remaining-8 {
				return "", errContentAuditFile
			}
			kind := string(chunk[:4])
			pixels = pixels || (n > 0 && (kind == "VP8 " || kind == "VP8L" || kind == "ANMF"))
			if copied, err := io.CopyBuffer(io.Discard, io.LimitReader(r, padded), buffer); err != nil || copied != padded {
				return "", errContentAuditFile
			}
			remaining -= 8 + padded
		}
		if !pixels {
			return "", errContentAuditFile
		}
	case "image/jpeg":
		_, _ = r.Discard(2)
		scan, pixels, done := false, false, false
		for !done {
			ch, err := r.ReadByte()
			if err != nil {
				return "", errContentAuditFile
			}
			if ch != 0xff {
				if scan {
					continue
				}
				return "", errContentAuditFile
			}
			marker, err := r.ReadByte()
			if err != nil {
				return "", errContentAuditFile
			}
			for marker == 0xff {
				marker, err = r.ReadByte()
				if err != nil {
					return "", errContentAuditFile
				}
			}
			if scan && (marker == 0 || marker >= 0xd0 && marker <= 0xd7) {
				continue
			}
			if marker == 0xd9 {
				if !pixels {
					return "", errContentAuditFile
				}
				done = true
				continue
			}
			if marker == 0 || marker == 0xd8 || marker >= 0xd0 && marker <= 0xd7 {
				return "", errContentAuditFile
			}
			var size [2]byte
			if _, err := io.ReadFull(r, size[:]); err != nil {
				return "", errContentAuditFile
			}
			n := int64(binary.BigEndian.Uint16(size[:])) - 2
			if n < 0 {
				return "", errContentAuditFile
			}
			if copied, err := io.CopyBuffer(io.Discard, io.LimitReader(r, n), buffer); err != nil || copied != n {
				return "", errContentAuditFile
			}
			scan = marker == 0xda
			pixels = pixels || scan
		}
	}
	if _, err := r.ReadByte(); err != io.EOF {
		return "", errContentAuditFile
	}
	return format, nil
}

func contentAuditImageFormat(data []byte) (string, bool) {
	if len(data) >= 3 && bytes.Equal(data[:3], []byte{0xff, 0xd8, 0xff}) {
		return "jpeg", true
	}
	if len(data) >= 8 && bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")) {
		for offset := 8; offset+12 <= len(data); {
			length := uint64(binary.BigEndian.Uint32(data[offset : offset+4]))
			if length > uint64(len(data)-offset-12) {
				return "", false
			}
			if string(data[offset+4:offset+8]) == "acTL" {
				return "", false
			}
			offset += int(length) + 12
		}
		return "png", true
	}
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		for offset := 12; offset+8 <= len(data); {
			length := uint64(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
			if length > uint64(len(data)-offset-8) {
				return "", false
			}
			chunk := string(data[offset : offset+4])
			if chunk == "ANIM" || chunk == "ANMF" || (chunk == "VP8X" && length > 0 && data[offset+8]&2 != 0) {
				return "", false
			}
			offset += 8 + int(length) + int(length%2)
		}
		return "webp", true
	}
	return "", false
}

type contentAuditThumbnail struct {
	Data   []byte
	Width  int
	Height int
}

type contentAuditLimitedBuffer struct{ bytes.Buffer }

func (b *contentAuditLimitedBuffer) Write(data []byte) (int, error) {
	if b.Len()+len(data) > contentAuditMaxThumbnailBytes {
		return 0, errContentAuditImage
	}
	return b.Buffer.Write(data)
}

func makeContentAuditThumbnail(ctx context.Context, data []byte, contentType string) (*contentAuditThumbnail, error) {
	if len(data) == 0 || len(data) > contentAuditMaxImageBytes {
		return nil, errContentAuditImage
	}
	format, ok := contentAuditImageFormat(data)
	if !ok || (contentType != "" && contentType != "image/"+format) {
		return nil, errContentAuditImage
	}
	config, decodedFormat, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || decodedFormat != format || config.Width < 1 || config.Height < 1 || config.Width > 8192 || config.Height > 8192 {
		return nil, errContentAuditImage
	}
	pixels := int64(config.Width) * int64(config.Height)
	// Includes source pixels, decoder work space, scaling and encoding buffers.
	if pixels > 16777216 || pixels*12+20<<20 > 256<<20 {
		return nil, errContentAuditImage
	}
	select {
	case contentAuditDecodeSlot <- struct{}{}:
		defer func() { <-contentAuditDecodeSlot }()
	case <-ctx.Done():
		return nil, errContentAuditImage
	}
	if ctx.Err() != nil {
		return nil, errContentAuditImage
	}
	decoded, actualFormat, err := image.Decode(bytes.NewReader(data))
	if err != nil || actualFormat != format || decoded.Bounds().Dx() != config.Width || decoded.Bounds().Dy() != config.Height {
		return nil, errContentAuditImage
	}
	for attempt, edge := range []int{1024, 768, 512} {
		if ctx.Err() != nil {
			return nil, errContentAuditImage
		}
		width, height := config.Width, config.Height
		if max(width, height) > edge {
			width, height = max(1, width*edge/max(config.Width, config.Height)), max(1, height*edge/max(config.Width, config.Height))
		}
		out := image.NewRGBA(image.Rect(0, 0, width, height))
		draw.Draw(out, out.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
		xdraw.ApproxBiLinear.Scale(out, out.Bounds(), decoded, decoded.Bounds(), draw.Over, nil)
		buffer := &contentAuditLimitedBuffer{}
		buffer.Grow(contentAuditMaxThumbnailBytes)
		if err := jpeg.Encode(buffer, out, &jpeg.Options{Quality: 80 - attempt*20}); err == nil {
			return &contentAuditThumbnail{Data: buffer.Bytes(), Width: width, Height: height}, nil
		}
	}
	return nil, errContentAuditImage
}

// Structured addresses are aids for operators, not download URLs. Query, user
// info, fragments and token-looking path segments never enter persisted data.
func redactContentAuditURL(raw string) string {
	if strings.HasPrefix(strings.ToLower(raw), "data:") {
		return "[binary omitted]"
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "[url omitted]"
	}
	u.User, u.RawQuery, u.Fragment, u.RawFragment, u.ForceQuery = nil, "", "", "", false
	segments := strings.Split(u.Path, "/")
	for i, segment := range segments {
		lower := strings.ToLower(segment)
		if len(segment) > 64 || strings.HasPrefix(lower, "sk-") || strings.HasPrefix(lower, "eyj") || strings.HasPrefix(lower, "bearer") || strings.Contains(lower, "token=") || strings.Contains(lower, "sig=") {
			segments[i] = "[redacted]"
			continue
		}
		if i > 0 {
			previous := strings.ToLower(segments[i-1])
			if previous == "token" || previous == "secret" || previous == "key" || previous == "signature" {
				segments[i] = "[redacted]"
			}
		}
	}
	u.Path, u.RawPath = strings.Join(segments, "/"), ""
	return contentAuditText(u.String(), 1024)
}

func contentAuditText(text string, limit int) string {
	if len(text) > limit {
		text = text[:limit]
	}
	return strings.ToValidUTF8(strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r < 32 {
			return -1
		}
		return r
	}, text), "")
}

func contentAuditImageIndex(index int) string { return strconv.Itoa(index) }

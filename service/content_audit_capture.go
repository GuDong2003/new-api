package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	contentAuditMemoryLimit int64 = 64 << 20
	contentAuditMaxFields         = 4096
	contentAuditMaxDepth          = 32
	contentAuditMaxScan           = 64 << 20
)

type contentAuditMemory struct{ used atomic.Int64 }

func (b *contentAuditMemory) acquire(size int64) bool {
	for {
		old := b.used.Load()
		if size < 0 || size > contentAuditMemoryLimit-old {
			return false
		}
		if b.used.CompareAndSwap(old, old+size) {
			return true
		}
	}
}
func (b *contentAuditMemory) release(size int64) { b.used.Add(-size) }

type contentAuditImageInput struct {
	Index    int
	URL      string
	Data     []byte
	Error    string
	MIME     string
	sourceID string
	charged  int64
	group    int64
	omitted  bool
}

type contentAuditImages struct {
	omitted int

	budget   *contentAuditMemory
	enabled  bool
	protocol string
	session  *contentAuditImageSession
}

type contentAuditImageEvent struct {
	kind  string
	input contentAuditImageInput
	group int64
	valid bool
}

// The relay owns the current block only. Queued blocks transfer ownership to
// the worker; completion is a separate channel and cannot be lost to overflow.
type contentAuditImageSession struct {
	sendMu      sync.Mutex
	events      chan contentAuditImageEvent
	done        chan struct{}
	initial     model.ContentAudit
	broken      bool
	failedGroup int64
	next        int
	group       int64
	lastGroup   int64
	lastValid   bool
	stopped     atomic.Bool
}

// Only the relay mutates this terminal verdict. Once a group breaks the data
// queue, later ignored groups cannot replace its reliable completion state.
func (s *contentAuditImageSession) breakGroup(group int64) {
	if !s.broken {
		s.failedGroup = group
	}
	s.broken = true
}

func (i *contentAuditImages) send(event contentAuditImageEvent) bool {
	group := event.input.group
	if event.kind == "group" {
		group = event.group
	}
	if !i.session.sendMu.TryLock() {
		i.session.breakGroup(group)
		if event.input.charged > 0 {
			i.budget.release(event.input.charged)
		}
		return false
	}
	defer i.session.sendMu.Unlock()
	if !i.session.broken && !i.session.stopped.Load() {
		select {
		case i.session.events <- event:
			return true
		default:
		}
	}
	i.session.breakGroup(group)
	if event.input.charged > 0 {
		i.budget.release(event.input.charged)
	}
	return false
}

func (s *contentAuditImageSession) stop() {
	s.sendMu.Lock()
	s.stopped.Store(true)
	s.sendMu.Unlock()
}

func (i *contentAuditImages) resourceBusy(input *contentAuditImageInput) {
	input.Error = "resource_busy"
	if !input.omitted {
		input.omitted = true
		i.omitted = min(i.omitted, math.MaxInt-1) + 1
	}
	i.session.breakGroup(input.group)
}

func (i *contentAuditImages) complete(input *contentAuditImageInput, valid bool) {
	if input == nil {
		return
	}
	if len(input.Data) > 0 {
		block := *input
		block.URL, block.MIME, block.sourceID = "", "", ""
		if !i.send(contentAuditImageEvent{kind: "data", input: block}) {
			i.resourceBusy(input)
		}
		input.Data, input.charged = nil, 0
	} else if input.charged > 0 {
		i.budget.release(input.charged)
		input.charged = 0
	}
	if !i.send(contentAuditImageEvent{kind: "end", input: *input, valid: valid}) {
		i.resourceBusy(input)
	}
}

func (i *contentAuditImages) release() {
	if i.session != nil {
		for {
			select {
			case event := <-i.session.events:
				if event.input.charged > 0 {
					i.budget.release(event.input.charged)
				}
			default:
				return
			}
		}
	}

}

// The lexer consumes JSON incrementally, including across arbitrary response
// Write boundaries. It never buffers an entire document or a binary string.
// Only bounded scalar tokens reach common.Unmarshal; parse failure never falls
// back to a raw payload or fragment. This is an audit copy, not the relay codec.
type contentAuditJSON struct {
	stack         []contentAuditJSONFrame
	root          any
	done          bool
	invalid       bool
	truncated     bool
	observed      int64
	limit         int
	stored        int
	fields        int
	inString      bool
	keyToken      bool
	escape        bool
	token         []byte
	tokenCut      bool
	scalar        bool
	skipString    bool
	binary        bool
	binaryEncoded int
	binaryCount   int
	binaryQuartet [4]byte
	binaryBad     bool
	binaryEnd     bool
	binaryEscape  []byte
	image         *contentAuditImageInput
	images        *contentAuditImages
	group         int64
	finished      bool
	hasCandidate  bool
}

type contentAuditJSONFrame struct {
	object     map[string]any
	array      []any
	key        string
	field      string
	expect     byte // object: k(key), c(colon), v(value), n(comma/end); array: v or n
	skip       bool
	imageIndex int // one-based pending native image; owned by images until validated
	candidate  *contentAuditImageInput
}

func newContentAuditJSON(limit int, images *contentAuditImages) *contentAuditJSON {
	p := &contentAuditJSON{limit: limit, images: images}
	if images != nil {
		if images.session == nil {
			images.session = &contentAuditImageSession{events: make(chan contentAuditImageEvent, 64), done: make(chan struct{})}
		}
		if images.session.group < math.MaxInt64 {
			images.session.group++
		} else {
			images.session.breakGroup(images.session.group)
		}
		p.group = images.session.group
	}
	return p
}

var contentAuditFieldNormalizer = strings.NewReplacer("-", "", "_", "")

func contentAuditSecretField(key string) bool {
	switch strings.ToLower(contentAuditFieldNormalizer.Replace(key)) {
	case "authorization", "apikey", "xapikey", "cookie", "setcookie", "proxyauthorization", "password", "passwd", "secret", "clientsecret", "token", "accesstoken", "refreshtoken", "idtoken", "credential", "credentials", "privatekey":
		return true
	}
	return false
}

func contentAuditAttachmentField(key string) bool {
	switch strings.ToLower(strings.ReplaceAll(key, "_", "")) {
	case "image", "imageurl", "inputimage", "inputaudio", "audio", "file", "filedata", "inlinedata", "attachment", "attachments":
		return true
	}
	return false
}

func (p *contentAuditJSON) currentKey() string {
	if len(p.stack) == 0 {
		return ""
	}
	return p.stack[len(p.stack)-1].key
}
func (p *contentAuditJSON) skipping() bool {
	if len(p.stack) == 0 {
		return false
	}
	frame := &p.stack[len(p.stack)-1]
	return frame.skip || contentAuditSecretField(frame.key) || contentAuditAttachmentField(frame.key)
}
func (p *contentAuditJSON) binaryField() bool {
	key := strings.ToLower(p.currentKey())
	if key == "b64_json" || key == "b64" || key == "base64" || key == "partial_image_b64" {
		return true
	}
	if key == "result" && p.nativeImageContainer() == "responses" {
		return true
	}
	if key != "data" {
		return false
	}
	for _, frame := range p.stack {
		if frame.field == "source" || frame.field == "inlineData" || frame.field == "inline_data" || frame.field == "audio" || frame.field == "file" {
			return true
		}
	}
	return false
}
func (p *contentAuditJSON) imageResult() bool {
	if p.images == nil || (p.images.protocol != "" && p.images.protocol != "openai_images") {
		return false
	}
	if len(p.stack) == 1 {
		return true
	} // image SSE result/partial-image event
	return len(p.stack) == 3 && p.stack[1].field == "data" && p.stack[1].object == nil
}

// Native images are extracted only from provider output containers. Their type
// and MIME are checked when the object closes, regardless of JSON field order.
func (p *contentAuditJSON) nativeImageContainer() string {
	if p.images == nil || len(p.stack) == 0 || p.stack[len(p.stack)-1].object == nil {
		return ""
	}
	s := p.stack
	if p.images.protocol == "openai_responses" {
		if len(s) == 3 && s[1].field == "output" && s[1].object == nil {
			return "responses"
		}
		if len(s) == 4 && s[1].field == "response" && s[2].field == "output" && s[2].object == nil {
			return "responses"
		}
		if len(s) == 2 && s[1].field == "item" {
			return "responses"
		}
	}
	if p.images.protocol == "gemini" && len(s) == 7 && s[1].field == "candidates" && s[1].object == nil && s[3].field == "content" && s[4].field == "parts" && s[4].object == nil && (s[6].field == "inlineData" || s[6].field == "inline_data") {
		return "gemini"
	}
	return ""
}

func (p *contentAuditJSON) finishNativeImage(frame *contentAuditJSONFrame) {
	if frame.candidate == nil {
		return
	}
	entry := frame.candidate
	valid := true
	switch p.nativeImageContainer() {
	case "responses":
		valid = frame.object["type"] == "image_generation_call"
		entry.sourceID, _ = frame.object["id"].(string)
	case "gemini":
		entry.MIME, _ = frame.object["mimeType"].(string)
		if entry.MIME == "" {
			entry.MIME, _ = frame.object["mime_type"].(string)
		}
		valid = strings.HasPrefix(entry.MIME, "image/")
	}
	p.images.complete(entry, valid)
	frame.candidate = nil
}

func (p *contentAuditJSON) add(value any) {
	p.fields = min(p.fields+1, contentAuditMaxFields+1)
	if p.fields > contentAuditMaxFields {
		p.truncated = true
	}
	if len(p.stack) == 0 {
		if p.done {
			p.invalid = true
			return
		}
		p.root, p.done = value, true
		return
	}
	frame := &p.stack[len(p.stack)-1]
	if frame.expect != 'v' {
		p.invalid = true
		return
	}
	metadata := p.nativeImageContainer() != "" && (frame.key == "type" || frame.key == "id" || frame.key == "mimeType" || frame.key == "mime_type")
	if !frame.skip && (p.fields <= contentAuditMaxFields || metadata) {
		if frame.object != nil {
			if contentAuditSecretField(frame.key) {
				value = "[redacted]"
			}
			if contentAuditAttachmentField(frame.key) {
				value = map[string]any{"omitted": "attachment"}
			}
			frame.object[frame.key] = value
		} else {
			frame.array = append(frame.array, value)
		}
	}
	frame.expect = 'n'
}

func (p *contentAuditJSON) startString() {
	if len(p.stack) > 0 && p.stack[len(p.stack)-1].expect == 'V' {
		p.stack[len(p.stack)-1].expect = 'v'
	}
	p.inString, p.escape, p.tokenCut, p.scalar = true, false, false, false
	p.token = p.token[:0]
	p.keyToken = len(p.stack) > 0 && p.stack[len(p.stack)-1].object != nil && (p.stack[len(p.stack)-1].expect == 'k' || p.stack[len(p.stack)-1].expect == 'K')
	p.skipString = !p.keyToken && p.skipping()
	p.binary = !p.keyToken && p.binaryField()
	p.image = nil
	p.binaryEncoded, p.binaryCount, p.binaryBad, p.binaryEnd = 0, 0, false, false
	p.binaryEscape = p.binaryEscape[:0]
	native := p.nativeImageContainer()
	nativeData := (native == "responses" && p.currentKey() == "result") || (native == "gemini" && p.currentKey() == "data")
	if p.binary && p.images != nil && (nativeData || (p.imageResult() && p.currentKey() == "b64_json")) {
		p.hasCandidate = true
		frame := &p.stack[len(p.stack)-1]
		if frame.candidate != nil {
			p.images.complete(frame.candidate, frame.candidate.URL != "")
		}
		p.image = &contentAuditImageInput{Index: p.images.session.next, group: p.group}
		p.images.session.next = min(p.images.session.next, math.MaxInt-1) + 1
		frame.candidate = p.image
		if !p.images.send(contentAuditImageEvent{kind: "begin", input: *p.image}) {
			p.images.resourceBusy(p.image)
		}
	}
	if !p.skipString && !p.binary {
		p.token = append(p.token, '"')
	}
}

func (p *contentAuditJSON) base64Byte(ch byte) {
	if p.binaryEncoded < math.MaxInt {
		p.binaryEncoded++
	}
	if p.image == nil || p.image.Error != "" || p.binaryBad {
		return
	}
	if ch == '\r' || ch == '\n' {
		return
	}
	if p.binaryEnd {
		p.binaryBad = true
		return
	}
	p.binaryQuartet[p.binaryCount] = ch
	p.binaryCount++
	if p.binaryCount != 4 {
		return
	}
	var output [3]byte
	n, err := base64.StdEncoding.Strict().Decode(output[:], p.binaryQuartet[:])
	p.binaryCount = 0
	if err != nil {
		p.binaryBad = true
		return
	}
	if cap(p.image.Data)-len(p.image.Data) < n {
		if len(p.image.Data) > 0 {
			block := *p.image
			if !p.images.send(contentAuditImageEvent{kind: "data", input: block}) {
				p.image.Data, p.image.charged = nil, 0
				p.images.resourceBusy(p.image)
				return
			}
			p.image.Data, p.image.charged = nil, 0
		}
		if !p.images.budget.acquire(contentAuditOriginalBlock) {
			p.images.resourceBusy(p.image)
			return
		}
		p.image.Data = make([]byte, 0, contentAuditOriginalBlock)
		p.image.charged = contentAuditOriginalBlock
	}
	p.image.Data = append(p.image.Data, output[:n]...)
	p.binaryEnd = p.binaryQuartet[3] == '='
}

func (p *contentAuditJSON) stringByte(ch byte) {
	if !p.escape && ch == '"' {
		p.finishString()
		return
	}
	if ch < 32 {
		p.invalid = true
		return
	}
	if p.binary {
		if len(p.binaryEscape) > 0 {
			p.binaryEscape = append(p.binaryEscape, ch)
			if (len(p.binaryEscape) == 2 && ch != 'u') || len(p.binaryEscape) == 6 {
				raw := append([]byte{'"'}, p.binaryEscape...)
				raw = append(raw, '"')
				var decoded string
				if common.Unmarshal(raw, &decoded) != nil || len(decoded) != 1 {
					p.binaryBad = true
				} else {
					p.base64Byte(decoded[0])
				}
				p.binaryEscape = p.binaryEscape[:0]
			}
		} else if ch == '\\' {
			p.binaryEscape = append(p.binaryEscape, ch)
		} else {
			p.base64Byte(ch)
		}
	} else if !p.skipString {
		maximum := max(0, p.limit-p.stored)
		if p.keyToken {
			maximum = 256
		} else if p.nativeImageContainer() != "" && (p.currentKey() == "type" || p.currentKey() == "id" || p.currentKey() == "mimeType" || p.currentKey() == "mime_type") {
			maximum = 256
		} else if p.currentKey() == "url" && p.imageResult() {
			// Result downloads own a separate bounded input allowance. A long
			// revised prompt must not truncate the URL before image extraction.
			maximum = 8193
		}
		if len(p.token) < maximum {
			p.token = append(p.token, ch)
		} else {
			p.tokenCut, p.truncated = true, true
		}
	}
	if p.escape {
		p.escape = false
	} else if ch == '\\' {
		p.escape = true
	}
}

func (p *contentAuditJSON) finishString() {
	p.inString = false
	if p.binary {
		if p.image != nil && p.image.Error == "" && (p.binaryBad || p.binaryCount != 0 || len(p.binaryEscape) != 0) {
			p.image.Error = "protocol_invalid"
			p.image.Data = nil
			p.images.budget.release(p.image.charged)
			p.image.charged = 0
		}
		p.add(map[string]any{"omitted": "binary", "encoded_bytes": p.binaryEncoded})
		return
	}
	if p.skipString {
		p.add("[omitted]")
		return
	}
	var value string
	if p.tokenCut {
		if p.keyToken {
			p.invalid = true
			return
		}
		// Trim only the incomplete JSON escape/rune at the bounded token edge.
		for range 8 {
			raw := append(bytes.Clone(p.token), '"')
			if common.Unmarshal(raw, &value) == nil {
				break
			}
			if len(p.token) <= 1 {
				break
			}
			p.token = p.token[:len(p.token)-1]
		}
	} else {
		p.token = append(p.token, '"')
		if common.Unmarshal(p.token, &value) != nil {
			p.invalid = true
			return
		}
	}
	p.stored = min(p.limit+8194, p.stored+len(value))
	if p.keyToken {
		frame := &p.stack[len(p.stack)-1]
		frame.key, frame.expect = value, 'c'
		return
	}
	if p.images != nil && p.currentKey() == "url" && p.imageResult() {
		p.hasCandidate = true
		frame := &p.stack[len(p.stack)-1]
		if frame.candidate != nil {
			p.images.complete(frame.candidate, frame.candidate.URL == "")
		}
		entry := &contentAuditImageInput{Index: p.images.session.next, URL: value, group: p.group}
		p.images.session.next = min(p.images.session.next, math.MaxInt-1) + 1
		if p.tokenCut || len(value) > 8192 {
			entry.URL, entry.Error = "", "protocol_invalid"
		}
		frame.candidate = entry
		if !p.images.send(contentAuditImageEvent{kind: "begin", input: *entry}) {
			p.images.resourceBusy(entry)
		}
	}
	p.add(value)
}

func (p *contentAuditJSON) finishScalar() {
	p.scalar = false
	var value any
	if common.Unmarshal(p.token, &value) != nil {
		p.invalid = true
		return
	}
	switch value.(type) {
	case nil, bool, float64:
		p.add(value)
	default:
		p.invalid = true
	}
	p.token = p.token[:0]
}

func (p *contentAuditJSON) Write(data []byte) (int, error) {
	p.observed = min(int64(math.MaxInt64-len(data)), p.observed) + int64(len(data))
	if p.invalid {
		return len(data), nil
	}
	if p.images == nil && p.observed > contentAuditMaxScan {
		p.invalid, p.truncated = true, true
		return len(data), nil
	}
	for _, ch := range data {
		if p.invalid {
			break
		}
		if p.inString {
			p.stringByte(ch)
			continue
		}
		if p.scalar {
			if ch == ',' || ch == ']' || ch == '}' || ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t' {
				p.finishScalar()
				if p.invalid {
					break
				}
			} else {
				if len(p.token) >= 64 {
					p.invalid = true
					break
				}
				p.token = append(p.token, ch)
				continue
			}
		}
		if ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t' {
			continue
		}
		if ch == '"' {
			p.startString()
			continue
		}
		switch ch {
		case '{', '[':
			if len(p.stack) >= contentAuditMaxDepth {
				p.invalid, p.truncated = true, true
				break
			}
			if p.done || (len(p.stack) > 0 && p.stack[len(p.stack)-1].expect != 'v' && p.stack[len(p.stack)-1].expect != 'V') {
				p.invalid = true
				break
			}
			frame := contentAuditJSONFrame{field: p.currentKey(), skip: p.skipping(), expect: 'v'}
			if ch == '{' {
				frame.object = map[string]any{}
				frame.expect = 'k'
			}
			if len(p.stack) > 0 && p.stack[len(p.stack)-1].expect == 'V' {
				p.stack[len(p.stack)-1].expect = 'v'
			}
			p.stack = append(p.stack, frame)
			if p.nativeImageContainer() == "gemini" {
				// Read only this output object's bounded metadata; add() still
				// replaces inlineData with an attachment marker in the text copy.
				p.stack[len(p.stack)-1].skip = false
			}
		case '}', ']':
			if len(p.stack) == 0 {
				p.invalid = true
				break
			}
			frame := p.stack[len(p.stack)-1]
			if (ch == '}') != (frame.object != nil) || (frame.expect != 'n' && frame.expect != 'k' && frame.expect != 'v') {
				p.invalid = true
				break
			}
			p.finishNativeImage(&frame)
			p.stack = p.stack[:len(p.stack)-1]
			if frame.object != nil {
				p.add(frame.object)
			} else {
				if frame.array == nil {
					frame.array = []any{}
				}
				p.add(frame.array)
			}
		case ':':
			if len(p.stack) == 0 || p.stack[len(p.stack)-1].expect != 'c' {
				p.invalid = true
				break
			}
			p.stack[len(p.stack)-1].expect = 'v'
		case ',':
			if len(p.stack) == 0 || p.stack[len(p.stack)-1].expect != 'n' {
				p.invalid = true
				break
			}
			frame := &p.stack[len(p.stack)-1]
			frame.key = ""
			frame.expect = 'V'
			if frame.object != nil {
				frame.expect = 'K'
			}
		default:
			if len(p.stack) > 0 && p.stack[len(p.stack)-1].expect == 'V' {
				p.stack[len(p.stack)-1].expect = 'v'
			}
			p.scalar = true
			p.token = append(p.token[:0], ch)
		}
	}
	return len(data), nil
}

func (p *contentAuditJSON) value() any {
	if p.scalar {
		p.finishScalar()
	}
	valid := !p.invalid && !p.inString && len(p.stack) == 0 && p.done
	if p.images != nil && p.hasCandidate && !p.finished {
		p.finished = true
		if !p.images.session.broken || p.images.session.failedGroup == p.group {
			p.images.session.lastGroup, p.images.session.lastValid = p.group, valid
		}
		p.images.send(contentAuditImageEvent{kind: "group", group: p.group, valid: valid})
	}
	if !valid {
		for index := len(p.stack) - 1; index >= 0; index-- {
			if p.stack[index].candidate != nil {
				p.images.complete(p.stack[index].candidate, false)
				p.stack[index].candidate = nil
			}
		}
		p.truncated = true
		return map[string]any{"omitted": "parse_or_resource_limit"}
	}
	return p.root
}

func redactContentAuditValue(value any, depth int) any {
	if depth > contentAuditMaxDepth {
		return map[string]any{"omitted": "depth_limit"}
	}
	switch value := value.(type) {
	case map[string]any:
		if kind, ok := value["type"].(string); ok {
			switch kind {
			case "image", "image_url", "input_image", "image_generation_call", "input_audio", "audio", "file", "input_file", "base64":
				return map[string]any{"type": kind, "omitted": "binary"}
			}
		}
		for key, child := range value {
			if contentAuditSecretField(key) {
				value[key] = "[redacted]"
				continue
			}
			if key == "b64_json" || key == "base64" || key == "b64" {
				value[key] = map[string]any{"omitted": "binary"}
				continue
			}
			if contentAuditAttachmentField(key) {
				value[key] = map[string]any{"omitted": "attachment"}
				continue
			}
			lower := strings.ToLower(strings.ReplaceAll(key, "_", ""))
			if text, ok := child.(string); ok {
				if lower == "url" || lower == "uri" || strings.HasSuffix(lower, "url") || strings.HasSuffix(lower, "uri") {
					value[key] = redactContentAuditURL(text)
					continue
				}
				trimmed := strings.TrimSpace(text)
				looksStructured := len(trimmed) > 1 && (trimmed[0] == '{' || trimmed[0] == '[')
				structured := key == "arguments" || key == "partial_json" || (looksStructured && ((key == "content" && (value["role"] == "tool" || value["type"] == "tool_result")) || (key == "output" && value["type"] == "function_call_output")))
				if structured && text != "" {
					parser := newContentAuditJSON(len(text), nil)
					_, _ = parser.Write([]byte(text))
					parsed := parser.value()
					value[key] = "[structured data omitted]"
					if !parser.truncated {
						if encoded, err := common.Marshal(redactContentAuditValue(parsed, depth+1)); err == nil {
							value[key] = string(encoded)
						}
					}
					continue
				}
			}
			value[key] = redactContentAuditValue(child, depth+1)
		}
		return value
	case []any:
		for i := range value {
			value[i] = redactContentAuditValue(value[i], depth+1)
		}
		return value
	case string:
		if strings.HasPrefix(strings.ToLower(value), "data:") {
			return "[binary omitted]"
		}
	}
	return value
}

func boundContentAuditValue(value any, budget *int, truncated *bool) any {
	if *budget < 32 {
		*truncated = true
		return nil
	}
	switch value := value.(type) {
	case map[string]any:
		out := map[string]any{}
		*budget -= 2
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		for _, key := range keys {
			encoded, _ := common.Marshal(key)
			if *budget < len(encoded)+40 {
				*truncated = true
				break
			}
			*budget -= len(encoded) + 2
			out[key] = boundContentAuditValue(value[key], budget, truncated)
		}
		return out
	case []any:
		out := []any{}
		*budget -= 2
		for _, item := range value {
			if *budget < 40 {
				*truncated = true
				break
			}
			*budget--
			out = append(out, boundContentAuditValue(item, budget, truncated))
		}
		return out
	default:
		encoded, _ := common.Marshal(value)
		if len(encoded) <= *budget {
			*budget -= len(encoded)
			return value
		}
		*truncated = true
		text, ok := value.(string)
		if !ok {
			*budget -= 4
			return nil
		}
		low, high := 0, len(text)
		for low < high {
			mid := (low + high + 1) / 2
			piece := strings.ToValidUTF8(text[:mid], "")
			encoded, _ = common.Marshal(piece)
			if len(encoded) <= *budget {
				low = mid
			} else {
				high = mid - 1
			}
		}
		text = strings.ToValidUTF8(text[:low], "")
		encoded, _ = common.Marshal(text)
		*budget -= len(encoded)
		return text
	}
}

func contentAuditSnapshot(value any, limit int, truncated *bool) json.RawMessage {
	value = redactContentAuditValue(value, 0)
	budget := max(32, limit-32)
	encoded, err := common.Marshal(boundContentAuditValue(value, &budget, truncated))
	if err != nil || len(encoded) > limit {
		*truncated = true
		return json.RawMessage(`{"omitted":"size_limit"}`)
	}
	return encoded
}

type contentAuditEvent struct {
	Event string `json:"event,omitempty"`
	Data  any    `json:"data"`
}

type contentAuditResponse struct {
	limit      int
	images     *contentAuditImages
	json       *contentAuditJSON
	stream     bool
	observed   int64
	truncated  bool
	events     []contentAuditEvent
	event      string
	linePrefix []byte
	lineData   bool
	lineEvent  bool
	lineBytes  int
	dataPrefix []byte
	dataSeen   bool
	stored     int
	fields     int
	terminal   bool
}

func newContentAuditResponse(limit int, images *contentAuditImages) *contentAuditResponse {
	return &contentAuditResponse{limit: limit, images: images, json: newContentAuditJSON(limit, images)}
}

func (r *contentAuditResponse) write(data []byte, stream bool) {
	r.observed = min(int64(math.MaxInt64-len(data)), r.observed) + int64(len(data))
	r.stream = stream
	if !stream {
		_, _ = r.json.Write(data)
		return
	}
	for _, ch := range data {
		if ch == '\r' {
			continue
		}
		if ch == '\n' {
			if r.lineBytes == 0 {
				r.finishEvent()
			} else if r.lineData {
				_, _ = r.json.Write([]byte{'\n'})
			}
			r.linePrefix = r.linePrefix[:0]
			r.lineData, r.lineEvent = false, false
			r.lineBytes = 0
			continue
		}
		r.lineBytes = min(r.lineBytes, math.MaxInt-1) + 1
		if r.lineData {
			if len(r.dataPrefix) < 16 {
				r.dataPrefix = append(r.dataPrefix, ch)
			}
			_, _ = r.json.Write([]byte{ch})
			continue
		}
		if r.lineEvent {
			if len(r.event) < 128 {
				r.event += string(ch)
			}
			continue
		}
		if len(r.linePrefix) > 16 {
			continue
		}
		r.linePrefix = append(r.linePrefix, ch)
		if bytes.Equal(r.linePrefix, []byte("data:")) {
			r.lineData, r.dataSeen = true, true
			continue
		}
		if bytes.Equal(r.linePrefix, []byte("event:")) {
			r.lineEvent = true
			r.event = ""
		}
	}
}

func (r *contentAuditResponse) finishEvent() {
	if !r.dataSeen {
		return
	}
	r.fields = min(contentAuditMaxFields+1, r.fields+r.json.fields)
	if strings.TrimSpace(string(r.dataPrefix)) == "[DONE]" {
		r.terminal = true
		if r.stored+64 <= r.limit && len(r.events) < contentAuditMaxFields {
			r.events = append(r.events, contentAuditEvent{Event: "done", Data: "[DONE]"})
			r.stored += 64
		}
	} else {
		value := r.json.value()
		r.truncated = r.truncated || r.json.truncated
		event := contentAuditEvent{Event: strings.TrimSpace(r.event), Data: value}
		// Count an upper bound without retaining a second serialization.
		encoded, _ := common.Marshal(event)
		if r.stored+len(encoded) > r.limit || len(r.events) >= contentAuditMaxFields || r.fields > contentAuditMaxFields {
			r.truncated = true
		} else {
			r.events = append(r.events, event)
			r.stored += len(encoded)
		}
		if event.Event == "message_stop" || event.Event == "response.completed" {
			r.terminal = true
		}
	}
	r.json = newContentAuditJSON(max(64, r.limit-r.stored), r.images)
	r.event = ""
	r.dataPrefix = r.dataPrefix[:0]
	r.dataSeen = false
}

// Tool argument deltas are JSON-encoded strings split at arbitrary boundaries.
// Scrubbing each fragment independently would leak split credential names and
// values. Join by protocol call identity, scrub the complete arguments, and put
// the safe logical delta in the final event; earlier events retain call identity.
func redactContentAuditToolDeltas(events []contentAuditEvent) {
	type fragment struct {
		object map[string]any
		field  string
	}
	groups := map[string][]fragment{}
	for _, event := range events {
		value, ok := event.Data.(map[string]any)
		if !ok {
			continue
		}
		if choices, ok := value["choices"].([]any); ok {
			for _, choice := range choices {
				c, ok := choice.(map[string]any)
				if !ok {
					continue
				}
				delta, _ := c["delta"].(map[string]any)
				calls, _ := delta["tool_calls"].([]any)
				if function, ok := delta["function_call"].(map[string]any); ok {
					key := "openai-function/" + contentAuditScalarID(c["index"])
					groups[key] = append(groups[key], fragment{function, "arguments"})
				}
				for _, call := range calls {
					call, ok := call.(map[string]any)
					if !ok {
						continue
					}
					function, ok := call["function"].(map[string]any)
					if !ok {
						continue
					}
					key := "openai/" + contentAuditScalarID(c["index"]) + "/" + contentAuditScalarID(call["index"])
					groups[key] = append(groups[key], fragment{function, "arguments"})
				}
			}
		}
		if delta, ok := value["delta"].(map[string]any); ok && delta["type"] == "input_json_delta" {
			key := "claude/" + contentAuditScalarID(value["index"])
			groups[key] = append(groups[key], fragment{delta, "partial_json"})
		}
		if event.Event == "response.function_call_arguments.delta" || value["type"] == "response.function_call_arguments.delta" {
			key := "responses/" + contentAuditScalarID(value["item_id"]) + "/" + contentAuditScalarID(value["output_index"])
			groups[key] = append(groups[key], fragment{value, "delta"})
		}
	}
	for _, fragments := range groups {
		var arguments strings.Builder
		for _, fragment := range fragments {
			if text, ok := fragment.object[fragment.field].(string); ok {
				arguments.WriteString(text)
				fragment.object[fragment.field] = ""
			}
		}
		if arguments.Len() == 0 {
			continue
		}
		parser := newContentAuditJSON(arguments.Len(), nil)
		_, _ = parser.Write([]byte(arguments.String()))
		value := parser.value()
		replacement := `{"omitted":"incomplete_tool_arguments"}`
		if !parser.truncated {
			encoded, err := common.Marshal(redactContentAuditValue(value, 0))
			if err == nil {
				replacement = string(encoded)
			}
		}
		last := fragments[len(fragments)-1]
		last.object[last.field] = replacement
	}
}

func (r *contentAuditResponse) snapshot() json.RawMessage {
	if !r.stream {
		value := r.json.value()
		r.truncated = r.truncated || r.json.truncated
		return contentAuditSnapshot(value, r.limit, &r.truncated)
	}
	r.finishEvent()
	redactContentAuditToolDeltas(r.events)
	values := make([]any, 0, len(r.events))
	for _, event := range r.events {
		values = append(values, map[string]any{"event": event.Event, "data": event.Data})
	}
	return contentAuditSnapshot(map[string]any{"events": values}, r.limit, &r.truncated)
}

// NextPart's standard MIME parser otherwise allows multi-megabyte headers.
// A per-header read allowance bounds it without buffering/skipping whole files.
type contentAuditBoundedReader struct {
	reader    io.Reader
	remaining int64
	allowance int64
	deadline  time.Time
}

func (r *contentAuditBoundedReader) Read(data []byte) (int, error) {
	if r.remaining <= 0 || r.allowance <= 0 || time.Now().After(r.deadline) {
		return 0, io.ErrUnexpectedEOF
	}
	data = data[:min(int64(len(data)), r.remaining, r.allowance)]
	n, err := r.reader.Read(data)
	r.remaining -= int64(n)
	r.allowance -= int64(n)
	return n, err
}

func captureContentAuditRequest(reader io.Reader, contentType string, limit int) (json.RawMessage, int64, bool) {
	mediaType, parameters, _ := mime.ParseMediaType(contentType)
	if mediaType == "multipart/form-data" {
		bounded := &contentAuditBoundedReader{reader: reader, remaining: contentAuditMaxScan, deadline: time.Now().Add(100 * time.Millisecond)}
		form := multipart.NewReader(bounded, parameters["boundary"])
		values := map[string]any{}
		var observed int64
		stored := 0
		truncated := false
		for index := range 129 {
			bounded.allowance = 32 << 10
			part, err := form.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil || index == 128 {
				truncated = true
				break
			}
			bounded.allowance = contentAuditMaxScan
			name := part.FormName()
			if name == "" || len(name) > 256 {
				truncated = true
				break
			}
			if part.FileName() != "" || contentAuditAttachmentField(name) {
				n, err := io.Copy(io.Discard, io.LimitReader(part, contentAuditMaxScan-observed))
				observed += n
				values[name] = map[string]any{"omitted": "attachment", "bytes": n}
				if err != nil || observed >= contentAuditMaxScan {
					truncated = true
					break
				}
				continue
			}
			remaining := max(0, limit-stored)
			data, err := io.ReadAll(io.LimitReader(part, int64(remaining)+1))
			observed += int64(len(data))
			if err != nil || len(data) > remaining {
				truncated = true
				break
			}
			stored += len(data) + len(name)
			values[name] = string(data)
			if contentAuditSecretField(name) {
				values[name] = "[redacted]"
			}
		}
		return contentAuditSnapshot(values, limit, &truncated), observed, truncated
	}
	parser := newContentAuditJSON(limit, nil)
	buffer := make([]byte, 32<<10)
	deadline := time.Now().Add(100 * time.Millisecond)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			_, _ = parser.Write(buffer[:n])
		}
		if err == io.EOF {
			break
		}
		if err != nil || parser.invalid || time.Now().After(deadline) {
			parser.invalid, parser.truncated = true, true
			break
		}
	}
	value := parser.value()
	return contentAuditSnapshot(value, limit, &parser.truncated), parser.observed, parser.truncated
}

func contentAuditScalarID(value any) string {
	switch value := value.(type) {
	case string:
		return value
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	return ""
}

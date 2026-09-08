package controller

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/tidwall/gjson"
)

type channelProbeToolCall struct {
	name      string
	arguments string
}

type channelProbeResponse struct {
	endpoint string
	stream   bool
	output   bool
	finished bool
	reason   string
	detail   string
	events   int
	tools    map[string]*channelProbeToolCall
	toolIDs  map[string]string
}

// Validate the full recorded response independently of preview visibility or
// redaction: late errors and complete tool arguments participate in the result.
func validateChannelProbeResponse(body []byte, d *channelTestDiagnostics, streamStatus *relaycommon.StreamStatus) {
	d.Status, d.Reason = "failed", "empty_response"
	if len(bytes.TrimSpace(body)) == 0 {
		return
	}
	response := channelProbeResponse{endpoint: d.EndpointType, stream: d.RequestedStream, tools: make(map[string]*channelProbeToolCall)}
	if d.RequestedStream {
		response.consumeStream(body)
	} else {
		response.consumeJSON(body)
	}
	d.EventCount = response.events
	d.ToolCount = len(response.tools)
	d.Detail = sanitizeChannelTestResponsePreview([]byte(response.detail))
	if d.TestType == "tool_call" {
		namesValid, argumentsValid := len(response.tools) > 0, len(response.tools) > 0
		for _, call := range response.tools {
			namesValid = namesValid && call.name == channelTestToolName
			var arguments map[string]any
			err := common.UnmarshalJsonStr(call.arguments, &arguments)
			argumentsValid = argumentsValid && err == nil && len(arguments) == 1 && arguments["message"] == "ping"
		}
		d.ToolNameValid, d.ToolArgumentsValid = &namesValid, &argumentsValid
	}
	if response.reason != "" {
		d.Reason = response.reason
		return
	}
	if d.RequestedStream && streamStatus != nil {
		if streamStatus.EndReason == relaycommon.StreamEndReasonTimeout {
			d.Reason = "stream_timeout"
			return
		}
		if streamStatus.HasErrors() || streamStatus.EndError != nil || !streamStatus.IsNormalEnd() {
			d.Reason = "stream_interrupted"
			return
		}
	}
	if d.RequestedStream && response.events == 0 {
		d.Reason = "invalid_stream"
		return
	}
	if d.RequestedStream && !response.finished {
		d.Reason = "incomplete_stream"
		return
	}
	if d.TestType == "tool_call" {
		switch {
		case len(response.tools) == 0:
			d.Reason = "tool_not_called"
		case !*d.ToolNameValid:
			d.Reason = "unexpected_tool"
		case !*d.ToolArgumentsValid:
			d.Reason = "invalid_tool_arguments"
		default:
			d.Status, d.Reason = "passed", "tool_validated"
		}
	} else if !response.output {
		d.Reason = "empty_output"
	} else {
		d.Status, d.Reason = "passed", "response_validated"
	}
	if d.Status == "passed" && d.RequestedStream && d.UpstreamStream != nil && !*d.UpstreamStream {
		d.Status, d.Reason = "degraded", "compatibility_stream"
	}
}

func (r *channelProbeResponse) consumeStream(body []byte) {
	var data [][]byte
	event := ""
	for len(body) > 0 {
		line, rest, _ := bytes.Cut(body, []byte{'\n'})
		body = rest
		line = bytes.TrimSuffix(line, []byte{'\r'})
		if len(line) == 0 {
			r.consumeEvent(data, event)
			data, event = nil, ""
			continue
		}
		if value, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			data = append(data, bytes.TrimPrefix(value, []byte{' '}))
		} else if value, ok := bytes.CutPrefix(line, []byte("event:")); ok {
			event = strings.TrimSpace(string(value))
		} else if line[0] != ':' && !bytes.HasPrefix(line, []byte("id:")) && !bytes.HasPrefix(line, []byte("retry:")) {
			r.reason = "invalid_stream"
		}
	}
	r.consumeEvent(data, event)
}

func (r *channelProbeResponse) consumeEvent(data [][]byte, event string) {
	if event == "error" || event == "upstream_error" {
		r.reason = "upstream_error"
		if len(data) > 0 {
			r.detail = detectErrorMessageFromJSONBytes(bytes.Join(data, []byte{'\n'}))
		}
		return
	}
	if len(data) == 0 || r.reason != "" {
		return
	}
	payload := bytes.TrimSpace(bytes.Join(data, []byte{'\n'}))
	if bytes.Equal(payload, []byte("[DONE]")) {
		if r.endpoint == "openai" {
			r.finished = true
		}
		return
	}
	r.events++
	r.consumeJSON(payload)
}

func (r *channelProbeResponse) consumeJSON(body []byte) {
	if !gjson.ValidBytes(body) {
		r.reason = "invalid_json"
		return
	}
	payload := gjson.ParseBytes(body)
	if !payload.IsObject() {
		r.reason = "invalid_response"
		return
	}
	if message := detectErrorMessageFromJSONBytes(body); message != "" || payload.Get("type").String() == "error" || payload.Get("type").String() == "upstream_error" {
		r.reason = "upstream_error"
		r.detail = message
		if r.detail == "" {
			r.detail = payload.Get("message").String()
		}
		return
	}
	switch r.endpoint {
	case "openai":
		r.consumeChat(payload)
	case "openai-response":
		r.consumeResponses(payload)
	case "anthropic":
		r.consumeClaude(payload)
	case "gemini":
		r.consumeGemini(payload)
	case "image-generation":
		if r.stream {
			kind := payload.Get("type").String()
			if kind == "image_generation.completed" || kind == "image_edit.completed" {
				r.finished = true
				r.output = r.output || validChannelProbeImage(payload)
			}
		} else {
			payload.Get("data").ForEach(func(_, item gjson.Result) bool {
				r.output = r.output || validChannelProbeImage(item)
				return true
			})
		}
	case "embeddings":
		payload.Get("data").ForEach(func(_, item gjson.Result) bool {
			embedding := item.Get("embedding")
			if embedding.IsArray() && len(embedding.Array()) > 0 {
				valid := true
				embedding.ForEach(func(_, value gjson.Result) bool {
					valid = valid && value.Type == gjson.Number
					return valid
				})
				r.output = r.output || valid
			}
			return true
		})
	case "jina-rerank":
		payload.Get("results").ForEach(func(_, item gjson.Result) bool {
			r.output = r.output || (item.Get("index").Type == gjson.Number && item.Get("relevance_score").Type == gjson.Number)
			return true
		})
	case "openai-response-compact":
		payload.Get("output").ForEach(func(_, item gjson.Result) bool {
			r.output = r.output || (item.Get("type").String() == "compaction" && item.Get("encrypted_content").String() != "")
			return true
		})
	}
}

func (r *channelProbeResponse) consumeChat(payload gjson.Result) {
	payload.Get("choices").ForEach(func(choiceIndex, choice gjson.Result) bool {
		prefix := fmt.Sprintf("%d", choiceIndex.Int())
		if choice.Get("index").Exists() {
			prefix = choice.Get("index").Raw
		}
		finish := choice.Get("finish_reason").String()
		if finish == "length" {
			r.reason = "output_incomplete"
		} else if finish == "content_filter" {
			r.reason = "output_blocked"
		} else if finish != "" {
			r.finished = true
		}
		message := choice.Get("message")
		if r.stream {
			message = choice.Get("delta")
		}
		r.output = r.output || channelProbeHasText(message.Get("content")) || channelProbeHasText(choice.Get("text"))
		message.Get("tool_calls").ForEach(func(index, call gjson.Result) bool {
			if call.Get("index").Exists() {
				index = call.Get("index")
			}
			key := r.toolKey(prefix+":"+index.String(), call.Get("id").String())
			r.recordTool(key, call.Get("function.name").String(), call.Get("function.arguments").String(), r.stream)
			return true
		})
		return true
	})
}

func (r *channelProbeResponse) consumeResponses(payload gjson.Result) {
	if !r.stream {
		r.consumeResponsesOutput(payload)
		return
	}
	kind := payload.Get("type").String()
	key := r.toolKey(payload.Get("output_index").Raw, payload.Get("item_id").String())
	switch kind {
	case "response.output_text.delta":
		r.output = r.output || channelProbeHasText(payload.Get("delta"))
	case "response.output_item.added", "response.output_item.done":
		item := payload.Get("item")
		if item.Get("id").String() != "" {
			key = r.toolKey(payload.Get("output_index").Raw, item.Get("id").String())
		}
		if item.Get("type").String() == "function_call" {
			r.recordTool(key, item.Get("name").String(), item.Get("arguments").String(), false)
		}
		r.output = r.output || channelProbeHasText(item.Get("content"))
	case "response.function_call_arguments.delta":
		r.recordTool(key, "", payload.Get("delta").String(), true)
	case "response.function_call_arguments.done":
		r.recordTool(key, payload.Get("name").String(), payload.Get("arguments").String(), false)
	case "response.completed":
		r.finished = true
		r.consumeResponsesOutput(payload.Get("response"))
	case "response.incomplete":
		r.reason = "output_incomplete"
	case "response.failed":
		r.reason = "upstream_error"
	}
}

func (r *channelProbeResponse) consumeResponsesOutput(payload gjson.Result) {
	if !r.stream && payload.Get("status").String() != "completed" {
		r.reason = "output_incomplete"
	}
	switch payload.Get("status").String() {
	case "incomplete":
		r.reason = "output_incomplete"
	case "failed", "cancelled":
		r.reason = "upstream_error"
	case "completed":
		r.finished = true
	}
	payload.Get("output").ForEach(func(index, item gjson.Result) bool {
		if item.Get("type").String() == "function_call" {
			key := r.toolKey(index.String(), item.Get("id").String())
			r.recordTool(key, item.Get("name").String(), item.Get("arguments").String(), false)
		}
		r.output = r.output || channelProbeHasText(item.Get("content"))
		return true
	})
}

func (r *channelProbeResponse) consumeClaude(payload gjson.Result) {
	if !r.stream {
		if payload.Get("stop_reason").String() == "max_tokens" {
			r.reason = "output_incomplete"
		}
		payload.Get("content").ForEach(func(index, item gjson.Result) bool {
			r.output = r.output || channelProbeHasText(item.Get("text"))
			if item.Get("type").String() == "tool_use" {
				r.recordTool(index.String(), item.Get("name").String(), item.Get("input").Raw, false)
			}
			return true
		})
		return
	}
	key := payload.Get("index").Raw
	switch payload.Get("type").String() {
	case "content_block_start":
		block := payload.Get("content_block")
		r.output = r.output || channelProbeHasText(block.Get("text"))
		if block.Get("type").String() == "tool_use" {
			args := block.Get("input").Raw
			if args == "{}" {
				args = ""
			}
			r.recordTool(key, block.Get("name").String(), args, false)
		}
	case "content_block_delta":
		delta := payload.Get("delta")
		r.output = r.output || channelProbeHasText(delta.Get("text"))
		if delta.Get("type").String() == "input_json_delta" {
			r.recordTool(key, "", delta.Get("partial_json").String(), true)
		}
	case "message_delta":
		if payload.Get("delta.stop_reason").String() == "max_tokens" {
			r.reason = "output_incomplete"
		}
	case "message_stop":
		r.finished = true
	}
}

func (r *channelProbeResponse) consumeGemini(payload gjson.Result) {
	payload.Get("candidates").ForEach(func(candidateIndex, candidate gjson.Result) bool {
		finish := candidate.Get("finishReason").String()
		switch finish {
		case "MAX_TOKENS":
			r.reason = "output_incomplete"
		case "STOP":
			r.finished = true
		case "":
		default:
			r.reason = "output_blocked"
		}
		candidate.Get("content.parts").ForEach(func(partIndex, part gjson.Result) bool {
			r.output = r.output || channelProbeHasText(part.Get("text"))
			call := part.Get("functionCall")
			if call.IsObject() {
				r.recordTool(candidateIndex.String()+":"+partIndex.String(), call.Get("name").String(), call.Get("args").Raw, false)
			}
			return true
		})
		return true
	})
}

func (r *channelProbeResponse) recordTool(key, name, arguments string, appendDelta bool) {
	if len(r.tools) >= 64 && r.tools[key] == nil {
		r.reason = "response_too_large"
		return
	}
	call := r.tools[key]
	if call == nil {
		call = &channelProbeToolCall{}
		r.tools[key] = call
	}
	if appendDelta {
		if name != call.name {
			call.name += name
		}
		call.arguments += arguments
	} else {
		if name != "" {
			call.name = name
		}
		if arguments != "" {
			call.arguments = arguments
		}
	}
	if len(call.arguments) > 64<<10 || len(call.name) > 256 {
		r.reason = "response_too_large"
	}
}

func (r *channelProbeResponse) toolKey(position, id string) string {
	if r.toolIDs == nil {
		r.toolIDs = make(map[string]string)
	}
	if id == "" {
		if known := r.toolIDs[position]; known != "" {
			return known
		}
		return position
	}
	key := "id:" + id
	if existing := r.tools[position]; existing != nil && r.tools[key] == nil {
		r.tools[key] = existing
		delete(r.tools, position)
	}
	r.toolIDs[position] = key
	return key
}

func channelProbeHasText(value gjson.Result) bool {
	if value.Type == gjson.String {
		return strings.TrimSpace(value.String()) != ""
	}
	if value.IsArray() {
		for _, part := range value.Array() {
			if text := part.Get("text"); text.Type == gjson.String && strings.TrimSpace(text.String()) != "" {
				return true
			}
		}
	}
	return false
}

func validChannelProbeImage(item gjson.Result) bool {
	encoded := item.Get("b64_json")
	if encoded.Type == gjson.String && strings.TrimSpace(encoded.String()) != "" {
		decoded, err := base64.StdEncoding.DecodeString(encoded.String())
		return err == nil && len(decoded) > 0
	}
	imageURL := item.Get("url").String()
	parsed, err := url.Parse(imageURL)
	return err == nil && parsed.Host != "" && (parsed.Scheme == "https" || parsed.Scheme == "http")
}

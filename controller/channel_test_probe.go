package controller

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/tidwall/gjson"
)

const channelTestToolName = "channel_test_echo"
const channelTestToolMessage = `Call channel_test_echo exactly once with {"message":"ping"}. Do not answer with text.`

// Matches the suffix the rest of the channel test flow uses to route a model
// to the response-compaction endpoint.
const channelTestCompactModelSuffix = "-compact"

type channelTestDiagnostics struct {
	Status             string `json:"status"`
	Reason             string `json:"reason"`
	EndpointType       string `json:"endpoint_type"`
	EndpointPath       string `json:"endpoint_path,omitempty"`
	TestType           string `json:"test_type"`
	RequestedStream    bool   `json:"requested_stream"`
	UpstreamStream     *bool  `json:"upstream_stream,omitempty"`
	DurationMS         int64  `json:"duration_ms"`
	FirstResponseMS    *int64 `json:"first_response_ms,omitempty"`
	EventCount         int    `json:"event_count"`
	ToolCount          int    `json:"tool_count"`
	ToolNameValid      *bool  `json:"tool_name_valid,omitempty"`
	ToolArgumentsValid *bool  `json:"tool_arguments_valid,omitempty"`
	Detail             string `json:"detail,omitempty"`
}

// Observe the response while the existing adaptor reads it. A converted client
// stream may contain a synthetic terminator even when the upstream was cut off.
type channelProbeUpstreamCapture struct {
	io.ReadCloser
	body        bytes.Buffer
	started     time.Time
	firstByteMS *int64
}

func (r *channelProbeUpstreamCapture) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		if r.firstByteMS == nil {
			r.firstByteMS = common.GetPointer(time.Since(r.started).Milliseconds())
		}
		_, _ = r.body.Write(p[:n])
	}
	return n, err
}

func channelProbeUpstreamEndpoint(request any) string {
	switch request.(type) {
	case *dto.GeneralOpenAIRequest, dto.GeneralOpenAIRequest:
		return "openai"
	case *dto.OpenAIResponsesRequest, dto.OpenAIResponsesRequest:
		return "openai-response"
	case *dto.ClaudeRequest, dto.ClaudeRequest:
		return "anthropic"
	case *dto.GeminiChatRequest, dto.GeminiChatRequest:
		return "gemini"
	case *dto.ImageRequest, dto.ImageRequest:
		return "image-generation"
	case *dto.EmbeddingRequest, dto.EmbeddingRequest:
		return "embeddings"
	case *dto.RerankRequest, dto.RerankRequest:
		return "jina-rerank"
	}
	return ""
}

// Resolve once, then use the same endpoint for request construction and validation.
// Legacy tests retain their existing endpoint selection rules.
func resolveChannelProbeEndpoint(channel *model.Channel, modelName, override string) (string, error) {
	endpoint := strings.TrimSpace(override)
	if endpoint != "" && !strings.EqualFold(endpoint, "auto") {
		if !isChannelProbeEndpoint(endpoint) {
			return "", fmt.Errorf("unsupported channel test endpoint: %s", endpoint)
		}
		return endpoint, nil
	}
	if channel.Type == constant.ChannelTypeAdvancedCustom {
		settings := channel.GetOtherSettings()
		if settings.AdvancedCustom != nil {
			for _, candidate := range settings.AdvancedCustom.SupportedEndpointTypesForModel(modelName) {
				if isChannelProbeEndpoint(string(candidate)) {
					return string(candidate), nil
				}
			}
		}
		return "", fmt.Errorf("no testable endpoint is configured for this model")
	}
	// Classify aliases using their configured upstream model, without mutating the request.
	upstreamModel := modelName
	if mapping := channel.GetModelMapping(); mapping != "" {
		var names map[string]string
		if err := common.UnmarshalJsonStr(mapping, &names); err != nil {
			return "", fmt.Errorf("invalid channel model mapping: %w", err)
		}
		visited := make(map[string]bool)
		for names[upstreamModel] != "" && !visited[upstreamModel] {
			visited[upstreamModel] = true
			upstreamModel = names[upstreamModel]
		}
	}
	name := strings.ToLower(upstreamModel)
	if strings.HasSuffix(modelName, channelTestCompactModelSuffix) || strings.HasSuffix(upstreamModel, channelTestCompactModelSuffix) {
		return string(constant.EndpointTypeOpenAIResponseCompact), nil
	}
	if strings.Contains(name, "rerank") || channel.Type == constant.ChannelTypeJina {
		return string(constant.EndpointTypeJinaRerank), nil
	}
	if strings.Contains(name, "embed") || strings.HasPrefix(name, "m3e") || strings.Contains(name, "bge-") || channel.Type == constant.ChannelTypeMokaAI {
		return string(constant.EndpointTypeEmbeddings), nil
	}
	if common.IsImageGenerationModel(name) || strings.Contains(name, "gpt-image-") || strings.Contains(name, "seedream") {
		return string(constant.EndpointTypeImageGeneration), nil
	}
	if strings.Contains(name, "codex") {
		return string(constant.EndpointTypeOpenAIResponse), nil
	}
	for _, candidate := range common.GetEndpointTypesByChannelType(channel.Type, upstreamModel) {
		if isChannelProbeEndpoint(string(candidate)) {
			return string(candidate), nil
		}
	}
	return "", fmt.Errorf("this channel has no testable endpoint")
}

func isChannelProbeEndpoint(endpoint string) bool {
	switch constant.EndpointType(endpoint) {
	case constant.EndpointTypeOpenAI, constant.EndpointTypeOpenAIResponse,
		constant.EndpointTypeAnthropic, constant.EndpointTypeGemini,
		constant.EndpointTypeImageGeneration, constant.EndpointTypeEmbeddings,
		constant.EndpointTypeJinaRerank, constant.EndpointTypeOpenAIResponseCompact:
		return true
	}
	return false
}

func channelProbeNotApplicable(endpoint, testType string, stream bool) bool {
	switch constant.EndpointType(endpoint) {
	case constant.EndpointTypeEmbeddings, constant.EndpointTypeJinaRerank, constant.EndpointTypeOpenAIResponseCompact:
		return stream || testType == "tool_call"
	case constant.EndpointTypeImageGeneration:
		return testType == "tool_call"
	}
	return false
}

func configureChannelProbeRequest(request dto.Request, testType string, stream bool, message string) error {
	if image, ok := request.(*dto.ImageRequest); ok {
		image.Stream = common.GetPointer(stream)
		if strings.TrimSpace(message) != "" {
			image.Prompt = strings.TrimSpace(message)
		}
		return nil
	}
	if general, ok := request.(*dto.GeneralOpenAIRequest); ok {
		applyChannelTestModelBudget(general, general.Model)
	}
	if testType != "tool_call" {
		return nil
	}
	parameters := map[string]any{
		"type":       "object",
		"properties": map[string]any{"message": map[string]any{"type": "string", "enum": []string{"ping"}}},
		"required":   []string{"message"}, "additionalProperties": false,
	}
	switch req := request.(type) {
	case *dto.GeneralOpenAIRequest:
		req.Messages = []dto.Message{{Role: "user", Content: channelTestToolMessage}}
		req.Tools = []dto.ToolCallRequest{{Type: "function", Function: dto.FunctionRequest{
			Name: channelTestToolName, Description: "Echo the probe message to verify tool calling.", Parameters: parameters,
		}}}
		req.ToolChoice = "auto"
		if req.MaxCompletionTokens != nil {
			req.MaxCompletionTokens = common.GetPointer(max(*req.MaxCompletionTokens, uint(1024)))
		} else {
			limit := uint(1024)
			if req.MaxTokens != nil {
				limit = max(limit, *req.MaxTokens)
			}
			req.MaxTokens = &limit
		}
	case *dto.OpenAIResponsesRequest:
		input, err := common.Marshal([]map[string]any{{"type": "message", "role": "user", "content": []map[string]string{{"type": "input_text", "text": channelTestToolMessage}}}})
		if err != nil {
			return err
		}
		tools, err := common.Marshal([]map[string]any{{"type": "function", "name": channelTestToolName, "description": "Echo the probe message to verify tool calling.", "parameters": parameters}})
		if err != nil {
			return err
		}
		req.Input, req.Tools = input, tools
		req.ToolChoice = []byte(`"auto"`)
		limit := uint(1024)
		if req.MaxOutputTokens != nil {
			limit = max(limit, *req.MaxOutputTokens)
		}
		req.MaxOutputTokens = &limit
	case *dto.ClaudeRequest:
		// Native Anthropic requests reach the probe already in Claude shape, so
		// the tool is declared with Claude's own schema field.
		req.Messages = []dto.ClaudeMessage{{Role: "user", Content: channelTestToolMessage}}
		req.Tools = []dto.Tool{{
			Name: channelTestToolName, Description: "Echo the probe message to verify tool calling.", InputSchema: parameters,
		}}
		req.ToolChoice = map[string]any{"type": "auto"}
		limit := uint(1024)
		if req.MaxTokens != nil {
			limit = max(limit, *req.MaxTokens)
		}
		req.MaxTokens, req.MaxTokensToSample = &limit, nil
	case *dto.GeminiChatRequest:
		tools, err := common.Marshal([]map[string]any{{"functionDeclarations": []map[string]any{{
			"name": channelTestToolName, "description": "Echo the probe message to verify tool calling.", "parameters": parameters,
		}}}})
		if err != nil {
			return err
		}
		req.Contents = []dto.GeminiChatContent{{Role: "user", Parts: []dto.GeminiPart{{Text: channelTestToolMessage}}}}
		req.Tools = tools
		limit := uint(1024)
		if req.GenerationConfig.MaxOutputTokens != nil {
			limit = max(limit, *req.GenerationConfig.MaxOutputTokens)
		}
		req.GenerationConfig.MaxOutputTokens = &limit
	default:
		return fmt.Errorf("tool probe is not applicable to this request")
	}
	return nil
}

func applyChannelTestModelBudget(request *dto.GeneralOpenAIRequest, modelName string) {
	if dto.IsOpenAIReasoningOModel(modelName) {
		limit := uint(16)
		if request.MaxTokens != nil {
			limit = max(limit, *request.MaxTokens)
		}
		if request.MaxCompletionTokens != nil {
			limit = max(limit, *request.MaxCompletionTokens)
		}
		request.MaxCompletionTokens, request.MaxTokens = &limit, nil
		return
	}
	limit := uint(16)
	if strings.Contains(modelName, "thinking") {
		if strings.Contains(modelName, "claude") {
			return
		}
		limit = 50
	} else if strings.Contains(modelName, "gemini") {
		limit = 3000
	}
	if request.MaxTokens == nil || *request.MaxTokens < limit {
		request.MaxTokens = &limit
	}
}

// Channel overrides still apply, but a probe must keep its single-image count
// and enough output tokens to finish the fixed tool call.
func enforceChannelProbeLimits(body, template []byte, endpoint, testType string) ([]byte, error) {
	if endpoint != "image-generation" && testType != "tool_call" {
		return body, nil
	}
	var fields map[string]json.RawMessage
	if err := common.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, fmt.Errorf("channel probe request must be a JSON object")
	}
	if endpoint == "image-generation" {
		fields["n"] = json.RawMessage("1")
		return common.Marshal(fields)
	}
	key := "max_tokens"
	switch endpoint {
	case "openai":
		if gjson.GetBytes(template, "max_completion_tokens").Exists() {
			key = "max_completion_tokens"
		}
	case "openai-response":
		key = "max_output_tokens"
	case "gemini":
		key = "generationConfig.maxOutputTokens"
	case "anthropic":
	default:
		return body, nil
	}
	limit := max(uint64(1024), gjson.GetBytes(template, key).Uint())
	current := gjson.GetBytes(body, key)
	if current.Type == gjson.Number && current.Float() > 0 {
		limit = max(limit, current.Uint())
	}
	encoded, err := common.Marshal(limit)
	if err != nil {
		return nil, err
	}
	if endpoint == "gemini" {
		var config map[string]json.RawMessage
		if raw := fields["generationConfig"]; len(raw) > 0 {
			if err := common.Unmarshal(raw, &config); err != nil {
				return nil, err
			}
		}
		if config == nil {
			config = make(map[string]json.RawMessage)
		}
		config["maxOutputTokens"] = encoded
		fields["generationConfig"], err = common.Marshal(config)
		if err != nil {
			return nil, err
		}
	} else {
		fields[key] = encoded
	}
	return common.Marshal(fields)
}

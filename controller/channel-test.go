package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/QuantumNous/new-api/relay"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	hosttypes "github.com/QuantumNous/new-api/types"

	"github.com/samber/lo"
	"github.com/tidwall/gjson"

	"github.com/gin-gonic/gin"
)

type testResult struct {
	context          *gin.Context
	localErr         error
	newAPIError      *types.NewAPIError
	responsePreview  string
	previewTruncated bool
	// diagnostics is set only for capability probes, where the caller wants the
	// per-endpoint verdict rather than a plain pass/fail.
	diagnostics *channelTestDiagnostics
}

type channelTestOptions struct {
	// testType selects a capability probe ("basic" or "tool_call"). Empty keeps
	// the legacy single-shot test with its existing endpoint selection rules.
	testType        string
	message         string
	useChannelStyle bool
	capturePreview  bool
	skipConsumeLog  bool
	maxTokens       *uint
}

const channelTestResponsePreviewMaxBytes = 8 << 10

var (
	channelTestPreviewSensitiveValuePattern = regexp.MustCompile(`(?i)\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential|signature)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;&}\"']+`)
	channelTestPreviewBearerPattern         = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/-]+={0,2}`)
	// Applied before the looser value pattern: a JSON string value or query
	// parameter must be redacted whole, not truncated at its first quote.
	channelTestPreviewSensitiveJSONPattern  = regexp.MustCompile(`(?i)((?:"|')?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|token|secret|password|credential|signature)(?:"|')?\s*:\s*)"(?:bearer\s+)?(?:\\.|[^"\\])*"`)
	channelTestPreviewSensitiveQueryPattern = regexp.MustCompile(`(?i)([?&;](?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|token|secret|password|credential|signature)=)([^&#\s,;\}"'()\]]*)`)
)

func normalizeChannelTestEndpoint(channel *model.Channel, modelName, endpointType string) string {
	normalized := strings.TrimSpace(endpointType)
	if strings.EqualFold(normalized, "auto") {
		normalized = ""
	}
	if normalized != "" {
		return normalized
	}
	if strings.HasSuffix(modelName, "-compact") {
		return string(constant.EndpointTypeOpenAIResponseCompact)
	}
	if channel != nil && (channel.Type == constant.ChannelTypeCodex || channel.Type == constant.ChannelTypeCodexCompatibility) {
		return string(constant.EndpointTypeOpenAIResponse)
	}
	if strings.HasSuffix(modelName, "-compact") {
		return string(constant.EndpointTypeOpenAIResponseCompact)
	}
	return normalized
}

func resolveChannelTestUserID(c *gin.Context) (int, error) {
	if c != nil {
		if userID := c.GetInt("id"); userID > 0 {
			return userID, nil
		}
	}

	var rootUser model.User
	if err := model.DB.Select("id").Where("role = ?", common.RoleRootUser).First(&rootUser).Error; err != nil {
		return 0, fmt.Errorf("failed to resolve channel test user: %w", err)
	}
	if rootUser.Id == 0 {
		return 0, errors.New("failed to resolve channel test user")
	}
	return rootUser.Id, nil
}

func testChannel(ctx context.Context, channel *model.Channel, testUserID int, testModel string, endpointType string, isStream bool) testResult {
	setting := operation_setting.GetMonitorSetting()
	return testChannelWithOptions(ctx, channel, testUserID, testModel, endpointType, isStream, channelTestOptions{
		message:         setting.ChannelTestMessage,
		useChannelStyle: setting.ChannelTestUseChannelStyle,
	})
}

func testChannelWithOptions(ctx context.Context, channel *model.Channel, testUserID int, testModel string, endpointType string, isStream bool, options channelTestOptions) (outcome testResult) {
	started := time.Now()
	var diagnostics *channelTestDiagnostics
	if options.testType != "" {
		diagnostics = &channelTestDiagnostics{
			Status:          "failed",
			Reason:          "request_failed",
			TestType:        options.testType,
			RequestedStream: isStream,
			EndpointType:    endpointType,
		}
		defer func() {
			diagnostics.DurationMS = time.Since(started).Milliseconds()
			outcome.diagnostics = diagnostics
			// A transport or billing failure outranks whatever the response
			// validator concluded from a partial body.
			if outcome.localErr != nil || outcome.newAPIError != nil {
				if diagnostics.Status == "passed" || diagnostics.Status == "degraded" {
					diagnostics.Reason = "request_failed"
				}
				diagnostics.Status = "failed"
			}
		}()
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if channel == nil {
		return testResult{localErr: errors.New("channel is nil")}
	}
	resolvedMessage, messageErr := operation_setting.ResolveChannelTestMessage(options.message)
	if messageErr != nil {
		return testResult{localErr: messageErr}
	}
	options.message = resolvedMessage
	tik := time.Now()
	var unsupportedTestChannelTypes = []int{
		constant.ChannelTypeMidjourney,
		constant.ChannelTypeMidjourneyPlus,
		constant.ChannelTypeSunoAPI,
		constant.ChannelTypeKling,
		constant.ChannelTypeJimeng,
		constant.ChannelTypeDoubaoVideo,
		constant.ChannelTypeVidu,
		constant.ChannelTypeTaskPlugin,
	}
	if lo.Contains(unsupportedTestChannelTypes, channel.Type) {
		channelTypeName := constant.GetChannelTypeName(channel.Type)
		return testResult{
			localErr: fmt.Errorf("%s channel test is not supported", channelTypeName),
		}
	}
	w := httptest.NewRecorder()
	if diagnostics != nil && options.capturePreview {
		// The verdict uses the full body; the preview shown to the admin is
		// redacted and truncated separately.
		defer func() {
			outcome.responsePreview = sanitizeChannelTestResponsePreview(w.Body.Bytes())
		}()
	}
	c, _ := gin.CreateTestContext(w)

	testModel = strings.TrimSpace(testModel)
	if testModel == "" {
		if channel.TestModel != nil && *channel.TestModel != "" {
			testModel = strings.TrimSpace(*channel.TestModel)
		} else {
			models := channel.GetModels()
			if len(models) > 0 {
				testModel = strings.TrimSpace(models[0])
			}
			if testModel == "" {
				testModel = "gpt-4o-mini"
			}
		}
	}

	if diagnostics != nil {
		// Resolve once, so request construction and response validation agree on
		// the endpoint even when the model is an alias.
		resolvedEndpoint, endpointErr := resolveChannelProbeEndpoint(channel, testModel, endpointType)
		if endpointErr != nil {
			diagnostics.Reason = "invalid_endpoint"
			return testResult{localErr: endpointErr}
		}
		endpointType = resolvedEndpoint
		diagnostics.EndpointType = endpointType
		if channelProbeNotApplicable(endpointType, options.testType, isStream) {
			diagnostics.Status, diagnostics.Reason = "skipped", "not_applicable"
			return testResult{}
		}
	} else {
		endpointType = normalizeChannelTestEndpoint(channel, testModel, endpointType)
	}

	requestPath := "/v1/chat/completions"

	// 如果指定了端点类型，使用指定的端点类型
	if endpointType != "" {
		if endpointInfo, ok := common.GetDefaultEndpointInfo(constant.EndpointType(endpointType)); ok {
			requestPath = endpointInfo.Path
		}
	} else {
		// 如果没有指定端点类型，使用原有的自动检测逻辑

		if strings.Contains(strings.ToLower(testModel), "rerank") {
			requestPath = "/v1/rerank"
		}

		// 先判断是否为 Embedding 模型
		if strings.Contains(strings.ToLower(testModel), "embedding") ||
			strings.HasPrefix(testModel, "m3e") || // m3e 系列模型
			strings.Contains(testModel, "bge-") || // bge 系列模型
			strings.Contains(testModel, "embed") ||
			channel.Type == constant.ChannelTypeMokaAI { // 其他 embedding 模型
			requestPath = "/v1/embeddings" // 修改请求路径
		}

		// VolcEngine 图像生成模型
		if channel.Type == constant.ChannelTypeVolcEngine && strings.Contains(testModel, "seedream") {
			requestPath = "/v1/images/generations"
		}

		// responses-only models
		if strings.Contains(strings.ToLower(testModel), "codex") {
			requestPath = "/v1/responses"
		}
		if strings.HasSuffix(testModel, "-compact") {
			requestPath = "/v1/responses/compact"
		}

	}
	if strings.HasPrefix(requestPath, "/v1/responses/compact") {
		testModel = strings.TrimSuffix(testModel, "-compact") + "-compact"
	}
	// Gemini 原生流式通过 URL action（:streamGenerateContent）表达而非请求体字段，
	// GeminiChatRequest.IsStream 依据请求 URL 判定，合成请求路径需与生产入口保持一致
	if isStream && constant.EndpointType(endpointType) == constant.EndpointTypeGemini {
		requestPath = strings.Replace(requestPath, ":generateContent", ":streamGenerateContent", 1)
	}
	if diagnostics != nil {
		// Probes validate the response shape, so the synthetic path has to match
		// what production would send: a resolved model and the SSE query Gemini
		// needs to actually stream.
		requestPath = strings.ReplaceAll(requestPath, "{model}", url.PathEscape(testModel))
		if isStream && constant.EndpointType(endpointType) == constant.EndpointTypeGemini {
			requestPath += "?alt=sse"
		}
	}
	c.Request = httptest.NewRequestWithContext(ctx, http.MethodPost, requestPath, nil)

	cache, err := model.GetUserCache(testUserID)
	if err != nil {
		return testResult{
			localErr:    err,
			newAPIError: nil,
		}
	}
	cache.WriteContext(c)
	c.Set("id", testUserID)

	//c.Request.Header.Set("Authorization", "Bearer "+channel.Key)
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set("channel", channel.Type)
	c.Set("base_url", channel.GetBaseURL())
	group, _ := model.GetUserGroup(testUserID, false)
	c.Set("group", group)

	newAPIError := middleware.SetupContextForSelectedChannel(c, channel, testModel)
	if newAPIError != nil {
		return testResult{
			context:     c,
			localErr:    newAPIError,
			newAPIError: newAPIError,
		}
	}

	// Determine relay format based on endpoint type or request path
	var relayFormat types.RelayFormat
	if endpointType != "" {
		// 根据指定的端点类型设置 relayFormat
		switch constant.EndpointType(endpointType) {
		case constant.EndpointTypeOpenAI:
			relayFormat = types.RelayFormatOpenAI
		case constant.EndpointTypeOpenAIResponse:
			relayFormat = types.RelayFormatOpenAIResponses
		case constant.EndpointTypeOpenAIResponseCompact:
			relayFormat = types.RelayFormatOpenAIResponsesCompaction
		case constant.EndpointTypeAnthropic:
			relayFormat = types.RelayFormatClaude
		case constant.EndpointTypeGemini:
			relayFormat = types.RelayFormatGemini
		case constant.EndpointTypeJinaRerank:
			relayFormat = types.RelayFormatRerank
		case constant.EndpointTypeImageGeneration:
			relayFormat = types.RelayFormatOpenAIImage
		case constant.EndpointTypeEmbeddings:
			relayFormat = types.RelayFormatEmbedding
		default:
			relayFormat = types.RelayFormatOpenAI
		}
	} else {
		// 根据请求路径自动检测
		relayFormat = types.RelayFormatOpenAI
		if c.Request.URL.Path == "/v1/embeddings" {
			relayFormat = types.RelayFormatEmbedding
		}
		if c.Request.URL.Path == "/v1/images/generations" {
			relayFormat = types.RelayFormatOpenAIImage
		}
		if c.Request.URL.Path == "/v1/messages" {
			relayFormat = types.RelayFormatClaude
		}
		if strings.Contains(c.Request.URL.Path, "/v1beta/models") {
			relayFormat = types.RelayFormatGemini
		}
		if c.Request.URL.Path == "/v1/rerank" || c.Request.URL.Path == "/rerank" {
			relayFormat = types.RelayFormatRerank
		}
		if c.Request.URL.Path == "/v1/responses" {
			relayFormat = types.RelayFormatOpenAIResponses
		}
		if strings.HasPrefix(c.Request.URL.Path, "/v1/responses/compact") {
			relayFormat = types.RelayFormatOpenAIResponsesCompaction
		}
	}

	request := buildTestRequestWithMessage(testModel, endpointType, channel, isStream, options.message)
	if diagnostics != nil {
		if err := configureChannelProbeRequest(request, options.testType, isStream, options.message); err != nil {
			return testResult{localErr: err}
		}
	}
	applyTestRequestMaxTokens(request, options.maxTokens)

	info, err := relaycommon.GenRelayInfo(c, relayFormat, request, nil)

	if err != nil {
		return testResult{
			context:     c,
			localErr:    err,
			newAPIError: types.NewError(err, types.ErrorCodeGenRelayInfoFailed),
		}
	}

	info.IsChannelTest = true
	info.DisableChannelTestClientProfile = !options.useChannelStyle
	info.InitChannelMeta(c)

	err = attachTestBillingRequestInput(info, request)
	if err != nil {
		return testResult{
			context:     c,
			localErr:    err,
			newAPIError: types.NewError(err, types.ErrorCodeJsonMarshalFailed),
		}
	}

	err = helper.ModelMappedHelper(c, info, request)
	if err != nil {
		return testResult{
			context:     c,
			localErr:    err,
			newAPIError: types.NewError(err, types.ErrorCodeChannelModelMappedError),
		}
	}
	if err := helper.ApplyReasoningModelSuffix(c, info, request); err != nil {
		return testResult{
			context:     c,
			localErr:    err,
			newAPIError: types.NewErrorWithStatusCode(err, types.ErrorCodeConvertRequestFailed, http.StatusBadRequest, types.ErrOptionWithSkipRetry()),
		}
	}

	testModel = info.UpstreamModelName
	// 更新请求中的模型名称
	request.SetModelName(testModel)

	apiType, _ := common.ChannelType2APIType(channel.Type)
	if info.RelayMode == relayconstant.RelayModeResponsesCompact &&
		!common.SupportsResponsesCompact(channel.Type, apiType) {
		return testResult{
			context:     c,
			localErr:    fmt.Errorf("responses compaction test is not supported for api type %d", apiType),
			newAPIError: types.NewError(fmt.Errorf("unsupported api type: %d", apiType), types.ErrorCodeInvalidApiType),
		}
	}
	adaptor := relay.GetAdaptor(apiType)
	if adaptor == nil {
		return testResult{
			context:     c,
			localErr:    fmt.Errorf("invalid api type: %d, adaptor is nil", apiType),
			newAPIError: types.NewError(fmt.Errorf("invalid api type: %d, adaptor is nil", apiType), types.ErrorCodeInvalidApiType),
		}
	}

	//// 创建一个用于日志的 info 副本，移除 ApiKey
	//logInfo := info
	//logInfo.ApiKey = ""
	common.SysLog(fmt.Sprintf("testing channel %d with model %s , info %+v ", channel.Id, testModel, info.ToString()))

	priceData, err := helper.ModelPriceHelper(c, info, 0, request.GetTokenCountMeta())
	if err != nil {
		return testResult{
			context:     c,
			localErr:    err,
			newAPIError: types.NewError(err, types.ErrorCodeModelPriceError, types.ErrOptionWithStatusCode(http.StatusBadRequest)),
		}
	}

	adaptor.Init(info)

	var convertedRequest any
	// 根据 RelayMode 选择正确的转换函数
	switch info.RelayMode {
	case relayconstant.RelayModeEmbeddings:
		// Embedding 请求 - request 已经是正确的类型
		if embeddingReq, ok := request.(*dto.EmbeddingRequest); ok {
			convertedRequest, err = adaptor.ConvertEmbeddingRequest(c, info, *embeddingReq)
		} else {
			return testResult{
				context:     c,
				localErr:    errors.New("invalid embedding request type"),
				newAPIError: types.NewError(errors.New("invalid embedding request type"), types.ErrorCodeConvertRequestFailed),
			}
		}
	case relayconstant.RelayModeImagesGenerations:
		// 图像生成请求 - request 已经是正确的类型
		if imageReq, ok := request.(*dto.ImageRequest); ok {
			convertedRequest, err = adaptor.ConvertImageRequest(c, info, *imageReq)
		} else {
			return testResult{
				context:     c,
				localErr:    errors.New("invalid image request type"),
				newAPIError: types.NewError(errors.New("invalid image request type"), types.ErrorCodeConvertRequestFailed),
			}
		}
	case relayconstant.RelayModeRerank:
		// Rerank 请求 - request 已经是正确的类型
		if rerankReq, ok := request.(*dto.RerankRequest); ok {
			convertedRequest, err = adaptor.ConvertRerankRequest(c, info.RelayMode, *rerankReq)
		} else {
			return testResult{
				context:     c,
				localErr:    errors.New("invalid rerank request type"),
				newAPIError: types.NewError(errors.New("invalid rerank request type"), types.ErrorCodeConvertRequestFailed),
			}
		}
	case relayconstant.RelayModeResponses:
		// Response 请求 - request 已经是正确的类型
		if responseReq, ok := request.(*dto.OpenAIResponsesRequest); ok {
			convertedRequest, err = adaptor.ConvertOpenAIResponsesRequest(c, info, *responseReq)
		} else {
			return testResult{
				context:     c,
				localErr:    errors.New("invalid response request type"),
				newAPIError: types.NewError(errors.New("invalid response request type"), types.ErrorCodeConvertRequestFailed),
			}
		}
	case relayconstant.RelayModeResponsesCompact:
		// Response compaction request - convert to OpenAIResponsesRequest before adapting
		switch req := request.(type) {
		case *dto.OpenAIResponsesCompactionRequest:
			convertedRequest, err = adaptor.ConvertOpenAIResponsesRequest(c, info, dto.OpenAIResponsesRequest{
				Model:              req.Model,
				Input:              req.Input,
				Instructions:       req.Instructions,
				PreviousResponseID: req.PreviousResponseID,
			})
		case *dto.OpenAIResponsesRequest:
			convertedRequest, err = adaptor.ConvertOpenAIResponsesRequest(c, info, *req)
		default:
			return testResult{
				context:     c,
				localErr:    errors.New("invalid response compaction request type"),
				newAPIError: types.NewError(errors.New("invalid response compaction request type"), types.ErrorCodeConvertRequestFailed),
			}
		}
	default:
		switch req := request.(type) {
		case *dto.GeneralOpenAIRequest:
			convertedRequest, err = adaptor.ConvertOpenAIRequest(c, info, req)
		case *dto.ClaudeRequest:
			convertedRequest, err = adaptor.ConvertClaudeRequest(c, info, req)
		case *dto.GeminiChatRequest:
			convertedRequest, err = adaptor.ConvertGeminiRequest(c, info, req)
		default:
			return testResult{
				context:     c,
				localErr:    errors.New("invalid chat request type"),
				newAPIError: types.NewError(errors.New("invalid chat request type"), types.ErrorCodeConvertRequestFailed),
			}
		}
	}

	if err != nil {
		return testResult{
			context:     c,
			localErr:    err,
			newAPIError: types.NewError(err, types.ErrorCodeConvertRequestFailed),
		}
	}
	jsonData, err := common.Marshal(convertedRequest)
	if err != nil {
		return testResult{
			context:     c,
			localErr:    err,
			newAPIError: types.NewError(err, types.ErrorCodeJsonMarshalFailed),
		}
	}

	//jsonData, err = relaycommon.RemoveDisabledFields(jsonData, info.ChannelOtherSettings)
	//if err != nil {
	//	return testResult{
	//		context:     c,
	//		localErr:    err,
	//		newAPIError: types.NewError(err, types.ErrorCodeConvertRequestFailed),
	//	}
	//}

	probeTemplate := jsonData
	if len(info.ParamOverride) > 0 {
		jsonData, err = relaycommon.ApplyParamOverrideWithRelayInfo(jsonData, info)
		if err != nil {
			if fixedErr, ok := relaycommon.AsParamOverrideReturnError(err); ok {
				return testResult{
					context:     c,
					localErr:    fixedErr,
					newAPIError: relaycommon.NewAPIErrorFromParamOverride(fixedErr),
				}
			}
			return testResult{
				context:     c,
				localErr:    err,
				newAPIError: types.NewError(err, types.ErrorCodeChannelParamOverrideInvalid),
			}
		}
	}
	if diagnostics != nil && len(info.ParamOverride) > 0 {
		// Channel overrides still apply, but a probe keeps its single-image count
		// and enough output tokens to finish the fixed tool call.
		jsonData, err = enforceChannelProbeLimits(jsonData, probeTemplate, channelProbeUpstreamEndpoint(convertedRequest), options.testType)
		if err != nil {
			return testResult{context: c, localErr: err, newAPIError: types.NewError(err, types.ErrorCodeChannelParamOverrideInvalid)}
		}
	}

	requestBody := bytes.NewBuffer(jsonData)
	c.Request.Body = io.NopCloser(bytes.NewBuffer(jsonData))
	resp, err := adaptor.DoRequest(c, info, requestBody)
	if err != nil {
		return testResult{
			context:     c,
			localErr:    err,
			newAPIError: types.NewOpenAIError(err, types.ErrorCodeDoRequestFailed, http.StatusInternalServerError),
		}
	}
	var httpResp *http.Response
	var upstreamCapture *channelProbeUpstreamCapture
	if resp != nil {
		httpResp = resp.(*http.Response)
		if diagnostics != nil {
			diagnostics.UpstreamStream = common.GetPointer(strings.Contains(strings.ToLower(httpResp.Header.Get("Content-Type")), "text/event-stream"))
			diagnostics.EndpointPath = info.RequestURLPath
			if httpResp.Body != nil {
				// Observe the raw upstream body while the adaptor reads it: the
				// converted client stream can carry a synthetic terminator even
				// when the upstream was cut off.
				upstreamCapture = &channelProbeUpstreamCapture{ReadCloser: httpResp.Body, started: started}
				httpResp.Body = upstreamCapture
			}
		}
		if httpResp.StatusCode != http.StatusOK {
			if diagnostics != nil {
				diagnostics.Reason = "upstream_error"
			}
			err := service.RelayErrorHandler(c.Request.Context(), httpResp, true)
			common.SysError(fmt.Sprintf(
				"channel test bad response: channel_id=%d name=%s type=%d model=%s endpoint_type=%s status=%d err=%v",
				channel.Id,
				channel.Name,
				channel.Type,
				testModel,
				endpointType,
				httpResp.StatusCode,
				err,
			))
			return testResult{
				context:     c,
				localErr:    err,
				newAPIError: types.NewOpenAIError(err, types.ErrorCodeBadResponse, httpResp.StatusCode),
			}
		}
	}
	usageA, respErr := adaptor.DoResponse(c, httpResp, info)
	if diagnostics != nil {
		if upstreamCapture != nil {
			diagnostics.FirstResponseMS = upstreamCapture.firstByteMS
			raw := bytes.TrimSpace(upstreamCapture.body.Bytes())
			// A complete JSON body means the upstream answered in one shot even
			// if the client saw SSE; SSE field prefixes mean it really streamed.
			if gjson.ValidBytes(raw) {
				diagnostics.UpstreamStream = common.GetPointer(false)
			} else if bytes.HasPrefix(raw, []byte("data:")) || bytes.HasPrefix(raw, []byte("event:")) || bytes.HasPrefix(raw, []byte(":")) {
				diagnostics.UpstreamStream = common.GetPointer(true)
			}
		}
		validateChannelProbeResponse(w.Body.Bytes(), diagnostics, info.StreamStatus)
		if upstreamEndpoint := channelProbeUpstreamEndpoint(convertedRequest); upstreamCapture != nil && upstreamEndpoint != "" {
			// Compaction sends a Responses request upstream but returns a
			// different result shape.
			if endpointType == string(constant.EndpointTypeOpenAIResponseCompact) {
				upstreamEndpoint = endpointType
			}
			upstreamDiagnostic := &channelTestDiagnostics{
				EndpointType:    upstreamEndpoint,
				TestType:        options.testType,
				RequestedStream: diagnostics.UpstreamStream != nil && *diagnostics.UpstreamStream,
			}
			validateChannelProbeResponse(upstreamCapture.body.Bytes(), upstreamDiagnostic, nil)
			if upstreamDiagnostic.Status == "failed" && diagnostics.Reason != "stream_timeout" {
				diagnostics.Status, diagnostics.Reason = "failed", upstreamDiagnostic.Reason
				diagnostics.Detail = upstreamDiagnostic.Detail
			}
		}
	}
	if respErr != nil {
		return testResult{
			context:     c,
			localErr:    respErr,
			newAPIError: respErr,
		}
	}
	usage, usageErr := coerceTestUsage(usageA, isStream, info.GetEstimatePromptTokens())
	if usageErr != nil {
		return testResult{
			context:     c,
			localErr:    usageErr,
			newAPIError: types.NewOpenAIError(usageErr, types.ErrorCodeBadResponseBody, http.StatusInternalServerError),
		}
	}
	var respBody []byte
	var responseTruncated bool
	// A probe has already judged the body per protocol, and its verdict must
	// survive shapes the legacy validator rejects (skipped, degraded).
	if diagnostics == nil {
		respBody, responseTruncated, err = readTestResponseBody(w.Result().Body, isStream)
		if err != nil {
			return testResult{
				context:     c,
				localErr:    err,
				newAPIError: types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError),
			}
		}
		if bodyErr := validateTestResponseBody(respBody, isStream); bodyErr != nil {
			return testResult{
				context:     c,
				localErr:    bodyErr,
				newAPIError: types.NewOpenAIError(bodyErr, types.ErrorCodeBadResponseBody, http.StatusInternalServerError),
			}
		}
	}
	info.SetEstimatePromptTokens(usage.PromptTokens)

	quota, tieredResult := settleTestQuota(info, priceData, usage)
	tok := time.Now()
	milliseconds := tok.Sub(tik).Milliseconds()
	consumedTime := float64(milliseconds) / 1000.0
	other := buildTestLogOther(c, info, priceData, usage, tieredResult)
	if !options.skipConsumeLog {
		model.RecordConsumeLog(c, testUserID, model.RecordConsumeLogParams{
			ChannelId:        channel.Id,
			PromptTokens:     usage.PromptTokens,
			CompletionTokens: usage.CompletionTokens,
			ModelName:        info.OriginModelName,
			TokenName:        "模型测试",
			Quota:            quota,
			Content:          "模型测试",
			UseTimeSeconds:   int(consumedTime),
			IsStream:         info.IsStream,
			Group:            info.UsingGroup,
			Other:            other,
		})
	}
	common.SysLog(fmt.Sprintf("testing channel #%d completed", channel.Id))
	resultData := testResult{
		context:     c,
		localErr:    nil,
		newAPIError: nil,
	}
	// Probes capture their preview from the recorder in a deferred hook, because
	// their verdict path never reads the response body here.
	if options.capturePreview && diagnostics == nil {
		previewBody := respBody
		previewTruncated := responseTruncated
		if len(previewBody) > channelTestResponsePreviewMaxBytes {
			previewBody = previewBody[:channelTestResponsePreviewMaxBytes]
			previewTruncated = true
		}
		resultData.responsePreview = sanitizeChannelTestResponsePreview(previewBody)
		resultData.previewTruncated = previewTruncated
	}
	return resultData
}

func attachTestBillingRequestInput(info *relaycommon.RelayInfo, request dto.Request) error {
	if info == nil {
		return nil
	}

	input, err := helper.BuildBillingExprRequestInputFromRequest(request, info.RequestHeaders)
	if err != nil {
		return err
	}
	info.BillingRequestInput = &input
	return nil
}

func settleTestQuota(info *relaycommon.RelayInfo, priceData hosttypes.PriceData, usage *dto.Usage) (int, *billingexpr.TieredResult) {
	if usage != nil && info != nil && info.TieredBillingSnapshot != nil {
		isClaudeUsageSemantic := usage.UsageSemantic == "anthropic" || info.GetFinalRequestRelayFormat() == types.RelayFormatClaude
		usedVars := billingexpr.UsedVars(info.TieredBillingSnapshot.ExprString)
		if ok, quota, result := service.TryTieredSettle(info, service.BuildTieredTokenParams(usage, isClaudeUsageSemantic, usedVars)); ok {
			return quota, result
		}
	}

	quota := 0
	if !priceData.UsePrice {
		completionQuota := common.QuotaRound(float64(usage.CompletionTokens) * priceData.CompletionRatio)
		quota = common.QuotaRound(float64(usage.PromptTokens) + float64(completionQuota))
		quota = common.QuotaRound(float64(quota) * priceData.ModelRatio)
		if priceData.ModelRatio != 0 && quota <= 0 {
			quota = 1
		}
		return quota, nil
	}

	return common.QuotaFromFloat(priceData.ModelPrice * common.QuotaPerUnit), nil
}

func buildTestLogOther(c *gin.Context, info *relaycommon.RelayInfo, priceData hosttypes.PriceData, usage *dto.Usage, tieredResult *billingexpr.TieredResult) *model.LogOther {
	other := service.GenerateTextOtherInfo(c, info, priceData.ModelRatio, priceData.GroupRatioInfo.GroupRatio, priceData.CompletionRatio,
		usage.PromptTokensDetails.CachedTokens, priceData.CacheRatio, priceData.ModelPrice, priceData.GroupRatioInfo.GroupSpecialRatio)
	if tieredResult != nil {
		service.InjectTieredBillingInfo(other, info, tieredResult)
	}
	return other
}

func coerceTestUsage(usageAny any, isStream bool, estimatePromptTokens int) (*dto.Usage, error) {
	switch u := usageAny.(type) {
	case *dto.Usage:
		return u, nil
	case dto.Usage:
		return &u, nil
	case nil:
		if !isStream {
			return nil, errors.New("usage is nil")
		}
		usage := &dto.Usage{
			PromptTokens: estimatePromptTokens,
		}
		usage.TotalTokens = usage.PromptTokens
		return usage, nil
	default:
		if !isStream {
			return nil, fmt.Errorf("invalid usage type: %T", usageAny)
		}
		usage := &dto.Usage{
			PromptTokens: estimatePromptTokens,
		}
		usage.TotalTokens = usage.PromptTokens
		return usage, nil
	}
}

func readTestResponseBody(body io.ReadCloser, isStream bool) ([]byte, bool, error) {
	defer func() { _ = body.Close() }()
	if !isStream {
		response, err := io.ReadAll(body)
		return response, false, err
	}
	limit := int64(channelTestResponsePreviewMaxBytes)
	response, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(response)) > limit {
		return response[:limit], true, nil
	}
	return response, false, nil
}

func sanitizeChannelTestResponsePreview(response []byte) string {
	preview := strings.TrimSpace(string(response))
	if preview == "" {
		return ""
	}
	// An SSE body is not JSON as a whole, so redact each event payload on its
	// own; otherwise a streamed preview would skip structured redaction.
	if strings.HasPrefix(preview, "data:") || strings.HasPrefix(preview, "event:") || strings.HasPrefix(preview, ":") {
		preview = sanitizeChannelTestStreamPreview(preview)
	}

	var value any
	if err := common.Unmarshal([]byte(preview), &value); err == nil {
		value = redactChannelTestPreviewValue(value)
		if sanitized, err := common.Marshal(value); err == nil {
			preview = string(sanitized)
		}
	}
	preview = channelTestPreviewSensitiveQueryPattern.ReplaceAllString(preview, `${1}[REDACTED]`)
	preview = channelTestPreviewSensitiveJSONPattern.ReplaceAllString(preview, `${1}"[REDACTED]"`)
	preview = channelTestPreviewSensitiveValuePattern.ReplaceAllString(preview, "[REDACTED]")
	preview = channelTestPreviewBearerPattern.ReplaceAllString(preview, "Bearer [REDACTED]")
	return preview
}

// sanitizeChannelTestStreamPreview rebuilds an SSE preview with every event's
// joined data payload passed back through the JSON redaction path.
func sanitizeChannelTestStreamPreview(preview string) string {
	var sanitized strings.Builder
	var data []string
	flush := func() {
		if len(data) == 0 {
			return
		}
		sanitized.WriteString("data: ")
		sanitized.WriteString(sanitizeChannelTestResponsePreview([]byte(strings.Join(data, "\n"))))
		sanitized.WriteByte('\n')
		data = nil
	}
	for _, line := range strings.Split(strings.ReplaceAll(preview, "\r\n", "\n")+"\n\n", "\n") {
		if value, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(data, strings.TrimPrefix(value, " "))
			continue
		}
		if strings.TrimSpace(line) == "" {
			flush()
			sanitized.WriteByte('\n')
			continue
		}
		sanitized.WriteString(line)
		sanitized.WriteByte('\n')
	}
	return strings.TrimSpace(sanitized.String())
}

func redactChannelTestPreviewValue(value any) any {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			if isSensitiveChannelTestPreviewKey(key) {
				item[key] = "[REDACTED]"
			} else {
				item[key] = redactChannelTestPreviewValue(child)
			}
		}
		return item
	case []any:
		for index, child := range item {
			item[index] = redactChannelTestPreviewValue(child)
		}
		return item
	default:
		return value
	}
}

func isSensitiveChannelTestPreviewKey(key string) bool {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.TrimSpace(key)))
	for _, sensitive := range []string{"authorization", "apikey", "accesskey", "refreshtoken", "token", "secret", "password", "credential", "signature", "cookie", "headers", "request", "prompt", "messages", "input"} {
		if normalized == sensitive || strings.Contains(normalized, sensitive) {
			return true
		}
	}
	return false
}

func detectErrorFromTestResponseBody(respBody []byte) error {
	b := bytes.TrimSpace(respBody)
	if len(b) == 0 {
		return nil
	}
	if message := detectErrorMessageFromJSONBytes(b); message != "" {
		return fmt.Errorf("upstream error: %s", message)
	}

	for _, line := range bytes.Split(b, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		payload := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}
		if message := detectErrorMessageFromJSONBytes(payload); message != "" {
			return fmt.Errorf("upstream error: %s", message)
		}
	}

	return nil
}

func validateStreamTestResponseBody(respBody []byte) error {
	b := bytes.TrimSpace(respBody)
	if len(b) == 0 {
		return errors.New("stream response body is empty")
	}

	for _, line := range bytes.Split(b, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		payload := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}

		return nil
	}

	return errors.New("stream response body does not contain a valid stream event")
}

func validateTestResponseBody(respBody []byte, isStream bool) error {
	if bodyErr := detectErrorFromTestResponseBody(respBody); bodyErr != nil {
		return bodyErr
	}
	if isStream {
		return validateStreamTestResponseBody(respBody)
	}
	return nil
}

func shouldUseStreamForAutomaticChannelTest(channel *model.Channel) bool {
	return channel != nil && (channel.Type == constant.ChannelTypeCodex || channel.Type == constant.ChannelTypeCodexCompatibility)
}

func detectErrorMessageFromJSONBytes(jsonBytes []byte) string {
	if len(jsonBytes) == 0 {
		return ""
	}
	if jsonBytes[0] != '{' && jsonBytes[0] != '[' {
		return ""
	}
	errVal := gjson.GetBytes(jsonBytes, "error")
	if !errVal.Exists() || errVal.Type == gjson.Null {
		return ""
	}

	message := gjson.GetBytes(jsonBytes, "error.message").String()
	if message == "" {
		message = gjson.GetBytes(jsonBytes, "error.error.message").String()
	}
	if message == "" && errVal.Type == gjson.String {
		message = errVal.String()
	}
	if message == "" {
		message = errVal.Raw
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return "upstream returned error payload"
	}
	return message
}

func buildTestRequest(model string, endpointType string, channel *model.Channel, isStream bool) dto.Request {
	return buildTestRequestWithMessage(model, endpointType, channel, isStream, operation_setting.DefaultChannelTestMessage)
}

func buildTestRequestWithMessage(model string, endpointType string, channel *model.Channel, isStream bool, message string) dto.Request {
	if resolvedMessage, err := operation_setting.ResolveChannelTestMessage(message); err == nil {
		message = resolvedMessage
	} else {
		message = operation_setting.DefaultChannelTestMessage
	}
	testResponsesInput := buildTestResponsesInput(message)

	// 根据端点类型构建不同的测试请求
	if endpointType != "" {
		switch constant.EndpointType(endpointType) {
		case constant.EndpointTypeEmbeddings:
			// 返回 EmbeddingRequest
			return &dto.EmbeddingRequest{
				Model: model,
				Input: []any{"hello world"},
			}
		case constant.EndpointTypeImageGeneration:
			// 返回 ImageRequest
			return &dto.ImageRequest{
				Model:  model,
				Prompt: message,
				N:      lo.ToPtr(uint(1)),
				Size:   "1024x1024",
			}
		case constant.EndpointTypeJinaRerank:
			// 返回 RerankRequest
			return &dto.RerankRequest{
				Model:     model,
				Query:     "What is Deep Learning?",
				Documents: []any{"Deep Learning is a subset of machine learning.", "Machine learning is a field of artificial intelligence."},
				TopN:      lo.ToPtr(2),
			}
		case constant.EndpointTypeOpenAIResponse:
			// 返回 OpenAIResponsesRequest
			return &dto.OpenAIResponsesRequest{
				Model:  model,
				Input:  testResponsesInput,
				Stream: lo.ToPtr(isStream),
			}
		case constant.EndpointTypeOpenAIResponseCompact:
			// 返回 OpenAIResponsesCompactionRequest
			return &dto.OpenAIResponsesCompactionRequest{
				Model: model,
				Input: testResponsesInput,
			}
		case constant.EndpointTypeAnthropic:
			return &dto.ClaudeRequest{
				Model:     model,
				Stream:    lo.ToPtr(isStream),
				MaxTokens: lo.ToPtr(uint(16)),
				Messages: []dto.ClaudeMessage{
					{
						Role:    "user",
						Content: message,
					},
				},
			}
		case constant.EndpointTypeGemini:
			return &dto.GeminiChatRequest{
				Contents: []dto.GeminiChatContent{
					{
						Role:  "user",
						Parts: []dto.GeminiPart{{Text: message}},
					},
				},
				GenerationConfig: dto.GeminiChatGenerationConfig{
					MaxOutputTokens: lo.ToPtr(uint(3000)),
				},
			}
		case constant.EndpointTypeOpenAI:
			req := &dto.GeneralOpenAIRequest{
				Model:  model,
				Stream: lo.ToPtr(isStream),
				Messages: []dto.Message{
					{
						Role:    "user",
						Content: message,
					},
				},
				MaxTokens: lo.ToPtr(uint(16)),
			}
			if isStream {
				req.StreamOptions = &dto.StreamOptions{IncludeUsage: true}
			}
			return req
		}
	}

	// 自动检测逻辑（保持原有行为）
	if strings.Contains(strings.ToLower(model), "rerank") {
		return &dto.RerankRequest{
			Model:     model,
			Query:     "What is Deep Learning?",
			Documents: []any{"Deep Learning is a subset of machine learning.", "Machine learning is a field of artificial intelligence."},
			TopN:      lo.ToPtr(2),
		}
	}

	// 先判断是否为 Embedding 模型
	if strings.Contains(strings.ToLower(model), "embedding") ||
		strings.HasPrefix(model, "m3e") ||
		strings.Contains(model, "bge-") {
		// 返回 EmbeddingRequest
		return &dto.EmbeddingRequest{
			Model: model,
			Input: []any{"hello world"},
		}
	}

	// Responses-only models (e.g. codex series)
	if strings.Contains(strings.ToLower(model), "codex") {
		return &dto.OpenAIResponsesRequest{
			Model:  model,
			Input:  testResponsesInput,
			Stream: lo.ToPtr(isStream),
		}
	}

	// Chat/Completion 请求 - 返回 GeneralOpenAIRequest
	testRequest := &dto.GeneralOpenAIRequest{
		Model:  model,
		Stream: lo.ToPtr(isStream),
		Messages: []dto.Message{
			{
				Role:    "user",
				Content: message,
			},
		},
	}
	if isStream {
		testRequest.StreamOptions = &dto.StreamOptions{IncludeUsage: true}
	}

	applyChannelTestModelBudget(testRequest, model)
	return testRequest
}

func buildTestResponsesInput(message string) json.RawMessage {
	data, err := common.Marshal([]dto.Message{{Role: "user", Content: message}})
	if err != nil {
		return json.RawMessage(`[{"role":"user","content":"hi"}]`)
	}
	return json.RawMessage(data)
}

func applyTestRequestMaxTokens(request dto.Request, maxTokens *uint) {
	if request == nil || maxTokens == nil || *maxTokens == 0 {
		return
	}
	switch req := request.(type) {
	case *dto.GeneralOpenAIRequest:
		if req.MaxTokens != nil {
			req.MaxTokens = lo.ToPtr(*maxTokens)
		}
		if req.MaxCompletionTokens != nil {
			req.MaxCompletionTokens = lo.ToPtr(*maxTokens)
		}
		if req.MaxTokens == nil && req.MaxCompletionTokens == nil {
			req.MaxTokens = lo.ToPtr(*maxTokens)
		}
	case *dto.OpenAIResponsesRequest:
		req.MaxOutputTokens = lo.ToPtr(*maxTokens)
	case *dto.ClaudeRequest:
		if req.MaxTokens != nil {
			req.MaxTokens = lo.ToPtr(*maxTokens)
		}
		if req.MaxTokensToSample != nil {
			req.MaxTokensToSample = lo.ToPtr(*maxTokens)
		}
		if req.MaxTokens == nil && req.MaxTokensToSample == nil {
			req.MaxTokens = lo.ToPtr(*maxTokens)
		}
	case *dto.GeminiChatRequest:
		req.GenerationConfig.MaxOutputTokens = lo.ToPtr(*maxTokens)
	}
}

type detailedChannelTestRequest struct {
	Model        string  `json:"model"`
	EndpointType string  `json:"endpoint_type"`
	Stream       bool    `json:"stream"`
	Message      *string `json:"message,omitempty"`
	// TestType requests a capability probe and its diagnostics instead of the
	// legacy pass/fail result.
	TestType string `json:"test_type,omitempty"`
}

func TestChannel(c *gin.Context) {
	testChannelHTTP(c, c.Query("model"), c.Query("endpoint_type"), parseChannelTestStream(c), "", "")
}

// TestChannelDetailed accepts a JSON body for model, endpoint, stream, and an
// optional one-run test message. An omitted or empty message falls back to the
// global channel-test message from settings and is never persisted.
func TestChannelDetailed(c *gin.Context) {
	var request detailedChannelTestRequest
	if c.Request != nil && c.Request.Body != nil {
		if err := c.ShouldBindJSON(&request); err != nil && !errors.Is(err, io.EOF) {
			common.ApiError(c, err)
			return
		}
	}
	if request.TestType != "" && request.TestType != "basic" && request.TestType != "tool_call" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "invalid channel test type"})
		return
	}
	message := ""
	if request.Message != nil {
		message = *request.Message
	}
	testChannelHTTP(c, request.Model, request.EndpointType, request.Stream, message, request.TestType)
}

func parseChannelTestStream(c *gin.Context) bool {
	isStream, _ := strconv.ParseBool(c.Query("stream"))
	return isStream
}

func testChannelHTTP(c *gin.Context, testModel string, endpointType string, isStream bool, message string, testType string) {
	channelId, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	channel, err := model.CacheGetChannel(channelId)
	if err != nil {
		channel, err = model.GetChannelById(channelId, true)
		if err != nil {
			common.ApiError(c, err)
			return
		}
	}
	//defer func() {
	//	if channel.ChannelInfo.IsMultiKey {
	//		go func() { _ = channel.SaveChannelInfo() }()
	//	}
	//}()
	testUserID, err := resolveChannelTestUserID(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	tik := time.Now()
	requestCtx := context.Background()
	if c.Request != nil {
		requestCtx = c.Request.Context()
	}
	monitorSetting := operation_setting.GetMonitorSetting()
	result := testChannelWithOptions(requestCtx, channel, testUserID, testModel, endpointType, isStream, channelTestOptions{
		testType:        testType,
		message:         message,
		useChannelStyle: monitorSetting.ChannelTestUseChannelStyle,
		capturePreview:  monitorSetting.ChannelTestShowResponsePreview,
	})
	if result.diagnostics != nil {
		diagnostics := result.diagnostics
		response := gin.H{
			// A degraded probe still reached the model, so it is not a failure.
			"success":     diagnostics.Status == "passed" || diagnostics.Status == "degraded",
			"message":     "",
			"time":        float64(diagnostics.DurationMS) / 1000,
			"diagnostics": diagnostics,
		}
		if result.localErr != nil {
			response["message"] = sanitizeChannelTestResponsePreview([]byte(result.localErr.Error()))
		}
		if result.newAPIError != nil {
			response["error_code"] = result.newAPIError.GetErrorCode()
		}
		// A skipped combination never contacted the channel.
		if diagnostics.Status != "skipped" {
			go channel.UpdateResponseTime(diagnostics.DurationMS)
		}
		if monitorSetting.ChannelTestShowResponsePreview {
			response["response_preview"] = result.responsePreview
			response["response_preview_truncated"] = result.previewTruncated
		}
		c.JSON(http.StatusOK, response)
		return
	}
	if result.localErr != nil {
		resp := gin.H{
			"success": false,
			"message": result.localErr.Error(),
			"time":    0.0,
		}
		if result.newAPIError != nil {
			resp["error_code"] = result.newAPIError.GetErrorCode()
		}
		c.JSON(http.StatusOK, resp)
		return
	}
	tok := time.Now()
	milliseconds := tok.Sub(tik).Milliseconds()
	go channel.UpdateResponseTime(milliseconds)
	consumedTime := float64(milliseconds) / 1000.0
	if result.newAPIError != nil {
		c.JSON(http.StatusOK, gin.H{
			"success":    false,
			"message":    result.newAPIError.Error(),
			"time":       consumedTime,
			"error_code": result.newAPIError.GetErrorCode(),
		})
		return
	}
	response := gin.H{
		"success": true,
		"message": "",
		"time":    consumedTime,
	}
	if monitorSetting.ChannelTestShowResponsePreview {
		response["response_preview"] = result.responsePreview
		response["response_preview_truncated"] = result.previewTruncated
	}
	c.JSON(http.StatusOK, response)
}

// channelTestSummary records the outcome of one channel test cycle so the
// system task can persist a per-run result for history.
type channelTestSummary struct {
	Tested    int `json:"tested"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Disabled  int `json:"disabled"`
	Enabled   int `json:"enabled"`
}

func testChannelForHealthCheck(ctx context.Context, channel *model.Channel, testUserID int, allowDisable bool, disableThreshold int64) channelTestSummary {
	summary := channelTestSummary{}
	isChannelEnabled := channel.Status == common.ChannelStatusEnabled
	tik := time.Now()
	result := testChannel(ctx, channel, testUserID, "", "", shouldUseStreamForAutomaticChannelTest(channel))
	milliseconds := time.Since(tik).Milliseconds()
	if ctx.Err() != nil {
		return summary
	}

	summary.Tested++

	shouldBanChannel := false
	newAPIError := result.newAPIError
	if newAPIError != nil {
		shouldBanChannel = service.ShouldDisableChannel(result.newAPIError)
	}

	if common.AutomaticDisableChannelEnabled && !shouldBanChannel {
		if milliseconds > disableThreshold {
			err := fmt.Errorf("响应时间 %.2fs 超过阈值 %.2fs", float64(milliseconds)/1000.0, float64(disableThreshold)/1000.0)
			newAPIError = types.NewOpenAIError(err, types.ErrorCodeChannelResponseTimeExceeded, http.StatusRequestTimeout)
			shouldBanChannel = true
		}
	}

	if newAPIError == nil {
		summary.Succeeded++
	} else {
		summary.Failed++
	}

	if allowDisable && isChannelEnabled && shouldBanChannel && channel.GetAutoBan() {
		processChannelError(result.context, *types.NewChannelError(channel.Id, channel.Type, channel.Name, channel.ChannelInfo.IsMultiKey, common.GetContextKeyString(result.context, constant.ContextKeyChannelKey), channel.GetAutoBan()), newAPIError, nil)
		summary.Disabled++
	}

	if result.localErr == nil && !isChannelEnabled && service.ShouldEnableChannel(newAPIError, channel.Status) {
		service.EnableChannel(channel.Id, common.GetContextKeyString(result.context, constant.ContextKeyChannelKey), channel.Name)
		summary.Enabled++
	}

	channel.UpdateResponseTime(milliseconds)
	return summary
}

// runChannelTestWorkers executes independent channel tests with bounded
// concurrency. Results and progress are reduced by the caller goroutine, so
// summary counts and the progress reporter remain serialized.
func runChannelTestWorkers(
	ctx context.Context,
	channels []*model.Channel,
	concurrency int,
	run func(context.Context, *model.Channel) channelTestSummary,
	report func(processed, total int),
) channelTestSummary {
	if ctx == nil {
		ctx = context.Background()
	}
	total := len(channels)
	if report != nil {
		report(0, total)
	}
	if total == 0 {
		return channelTestSummary{}
	}

	workerCount := min(operation_setting.NormalizeChannelTestConcurrency(concurrency), total)
	jobs := make(chan *model.Channel)
	results := make(chan channelTestSummary)

	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case channel, ok := <-jobs:
					if !ok {
						return
					}
					if ctx.Err() != nil {
						return
					}

					result := channelTestSummary{}
					if channel != nil && channel.Status != common.ChannelStatusManuallyDisabled {
						result = run(ctx, channel)
					}

					results <- result

					if common.RequestInterval > 0 {
						select {
						case <-ctx.Done():
							return
						case <-time.After(common.RequestInterval):
						}
					}
				}
			}
		}()
	}

	go func() {
		defer close(jobs)
		for _, channel := range channels {
			select {
			case <-ctx.Done():
				return
			case jobs <- channel:
			}
		}
	}()

	go func() {
		workers.Wait()
		close(results)
	}()

	summary := channelTestSummary{}
	processed := 0
	for result := range results {
		summary.Tested += result.Tested
		summary.Succeeded += result.Succeeded
		summary.Failed += result.Failed
		summary.Disabled += result.Disabled
		summary.Enabled += result.Enabled
		processed++
		if report != nil && ctx.Err() == nil {
			report(processed, total)
		}
	}
	return summary
}

// performChannelTests runs channel health checks with the configured bounded
// concurrency and honors cancellation when a system-task runner loses its
// lease.
func performChannelTests(ctx context.Context, channels []*model.Channel, testUserID int, allowDisable bool, concurrency int, report func(processed, total int)) channelTestSummary {
	if ctx == nil {
		ctx = context.Background()
	}
	disableThreshold := int64(common.ChannelDisableThreshold * 1000)
	if disableThreshold == 0 {
		disableThreshold = 10000000 // an impossible value
	}
	return runChannelTestWorkers(
		ctx,
		channels,
		concurrency,
		func(ctx context.Context, channel *model.Channel) channelTestSummary {
			return testChannelForHealthCheck(ctx, channel, testUserID, allowDisable, disableThreshold)
		},
		report,
	)
}

// runChannelTestTask runs one synchronous channel test cycle for the system task
// runner (both the scheduled job and the manual "test all channels" trigger go
// through here). It honors ctx cancellation so a runner that loses its lease
// stops promptly. mode selects the channel set: an empty mode falls back to the
// configured monitor ChannelTestMode (scheduled behavior), while a manual
// trigger passes ChannelTestModeScheduledAll to test every channel. When notify
// is set the root user is notified on completion. Cross-instance execution is
// guarded by the system task per-type lock, so no process-local guard is needed.
func runChannelTestTask(ctx context.Context, mode string, notify bool, report func(processed, total int)) (channelTestSummary, error) {
	testUserID, err := resolveChannelTestUserID(nil)
	if err != nil {
		return channelTestSummary{}, err
	}
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		return channelTestSummary{}, err
	}
	if strings.TrimSpace(mode) == "" {
		mode = operation_setting.GetMonitorSetting().ChannelTestMode
	}
	selected := selectChannelsForAutomaticTest(channels, mode)
	allowDisable := mode != operation_setting.ChannelTestModePassiveRecovery
	concurrency := operation_setting.GetMonitorSetting().ChannelTestConcurrency
	summary := performChannelTests(ctx, selected, testUserID, allowDisable, concurrency, report)
	if notify && (ctx == nil || ctx.Err() == nil) {
		service.NotifyRootUser(dto.NotifyTypeChannelTest, "通道测试完成", "所有通道测试已完成")
	}
	return summary, nil
}

func selectChannelsForAutomaticTest(channels []*model.Channel, mode string) []*model.Channel {
	selected := make([]*model.Channel, 0, len(channels))
	for _, channel := range channels {
		if channel.Status == common.ChannelStatusManuallyDisabled {
			continue
		}
		if mode == operation_setting.ChannelTestModeAutoBanOnly && !channel.GetAutoBan() {
			continue
		}
		if mode == operation_setting.ChannelTestModePassiveRecovery && channel.Status != common.ChannelStatusAutoDisabled {
			continue
		}
		selected = append(selected, channel)
	}
	return selected
}

// TestAllChannels enqueues a channel_test system task instead of running the
// test loop inline. If any channel_test task is already active, the manual run is
// rejected so the caller does not mistake a scheduled run for this manual one.
func TestAllChannels(c *gin.Context) {
	task, created, err := service.EnqueueSystemTask(model.SystemTaskTypeChannelTest, channelTestTaskPayload{
		Mode:   operation_setting.ChannelTestModeScheduledAll,
		Notify: true,
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if !created {
		c.JSON(http.StatusConflict, gin.H{
			"success": false,
			"message": "已有通道测试任务正在运行或等待中，不能启动本次手动任务",
			"data": gin.H{
				"task_id": task.TaskID,
				"status":  task.Status,
				"type":    task.Type,
			},
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"task_id": task.TaskID,
			"status":  task.Status,
		},
	})
}

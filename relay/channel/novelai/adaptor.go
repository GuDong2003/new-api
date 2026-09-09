package novelai

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relay/channel"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

const (
	defaultWidth       = 832
	defaultHeight      = 1216
	defaultSteps       = 28
	defaultScale       = 5
	defaultSampler     = "k_euler_ancestral"
	defaultNoiseScheme = "karras"
	maxNativeImages    = 8
	maxNativeDimension = 2048
	maxNativePixels    = 3145728
)

var modelList = []string{
	"nai-diffusion-5-full",
	"nai-diffusion-5-curated",
	"nai-diffusion-4-5-full",
	"nai-diffusion-4-5-curated",
	"nai-diffusion-4-full",
	"nai-diffusion-4-curated",
	"nai-diffusion-3",
	"nai-diffusion-furry-3",
}

type Adaptor struct{}

func (a *Adaptor) Init(info *relaycommon.RelayInfo) {}

func (a *Adaptor) GetRequestURL(info *relaycommon.RelayInfo) (string, error) {
	if info == nil || info.ChannelMeta == nil {
		return "", errors.New("novelai adaptor: relay info is nil")
	}
	baseURL := strings.TrimRight(info.ChannelBaseUrl, "/")
	if baseURL == "" {
		baseURL = constant.GetChannelBaseURL(constant.ChannelTypeNovelAI)
	}
	if baseURL == "" {
		return "", errors.New("novelai adaptor: base URL is required")
	}
	return baseURL + "/ai/generate-image", nil
}

func (a *Adaptor) SetupRequestHeader(c *gin.Context, req *http.Header, info *relaycommon.RelayInfo) error {
	if info == nil || info.ChannelMeta == nil {
		return errors.New("novelai adaptor: relay info is nil")
	}
	if strings.TrimSpace(info.ApiKey) == "" {
		return errors.New("novelai adaptor: API token is required")
	}
	channel.SetupApiRequestHeader(info, c, req)
	req.Set("Authorization", "Bearer "+strings.TrimSpace(info.ApiKey))
	req.Set("Accept", "application/x-zip-compressed")
	req.Set("User-Agent", "new-api/novelai")
	return nil
}

func (a *Adaptor) ConvertImageRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.ImageRequest) (any, error) {
	if info == nil || info.ChannelMeta == nil {
		return nil, errors.New("novelai adaptor: relay info is nil")
	}
	if info.RelayMode != relayconstant.RelayModeImagesGenerations {
		return nil, errors.New("novelai adaptor: image editing is not implemented yet")
	}
	modelName := strings.TrimSpace(info.UpstreamModelName)
	if modelName == "" {
		modelName = strings.TrimSpace(request.Model)
	}
	if modelName == "" {
		return nil, errors.New("novelai adaptor: model is required")
	}
	if strings.TrimSpace(request.Prompt) == "" {
		return nil, errors.New("novelai adaptor: prompt is required")
	}

	parameters := defaultParameters(request)
	if raw, ok := request.Extra["nai"]; ok {
		var native struct {
			Action     string         `json:"action"`
			Parameters map[string]any `json:"parameters"`
		}
		if err := common.Unmarshal(raw, &native); err != nil {
			return nil, fmt.Errorf("novelai adaptor: invalid nai parameters: %w", err)
		}
		if native.Action != "" && native.Action != "generate" {
			return nil, fmt.Errorf("novelai adaptor: action %q is not supported yet", native.Action)
		}
		for key, value := range native.Parameters {
			parameters[key] = value
		}
	}
	if err := normalizeParameters(parameters, request); err != nil {
		return nil, err
	}

	requestData := map[string]any{
		"input":                strings.TrimSpace(request.Prompt),
		"model":                modelName,
		"action":               "generate",
		"parameters":           parameters,
		"use_new_shared_trial": true,
	}
	encoded, err := common.Marshal(requestData)
	if err != nil {
		return nil, fmt.Errorf("novelai adaptor: encode request: %w", err)
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="request"; filename="blob"`)
	header.Set("Content-Type", "application/json")
	part, err := writer.CreatePart(header)
	if err != nil {
		return nil, fmt.Errorf("novelai adaptor: create request part: %w", err)
	}
	if _, err = part.Write(encoded); err != nil {
		return nil, fmt.Errorf("novelai adaptor: write request part: %w", err)
	}
	if err = writer.Close(); err != nil {
		return nil, fmt.Errorf("novelai adaptor: close request form: %w", err)
	}
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())
	return &body, nil
}

func defaultParameters(request dto.ImageRequest) map[string]any {
	width, height := parseSize(request.Size)
	if width == 0 || height == 0 {
		width, height = defaultWidth, defaultHeight
	}
	imageCount := uint(1)
	if request.N != nil {
		imageCount = *request.N
	}
	return map[string]any{
		"params_version":       4,
		"width":                width,
		"height":               height,
		"steps":                defaultSteps,
		"scale":                defaultScale,
		"sampler":              defaultSampler,
		"noise_schedule":       defaultNoiseScheme,
		"cfg_rescale":          0,
		"n_samples":            imageCount,
		"negative_prompt":      "",
		"ucPresetId":           "none",
		"qualityPresetId":      "none",
		"legacy":               false,
		"dynamic_thresholding": false,
		"add_original_image":   false,
		"image_format":         "png",
	}
}

func normalizeParameters(parameters map[string]any, request dto.ImageRequest) error {
	if _, ok := parameters["width"]; !ok {
		parameters["width"] = defaultWidth
	}
	if _, ok := parameters["height"]; !ok {
		parameters["height"] = defaultHeight
	}
	width, err := nativeInt(parameters["width"], "width")
	if err != nil {
		return err
	}
	height, err := nativeInt(parameters["height"], "height")
	if err != nil {
		return err
	}
	if width < 64 || height < 64 || width > maxNativeDimension || height > maxNativeDimension || width%64 != 0 || height%64 != 0 || width*height > maxNativePixels {
		return fmt.Errorf("novelai adaptor: image dimensions must be multiples of 64 and within the NovelAI limit")
	}
	parameters["width"] = width
	parameters["height"] = height

	if request.N != nil {
		if *request.N == 0 || *request.N > maxNativeImages {
			return fmt.Errorf("novelai adaptor: n must be between 1 and %d", maxNativeImages)
		}
		parameters["n_samples"] = *request.N
	}
	count, err := nativeInt(parameters["n_samples"], "n_samples")
	if err != nil {
		return err
	}
	if count < 1 || count > maxNativeImages {
		return fmt.Errorf("novelai adaptor: n_samples must be between 1 and %d", maxNativeImages)
	}
	parameters["n_samples"] = count

	if steps, exists := parameters["steps"]; exists {
		value, err := nativeInt(steps, "steps")
		if err != nil {
			return err
		}
		if value < 1 || value > 50 {
			return errors.New("novelai adaptor: steps must be between 1 and 50")
		}
		parameters["steps"] = value
	}
	return nil
}

func nativeInt(value any, name string) (int, error) {
	switch typed := value.(type) {
	case int:
		return typed, nil
	case int64:
		return int(typed), nil
	case uint:
		if uint64(typed) > uint64(^uint(0)>>1) {
			return 0, fmt.Errorf("novelai adaptor: %s is too large", name)
		}
		return int(typed), nil
	case float64:
		if typed < math.MinInt32 || typed > math.MaxInt32 || math.Trunc(typed) != typed {
			return 0, fmt.Errorf("novelai adaptor: %s must be an integer", name)
		}
		return int(typed), nil
	case json.Number:
		parsed, err := strconv.Atoi(string(typed))
		if err != nil {
			return 0, fmt.Errorf("novelai adaptor: %s must be an integer", name)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("novelai adaptor: %s must be a number", name)
	}
}

func parseSize(size string) (int, int) {
	parts := strings.Split(strings.TrimSpace(size), "x")
	if len(parts) != 2 {
		return 0, 0
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil {
		return 0, 0
	}
	return width, height
}

func (a *Adaptor) DoRequest(c *gin.Context, info *relaycommon.RelayInfo, requestBody io.Reader) (any, error) {
	return channel.DoFormRequest(a, c, info, requestBody)
}

func (a *Adaptor) DoResponse(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (any, *types.NewAPIError) {
	if resp == nil || resp.Body == nil {
		return nil, types.NewError(errors.New("novelai adaptor: empty response"), types.ErrorCodeBadResponse)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewError(fmt.Errorf("novelai adaptor: read response: %w", err), types.ErrorCodeReadResponseBodyFailed)
	}
	if !isZip(body) {
		return nil, types.NewError(extractNativeError(body), types.ErrorCodeBadResponse)
	}
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return nil, types.NewError(fmt.Errorf("novelai adaptor: invalid ZIP response: %w", err), types.ErrorCodeBadResponseBody)
	}
	imageResponse := dto.ImageResponse{Created: common.GetTimestamp()}
	for _, file := range reader.File {
		if file.FileInfo().IsDir() || !isImageFile(file.Name) {
			continue
		}
		fileReader, err := file.Open()
		if err != nil {
			return nil, types.NewError(fmt.Errorf("novelai adaptor: open image: %w", err), types.ErrorCodeBadResponseBody)
		}
		imageBytes, readErr := io.ReadAll(fileReader)
		_ = fileReader.Close()
		if readErr != nil {
			return nil, types.NewError(fmt.Errorf("novelai adaptor: read image: %w", readErr), types.ErrorCodeBadResponseBody)
		}
		imageResponse.Data = append(imageResponse.Data, dto.ImageData{B64Json: base64.StdEncoding.EncodeToString(imageBytes)})
	}
	if len(imageResponse.Data) == 0 {
		return nil, types.NewError(errors.New("novelai adaptor: response contained no images"), types.ErrorCodeBadResponseBody)
	}
	encoded, err := common.Marshal(imageResponse)
	if err != nil {
		return nil, types.NewError(fmt.Errorf("novelai adaptor: encode response: %w", err), types.ErrorCodeBadResponseBody)
	}
	c.Header("Content-Type", "application/json")
	c.Status(http.StatusOK)
	_, _ = c.Writer.Write(encoded)

	usage := &dto.Usage{}
	if info != nil && info.PriceData.UsePrice {
		info.PriceData.AddOtherRatio("n", float64(len(imageResponse.Data)))
	}
	return usage, nil
}

func extractNativeError(body []byte) error {
	var payload struct {
		Message string `json:"message"`
		Error   string `json:"error"`
		Detail  string `json:"detail"`
	}
	if err := common.Unmarshal(body, &payload); err == nil {
		for _, message := range []string{payload.Message, payload.Error, payload.Detail} {
			if strings.TrimSpace(message) != "" {
				return errors.New(strings.TrimSpace(message))
			}
		}
	}
	if message := strings.TrimSpace(string(body)); message != "" {
		return errors.New(message)
	}
	return errors.New("novelai adaptor: upstream returned a non-image response")
}

func isZip(body []byte) bool {
	return len(body) >= 4 && body[0] == 'P' && body[1] == 'K' && body[2] == 3 && body[3] == 4
}

func isImageFile(name string) bool {
	name = strings.ToLower(name)
	return strings.HasSuffix(name, ".png") || strings.HasSuffix(name, ".jpg") || strings.HasSuffix(name, ".jpeg") || strings.HasSuffix(name, ".webp")
}

func (a *Adaptor) GetModelList() []string { return modelList }

func (a *Adaptor) GetChannelName() string { return "novelai" }

func (a *Adaptor) ConvertRerankRequest(*gin.Context, int, dto.RerankRequest) (any, error) {
	return nil, errors.New("novelai adaptor: endpoint not supported")
}

func (a *Adaptor) ConvertEmbeddingRequest(*gin.Context, *relaycommon.RelayInfo, dto.EmbeddingRequest) (any, error) {
	return nil, errors.New("novelai adaptor: endpoint not supported")
}

func (a *Adaptor) ConvertAudioRequest(*gin.Context, *relaycommon.RelayInfo, dto.AudioRequest) (io.Reader, error) {
	return nil, errors.New("novelai adaptor: endpoint not supported")
}

func (a *Adaptor) ConvertOpenAIRequest(*gin.Context, *relaycommon.RelayInfo, *dto.GeneralOpenAIRequest) (any, error) {
	return nil, errors.New("novelai adaptor: endpoint not supported")
}

func (a *Adaptor) ConvertOpenAIResponsesRequest(*gin.Context, *relaycommon.RelayInfo, dto.OpenAIResponsesRequest) (any, error) {
	return nil, errors.New("novelai adaptor: endpoint not supported")
}

func (a *Adaptor) ConvertClaudeRequest(*gin.Context, *relaycommon.RelayInfo, *dto.ClaudeRequest) (any, error) {
	return nil, errors.New("novelai adaptor: endpoint not supported")
}

func (a *Adaptor) ConvertGeminiRequest(*gin.Context, *relaycommon.RelayInfo, *dto.GeminiChatRequest) (any, error) {
	return nil, errors.New("novelai adaptor: endpoint not supported")
}

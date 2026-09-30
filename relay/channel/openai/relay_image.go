package openai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// OpenaiImageHandler handles non-streaming OpenAI image responses
// (generations/edits), returning the parsed usage for billing.
func OpenaiImageHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	defer service.CloseResponseBodyGracefully(resp)

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}

	var usageResp dto.SimpleResponse
	err = common.Unmarshal(responseBody, &usageResp)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
	}

	if oaiError := usageResp.GetOpenAIError(); oaiError != nil && oaiError.Type != "" {
		return nil, types.WithOpenAIError(*oaiError, resp.StatusCode)
	}
	var apiErr *types.NewAPIError
	responseBody, apiErr = validateOpenAIImageResult(c.Request.Context(), responseBody, "data")
	if apiErr != nil {
		return nil, apiErr
	}

	info.UpdateImageCount(openaiImageResponseCount(responseBody))

	// 写入新的 response body
	service.IOCopyBytesGracefully(c, resp, responseBody)

	normalizeOpenAIUsage(&usageResp.Usage)
	applyUsagePostProcessing(info, &usageResp.Usage, responseBody)
	return &usageResp.Usage, nil
}

// openaiImageResponseCount counts billable images in an OpenAI-format image
// response body. An object-shaped data is one image when it carries url or
// b64_json. For arrays the count is the larger of the url-bearing and the
// b64_json-bearing entry counts: a standard response uses one response_format
// so this equals the entry count, an upstream that splits one image into a url
// entry and a b64_json entry bills once, and entries without any image payload
// bill nothing. A zero result leaves the requested quantity in place because
// UpdateImageCount ignores non-positive counts.
func openaiImageResponseCount(responseBody []byte) int64 {
	data := gjson.GetBytes(responseBody, "data")
	if data.IsObject() {
		if openaiImageDataHasField(data, "url") || openaiImageDataHasField(data, "b64_json") {
			return 1
		}
		return 0
	}
	if !data.IsArray() {
		return 0
	}
	var urls, b64s int64
	data.ForEach(func(_, item gjson.Result) bool {
		if openaiImageDataHasField(item, "url") {
			urls++
		}
		if openaiImageDataHasField(item, "b64_json") {
			b64s++
		}
		return true
	})
	return max(urls, b64s)
}

// openaiImageDataHasField reports whether an image data entry carries a
// non-empty string value for field.
func openaiImageDataHasField(item gjson.Result, field string) bool {
	value := item.Get(field)
	return value.Type == gjson.String && strings.TrimSpace(value.String()) != ""
}

// Validate the result before it reaches the client or the billing settlement.
// A successful HTTP status and a nonempty URL can still describe a login page.
// This is independent of optional gallery/audit storage and never forwards the
// caller's credentials. One deadline bounds the whole batch, including redirects.
func validateOpenAIImageResult(ctx context.Context, body []byte, dataPath string) ([]byte, *types.NewAPIError) {
	data := gjson.ParseBytes(body)
	if dataPath != "" {
		data = data.Get(dataPath)
	}
	invalid := types.NewOpenAIError(fmt.Errorf("upstream returned no usable image"), types.ErrorCodeBadResponseBody, http.StatusBadGateway)
	if !data.IsObject() && !data.IsArray() {
		return nil, invalid
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 12*time.Second)
	defer cancel()
	hasImage := false
	items := data.Array()
	var inlineCount, urlCount int
	for _, item := range items {
		if openaiImageDataHasField(item, "b64_json") {
			inlineCount++
		}
		if openaiImageDataHasField(item, "url") {
			urlCount++
		}
	}
	invalidURLs := make(map[int]bool)
	verified := make(map[string]bool)
	for index, item := range items {
		if openaiImageDataHasField(item, "b64_json") {
			hasImage = true
			continue
		}
		if !openaiImageDataHasField(item, "url") {
			continue
		}
		raw := strings.TrimSpace(item.Get("url").String())
		if !verified[raw] && !openAIImageURLAvailable(ctx, raw) {
			// Some providers split the URL and inline form of the same image into
			// separate entries. Prefer those inline images if every URL has one.
			if inlineCount > 0 && inlineCount >= urlCount {
				invalidURLs[index] = true
				continue
			}
			return nil, invalid
		}
		verified[raw] = true
		hasImage = true
	}

	if !hasImage {
		return nil, invalid
	}
	if len(invalidURLs) > 0 {
		valid := make([]json.RawMessage, 0, len(items)-len(invalidURLs))
		for index, item := range items {
			if !invalidURLs[index] {
				valid = append(valid, json.RawMessage(item.Raw))
			}
		}
		encoded, err := common.Marshal(valid)
		if err != nil {
			return nil, invalid
		}
		body, err = sjson.SetRawBytes(body, dataPath, encoded)
		if err != nil {
			return nil, invalid
		}
	}
	return body, nil
}

// openAIImageURLAvailable probes actual bytes rather than trusting a file
// extension or Content-Type. Range and LimitReader bound the consumed body even
// when the image host ignores Range. Download credentials are never inherited.
func openAIImageURLAvailable(ctx context.Context, raw string) bool {
	var reader io.Reader
	if strings.HasPrefix(raw, "data:image/") {
		header, encoded, ok := strings.Cut(raw, ",")
		if !ok || !strings.HasSuffix(header, ";base64") {
			return false
		}
		reader = base64.NewDecoder(base64.StdEncoding, strings.NewReader(encoded))
	} else {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
			return false
		}
		path := strings.ToLower(strings.TrimRight(u.Path, "/"))
		if path == "/login" || path == "/signin" || path == "/sign-in" || strings.HasSuffix(path, "/auth/login") {
			return false
		}
		if service.ValidateSSRFProtectedFetchURL(raw) != nil {
			return false
		}
		var response *http.Response
		if system_setting.EnableWorker() {
			response, err = service.DoWorkerRequestWithContext(ctx, &service.WorkerRequest{
				URL: raw, Key: system_setting.WorkerValidKey, Method: http.MethodGet,
				Headers: map[string]string{"Accept": "image/*", "Range": "bytes=0-511"},
			})
		} else {
			request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
			if requestErr != nil {
				return false
			}
			request.Header.Set("Accept", "image/*")
			request.Header.Set("Range", "bytes=0-511")
			client := service.GetSSRFProtectedHTTPClient()
			if client == nil {
				return false
			}
			response, err = client.Do(request)
		}
		if err != nil {
			return false
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
			return false
		}
		reader = response.Body
	}
	prefix, err := io.ReadAll(io.LimitReader(reader, 512))
	return err == nil && strings.HasPrefix(http.DetectContentType(prefix), "image/")
}

// normalizeOpenAIUsage maps the OpenAI Images usage shape (input_tokens /
// output_tokens / input_tokens_details / output_tokens_details) onto the
// canonical prompt/completion fields. It is used only on the OpenAI image
// relay paths (generations/edits, streaming and non-streaming): the image
// API never returns prompt_tokens / completion_tokens, so the overwrite (=)
// semantics here are equivalent to the previous additive (+=) behavior while
// avoiding any future double-counting if both field sets are ever populated.
// Do not reuse this on chat/embedding paths without revisiting the overwrite
// semantics.
func normalizeOpenAIUsage(usage *dto.Usage) {
	if usage == nil {
		return
	}
	if usage.InputTokens != 0 {
		usage.PromptTokens = usage.InputTokens
	}
	if usage.OutputTokens != 0 {
		usage.CompletionTokens = usage.OutputTokens
	}
	if usage.InputTokensDetails != nil {
		usage.PromptTokensDetails = usage.InputTokensDetails.Clone()
	}
	if usage.OutputTokensDetails != nil {
		usage.CompletionTokenDetails = *usage.OutputTokensDetails
	}
	if usage.TotalTokens == 0 {
		usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	}
}

func OpenaiImageStreamHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	if resp == nil || resp.Body == nil {
		logger.LogError(c, "invalid image stream response")
		return nil, types.NewOpenAIError(fmt.Errorf("invalid response"), types.ErrorCodeBadResponse, http.StatusInternalServerError)
	}

	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return OpenaiImageHandler(c, info, resp)
	}
	if !strings.Contains(contentType, "text/event-stream") {
		return openaiImageJSONAsStreamHandler(c, info, resp)
	}
	// Reuse the shared streaming engine (helper.StreamScannerHandler) so the
	// image streaming path gets the same ping keepalive, streaming-timeout
	// watchdog, client-disconnect detection, panic recovery and goroutine
	// cleanup as every other relay stream. The scanner delivers only the
	// "data:" payload, so the SSE "event:" line is rebuilt from the JSON "type"
	// field (real OpenAI image events keep event == type).
	usage := &dto.Usage{}
	var lastStreamData []byte
	var completedImages int64
	var resultErr *types.NewAPIError

	helper.StreamScannerHandler(c, resp, info, func(data string, sr *helper.StreamResult) {
		raw := common.StringToByteSlice(data)
		lastStreamData = raw
		if isOpenAIImageStreamErrorEvent(raw) {
			resultErr = types.NewOpenAIError(fmt.Errorf("upstream image generation failed"), types.ErrorCodeBadResponseBody, http.StatusBadGateway)
			sr.Stop(fmt.Errorf("%s", extractOpenAIImageStreamErrorMessage(raw)))
			if completedImages == 0 {
				_ = writeOpenaiImageStreamChunk(c, raw)
			}
			return
		}
		var chunk struct {
			Type  string    `json:"type"`
			Usage dto.Usage `json:"usage"`
		}
		if err := common.Unmarshal(raw, &chunk); err == nil {
			normalizeOpenAIUsage(&chunk.Usage)
			if service.ValidUsage(&chunk.Usage) {
				usage = &chunk.Usage
			}
			if chunk.Type == "image_generation.completed" || chunk.Type == "image_edit.completed" {
				raw, resultErr = validateOpenAIImageResult(c.Request.Context(), raw, "")
				if resultErr != nil {
					sr.Stop(resultErr)
					return
				}
				completedImages++
			}
		}
		if err := writeOpenaiImageStreamChunk(c, raw); err != nil {
			sr.Stop(err)
		}
	})

	if resultErr == nil && completedImages == 0 && info.StreamStatus != nil &&
		(info.StreamStatus.EndReason == relaycommon.StreamEndReasonDone || info.StreamStatus.EndReason == relaycommon.StreamEndReasonEOF) {
		resultErr = types.NewOpenAIError(fmt.Errorf("upstream returned no completed image"), types.ErrorCodeBadResponseBody, http.StatusBadGateway)
	}
	if resultErr != nil {
		if completedImages == 0 {
			return nil, resultErr
		}
		// Earlier completed images were delivered and remain billable. Never
		// refund them because a later image in the same stream failed.
		info.UpdateImageCount(completedImages)
		applyUsagePostProcessing(info, usage, lastStreamData)
		// Close the usable partial result normally. Sending a terminal error
		// would make clients discard the completed images we just charged for.
		helper.Done(c)
		return usage, nil
	}

	// StreamScannerHandler consumes the upstream [DONE]; re-emit it so the
	// client still receives a terminal data: [DONE].
	if info.StreamStatus != nil && info.StreamStatus.EndReason == relaycommon.StreamEndReasonDone {
		helper.Done(c)
	}

	applyUsagePostProcessing(info, usage, lastStreamData)
	// Only trust completedImages when upstream finished the stream (done/eof).
	// On client-side aborts (client_gone, or handler_stop from a failed client
	// write) the counter undercounts what upstream actually generated and
	// charged, so keep the requested n — otherwise a client could pay for one
	// image by disconnecting right after the first completed event. The abort
	// guard only blocks lowering the charge: if completed events already
	// exceed the recorded n, bill the higher actual count regardless.
	if info.StreamStatus != nil {
		upstreamFinished := info.StreamStatus.EndReason == relaycommon.StreamEndReasonDone ||
			info.StreamStatus.EndReason == relaycommon.StreamEndReasonEOF
		if upstreamFinished || completedImages > int64(info.RequestedImageCount()) {
			info.UpdateImageCount(completedImages)
		}
	}
	return usage, nil
}

// writeOpenaiImageStreamChunk rebuilds the SSE frame for an image stream chunk:
// it emits an "event:" line derived from the JSON "type" field (when present)
// followed by the verbatim "data:" payload, mirroring helper.ResponseChunkData.
func writeOpenaiImageStreamChunk(c *gin.Context, data []byte) error {
	var payload struct {
		Type string `json:"type"`
	}
	_ = common.Unmarshal(data, &payload)
	if eventName := strings.TrimSpace(payload.Type); eventName != "" {
		return helper.ResponseChunkData(c, dto.ResponsesStreamResponse{Type: eventName}, string(data))
	}
	return helper.StringData(c, string(data))
}

// isOpenAIImageStreamErrorEvent detects upstream error chunks by JSON content
// only ("type" of error/upstream_error, or a non-empty "error" field). The SSE
// "event:" line is not available here: StreamScannerHandler delivers only the
// "data:" payload. A payload carrying just a "message" key is deliberately NOT
// treated as an error to avoid false positives.
func isOpenAIImageStreamErrorEvent(data []byte) bool {
	if !json.Valid(data) {
		return false
	}
	var payload struct {
		Type  string          `json:"type"`
		Error json.RawMessage `json:"error"`
	}
	if err := common.Unmarshal(data, &payload); err != nil {
		return false
	}
	payloadType := strings.ToLower(strings.TrimSpace(payload.Type))
	return payloadType == "error" || payloadType == "upstream_error" || len(payload.Error) > 0
}

func extractOpenAIImageStreamErrorMessage(data []byte) string {
	if len(data) == 0 || !json.Valid(data) {
		return "upstream image stream returned error event"
	}
	var payload struct {
		Message string          `json:"message"`
		Error   json.RawMessage `json:"error"`
	}
	if err := common.Unmarshal(data, &payload); err != nil {
		return "upstream image stream returned error event"
	}
	if msg := strings.TrimSpace(payload.Message); msg != "" {
		return msg
	}
	if len(payload.Error) > 0 {
		var nested struct {
			Message string `json:"message"`
		}
		if err := common.Unmarshal(payload.Error, &nested); err == nil {
			if msg := strings.TrimSpace(nested.Message); msg != "" {
				return msg
			}
		}
		if msg := strings.TrimSpace(common.JsonRawMessageToString(payload.Error)); msg != "" {
			return msg
		}
	}
	return "upstream image stream returned error event"
}

func openaiImageJSONAsStreamHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	defer service.CloseResponseBodyGracefully(resp)

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}

	// Only decode usage/error. Do not Unmarshal data[] into dto.ImageResponse —
	// b64_json values are large and would be copied into Go strings then
	// re-marshaled for each SSE event.
	var usageResp dto.SimpleResponse
	if err := common.Unmarshal(responseBody, &usageResp); err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
	}
	if oaiError := usageResp.GetOpenAIError(); oaiError != nil && oaiError.Type != "" {
		return nil, types.WithOpenAIError(*oaiError, resp.StatusCode)
	}
	var apiErr *types.NewAPIError
	responseBody, apiErr = validateOpenAIImageResult(c.Request.Context(), responseBody, "data")
	if apiErr != nil {
		return nil, apiErr
	}
	normalizeOpenAIUsage(&usageResp.Usage)
	applyUsagePostProcessing(info, &usageResp.Usage, responseBody)

	info.UpdateImageCount(openaiImageResponseCount(responseBody))

	helper.SetEventStreamHeaders(c)
	c.Status(http.StatusOK)

	created := gjson.GetBytes(responseBody, "created").Int()
	if created == 0 {
		created = time.Now().Unix()
	}
	if info != nil {
		info.SetFirstResponseTime()
	}

	validUsage := service.ValidUsage(&usageResp.Usage)
	var usageJSON []byte
	if validUsage {
		usageJSON, err = common.Marshal(usageResp.Usage)
		if err != nil {
			return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
		}
	}

	// gjson.Result.Array returns the element list for an array and a single
	// element for an object-shaped data, keeping document-relative indexes so
	// the zero-copy field forwarding below stays valid for both shapes.
	// Entries without url or b64_json carry no image and are not forwarded.
	emitted := 0
	for _, image := range gjson.GetBytes(responseBody, "data").Array() {
		if !openaiImageDataHasField(image, "url") && !openaiImageDataHasField(image, "b64_json") {
			continue
		}
		payload := []byte(`{"type":"image_generation.completed"}`)
		payload, err = sjson.SetBytes(payload, "created_at", created)
		if err != nil {
			return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
		}
		if validUsage {
			payload, err = sjson.SetRawBytes(payload, "usage", usageJSON)
			if err != nil {
				return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
			}
		}
		// b64_json goes last: every sjson.Set* reallocates the whole payload,
		// so inserting the large blob after all small fields avoids re-copying
		// multi-MB buffers.
		for _, field := range []string{"url", "revised_prompt", "b64_json"} {
			value := image.Get(field)
			if value.Type != gjson.String || value.Raw == `""` {
				continue
			}
			raw := []byte(value.Raw)
			if value.Index > 0 {
				raw = responseBody[value.Index : value.Index+len(value.Raw)]
			}
			payload, err = sjson.SetRawBytes(payload, field, raw)
			if err != nil {
				return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
			}
		}
		if writeErr := helper.ResponseChunkData(c, dto.ResponsesStreamResponse{Type: "image_generation.completed"}, string(payload)); writeErr != nil {
			if info != nil && info.StreamStatus != nil {
				info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonClientGone, writeErr)
			}
			return &usageResp.Usage, nil
		}
		emitted++
	}
	if err := writeOpenaiImageStreamDone(c); err != nil {
		if info != nil && info.StreamStatus != nil {
			info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonClientGone, err)
		}
		return &usageResp.Usage, nil
	}
	if info != nil {
		info.ReceivedResponseCount += emitted
		if info.StreamStatus == nil {
			info.StreamStatus = relaycommon.NewStreamStatus()
		}
		info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonDone, nil)
	}
	return &usageResp.Usage, nil
}

func writeOpenaiImageStreamDone(c *gin.Context) error {
	return helper.StringData(c, "[DONE]")
}

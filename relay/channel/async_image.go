package channel

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/gin-gonic/gin"
	"golang.org/x/net/publicsuffix"
)

const (
	upstreamImageAsyncQuery          = "1"
	upstreamImageTaskPollMaxInterval = 8 * time.Second
)

var upstreamImageTaskPollDelays = []time.Duration{
	800 * time.Millisecond,
	1500 * time.Millisecond,
	2500 * time.Millisecond,
	4 * time.Second,
	6 * time.Second,
	upstreamImageTaskPollMaxInterval,
}

type upstreamImageTaskResponse struct {
	TaskID    string          `json:"task_id"`
	Status    string          `json:"status"`
	StatusURL string          `json:"status_url"`
	PollURL   string          `json:"poll_url"`
	Data      json.RawMessage `json:"data"`
	Error     json.RawMessage `json:"error"`
}

func (r upstreamImageTaskResponse) HasData() bool {
	data := bytes.TrimSpace(r.Data)
	return len(data) > 0 && !bytes.Equal(data, []byte("null")) && !bytes.Equal(data, []byte("[]"))
}

func (r upstreamImageTaskResponse) HasError() bool {
	err := bytes.TrimSpace(r.Error)
	return len(err) > 0 && !bytes.Equal(err, []byte("null")) && !bytes.Equal(err, []byte("{}"))
}

func (r upstreamImageTaskResponse) Completed() bool {
	if r.HasData() {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(r.Status)) {
	case "completed", "complete", "success", "succeeded", "succeed", "done", "finished":
		return true
	default:
		return false
	}
}

func (r upstreamImageTaskResponse) Failed() bool {
	if r.HasError() {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(r.Status)) {
	case "failed", "failure", "error", "cancelled", "canceled":
		return true
	default:
		return false
	}
}

func parseUpstreamImageTaskResponse(body []byte) (upstreamImageTaskResponse, error) {
	var response upstreamImageTaskResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return upstreamImageTaskResponse{}, err
	}
	return response, nil
}

func shouldAttemptUpstreamImageAsync(c *gin.Context, info *relaycommon.RelayInfo) bool {
	if c == nil || info == nil || c.Request == nil {
		return false
	}
	if common.GetContextKeyString(c, constant.ContextKeyAsyncImageTaskID) == "" {
		return false
	}
	return info.RelayMode == relayconstant.RelayModeImagesGenerations ||
		info.RelayMode == relayconstant.RelayModeImagesEdits
}

// doUpstreamImageRequest tries the provider's OpenAI-compatible async image
// protocol. It returns a normal final response so existing adaptors still own
// response conversion and billing. Unsupported providers use the original body
// for one synchronous fallback; accepted provider tasks are polled in place.
func doUpstreamImageRequest(c *gin.Context, request *http.Request, info *relaycommon.RelayInfo) (*http.Response, error) {
	if request == nil || request.URL == nil || request.GetBody == nil {
		return doRequestOnce(c, request, info)
	}

	body, err := request.GetBody()
	if err != nil {
		return doRequestOnce(c, request, info)
	}
	asyncRequest := request.Clone(request.Context())
	asyncRequest.Body = body
	asyncRequest.GetBody = request.GetBody
	asyncURL := *request.URL
	asyncRequest.URL = &asyncURL
	query := asyncRequest.URL.Query()
	query.Set("async", upstreamImageAsyncQuery)
	asyncRequest.URL.RawQuery = query.Encode()
	asyncRequest.Header = request.Header.Clone()
	asyncRequest.Header.Set("Prefer", "respond-async")
	asyncRequest.Header.Set("X-Image-Async", "true")

	response, err := doRequestOnce(c, asyncRequest, info)
	if err != nil {
		return nil, err
	}
	responseBody, readErr := readAndCloseResponse(response)
	if readErr != nil {
		return nil, readErr
	}

	envelope, parseErr := parseUpstreamImageTaskResponse(responseBody)
	if response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
		if parseErr != nil || envelope.TaskID == "" {
			return bufferedHTTPResponse(response, response.StatusCode, responseBody), nil
		}
		if envelope.HasData() {
			return bufferedHTTPResponse(response, http.StatusOK, responseBody), nil
		}
		if envelope.Failed() {
			return bufferedHTTPResponse(response, http.StatusBadGateway, responseBody), nil
		}
		taskURL, urlErr := resolveUpstreamImageTaskURL(
			asyncRequest.URL.String(),
			firstNonEmpty(envelope.StatusURL, envelope.PollURL),
			envelope.TaskID,
		)
		if urlErr != nil {
			return bufferedHTTPResponse(response, http.StatusBadGateway, []byte(fmt.Sprintf(`{"error":{"message":%q}}`, urlErr.Error()))), nil
		}
		return pollUpstreamImageTask(c, asyncRequest, info, taskURL)
	}

	if isUnsupportedUpstreamImageAsync(response.StatusCode, responseBody) {
		fallbackBody, fallbackErr := request.GetBody()
		if fallbackErr != nil {
			return bufferedHTTPResponse(response, response.StatusCode, responseBody), nil
		}
		fallbackRequest := request.Clone(request.Context())
		fallbackRequest.Body = fallbackBody
		fallbackRequest.GetBody = request.GetBody
		return doRequestOnce(c, fallbackRequest, info)
	}
	return bufferedHTTPResponse(response, response.StatusCode, responseBody), nil
}

func readAndCloseResponse(response *http.Response) ([]byte, error) {
	if response == nil || response.Body == nil {
		return nil, fmt.Errorf("upstream image response is empty")
	}
	body, err := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return body, nil
}

func bufferedHTTPResponse(response *http.Response, status int, body []byte) *http.Response {
	result := new(http.Response)
	if response != nil {
		*result = *response
		result.Header = response.Header.Clone()
	}
	result.StatusCode = status
	result.Status = fmt.Sprintf("%d %s", status, http.StatusText(status))
	result.Body = io.NopCloser(bytes.NewReader(body))
	result.ContentLength = int64(len(body))
	return result
}

func isUnsupportedUpstreamImageAsync(status int, body []byte) bool {
	switch status {
	case http.StatusNotFound,
		http.StatusMethodNotAllowed,
		http.StatusNotImplemented:
		return true
	}
	if status != http.StatusBadRequest && status != http.StatusNotAcceptable &&
		status != http.StatusUnsupportedMediaType && status != http.StatusUnprocessableEntity {
		return false
	}
	message := strings.ToLower(strings.TrimSpace(string(body)))
	if message == "" {
		return status == http.StatusBadRequest
	}
	asyncMarker := strings.Contains(message, "async") ||
		strings.Contains(message, "respond-async") ||
		strings.Contains(message, "x-image-async")
	unsupportedMarker := strings.Contains(message, "unsupported") ||
		strings.Contains(message, "not support") ||
		strings.Contains(message, "unknown") ||
		strings.Contains(message, "unrecognized") ||
		strings.Contains(message, "not implemented") ||
		strings.Contains(message, "invalid parameter")
	return asyncMarker && unsupportedMarker
}

func resolveUpstreamImageTaskURL(baseURL, rawURL, taskID string) (*url.URL, error) {
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("upstream image task base URL is invalid")
	}

	var resolved *url.URL
	if strings.TrimSpace(rawURL) == "" {
		baseCopy := *base
		resolved = &baseCopy
		basePath := strings.TrimRight(resolved.Path, "/")
		if strings.HasSuffix(basePath, "/edits") {
			basePath = strings.TrimSuffix(basePath, "/edits") + "/generations"
		}
		resolved.Path = basePath + "/" + url.PathEscape(taskID)
		resolved.RawQuery = ""
	} else {
		candidate, parseErr := url.Parse(rawURL)
		if parseErr != nil {
			return nil, fmt.Errorf("upstream image task URL is invalid")
		}
		if !candidate.IsAbs() && !strings.HasPrefix(candidate.Path, "/") {
			candidate.Path = "/" + candidate.Path
		}
		resolved = base.ResolveReference(candidate)
	}
	if !sameUpstreamProvider(base, resolved) {
		return nil, fmt.Errorf("upstream image task URL must stay with the selected channel's provider")
	}
	resolved.Fragment = ""
	return resolved, nil
}

// sameUpstreamProvider reports whether a task URL a provider handed back stays
// with that provider, since polling it carries the channel's key. Beyond the
// channel's own host it allows a parent or child host inside the provider's
// registered domain, such as qkmss.com for api.qkmss.com, on the channel's
// port or with both on their scheme's default port. The scheme stays the same
// or is upgraded to https.
func sameUpstreamProvider(channel, task *url.URL) bool {
	channelScheme, taskScheme := strings.ToLower(channel.Scheme), strings.ToLower(task.Scheme)
	if taskScheme != channelScheme && (channelScheme != "http" || taskScheme != "https") {
		return false
	}
	if strings.EqualFold(task.Host, channel.Host) {
		return true
	}

	defaultPorts := map[string]string{"http": "80", "https": "443"}
	channelPort := cmp.Or(channel.Port(), defaultPorts[channelScheme])
	taskPort := cmp.Or(task.Port(), defaultPorts[taskScheme])
	if taskPort != channelPort && (channelPort != defaultPorts[channelScheme] || taskPort != defaultPorts[taskScheme]) {
		return false
	}

	channelHost, taskHost := channel.Hostname(), task.Hostname()
	for _, host := range []string{channelHost, taskHost} {
		// Only a plain domain name can share a provider's domain: an IP or a
		// bare name has none, and a name outside ASCII connects to the host
		// its IDNA form spells, which lowercasing does not predict (İ
		// lowercases to i). So this looks at the name before lowercasing.
		if net.ParseIP(host) != nil || !strings.Contains(host, ".") || strings.HasSuffix(host, ".") ||
			strings.ContainsFunc(host, func(r rune) bool { return r > unicode.MaxASCII }) {
			return false
		}
	}
	channelHost, taskHost = strings.ToLower(channelHost), strings.ToLower(taskHost)
	if taskHost == channelHost {
		return true
	}

	// Only a parent or child host counts: siblings such as two resources on
	// openai.azure.com may belong to different tenants.
	parent, child := channelHost, taskHost
	if len(parent) > len(child) {
		parent, child = child, parent
	}
	if !strings.HasSuffix(child, "."+parent) {
		return false
	}
	// The parent must be a registered domain under a suffix the public suffix
	// list knows: github.io is nobody's own domain, and .local names none.
	suffix, icann := publicsuffix.PublicSuffix(parent)
	return suffix != parent && (icann || strings.Contains(suffix, "."))
}

func pollUpstreamImageTask(c *gin.Context, source *http.Request, info *relaycommon.RelayInfo, taskURL *url.URL) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		pollRequest, err := newUpstreamImagePollRequest(source, taskURL)
		if err != nil {
			return nil, err
		}
		response, err := doRequestOnce(c, pollRequest, info)
		if err != nil {
			return nil, err
		}
		body, readErr := readAndCloseResponse(response)
		if readErr != nil {
			return nil, readErr
		}
		envelope, parseErr := parseUpstreamImageTaskResponse(body)
		if response.StatusCode >= http.StatusInternalServerError || response.StatusCode == http.StatusTooManyRequests {
			if err := waitForUpstreamImageTask(attempt, source.Context()); err != nil {
				return nil, err
			}
			continue
		}
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			return bufferedHTTPResponse(response, response.StatusCode, body), nil
		}
		if parseErr != nil {
			return bufferedHTTPResponse(response, response.StatusCode, body), nil
		}
		if envelope.Failed() {
			return bufferedHTTPResponse(response, http.StatusBadGateway, body), nil
		}
		if envelope.Completed() {
			if !envelope.HasData() {
				return bufferedHTTPResponse(response, http.StatusBadGateway, body), nil
			}
			return bufferedHTTPResponse(response, http.StatusOK, body), nil
		}
		if err := waitForUpstreamImageTask(attempt, source.Context()); err != nil {
			return nil, err
		}
	}
}

func newUpstreamImagePollRequest(source *http.Request, target *url.URL) (*http.Request, error) {
	request, err := http.NewRequestWithContext(source.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header = source.Header.Clone()
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	for _, header := range []string{
		"Accept-Encoding",
		"Content-Length",
		"Content-Type",
		"Prefer",
		"X-Image-Async",
	} {
		request.Header.Del(header)
	}
	request.Header.Set("Accept", "application/json")
	// A Host override names the channel's own host; a task on another host of
	// the provider is asked for by that host's name.
	if strings.EqualFold(target.Hostname(), source.URL.Hostname()) {
		request.Host = source.Host
	}
	return request, nil
}

func waitForUpstreamImageTask(attempt int, ctx context.Context) error {
	delay := upstreamImageTaskPollDelays[min(attempt, len(upstreamImageTaskPollDelays)-1)]
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

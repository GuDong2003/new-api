package openai

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

func TestImageResultsRejectNonImagesBeforeForwarding(t *testing.T) {
	previousTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = previousTimeout })
	service.InitHttpClient()
	fetch := system_setting.GetFetchSetting()
	previous := *fetch
	fetch.AllowPrivateIp = true
	fetch.AllowedPorts = []string{"1-65535"}
	t.Cleanup(func() { *fetch = previous })
	image, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=")
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Empty(t, r.Header.Get("Authorization"))
		assert.Empty(t, r.Header.Get("Cookie"))
		switch r.URL.Path {
		case "/image":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(image)
		case "/redirect":
			http.Redirect(w, r, "/html", http.StatusFound)
		case "/pretend.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = io.WriteString(w, "<html>sign in</html>")
		default:
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, "<html>sign in</html>")
		}
	}))
	t.Cleanup(server.Close)
	for _, tc := range []struct {
		name, body string
		valid      bool
	}{
		{"login page", `{"data":[{"url":"https://platform.openai.com/login?redirect=private"}],"status":"completed"}`, false},
		{"HTML body", `{"data":[{"url":"` + server.URL + `/html"}]}`, false},
		{"redirect to HTML", `{"data":[{"url":"` + server.URL + `/redirect"}]}`, false},
		{"false image MIME", `{"data":[{"url":"` + server.URL + `/pretend.png"}]}`, false},
		{"empty data", `{"data":[]}`, false},
		{"no image payload", `{"data":[{"revised_prompt":"a fox"}]}`, false},
		{"blank image URL", `{"data":[{"url":"  "}]}`, false},
		{"image URL without extension", `{"data":[{"url":"` + server.URL + `/image?signature=opaque"}]}`, true},
	} {
		for _, mode := range []string{"json", "json-as-sse", "sse"} {
			t.Run(tc.name+"/"+mode, func(t *testing.T) {
				body, contentType := tc.body, "application/json"
				if mode == "sse" {
					item := gjson.Get(tc.body, "data.0").Raw
					if item == "" {
						item = `{}`
					}
					completed, err := sjson.Set(item, "type", "image_generation.completed")
					require.NoError(t, err)
					body, contentType = "data: "+completed+"\n\ndata: [DONE]\n\n", "text/event-stream"
				}
				c, recorder, response, info := newImageTestContext(t, body, contentType, mode != "json")
				c.Request.Header.Set("Authorization", "Bearer must-not-leak")
				c.Request.Header.Set("Cookie", "session=must-not-leak")
				info.PriceData.UsePrice = true
				info.PriceData.AddOtherRatio("n", 1)
				var apiErr error
				if mode != "json" {
					_, failure := OpenaiImageStreamHandler(c, info, response)
					if failure != nil {
						apiErr = failure
					}
				} else {
					_, failure := OpenaiImageHandler(c, info, response)
					if failure != nil {
						apiErr = failure
					}
				}
				if tc.valid {
					require.NoError(t, apiErr)
					assert.Contains(t, recorder.Body.String(), "/image?signature=opaque")
				} else {
					require.Error(t, apiErr)
					assert.Empty(t, recorder.Body.String(), "invalid results must not be sent as successful images")
					assert.Nil(t, info.BillingImageCount)
				}
			})
		}
	}
}

func newImageTestContext(t *testing.T, body, contentType string, isStream bool) (*gin.Context, *httptest.ResponseRecorder, *http.Response, *relaycommon.RelayInfo) {
	t.Helper()

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/generations", nil)

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{contentType}},
	}
	info := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{},
		IsStream:    isStream,
	}
	return c, recorder, resp, info
}

func TestImageExpressionUsesCompletedCountAndProtectsAbortedStreams(t *testing.T) {
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })
	for _, tc := range []struct {
		name, body      string
		stream, abort   bool
		requested, want int
	}{
		{"JSON uses actual count", `{"data":[{"b64_json":"first"},{"b64_json":"second"}]}`, false, false, 3, 2},
		{"JSON wrapped as SSE uses actual count", `{"data":[{"b64_json":"first"}]}`, true, false, 3, 1},
		{"JSON object data counts one image", `{"data":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=","b64_json":"first"}}`, false, false, 3, 1},
		{"JSON wrapped as SSE counts object data once", `{"data":{"b64_json":"first"}}`, true, false, 3, 1},
		{"completed stream refunds missing images", "data: {\"type\":\"image_generation.completed\",\"b64_json\":\"first\"}\n\ndata: [DONE]\n\n", true, false, 3, 1},
		{"client abort cannot reduce count", "data: {\"type\":\"image_generation.completed\",\"b64_json\":\"first\"}\n\n", true, true, 3, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			contentType := "application/json"
			if strings.HasPrefix(tc.body, "data:") {
				contentType = "text/event-stream"
			}
			c, _, resp, info := newImageTestContext(t, tc.body, contentType, tc.stream)
			if tc.abort {
				c, _, resp, info = newDisconnectingImageStream(t, tc.body, "first")
			}
			info.TieredBillingSnapshot = &billingexpr.BillingSnapshot{EstimatedImageCount: &tc.requested}
			if tc.stream {
				_, err := OpenaiImageStreamHandler(c, info, resp)
				require.Nil(t, err)
			} else {
				_, err := OpenaiImageHandler(c, info, resp)
				require.Nil(t, err)
			}
			count := info.RequestedImageCount()
			if info.BillingImageCount != nil {
				count = *info.BillingImageCount
			}
			assert.Equal(t, tc.want, count)
			assert.Empty(t, info.PriceData.OtherRatios(), "expression quantities must not add a legacy multiplier")
		})
	}
}

func TestImageStreamRejectsNoResultAndRetainsAlreadyDeliveredImages(t *testing.T) {
	previous := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = previous })
	for _, tc := range []struct {
		name, body string
		wantError  bool
	}{
		{"done without an image", "data: [DONE]\n\n", true},
		{"error before completion stays failed", "data: {\"type\":\"error\",\"error\":{\"message\":\"failed\"}}\n\ndata: {\"type\":\"image_generation.completed\",\"b64_json\":\"late\"}\n\ndata: [DONE]\n\n", true},
		{"preview is not a completed image", "data: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"preview\"}\n\ndata: [DONE]\n\n", true},
		{"a later invalid URL keeps the delivered image billed", "data: {\"type\":\"image_generation.completed\",\"b64_json\":\"first\"}\n\ndata: {\"type\":\"image_generation.completed\",\"url\":\"https://platform.openai.com/login\"}\n\ndata: [DONE]\n\n", false},
		{"a later explicit error keeps the delivered image", "data: {\"type\":\"image_generation.completed\",\"b64_json\":\"first\"}\n\ndata: {\"type\":\"error\",\"error\":{\"message\":\"failed\"}}\n\n", false},
		{"a later upstream error keeps the delivered image", "data: {\"type\":\"image_generation.completed\",\"b64_json\":\"first\"}\n\ndata: {\"type\":\"upstream_error\",\"error\":{\"message\":\"failed\"}}\n\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, recorder, response, info := newImageTestContext(t, tc.body, "text/event-stream", true)
			info.PriceData.UsePrice = true
			info.PriceData.AddOtherRatio("n", 2)
			_, failure := OpenaiImageStreamHandler(c, info, response)
			if tc.wantError {
				require.NotNil(t, failure)
				assert.NotContains(t, recorder.Body.String(), "image_generation.completed")
			} else {
				require.Nil(t, failure)
				assert.Equal(t, 1.0, info.PriceData.OtherRatios()["n"])
				assert.Equal(t, 1, strings.Count(recorder.Body.String(), "event: image_generation.completed"))
				assert.NotContains(t, recorder.Body.String(), "platform.openai.com")
				assert.NotContains(t, recorder.Body.String(), `"error"`)
				assert.True(t, strings.HasSuffix(recorder.Body.String(), "data: [DONE]\n\n"))
			}
		})
	}
}

func TestImageResultsKeepSplitInlineFallbackAndUseWorker(t *testing.T) {
	service.InitHttpClient()
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("split inline fallback/stream=%t", stream), func(t *testing.T) {
			body := `{"data":[{"url":"https://platform.openai.com/login"},{"b64_json":"inline-image"}]}`
			c, recorder, response, info := newImageTestContext(t, body, "application/json", stream)
			info.PriceData.UsePrice = true
			var apiErr *types.NewAPIError
			if stream {
				_, apiErr = OpenaiImageStreamHandler(c, info, response)
			} else {
				_, apiErr = OpenaiImageHandler(c, info, response)
			}
			require.Nil(t, apiErr)
			assert.NotContains(t, recorder.Body.String(), "platform.openai.com")
			assert.Contains(t, recorder.Body.String(), `"b64_json":"inline-image"`)
			assert.Equal(t, 1.0, info.PriceData.OtherRatios()["n"])
		})
	}
	t.Run("configured worker fetches image", func(t *testing.T) {
		picture, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=")
		require.NoError(t, err)
		calls := 0
		worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			var payload service.WorkerRequest
			require.NoError(t, common.DecodeJson(r.Body, &payload))
			assert.Equal(t, "https://images.example/image", payload.URL)
			assert.Equal(t, http.MethodGet, payload.Method)
			assert.Equal(t, "bytes=0-511", payload.Headers["Range"])
			assert.Equal(t, "worker-fixture", payload.Key)
			assert.Empty(t, r.Header.Get("Authorization"))
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(picture)
		}))
		t.Cleanup(worker.Close)
		oldURL, oldKey := system_setting.WorkerUrl, system_setting.WorkerValidKey
		fetch := system_setting.GetFetchSetting()
		oldFetch := *fetch
		system_setting.WorkerUrl, system_setting.WorkerValidKey = worker.URL, "worker-fixture"
		fetch.ApplyIPFilterForDomain = false
		t.Cleanup(func() { system_setting.WorkerUrl, system_setting.WorkerValidKey = oldURL, oldKey; *fetch = oldFetch })
		c, recorder, response, info := newImageTestContext(t, `{"data":[{"url":"https://images.example/image"}]}`, "application/json", false)
		_, failure := OpenaiImageHandler(c, info, response)
		require.Nil(t, failure)
		assert.Equal(t, 1, calls)
		assert.Contains(t, recorder.Body.String(), "https://images.example/image")
	})
}

func TestImageCacheUsageAcrossResponseFormats(t *testing.T) {
	previousTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = previousTimeout })
	// Contract fixture for compatible upstreams. Live OpenAI cache response
	// verification is a separate release check; this is not a captured response.
	const usageJSON = `{"input_tokens":1000,"output_tokens":100,"total_tokens":1100,"input_tokens_details":{"text_tokens":400,"image_tokens":600,"cached_tokens":300,"cached_tokens_details":{"text_tokens":100,"image_tokens":200}}}`
	for _, mode := range []string{"image_generation", "image_edit"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", mode, stream), func(t *testing.T) {
				body := `{"data":[{"b64_json":"image"}],"usage":` + usageJSON + `}`
				contentType := "application/json"
				if stream {
					body = "data: {\"type\":\"" + mode + ".completed\",\"b64_json\":\"image\",\"usage\":" + usageJSON + "}\n\ndata: [DONE]\n\n"
					contentType = "text/event-stream"
				}
				ctx, recorder, response, info := newImageTestContext(t, body, contentType, stream)
				info.RelayMode = relayconstant.RelayModeImagesGenerations
				if mode == "image_edit" {
					info.RelayMode = relayconstant.RelayModeImagesEdits
					ctx.Request.URL.Path = "/v1/images/edits"
				}
				result, apiErr := (&Adaptor{}).DoResponse(ctx, response, info)
				require.Nil(t, apiErr)
				usage := result.(*dto.Usage)
				assert.Equal(t, 1000, usage.PromptTokens)
				assert.Equal(t, 300, usage.PromptTokensDetails.CachedTokens)
				require.NotNil(t, usage.PromptTokensDetails.CachedTokensDetails)
				assert.Equal(t, 200, *usage.PromptTokensDetails.CachedTokensDetails.ImageTokens)
				assert.Contains(t, recorder.Body.String(), `"cached_tokens_details":{"text_tokens":100,"image_tokens":200}`)
			})
		}
	}
}

func TestNormalizeOpenAIUsageMapsOutputImageTokens(t *testing.T) {
	previousTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = previousTimeout })

	const usageJSON = `{"input_tokens":15,"output_tokens":1352,"total_tokens":1367,"input_tokens_details":{"text_tokens":15,"image_tokens":0},"output_tokens_details":{"image_tokens":1120,"text_tokens":232}}`
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%t", stream), func(t *testing.T) {
			body := `{"data":[{"b64_json":"image"}],"usage":` + usageJSON + `}`
			contentType := "application/json"
			if stream {
				body = "data: {\"type\":\"image_generation.completed\",\"b64_json\":\"image\",\"usage\":" + usageJSON + "}\n\ndata: [DONE]\n\n"
				contentType = "text/event-stream"
			}
			ctx, _, response, info := newImageTestContext(t, body, contentType, stream)
			info.RelayMode = relayconstant.RelayModeImagesGenerations
			result, apiErr := (&Adaptor{}).DoResponse(ctx, response, info)
			require.Nil(t, apiErr)
			usage := result.(*dto.Usage)
			assert.Equal(t, 15, usage.PromptTokens)
			assert.Equal(t, 1352, usage.CompletionTokens)
			assert.Equal(t, 1120, usage.CompletionTokenDetails.ImageTokens)
			assert.Equal(t, 232, usage.CompletionTokenDetails.TextTokens)
		})
	}
}

func TestOpenaiImageDoResponseUsesInfoIsStream(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	body := `{"created":1710000000,"data":[{"b64_json":"image"}]}`

	t.Run("non-stream response stays JSON", func(t *testing.T) {
		c, recorder, resp, info := newImageTestContext(t, body, "application/json", false)
		info.RelayMode = relayconstant.RelayModeImagesGenerations

		usage, err := (&Adaptor{}).DoResponse(c, resp, info)

		require.Nil(t, err)
		require.NotNil(t, usage)
		require.Equal(t, body, recorder.Body.String())
	})

	t.Run("stream response converts JSON to SSE", func(t *testing.T) {
		c, recorder, resp, info := newImageTestContext(t, body, "application/json", true)
		info.RelayMode = relayconstant.RelayModeImagesGenerations

		usage, err := (&Adaptor{}).DoResponse(c, resp, info)

		require.Nil(t, err)
		require.NotNil(t, usage)
		require.Contains(t, recorder.Body.String(), `event: image_generation.completed`)
		require.Contains(t, recorder.Body.String(), `data: [DONE]`)
	})
}

// TestOpenaiImageStreamHandlerForwardsSSEAndUsage covers the core SSE path:
// chunks are forwarded with rebuilt event lines, usage is extracted and
// normalized (input_tokens -> prompt_tokens with details), and [DONE] is
// re-emitted to the client.
func TestOpenaiImageStreamHandlerForwardsSSEAndUsage(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	body := strings.Join([]string{
		`event: image_generation.partial_image`,
		`data: {"type":"image_generation.partial_image","b64_json":"partial"}`,
		``,
		`data: {"type":"image_generation.completed","b64_json":"image","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7,"input_tokens_details":{"image_tokens":2,"text_tokens":1}}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	c, recorder, resp, info := newImageTestContext(t, body, "text/event-stream", true)
	info.PriceData.UsePrice = true
	info.PriceData.AddOtherRatio("n", 3)

	usage, err := OpenaiImageStreamHandler(c, info, resp)
	require.Nil(t, err)
	require.Equal(t, 3, usage.PromptTokens)
	require.Equal(t, 4, usage.CompletionTokens)
	require.Equal(t, 7, usage.TotalTokens)
	require.Equal(t, 2, usage.PromptTokensDetails.ImageTokens)
	require.Equal(t, 1, usage.PromptTokensDetails.TextTokens)
	require.Contains(t, recorder.Body.String(), `event: image_generation.partial_image`)
	require.Contains(t, recorder.Body.String(), `data: {"type":"image_generation.partial_image","b64_json":"partial"}`)
	require.Contains(t, recorder.Body.String(), `"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7,"input_tokens_details":{"image_tokens":2,"text_tokens":1}}`)
	require.Contains(t, recorder.Body.String(), `data: [DONE]`)
	require.Equal(t, "text/event-stream", recorder.Header().Get("Content-Type"))
	require.Equal(t, 1.0, info.PriceData.OtherRatios()["n"], "only completed images are billed after upstream finishes")
}

func TestOpenaiImageStreamHandlerUsesCompletedEventCount(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	body := strings.Join([]string{
		`data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"partial"}`,
		``,
		`data: {"type":"image_generation.completed","b64_json":"first"}`,
		``,
		`data: {"type":"image_edit.completed","b64_json":"second","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	c, _, resp, info := newImageTestContext(t, body, "text/event-stream", true)
	info.PriceData.UsePrice = true
	info.PriceData.AddOtherRatio("n", 3)

	usage, err := OpenaiImageStreamHandler(c, info, resp)

	require.Nil(t, err)
	require.Equal(t, 7, usage.TotalTokens)
	require.Equal(t, 2.0, info.PriceData.OtherRatios()["n"])
}

// blockingBody serves one SSE chunk, then blocks until Close (the scanner's
// cleanup) and returns EOF — keeping the upstream "open" while the client-side
// disconnect is simulated elsewhere.
type blockingBody struct {
	mu     sync.Mutex
	sent   bool
	chunk  []byte
	closed chan struct{}
}

func (b *blockingBody) Read(p []byte) (int, error) {
	b.mu.Lock()
	if !b.sent {
		b.sent = true
		n := copy(p, b.chunk)
		b.mu.Unlock()
		return n, nil
	}
	b.mu.Unlock()
	<-b.closed
	return 0, io.EOF
}

func (b *blockingBody) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	select {
	case <-b.closed:
	default:
		close(b.closed)
	}
	return nil
}

// cancelAfterWriter cancels the request context right after the payload
// containing needle has been written to the client, simulating a client that
// disconnects after receiving that event. Cancelling from the write side (not
// the upstream read side) makes the abort deterministic: the handler has
// already processed and counted the event when the disconnect fires.
type cancelAfterWriter struct {
	gin.ResponseWriter
	needle string
	cancel context.CancelFunc
	once   sync.Once
}

func (w *cancelAfterWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	if strings.Contains(string(p), w.needle) {
		w.once.Do(w.cancel)
	}
	return n, err
}

func (w *cancelAfterWriter) WriteString(s string) (int, error) {
	n, err := io.WriteString(w.ResponseWriter, s)
	if strings.Contains(s, w.needle) {
		w.once.Do(w.cancel)
	}
	return n, err
}

func newDisconnectingImageStream(t *testing.T, sseBody, disconnectAfter string) (*gin.Context, *httptest.ResponseRecorder, *http.Response, *relaycommon.RelayInfo) {
	t.Helper()
	c, recorder, resp, info := newImageTestContext(t, "", "text/event-stream", true)
	ctx, cancel := context.WithCancel(c.Request.Context())
	t.Cleanup(cancel)
	c.Request = c.Request.WithContext(ctx)
	c.Writer = &cancelAfterWriter{ResponseWriter: c.Writer, needle: disconnectAfter, cancel: cancel}
	resp.Body = &blockingBody{
		chunk:  []byte(sseBody),
		closed: make(chan struct{}),
	}
	return c, recorder, resp, info
}

// TestOpenaiImageStreamHandlerClientDisconnectKeepsRequestedCount guards the
// billing invariant: completed-event counting must not lower the charge when
// the client aborts the stream. Upstream already generated (and charged for)
// all requested images, so a disconnect after the first completed event keeps
// the requested n instead of dropping it to 1.
func TestOpenaiImageStreamHandlerClientDisconnectKeepsRequestedCount(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	body := "data: {\"type\":\"image_generation.completed\",\"b64_json\":\"first\"}\n\n"
	c, recorder, resp, info := newDisconnectingImageStream(t, body, "first")
	info.PriceData.UsePrice = true
	info.PriceData.AddOtherRatio("n", 3)

	usage, err := OpenaiImageStreamHandler(c, info, resp)

	require.Nil(t, err)
	require.NotNil(t, usage)
	require.NotNil(t, info.StreamStatus)
	// A client abort surfaces as client_gone (main-loop ctx watch) or
	// handler_stop (failed client write); both must be treated as untrusted.
	require.Contains(t,
		[]relaycommon.StreamEndReason{relaycommon.StreamEndReasonClientGone, relaycommon.StreamEndReasonHandlerStop},
		info.StreamStatus.EndReason)
	require.Contains(t, recorder.Body.String(), `"b64_json":"first"`)
	require.Equal(t, 3.0, info.PriceData.OtherRatios()["n"], "client abort must not reduce the billed image count")
}

// TestOpenaiImageStreamHandlerClientDisconnectRaisesCount covers the other
// direction of the abort guard: when completed events already exceed the
// recorded n, the higher actual count is billed even though the client aborted.
func TestOpenaiImageStreamHandlerClientDisconnectRaisesCount(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	body := strings.Join([]string{
		`data: {"type":"image_generation.completed","b64_json":"first"}`,
		``,
		`data: {"type":"image_generation.completed","b64_json":"second"}`,
		``,
		``,
	}, "\n")
	c, _, resp, info := newDisconnectingImageStream(t, body, "second")
	info.PriceData.UsePrice = true
	info.PriceData.AddOtherRatio("n", 1)

	usage, err := OpenaiImageStreamHandler(c, info, resp)

	require.Nil(t, err)
	require.NotNil(t, usage)
	require.NotNil(t, info.StreamStatus)
	require.Contains(t,
		[]relaycommon.StreamEndReason{relaycommon.StreamEndReasonClientGone, relaycommon.StreamEndReasonHandlerStop},
		info.StreamStatus.EndReason)
	require.Equal(t, 2.0, info.PriceData.OtherRatios()["n"], "completed events beyond the recorded n must raise the charge even on abort")
}

// TestOpenaiImageStreamHandlerWrapsJSONResponse covers the non-SSE fallback:
// a JSON upstream response is wrapped into pseudo-SSE completed events.
func TestOpenaiImageStreamHandlerWrapsJSONResponse(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	body := `{"created":1710000000,"data":[{"b64_json":"first","revised_prompt":"draw a cat"},{"b64_json":"second"}],"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7,"input_tokens_details":{"image_tokens":2,"text_tokens":1}}}`

	c, recorder, resp, info := newImageTestContext(t, body, "application/json", true)
	info.PriceData.UsePrice = true
	info.PriceData.AddOtherRatio("n", 3)

	usage, err := OpenaiImageStreamHandler(c, info, resp)
	require.Nil(t, err)
	require.Equal(t, 3, usage.PromptTokens)
	require.Equal(t, 4, usage.CompletionTokens)
	require.Equal(t, 7, usage.TotalTokens)
	require.Equal(t, 2, usage.PromptTokensDetails.ImageTokens)
	require.Equal(t, 1, usage.PromptTokensDetails.TextTokens)
	require.Equal(t, "text/event-stream", recorder.Header().Get("Content-Type"))
	require.Empty(t, recorder.Header().Get("Content-Length"))
	require.Contains(t, recorder.Body.String(), `event: image_generation.completed`)
	require.Contains(t, recorder.Body.String(), `"type":"image_generation.completed"`)
	require.Contains(t, recorder.Body.String(), `"b64_json":"first"`)
	require.Contains(t, recorder.Body.String(), `"b64_json":"second"`)
	require.Contains(t, recorder.Body.String(), `"revised_prompt":"draw a cat"`)
	require.Contains(t, recorder.Body.String(), `data: [DONE]`)
	require.Equal(t, 2, strings.Count(recorder.Body.String(), `event: image_generation.completed`))
	require.Equal(t, 2.0, info.PriceData.OtherRatios()["n"])
}

func TestOpenaiImageHandlerUsesPositiveActualCountForFixedPrice(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })
	longImage := strings.Repeat("a", 4096)

	tests := []struct {
		name      string
		body      string
		usePrice  bool
		wantCount float64
	}{
		{
			name:      "fixed price uses data length",
			body:      `{"data":[{"b64_json":"` + longImage + `"},{"b64_json":"second"}]}`,
			usePrice:  true,
			wantCount: 2,
		},
		{
			name:      "ratio billing ignores data length",
			body:      `{"data":[{"b64_json":"first"},{"b64_json":"second"}]}`,
			usePrice:  false,
			wantCount: 3,
		},
		{
			name:      "object data with url and b64_json counts one image",
			body:      `{"data":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=","b64_json":"` + longImage + `"}}`,
			usePrice:  true,
			wantCount: 1,
		},
		{
			name:      "url and b64_json split across entries count one image",
			body:      `{"data":[{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII="},{"b64_json":"` + longImage + `"}]}`,
			usePrice:  true,
			wantCount: 1,
		},
		{
			name:      "entries without image payload do not add to valid images",
			body:      `{"data":[{"revised_prompt":"draw a cat"},{"b64_json":"first"}]}`,
			usePrice:  true,
			wantCount: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, recorder, resp, info := newImageTestContext(t, tt.body, "application/json", false)
			info.PriceData.UsePrice = tt.usePrice
			info.PriceData.AddOtherRatio("n", 3)

			_, err := OpenaiImageHandler(c, info, resp)

			require.Nil(t, err)
			require.Equal(t, tt.wantCount, info.PriceData.OtherRatios()["n"])
			require.Equal(t, tt.body, recorder.Body.String())
		})
	}
}

// TestOpenaiImageStreamHandlerWrapsNonStandardDataShapes covers the JSON-to-SSE
// fallback when upstream returns data as an object, splits one image across a
// url entry and a b64_json entry, or returns entries without any image payload.
// Forwarded events and the billed quantity must both follow the real images.
func TestOpenaiImageStreamHandlerWrapsNonStandardDataShapes(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	for _, tc := range []struct {
		name       string
		body       string
		wantEvents int
		wantCount  float64
		wantBody   []string
	}{
		{
			name:       "object data is forwarded as one completed event",
			body:       `{"data":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=","b64_json":"first"}}`,
			wantEvents: 1,
			wantCount:  1,
			wantBody:   []string{`"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII="`, `"b64_json":"first"`},
		},
		{
			name:       "split url and b64_json entries bill one image",
			body:       `{"data":[{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII="},{"b64_json":"first"}]}`,
			wantEvents: 2,
			wantCount:  1,
			wantBody:   []string{`"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII="`, `"b64_json":"first"`},
		},
		{
			name:       "entries without image payload are dropped beside valid images",
			body:       `{"data":[{"revised_prompt":"draw a cat"},{"b64_json":"first"}]}`,
			wantEvents: 1,
			wantCount:  1,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, recorder, resp, info := newImageTestContext(t, tc.body, "application/json", true)
			info.PriceData.UsePrice = true
			info.PriceData.AddOtherRatio("n", 3)

			_, err := OpenaiImageStreamHandler(c, info, resp)
			require.Nil(t, err)
			out := recorder.Body.String()
			assert.Equal(t, tc.wantEvents, strings.Count(out, "event: image_generation.completed"))
			assert.Equal(t, tc.wantEvents, info.ReceivedResponseCount)
			for _, want := range tc.wantBody {
				assert.Contains(t, out, want)
			}
			assert.True(t, strings.HasSuffix(out, "data: [DONE]\n\n"))
			assert.Equal(t, tc.wantCount, info.PriceData.OtherRatios()["n"])
		})
	}
}

// TestOpenaiImageHandlersReturnJSONError covers JSON error responses for both
// entry points: the non-streaming handler and the stream handler's non-SSE
// fallback. Neither must leak the error body to the client.
func TestOpenaiImageHandlersReturnJSONError(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	body := `{"error":{"message":"content moderation failed","type":"upstream_error","code":"content_moderation_failed","status":502}}`

	t.Run("non-streaming handler", func(t *testing.T) {
		c, recorder, resp, info := newImageTestContext(t, body, "application/json", false)

		usage, err := OpenaiImageHandler(c, info, resp)
		require.Nil(t, usage)
		require.NotNil(t, err)
		require.Equal(t, http.StatusOK, err.StatusCode)
		oaiError := err.ToOpenAIError()
		require.Equal(t, "content moderation failed", oaiError.Message)
		require.Equal(t, "upstream_error", oaiError.Type)
		require.Equal(t, "content_moderation_failed", oaiError.Code)
		require.Empty(t, recorder.Body.String())
	})

	t.Run("stream handler JSON fallback", func(t *testing.T) {
		c, recorder, resp, info := newImageTestContext(t, body, "application/json", true)

		usage, err := OpenaiImageStreamHandler(c, info, resp)
		require.Nil(t, usage)
		require.NotNil(t, err)
		require.Equal(t, http.StatusOK, err.StatusCode)
		require.Equal(t, "content moderation failed", err.ToOpenAIError().Message)
		require.Empty(t, recorder.Body.String())
	})

	t.Run("stream handler non-2xx stays JSON error", func(t *testing.T) {
		c, recorder, resp, info := newImageTestContext(t, body, "application/json", true)
		resp.StatusCode = http.StatusBadGateway

		usage, err := OpenaiImageStreamHandler(c, info, resp)
		require.Nil(t, usage)
		require.NotNil(t, err)
		require.Equal(t, http.StatusBadGateway, err.StatusCode)
		require.Equal(t, "content moderation failed", err.ToOpenAIError().Message)
		require.Empty(t, recorder.Body.String())
		require.NotContains(t, recorder.Header().Get("Content-Type"), "text/event-stream")
	})
}

// TestOpenaiImageStreamHandlerRecordsUpstreamErrorEvent verifies that an error
// event inside the SSE stream is recorded as a soft error while the payload is
// still forwarded to the client.
func TestOpenaiImageStreamHandlerRecordsUpstreamErrorEvent(t *testing.T) {
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	body := strings.Join([]string{
		`event: image_generation.partial_image`,
		`data: {"type":"image_generation.partial_image","b64_json":"partial"}`,
		``,
		`event: error`,
		`data: {"type":"upstream_error","error":{"message":"stream error: stream ID 77; INTERNAL_ERROR; received from peer"}}`,
		``,
	}, "\n")

	c, recorder, resp, info := newImageTestContext(t, body, "text/event-stream", true)

	usage, err := OpenaiImageStreamHandler(c, info, resp)
	require.NotNil(t, err)
	require.Nil(t, usage)
	require.NotNil(t, info.StreamStatus)
	require.Contains(t, []relaycommon.StreamEndReason{relaycommon.StreamEndReasonHandlerStop, relaycommon.StreamEndReasonEOF}, info.StreamStatus.EndReason)
	require.True(t, info.StreamStatus.HasErrors())
	require.Equal(t, 1, info.StreamStatus.TotalErrorCount())
	require.Contains(t, info.StreamStatus.Errors[0].Message, "INTERNAL_ERROR")
	// The scanner strips the upstream "event: error" line; the event name is
	// rebuilt from the JSON "type" field (upstream_error). The error message
	// is still forwarded in the data: payload (stream ID 77).
	require.Contains(t, recorder.Body.String(), `event: upstream_error`)
	require.Contains(t, recorder.Body.String(), `stream ID 77`)
}

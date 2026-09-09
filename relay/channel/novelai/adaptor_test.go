package novelai

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/gin-gonic/gin"
)

func TestAdaptorBuildsNovelAIRequest(t *testing.T) {
	adaptor := &Adaptor{}
	info := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType:       constant.ChannelTypeNovelAI,
			ChannelBaseUrl:    "https://example.invalid/native",
			ApiKey:            "pst-test-token",
			UpstreamModelName: "nai-diffusion-4-5-full",
		},
		RelayMode: relayconstant.RelayModeImagesGenerations,
	}
	require.Equal(t, "https://example.invalid/native/ai/generate-image", mustRequestURL(t, adaptor, info))

	request := &dto.ImageRequest{
		Model:  "nai-diffusion-4-5-full",
		Prompt: "a white fox",
		N:      uintPtr(2),
		Extra: map[string]json.RawMessage{
			"nai": json.RawMessage(`{"parameters":{"width":832,"height":1216,"steps":28,"scale":5,"sampler":"k_euler_ancestral","seed":42,"negative_prompt":"lowres"}}`),
		},
	}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/images/generations", nil)

	body, err := adaptor.ConvertImageRequest(c, info, *request)
	require.NoError(t, err)
	buffer, ok := body.(*bytes.Buffer)
	require.True(t, ok)
	require.NotEmpty(t, buffer.Bytes())

	header := http.Header{}
	require.NoError(t, adaptor.SetupRequestHeader(c, &header, info))
	assert.Equal(t, "Bearer pst-test-token", header.Get("Authorization"))
	assert.Equal(t, "multipart/form-data", strings.Split(header.Get("Content-Type"), ";")[0])

	reader := multipart.NewReader(bytes.NewReader(buffer.Bytes()), strings.TrimPrefix(strings.Split(header.Get("Content-Type"), "boundary=")[1], ""))
	part, err := reader.NextPart()
	require.NoError(t, err)
	assert.Equal(t, "request", part.FormName())
	requestJSON, err := io.ReadAll(part)
	require.NoError(t, err)
	assert.Contains(t, string(requestJSON), `"action":"generate"`)
	assert.Contains(t, string(requestJSON), `"input":"a white fox"`)
}

func TestAdaptorRequiresExplicitBaseURL(t *testing.T) {
	info := &relaycommon.RelayInfo{
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType: constant.ChannelTypeNovelAI,
		},
	}
	_, err := (&Adaptor{}).GetRequestURL(info)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "base URL is required")
}

func TestAdaptorConvertsNovelAIZipToImageResponse(t *testing.T) {
	var zipBody bytes.Buffer
	writer := zip.NewWriter(&zipBody)
	imageBytes := []byte("fake-png")
	part, err := writer.Create("image_0.png")
	require.NoError(t, err)
	_, err = part.Write(imageBytes)
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	info := &relaycommon.RelayInfo{RelayMode: relayconstant.RelayModeImagesGenerations}
	response := &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(bytes.NewReader(zipBody.Bytes())),
		Header:     make(http.Header),
	}
	usage, apiError := (&Adaptor{}).DoResponse(c, response, info)
	require.Nil(t, apiError)
	require.NotNil(t, usage)

	var imageResponse dto.ImageResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &imageResponse))
	require.Len(t, imageResponse.Data, 1)
	assert.Equal(t, base64.StdEncoding.EncodeToString(imageBytes), imageResponse.Data[0].B64Json)
}

func mustRequestURL(t *testing.T, adaptor *Adaptor, info *relaycommon.RelayInfo) string {
	t.Helper()
	url, err := adaptor.GetRequestURL(info)
	require.NoError(t, err)
	return url
}

func uintPtr(value uint) *uint {
	return &value
}

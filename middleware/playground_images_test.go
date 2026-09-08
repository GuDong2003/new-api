package middleware

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func playgroundImageRequest(t *testing.T, path string, multipartBody bool, group string) *http.Request {
	t.Helper()
	fields := map[string]string{
		"model": "gpt-image-1", "group": group, "prompt": "A ceramic cup",
		"n": "2", "stream": "true", "output_compression": "0", "partial_images": "0",
	}
	if !multipartBody {
		body, err := common.Marshal(map[string]any{
			"model": "gpt-image-1", "group": group, "prompt": "A ceramic cup",
			"n": 2, "stream": true, "output_compression": 0, "partial_images": 0,
		})
		require.NoError(t, err)
		request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		return request
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		require.NoError(t, writer.WriteField(key, value))
	}
	image, err := writer.CreateFormFile("image", "cup.png")
	require.NoError(t, err)
	_, err = io.WriteString(image, "reference-image")
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	request := httptest.NewRequest(http.MethodPost, path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

// The playground image routes read the model and group out of the body, which
// is JSON for generation and multipart for an edit.
func TestPlaygroundImageRequestKeepsBodyReadableForRelay(t *testing.T) {
	gin.SetMode(gin.TestMode)

	for _, test := range []struct {
		name, path string
		multipart  bool
		mode       int
	}{
		{"generation as JSON", "/pg/images/generations", false, relayconstant.RelayModeImagesGenerations},
		{"edit as JSON", "/pg/images/edits", false, relayconstant.RelayModeImagesEdits},
		{"edit as multipart", "/pg/images/edits", true, relayconstant.RelayModeImagesEdits},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(recorder)
			context.Request = playgroundImageRequest(t, test.path, test.multipart, "premium")

			request, selectChannel, err := getModelRequest(context)
			require.NoError(t, err)
			assert.True(t, selectChannel)
			assert.Equal(t, "gpt-image-1", request.Model)
			assert.Equal(t, "premium", request.Group)
			assert.Equal(t, "premium", common.GetContextKeyString(context, constant.ContextKeyTokenGroup))
			assert.Equal(t, test.mode, relayconstant.Path2RelayMode(test.path))

			// The body must still be parseable afterwards, since the relay reads
			// it again to build the upstream request.
			imageRequest, err := helper.GetAndValidOpenAIImageRequest(context, test.mode)
			require.NoError(t, err)
			assert.Equal(t, "A ceramic cup", imageRequest.Prompt)
			require.NotNil(t, imageRequest.N)
			assert.Equal(t, uint(2), *imageRequest.N)

			if test.multipart {
				require.Len(t, context.Request.MultipartForm.File["image"], 1)
				assert.Equal(t, "0", context.Request.PostForm.Get("output_compression"))
			}
		})
	}
}

func TestPlaygroundRejectsUnauthorizedGroupBeforeChannelSelection(t *testing.T) {
	require.NoError(t, i18n.Init())
	gin.SetMode(gin.TestMode)
	previous := setting.UserUsableGroups2JSONString()
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default"}`))
	t.Cleanup(func() {
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(previous))
	})

	for _, path := range []string{
		"/pg/chat/completions",
		"/pg/images/generations",
		"/pg/images/edits",
	} {
		t.Run(path, func(t *testing.T) {
			router := gin.New()
			router.POST(
				path,
				func(c *gin.Context) {
					common.SetContextKey(c, constant.ContextKeyUsingGroup, "default")
					c.Next()
				},
				Distribute(),
				func(c *gin.Context) {
					t.Error("a request for an unusable group reached the relay")
					c.Status(http.StatusOK)
				},
			)

			response := httptest.NewRecorder()
			router.ServeHTTP(response, playgroundImageRequest(
				t, path, strings.HasSuffix(path, "/edits"), "private-test-group",
			))

			assert.Equal(t, http.StatusForbidden, response.Code)
		})
	}
}

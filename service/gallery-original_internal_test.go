package service

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"io"
	"net/http"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

type galleryOriginalTransport func(*http.Request) (*http.Response, error)

func (transport galleryOriginalTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestGalleryTransientOriginalCompletion(t *testing.T) {
	for _, test := range []struct {
		name     string
		truncate bool
	}{{"complete", false}, {"truncated", true}} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("GALLERY_STORAGE_DIR", root)
			var encoded bytes.Buffer
			require.NoError(t, png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 2, 2))))
			data := encoded.Bytes()
			client := &http.Client{Transport: galleryOriginalTransport(func(request *http.Request) (*http.Response, error) {
				require.Empty(t, request.Header.Get("Authorization"))
				require.Empty(t, request.Header.Get("Cookie"))
				require.Empty(t, request.Header.Get("Referer"))
				body := data
				if test.truncate {
					body = data[:len(data)-3]
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, ContentLength: int64(len(data)), Body: io.NopCloser(bytes.NewReader(body))}, nil
			})}
			file, mime, cleanup, err := downloadGalleryOriginal(context.Background(), 41, "https://images.example/a.png", client)
			if test.truncate {
				require.Error(t, err)
				require.Nil(t, file)
			} else {
				require.NoError(t, err)
				require.Equal(t, "image/png", mime)
				actual, err := io.ReadAll(file)
				require.NoError(t, err)
				require.Equal(t, data, actual)
				cleanup()
			}
			entries, err := os.ReadDir(root)
			require.NoError(t, err)
			require.Empty(t, entries)
		})
	}
}

func TestGalleryTransientOriginalRejectsUnsafeURLBeforeTransport(t *testing.T) {
	client := &http.Client{Transport: galleryOriginalTransport(func(*http.Request) (*http.Response, error) { t.Fatal("unsafe outbound request"); return nil, nil })}
	for _, url := range []string{"http://127.0.0.1/a.png", "http://169.254.169.254/a.png", "https://user:password@images.example/a.png", "file:///etc/passwd"} {
		file, _, _, err := downloadGalleryOriginal(context.Background(), 41, url, client)
		require.Error(t, err)
		require.Nil(t, file)
	}
}

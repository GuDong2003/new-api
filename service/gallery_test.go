package service_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func galleryFixture(t *testing.T, dialect gorm.Dialector) {
	t.Helper()
	old := model.DB
	db, err := gorm.Open(dialect, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	model.DB = db
	t.Setenv("GALLERY_STORAGE_DIR", t.TempDir())
	require.NoError(t, model.MigrateGallery(db))
	require.NoError(t, db.Where("1 = 1").Delete(&model.GalleryImage{}).Error)
	require.NoError(t, db.Where("1 = 1").Delete(&model.GallerySettings{}).Error)
	require.NoError(t, model.MigrateGallery(db))
	t.Cleanup(func() { model.DB = old; sqlDB, _ := db.DB(); _ = sqlDB.Close() })
}

func galleryPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 16, 8))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	return b.Bytes()
}

func galleryMultipart(t *testing.T, metadata string, fields ...[]string) *multipart.Reader {
	t.Helper()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	if metadata != "" {
		require.NoError(t, w.WriteField("metadata", metadata))
	}
	for _, field := range fields {
		require.NoError(t, w.WriteField(field[0], field[1]))
	}
	require.NoError(t, w.Close())
	return multipart.NewReader(&b, w.Boundary())
}

func gallerySave(t *testing.T, user int, source, id string, data []byte) (*model.GalleryImage, error) {
	t.Helper()
	metadata, _ := common.Marshal(map[string]any{"source": source, "source_id": id, "model": "test", "prompt": "fox", "parameters": map[string]any{"seed": 42, "api_key": "never persist", "url": "https://secret.invalid"}})
	return service.SaveGalleryImage(context.Background(), user, galleryMultipart(t, string(metadata), []string{"file", string(data)}))
}

func TestGalleryDatabaseMatrix(t *testing.T) {
	dialects := map[string]gorm.Dialector{"sqlite": sqlite.Open(filepath.Join(t.TempDir(), "gallery.db"))}
	if dsn := os.Getenv("GALLERY_TEST_MYSQL_DSN"); dsn != "" {
		dialects["mysql"] = mysql.Open(dsn)
	}
	if dsn := os.Getenv("GALLERY_TEST_POSTGRES_DSN"); dsn != "" {
		dialects["postgres"] = postgres.Open(dsn)
	}
	for name, dialect := range dialects {
		t.Run(name, func(t *testing.T) {
			galleryFixture(t, dialect)
			ctx := context.Background()
			original := galleryPNG(t)
			usage, err := service.GetGalleryUsage(ctx, 1)
			require.NoError(t, err)
			require.Zero(t, usage.UsedImages)
			require.True(t, usage.CanSave)
			settings, err := service.GetGallerySettings(ctx)
			require.NoError(t, err)
			settings.UserMaxImages = 2
			_, err = service.UpdateGallerySettings(ctx, *settings)
			require.NoError(t, err)
			first, err := gallerySave(t, 1, "drawing", "job:0", original)
			require.NoError(t, err)
			retry, err := gallerySave(t, 1, "drawing", "job:0", original)
			require.NoError(t, err)
			require.Equal(t, first.ID, retry.ID)
			_, _, err = service.OpenGalleryImage(ctx, 2, first.ID, false)
			require.ErrorIs(t, err, gorm.ErrRecordNotFound)
			f, _, err := service.OpenGalleryImage(ctx, 1, first.ID, false)
			require.NoError(t, err)
			data, err := io.ReadAll(f)
			f.Close()
			require.NoError(t, err)
			require.Equal(t, original, data)
			require.NotContains(t, first.Parameters, "api_key")
			require.NotContains(t, first.Parameters, "url")
			_, err = gallerySave(t, 1, "nai", "nai:0", original)
			require.NoError(t, err)
			usage, err = service.GetGalleryUsage(ctx, 1)
			require.NoError(t, err)
			require.EqualValues(t, 2, usage.UsedImages)
			require.Greater(t, usage.UsedBytes, int64(len(original)*2))
			require.False(t, usage.CanSave)
			_, err = gallerySave(t, 1, "drawing", "third", original)
			require.EqualError(t, err, "Gallery storage limit reached.")
			other, err := gallerySave(t, 2, "nai", "job:0", original)
			require.NoError(t, err)
			require.NotEqual(t, first.ID, other.ID)
			require.ErrorIs(t, service.DeleteGalleryImage(ctx, 2, first.ID), gorm.ErrRecordNotFound)
			page, err := service.ListGalleryImages(ctx, 1, 1, 24, "drawing")
			require.NoError(t, err)
			require.EqualValues(t, 1, page.Total)
			require.Len(t, page.Items, 1)
			require.NoError(t, model.MigrateGallery(model.DB))
			require.NoError(t, model.MigrateGallery(model.DB))
			stored, err := service.GetGallerySettings(ctx)
			require.NoError(t, err)
			require.Equal(t, 2, stored.UserMaxImages)
			var duplicate = model.GalleryImage{ID: "duplicate", UserID: 1, SourceID: "job:0"}
			require.Error(t, model.DB.Create(&duplicate).Error)
			require.NoError(t, model.DB.Model(&model.GalleryImage{}).Where("id = ?", first.ID).Update("expires_at", time.Now().Unix()-1).Error)
			_, _, err = service.OpenGalleryImage(ctx, 1, first.ID, false)
			require.ErrorIs(t, err, gorm.ErrRecordNotFound)
			require.NoError(t, service.CleanupGallery(ctx))
			usage, err = service.GetGalleryUsage(ctx, 1)
			require.NoError(t, err)
			require.EqualValues(t, 1, usage.UsedImages)
			require.NoError(t, service.DeleteGalleryImage(ctx, 2, other.ID))
		})
	}
}

func TestGalleryRejectsMalformedAndForbiddenInputs(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	data := galleryPNG(t)
	valid := `{"source":"drawing","source_id":"job","model":"test","parameters":{}}`
	for name, reader := range map[string]*multipart.Reader{
		"missing metadata":   galleryMultipart(t, "", []string{"file", string(data)}),
		"oversized metadata": galleryMultipart(t, strings.Repeat("a", 65537), []string{"file", string(data)}),
		"two sources":        galleryMultipart(t, valid, []string{"file", string(data)}, []string{"file", string(data)}),
		"invalid source":     galleryMultipart(t, `{"source":"api","source_id":"job"}`, []string{"file", string(data)}),
		"invalid bytes":      galleryMultipart(t, valid, []string{"file", "not an image"}),
		"truncated PNG":      galleryMultipart(t, valid, []string{"file", string(data[:len(data)-8])}),
		"private URL":        galleryMultipart(t, valid, []string{"url", "http://127.0.0.1/image.png"}),
		"metadata URL":       galleryMultipart(t, valid, []string{"url", "http://169.254.169.254/latest/meta-data/"}),
		"credentials URL":    galleryMultipart(t, valid, []string{"url", "https://secret:password@example.com/image.png"}),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := service.SaveGalleryImage(ctx, 1, reader)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "127.0.0.1")
			usage, e := service.GetGalleryUsage(ctx, 1)
			require.NoError(t, e)
			require.Zero(t, usage.UsedImages)
		})
	}
	settings, err := service.GetGallerySettings(ctx)
	require.NoError(t, err)
	for _, days := range []int{0, 3651} {
		bad := *settings
		bad.RetentionDays = days
		_, err = service.UpdateGallerySettings(ctx, bad)
		require.EqualError(t, err, "Gallery settings are invalid.")
	}
	bad := *settings
	bad.UserMaxBytes = 1<<40 + 1
	_, err = service.UpdateGallerySettings(ctx, bad)
	require.Error(t, err)
	settings.Enabled = false
	_, err = service.UpdateGallerySettings(ctx, *settings)
	require.NoError(t, err)
	_, err = gallerySave(t, 1, "drawing", "disabled", data)
	require.EqualError(t, err, "Gallery storage is disabled.")
}

func TestGalleryPrivateHTTPAndIdempotentMultipartValidation(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	original := galleryPNG(t)
	first, err := gallerySave(t, 1, "drawing", "job", original)
	require.NoError(t, err)
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(func(c *gin.Context) {
		if c.GetHeader("Authorization") == "Bearer owner" {
			c.Set("id", 1)
		} else {
			c.Set("id", 2)
		}
	})
	engine.GET("/images/:id/file", controller.GetGalleryFile)
	engine.DELETE("/images/:id", controller.DeleteGalleryImage)
	engine.GET("/images", controller.ListGalleryImages)
	engine.PUT("/settings", controller.UpdateGallerySettings)
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		path := "/images/" + first.ID
		if method == http.MethodGet {
			path += "/file"
		}
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, path, nil)
		engine.ServeHTTP(response, request)
		require.Equal(t, http.StatusNotFound, response.Code)
		require.NotContains(t, response.Body.String(), os.Getenv("GALLERY_STORAGE_DIR"))
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/images/"+first.ID+"/file", nil)
	request.Header.Set("Authorization", "Bearer owner")
	engine.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, original, response.Body.Bytes())
	require.Equal(t, "private, no-store", response.Header().Get("Cache-Control"))
	response = httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/images", nil))
	require.Contains(t, response.Body.String(), `"items":[]`)
	for _, body := range []string{`{"retention_days":7,"user_max_images":100,"user_max_bytes":209715200,"total_max_bytes":536870912}`, `{"enabled":null,"retention_days":7,"user_max_images":100,"user_max_bytes":209715200,"total_max_bytes":536870912}`, `{"enabled":true,"retention_days":7,"user_max_images":100,"user_max_bytes":9007199254740993,"total_max_bytes":536870912}`} {
		response = httptest.NewRecorder()
		engine.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/settings", strings.NewReader(body)))
		require.Equal(t, http.StatusBadRequest, response.Code)
	}
	// Retrying an existing source ID must not bypass the exactly-one-source rule.
	metadata := `{"source":"drawing","source_id":"job","model":"test","parameters":{}}`
	_, err = service.SaveGalleryImage(context.Background(), 1, galleryMultipart(t, metadata, []string{"file", string(original)}, []string{"url", "https://example.com/image.png"}))
	require.ErrorIs(t, err, model.ErrGalleryInvalid)
}

func TestGalleryQuotasCleanupAndLowerLimits(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	original := galleryPNG(t)
	settings, err := service.GetGallerySettings(ctx)
	require.NoError(t, err)
	settings.UserMaxBytes = 1 << 20
	settings.TotalMaxBytes = 1 << 20
	_, err = service.UpdateGallerySettings(ctx, *settings)
	require.NoError(t, err)
	// Streaming writes must stop at the remaining budget, and failures free it.
	_, err = gallerySave(t, 1, "drawing", "oversize", bytes.Repeat([]byte{1}, (1<<20)+1))
	require.ErrorIs(t, err, model.ErrGalleryCapacity)
	entries, err := os.ReadDir(os.Getenv("GALLERY_STORAGE_DIR"))
	require.NoError(t, err)
	require.Empty(t, entries)
	first, err := gallerySave(t, 1, "drawing", "first", original)
	require.NoError(t, err)
	// Simulate retained image usage near the global cap, independent of user cap.
	require.NoError(t, model.DB.Model(&model.GalleryImage{}).Where("id = ?", first.ID).Update("storage_bytes", (1<<20)-100).Error)
	_, err = gallerySave(t, 2, "nai", "global", original)
	require.ErrorIs(t, err, model.ErrGalleryCapacity)
	require.NoError(t, model.DB.Model(&model.GalleryImage{}).Where("id = ?", first.ID).Update("storage_bytes", first.StorageBytes).Error)
	second, err := gallerySave(t, 1, "nai", "second", original)
	require.NoError(t, err)
	settings.UserMaxImages = 1
	settings.RetentionDays = 1
	_, err = service.UpdateGallerySettings(ctx, *settings)
	require.NoError(t, err)
	require.NoError(t, service.CleanupGallery(ctx))
	page, err := service.ListGalleryImages(ctx, 1, 1, 24, "")
	require.NoError(t, err)
	require.EqualValues(t, 2, page.Total)
	require.EqualValues(t, 7*86400, first.ExpiresAt-first.CreatedAt)
	require.NoError(t, service.DeleteGalleryImage(ctx, 1, first.ID))
	require.NoError(t, service.DeleteGalleryImage(ctx, 1, second.ID))
	fresh, err := gallerySave(t, 1, "nai", "future", original)
	require.NoError(t, err)
	require.EqualValues(t, 86400, fresh.ExpiresAt-fresh.CreatedAt)
	// Simulate an interrupted write using its persisted ownership record. Recovery
	// must remove those files, not an unrelated file in the same directory.
	require.NoError(t, model.DB.Model(&model.GalleryImage{}).Where("id = ?", fresh.ID).Update("state", "pending").Error)
	unrelated := filepath.Join(os.Getenv("GALLERY_STORAGE_DIR"), "unrelated.keep")
	require.NoError(t, os.WriteFile(unrelated, []byte("preserve"), 0600))
	service.StartGallery()
	service.StopGallery()
	entries, err = os.ReadDir(os.Getenv("GALLERY_STORAGE_DIR"))
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "unrelated.keep", entries[0].Name())
	usage, err := service.GetGalleryUsage(ctx, 1)
	require.NoError(t, err)
	require.Zero(t, usage.UsedBytes)
}

func TestGalleryParameterTypesAndSafeNAIMetadata(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	original := galleryPNG(t)
	for _, parameters := range []string{`{"seed":true}`, `{"sm":"secret"}`, `{"width":[]}`, `{"sampler":"https://private.invalid"}`, `{"ucPresetId":2}`} {
		metadata := `{"source":"nai","source_id":"typed","model":"test","parameters":` + parameters + `}`
		_, err := service.SaveGalleryImage(ctx, 1, galleryMultipart(t, metadata, []string{"file", string(original)}))
		require.ErrorIs(t, err, model.ErrGalleryInvalid)
	}
	metadata := `{"source":"nai","source_id":"safe","model":"test","parameters":{"params_version":4,"n_samples":1,"ucPresetId":"humanFocus","qualityPresetId":"light","tag_hint_qt":3,"legacy":false,"image_format":"png","reference_image_multiple":["secret binary"],"api_key":"secret"}}`
	saved, err := service.SaveGalleryImage(ctx, 1, galleryMultipart(t, metadata, []string{"file", string(original)}))
	require.NoError(t, err)
	require.Equal(t, float64(4), saved.Parameters["params_version"])
	require.Equal(t, "light", saved.Parameters["qualityPresetId"])
	require.Equal(t, "humanFocus", saved.Parameters["ucPresetId"])
	require.NotContains(t, saved.Parameters, "reference_image_multiple")
}

func TestGalleryOriginalFormatsThumbnailFallbackAndDeletionRetry(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	var jpegData, widePNG bytes.Buffer
	require.NoError(t, jpeg.Encode(&jpegData, image.NewRGBA(image.Rect(0, 0, 4, 2)), nil))
	require.NoError(t, png.Encode(&widePNG, image.NewRGBA(image.Rect(0, 0, 9000, 1))))
	webpData, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	require.NoError(t, err)
	for name, data := range map[string][]byte{"jpeg": jpegData.Bytes(), "webp": webpData, "wide": widePNG.Bytes()} {
		t.Run(name, func(t *testing.T) {
			saved, err := gallerySave(t, 1, "drawing", name, data)
			require.NoError(t, err)
			original, _, err := service.OpenGalleryImage(ctx, 1, saved.ID, false)
			require.NoError(t, err)
			got, err := io.ReadAll(original)
			original.Close()
			require.NoError(t, err)
			require.Equal(t, data, got)
			if name == "wide" {
				require.False(t, saved.HasThumbnail)
				f, _, err := service.OpenGalleryImage(ctx, 1, saved.ID, true)
				require.NoError(t, err)
				got, err := io.ReadAll(f)
				f.Close()
				require.NoError(t, err)
				require.Equal(t, data, got)
			}
		})
	}
	saved, err := gallerySave(t, 2, "nai", "delete", galleryPNG(t))
	require.NoError(t, err)
	path := filepath.Join(os.Getenv("GALLERY_STORAGE_DIR"), "gallery-"+saved.ID+".original")
	// A filesystem failure cannot remove accounting before the bytes are removed.
	require.NoError(t, os.Rename(path, path+".held"))
	require.NoError(t, os.Mkdir(path, 0700))
	blocker := filepath.Join(path, "blocker")
	require.NoError(t, os.WriteFile(blocker, []byte("x"), 0600))
	require.ErrorIs(t, service.DeleteGalleryImage(ctx, 2, saved.ID), model.ErrGalleryUnavailable)
	usage, err := service.GetGalleryUsage(ctx, 2)
	require.NoError(t, err)
	require.EqualValues(t, 1, usage.UsedImages)
	require.Equal(t, saved.StorageBytes, usage.UsedBytes)
	require.NoError(t, os.Remove(blocker))
	require.NoError(t, os.Remove(path))
	require.NoError(t, os.Rename(path+".held", path))
	require.NoError(t, service.DeleteGalleryImage(ctx, 2, saved.ID))
	usage, err = service.GetGalleryUsage(ctx, 2)
	require.NoError(t, err)
	require.Zero(t, usage.UsedBytes)
}

func TestGalleryRejectsFramedPNGWithUndecodablePixels(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	// The genuine tiny PNG contributes a valid IHDR and IEND. Replace its
	// compressed pixels with an empty IDAT whose framing and CRC are valid.
	original := galleryPNG(t)
	malformed := append([]byte(nil), original[:33]...)
	var emptyIDAT [12]byte
	copy(emptyIDAT[4:8], "IDAT")
	binary.BigEndian.PutUint32(emptyIDAT[8:], crc32.ChecksumIEEE([]byte("IDAT")))
	malformed = append(malformed, emptyIDAT[:]...)
	malformed = append(malformed, original[len(original)-12:]...)
	config, _, err := image.DecodeConfig(bytes.NewReader(malformed))
	require.NoError(t, err)
	require.Equal(t, 16, config.Width)
	_, _, err = image.Decode(bytes.NewReader(malformed))
	require.Error(t, err)
	_, err = gallerySave(t, 1, "drawing", "bad-pixels", malformed)
	require.ErrorIs(t, err, model.ErrGalleryInvalid)
	var count int64
	require.NoError(t, model.DB.Model(&model.GalleryImage{}).Count(&count).Error)
	require.Zero(t, count)
	entries, err := os.ReadDir(os.Getenv("GALLERY_STORAGE_DIR"))
	require.NoError(t, err)
	require.Empty(t, entries)
}

func TestGalleryConcurrentAdmissionAndIdempotency(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	original := galleryPNG(t)
	settings, err := service.GetGallerySettings(ctx)
	require.NoError(t, err)
	settings.UserMaxImages = 1
	_, err = service.UpdateGallerySettings(ctx, *settings)
	require.NoError(t, err)
	readers := []*multipart.Reader{}
	for _, id := range []string{"job-a", "job-b"} {
		metadata := `{"source":"drawing","source_id":"` + id + `","model":"test","parameters":{}}`
		readers = append(readers, galleryMultipart(t, metadata, []string{"file", string(original)}))
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, reader := range readers {
		wg.Go(func() { _, err := service.SaveGalleryImage(ctx, 1, reader); results <- err })
	}
	wg.Wait()
	close(results)
	successes, limited := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			require.ErrorIs(t, err, model.ErrGalleryCapacity)
			limited++
		}
	}
	require.Equal(t, 1, successes)
	require.Equal(t, 1, limited)
	usage, err := service.GetGalleryUsage(ctx, 1)
	require.NoError(t, err)
	require.EqualValues(t, 1, usage.UsedImages)
}

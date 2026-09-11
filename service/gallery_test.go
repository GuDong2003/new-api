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
	"math"
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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
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
	require.NoError(t, db.Where("1 = 1").Delete(&model.GalleryCanvas{}).Error)
	require.NoError(t, db.Where("1 = 1").Delete(&model.GalleryRemoval{}).Error)
	require.NoError(t, db.Where("1 = 1").Delete(&model.GallerySettings{}).Error)
	require.NoError(t, model.MigrateGallery(db))
	t.Cleanup(func() { model.DB = old; sqlDB, _ := db.DB(); _ = sqlDB.Close() })
}

func galleryCanvasDocument(t *testing.T, kind string) map[string]any {
	t.Helper()
	var doc map[string]any
	input := `{"version":1,"nodes":[],"edges":[],"referenceIds":[],"mask":null,"viewport":{"x":0,"y":0,"zoom":1},"settings":{"model":"gpt-image-1","size":"auto","n":1}}`
	if kind == "nai" {
		input = `{"version":1,"nodes":[],"viewport":{"x":0,"y":0,"zoom":1},"settings":{"model":"nai-diffusion-4-full","negativePrompt":"blur","width":1024,"height":1024,"steps":30,"scale":6.5,"sampler":"k_dpmpp_2m","noiseSchedule":"exponential","cfgRescale":0.25,"seed":4294967295,"n":2,"qualityToggle":true,"qualityTier":"light","ucPreset":"humanFocus","smea":true,"smeaDyn":true,"decrisp":true}}`
	}
	require.NoError(t, common.UnmarshalJsonStr(input, &doc))
	return doc
}

func galleryCanvasDrawingReferences(t *testing.T) map[string]any {
	t.Helper()
	var doc map[string]any
	require.NoError(t, common.UnmarshalJsonStr(`{
		"version":1,"viewport":{"x":0,"y":0,"zoom":1},
		"settings":{"mode":"edit","model":"gpt-image-1","prompt":"a white fox","size":"auto","n":1,"outputCompression":0,"stream":false},
		"nodes":[
			{"id":"reference-node","type":"image","position":{"x":-20,"y":10},"width":280,"height":330,"data":{"asset":{"id":"11111111-1111-4111-8111-111111111111","name":"fox.png","width":16,"height":8,"mimeType":"image/png"},"prompt":"fox","settings":{},"status":"complete","createdAt":100}},
			{"id":"result-node","type":"image","position":{"x":400,"y":20},"data":{"asset":{"id":"11111111-1111-4111-8111-111111111111","name":"fox.png","width":16,"height":8,"mimeType":"image/png"},"prompt":"a white fox","revisedPrompt":"a snowy fox","settings":{"mode":"edit"},"status":"complete","createdAt":101,"referenceIds":["reference-node"],"mask":{"id":"22222222-2222-4222-8222-222222222222","name":"mask.png","width":16,"height":8,"mimeType":"image/png"}}}
		],
		"edges":[{"id":"reference-edge","source":"reference-node","target":"result-node"}],
		"referenceIds":["reference-node"],
		"mask":{"referenceId":"reference-node","asset":{"id":"22222222-2222-4222-8222-222222222222","name":"mask.png","width":16,"height":8,"mimeType":"image/png"}}
	}`, &doc))
	return doc
}

func TestGalleryCanvasDocumentContentAndSanitization(t *testing.T) {
	for _, kind := range []string{"drawing", "nai"} {
		t.Run(kind, func(t *testing.T) {
			doc := galleryCanvasDocument(t, kind)
			first, err := service.NormalizeGalleryCanvasDocument(kind, doc)
			require.NoError(t, err)
			require.Len(t, first.ContentHash, 64)
			require.Empty(t, first.Assets)
			raw, err := common.Marshal(first.Document)
			require.NoError(t, err)
			require.EqualValues(t, len(raw), first.Bytes)
			doc["viewport"] = map[string]any{"x": float64(20), "y": float64(10), "zoom": float64(2)}
			doc["api_key"] = "must not persist"
			settings := doc["settings"].(map[string]any)
			settings["headers"] = map[string]any{"Authorization": "Bearer secret"}
			settings["unknown"] = "must not persist"
			second, err := service.NormalizeGalleryCanvasDocument(kind, doc)
			require.NoError(t, err)
			require.Equal(t, first.ContentHash, second.ContentHash)
			require.NotContains(t, second.Document, "api_key")
			require.NotContains(t, second.Document["settings"], "headers")
			require.NotContains(t, second.Document["settings"], "unknown")
			require.Equal(t, float64(0), first.Document["viewport"].(map[string]any)["x"])
			settings["prompt"] = "actual new content"
			third, err := service.NormalizeGalleryCanvasDocument(kind, doc)
			require.NoError(t, err)
			require.NotEqual(t, first.ContentHash, third.ContentHash)
		})
	}
}

func TestGalleryCanvasDocumentPreservesEditorRelationsAndSettings(t *testing.T) {
	doc := galleryCanvasDrawingReferences(t)
	info, err := service.NormalizeGalleryCanvasDocument("drawing", doc)
	require.NoError(t, err)
	require.Equal(t, []service.GalleryCanvasAssetRef{
		{ID: "11111111-1111-4111-8111-111111111111", Name: "fox.png", Width: 16, Height: 8, MIMEType: "image/png"},
		{ID: "22222222-2222-4222-8222-222222222222", Name: "mask.png", Width: 16, Height: 8, MIMEType: "image/png"},
	}, info.Assets)
	require.Equal(t, doc["edges"], info.Document["edges"])
	require.Equal(t, doc["mask"], info.Document["mask"])
	require.Equal(t, doc["referenceIds"], info.Document["referenceIds"])
	data := info.Document["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)
	require.Equal(t, []any{"reference-node"}, data["referenceIds"])
	require.Equal(t, "a snowy fox", data["revisedPrompt"])
	require.Equal(t, float64(0), info.Document["settings"].(map[string]any)["outputCompression"])
	doc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)["jobId"] = "runtime-job"
	doc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)["progress"] = float64(50)
	retry, err := service.NormalizeGalleryCanvasDocument("drawing", doc)
	require.NoError(t, err)
	require.Equal(t, info.ContentHash, retry.ContentHash)
	data = retry.Document["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)
	require.NotContains(t, data, "jobId")
	require.NotContains(t, data, "progress")
	nai := galleryCanvasDocument(t, "nai")
	naiInfo, err := service.NormalizeGalleryCanvasDocument("nai", nai)
	require.NoError(t, err)
	for key, value := range nai["settings"].(map[string]any) {
		require.Equal(t, value, naiInfo.Document["settings"].(map[string]any)[key], key)
	}
}

func TestGalleryCanvasDocumentRejectsMalformedContent(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"wrong version":        func(d map[string]any) { d["version"] = float64(2) },
		"string version":       func(d map[string]any) { d["version"] = "1" },
		"missing nodes":        func(d map[string]any) { delete(d, "nodes") },
		"null nodes":           func(d map[string]any) { d["nodes"] = nil },
		"duplicate node":       func(d map[string]any) { d["nodes"] = append(d["nodes"].([]any), d["nodes"].([]any)[0]) },
		"dangling edge":        func(d map[string]any) { d["edges"].([]any)[0].(map[string]any)["source"] = "missing" },
		"dangling reference":   func(d map[string]any) { d["referenceIds"] = []any{"missing"} },
		"wrong mask reference": func(d map[string]any) { d["mask"].(map[string]any)["referenceId"] = "result-node" },
		"wrong mask size":      func(d map[string]any) { d["mask"].(map[string]any)["asset"].(map[string]any)["width"] = float64(17) },
		"infinite viewport":    func(d map[string]any) { d["viewport"].(map[string]any)["x"] = math.Inf(1) },
		"invalid zoom":         func(d map[string]any) { d["viewport"].(map[string]any)["zoom"] = float64(0) },
		"fractional n":         func(d map[string]any) { d["settings"].(map[string]any)["n"] = 1.5 },
		"bad enum":             func(d map[string]any) { d["settings"].(map[string]any)["mode"] = "unknown" },
		"too many nodes":       func(d map[string]any) { d["nodes"] = make([]any, 501) },
		"too many edges":       func(d map[string]any) { d["edges"] = make([]any, 8001) },
		"too many references":  func(d map[string]any) { d["referenceIds"] = make([]any, 17) },
	} {
		t.Run(name, func(t *testing.T) {
			doc := galleryCanvasDrawingReferences(t)
			mutate(doc)
			_, err := service.NormalizeGalleryCanvasDocument("drawing", doc)
			require.ErrorIs(t, err, model.ErrGalleryInvalid)
		})
	}
	for name, mutate := range map[string]func(map[string]any){
		"embedded src":            func(d map[string]any) { d["asset"].(map[string]any)["src"] = "data:image/png;base64,secret" },
		"non UUID":                func(d map[string]any) { d["asset"].(map[string]any)["id"] = "legacy-task-id" },
		"unsafe MIME":             func(d map[string]any) { d["asset"].(map[string]any)["mimeType"] = "image/svg+xml" },
		"fractional dimension":    func(d map[string]any) { d["asset"].(map[string]any)["width"] = 1.5 },
		"conflicting descriptor":  func(d map[string]any) { d["asset"].(map[string]any)["name"] = "different.png" },
		"dangling node reference": func(d map[string]any) { d["referenceIds"] = []any{"missing"} },
		"node mask mismatch":      func(d map[string]any) { d["mask"].(map[string]any)["height"] = float64(9) },
		"invalid status":          func(d map[string]any) { d["status"] = "running" },
		"NaN created time":        func(d map[string]any) { d["createdAt"] = math.NaN() },
	} {
		t.Run(name, func(t *testing.T) {
			doc := galleryCanvasDrawingReferences(t)
			mutate(doc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any))
			_, err := service.NormalizeGalleryCanvasDocument("drawing", doc)
			require.ErrorIs(t, err, model.ErrGalleryInvalid)
		})
	}
	_, err := service.NormalizeGalleryCanvasDocument("unknown", galleryCanvasDocument(t, "drawing"))
	require.ErrorIs(t, err, model.ErrGalleryInvalid)
}

func TestGalleryCanvasDocumentNAINodeAndUsage(t *testing.T) {
	doc := galleryCanvasDocument(t, "nai")
	var node map[string]any
	require.NoError(t, common.UnmarshalJsonStr(`{"id":"nai-node","type":"nai-image","position":{"x":12,"y":-24},"data":{"asset":{"id":"33333333-3333-4333-8333-333333333333","name":"novel.jpg","width":1024,"height":1024,"mimeType":"image/jpeg"},"prompt":"a fox","settings":{"seed":0,"scale":0,"cfgRescale":0},"status":"complete","createdAt":123,"usage":{"input_tokens":12,"output_tokens":34,"total_tokens":46,"input_tokens_details":{"text_tokens":2,"image_tokens":10,"Authorization":"secret"},"api_key":"secret"}}}`, &node))
	doc["nodes"] = []any{node}
	info, err := service.NormalizeGalleryCanvasDocument("nai", doc)
	require.NoError(t, err)
	assert.Equal(t, []service.GalleryCanvasAssetRef{{ID: "33333333-3333-4333-8333-333333333333", Name: "novel.jpg", Width: 1024, Height: 1024, MIMEType: "image/jpeg"}}, info.Assets)
	data := info.Document["nodes"].([]any)[0].(map[string]any)["data"].(map[string]any)
	assert.Equal(t, map[string]any{"input_tokens": float64(12), "output_tokens": float64(34), "total_tokens": float64(46), "input_tokens_details": map[string]any{"text_tokens": float64(2), "image_tokens": float64(10)}}, data["usage"])
	assert.Equal(t, float64(0), data["settings"].(map[string]any)["seed"])
	assert.Equal(t, float64(0), data["settings"].(map[string]any)["scale"])
	assert.NotContains(t, info.Document, "referenceIds")
	_, err = service.NormalizeGalleryCanvasDocument("drawing", doc)
	require.ErrorIs(t, err, model.ErrGalleryInvalid)
	node["data"].(map[string]any)["usage"].(map[string]any)["input_tokens"] = "secret-not-a-number"
	_, err = service.NormalizeGalleryCanvasDocument("nai", doc)
	require.ErrorIs(t, err, model.ErrGalleryInvalid)
}

func TestGalleryCanvasDocumentSettingsBoundaries(t *testing.T) {
	for _, tc := range []struct {
		kind, key string
		value     any
	}{
		{"nai", "seed", float64(4294967296)},
		{"nai", "width", float64(2049)},
		{"nai", "steps", float64(51)},
		{"nai", "scale", float64(-1)},
		{"nai", "cfgRescale", 1.1},
		{"nai", "n", float64(9)},
		{"nai", "sampler", "unsupported"},
		{"nai", "qualityToggle", "false"},
		{"drawing", "n", float64(11)},
		{"drawing", "outputCompression", float64(-1)},
		{"drawing", "partialImages", float64(4)},
		{"drawing", "prompt", strings.Repeat("🦊", 16001)},
	} {
		t.Run(tc.kind+"/"+tc.key, func(t *testing.T) {
			doc := galleryCanvasDocument(t, tc.kind)
			doc["settings"].(map[string]any)[tc.key] = tc.value
			_, err := service.NormalizeGalleryCanvasDocument(tc.kind, doc)
			require.ErrorIs(t, err, model.ErrGalleryInvalid)
		})
	}
	doc := galleryCanvasDocument(t, "drawing")
	var settings map[string]any
	require.NoError(t, common.UnmarshalJsonStr(`{"mode":"edit","group":"custom","model":"dall-e-3","prompt":"fox","size":"1792x1024","quality":"hd","n":10,"background":"opaque","outputFormat":"webp","outputCompression":0,"moderation":"low","responseFormat":"url","style":"natural","inputFidelity":"high","stream":true,"partialImages":3,"user":"artist"}`, &settings))
	doc["settings"] = settings
	info, err := service.NormalizeGalleryCanvasDocument("drawing", doc)
	require.NoError(t, err)
	assert.Equal(t, settings, info.Document["settings"])
	// Persistence mirrors the schema; generation-time model compatibility is
	// enforced by the editor/request layer, not by saving a historical document.
}

func TestGalleryCanvasMigrationAndTotals(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	legacy := model.GalleryImage{ID: "legacy", UserID: 1, SourceID: "old-job", State: "ready", StorageBytes: 100, ExpiresAt: 12345, ParametersJSON: `{"seed":42}`}
	require.NoError(t, model.DB.Create(&legacy).Error)
	settings := model.GallerySettings{Enabled: false, RetentionDays: 23, UserMaxImages: 234, UserMaxBytes: 3000000, TotalMaxBytes: 9000000}
	require.NoError(t, model.WriteGallerySettings(ctx, settings))
	for range 2 {
		require.NoError(t, model.MigrateGallery(model.DB))
	}
	var restored model.GalleryImage
	require.NoError(t, model.DB.First(&restored, "id = ?", "legacy").Error)
	require.Equal(t, int64(12345), restored.ExpiresAt)
	require.Equal(t, float64(42), restored.Parameters["seed"])
	stored, err := model.ReadGallerySettings(ctx)
	require.NoError(t, err)
	settings.ID = 1
	require.Equal(t, settings, *stored)
	for _, image := range []model.GalleryImage{
		{ID: "ref", UserID: 1, SourceID: "ref", Role: "reference", StorageBytes: 200},
		{ID: "mask", UserID: 1, SourceID: "mask", Role: "mask", StorageBytes: 30, State: "deleting"},
		{ID: "other", UserID: 2, SourceID: "other", Role: "generated", StorageBytes: 400},
	} {
		require.NoError(t, model.DB.Create(&image).Error)
	}
	canvas := model.GalleryCanvas{ID: "canvas", UserID: 1, Kind: "drawing", Name: "foxes", Revision: 3, State: "ready", MutationID: "mutation", DocumentJSON: `{"version":1}`, RemovedAssetIDsJSON: `["removed-asset"]`, ContentHash: "hash", StorageBytes: 50, UpdatedAt: 123, ExpiresAt: 456}
	require.NoError(t, model.DB.Create(&canvas).Error)
	require.NoError(t, model.DB.Create(&model.GalleryCanvas{ID: "other-canvas", UserID: 2, StorageBytes: 60}).Error)
	removal := model.GalleryRemoval{UserID: 1, CanvasID: "canvas", AssetID: "removed-asset", Revision: 3, Reason: "deleted", CreatedAt: 123}
	require.NoError(t, model.DB.Create(&removal).Error)
	for range 2 {
		require.NoError(t, model.MigrateGallery(model.DB))
	}
	var loaded model.GalleryCanvas
	require.NoError(t, model.DB.First(&loaded, "id = ?", "canvas").Error)
	require.Equal(t, map[string]any{"version": float64(1)}, loaded.Document)
	require.Equal(t, canvas.MutationID, loaded.MutationID)
	require.Equal(t, canvas.ExpiresAt, loaded.ExpiresAt)
	assert.Equal(t, []string{"removed-asset"}, loaded.RemovedAssetIDs)
	count, userBytes, totalBytes, err := model.GalleryTotals(ctx, 1)
	require.NoError(t, err)
	require.EqualValues(t, 2, count)
	require.EqualValues(t, 380, userBytes)
	require.EqualValues(t, 840, totalBytes)
	var removals []model.GalleryRemoval
	require.NoError(t, model.DB.Where("user_id = ? AND canvas_id = ?", 1, "canvas").Find(&removals).Error)
	require.Len(t, removals, 1)
	require.Equal(t, "removed-asset", removals[0].AssetID)
	for _, state := range []string{"deleted", "expired"} {
		require.NoError(t, model.DB.Model(&model.GalleryCanvas{}).Where("id = ?", "canvas").Update("state", state).Error)
		require.NoError(t, model.DB.First(&loaded, "id = ?", "canvas").Error)
		assert.Nil(t, loaded.Document)
		assert.Equal(t, state, loaded.State)
		assert.Equal(t, []string{"removed-asset"}, loaded.RemovedAssetIDs)
	}
}

func TestGalleryCanvasDocumentStorageType(t *testing.T) {
	canvasSchema, err := schema.Parse(&model.GalleryCanvas{}, &sync.Map{}, schema.NamingStrategy{})
	require.NoError(t, err)
	for _, tc := range []struct {
		name    string
		dialect gorm.Dialector
		want    string
	}{
		{"mysql", mysql.Open(""), "longtext"},
		{"postgres", postgres.Open(""), "text"},
		{"sqlite", sqlite.Open(":memory:"), "text"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, name := range []string{"DocumentJSON", "RemovedAssetIDsJSON"} {
				field := canvasSchema.LookUpField(name)
				require.NotNil(t, field)
				assert.Equal(t, tc.want, tc.dialect.DataTypeOf(field), name)
			}
		})
	}
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
			// A supported document can exceed MySQL TEXT's 64 KiB capacity.
			// Verify full content survives storage and repeated startup migration
			// on every configured real engine, not just generated DDL types.
			document := galleryCanvasDrawingReferences(t)
			document["settings"].(map[string]any)["prompt"] = strings.Repeat("x", 32000)
			for _, node := range document["nodes"].([]any) {
				node.(map[string]any)["data"].(map[string]any)["prompt"] = strings.Repeat("y", 32000)
			}
			info, err := service.NormalizeGalleryCanvasDocument("drawing", document)
			require.NoError(t, err)
			raw, err := common.Marshal(info.Document)
			require.NoError(t, err)
			require.Greater(t, len(raw), 65535)
			canvas := model.GalleryCanvas{ID: "large-document", UserID: 1, Kind: "drawing", State: "ready", DocumentVersion: 1, DocumentJSON: string(raw), StorageBytes: info.Bytes, ContentHash: info.ContentHash, Revision: 1, UpdatedAt: 123, ExpiresAt: 456}
			require.NoError(t, model.DB.Create(&canvas).Error)
			for range 2 {
				require.NoError(t, model.MigrateGallery(model.DB))
			}
			var restored model.GalleryCanvas
			require.NoError(t, model.DB.First(&restored, "id = ?", canvas.ID).Error)
			assert.Equal(t, string(raw), restored.DocumentJSON)
			assert.Equal(t, info.Document, restored.Document)
			assert.Equal(t, int64(123), restored.UpdatedAt)
			assert.Equal(t, int64(456), restored.ExpiresAt)
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

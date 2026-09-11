package service_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
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
			for _, name := range []string{"DocumentJSON", "RemovedAssetIDsJSON", "MutationAssetIDMapJSON"} {
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

const canvasFixtureID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const canvasFixtureAsset = "11111111-1111-4111-8111-111111111111"

func canvasSaveMetadata(t *testing.T) map[string]any {
	t.Helper()
	doc := galleryCanvasDrawingReferences(t)
	doc["nodes"] = doc["nodes"].([]any)[:1]
	doc["edges"], doc["referenceIds"], doc["mask"] = []any{}, []any{}, nil
	original := galleryPNG(t)
	return map[string]any{"id": canvasFixtureID, "kind": "drawing", "name": "白狐", "base_revision": 0, "mutation_id": "mutation-a", "document": doc, "assets": []any{map[string]any{"id": canvasFixtureAsset, "role": "generated", "node_id": "reference-node", "bytes": len(original), "sha256": fmt.Sprintf("%x", sha256.Sum256(original))}}}
}

func saveCanvasMetadata(t *testing.T, user int, metadata map[string]any, fields ...[]string) (*model.GalleryCanvas, error) {
	t.Helper()
	raw, err := common.Marshal(metadata)
	require.NoError(t, err)
	return service.SaveGalleryCanvas(context.Background(), user, galleryMultipart(t, string(raw), fields...))
}

func TestGalleryCanvasAtomicCreateRetryAndRetention(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	metadata := canvasSaveMetadata(t)
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	assert.EqualValues(t, 1, saved.Revision)
	assert.Len(t, saved.Assets, 1)
	loaded, err := service.GetGalleryCanvas(ctx, 41, canvasFixtureID)
	require.NoError(t, err)
	assert.Equal(t, saved.Document, loaded.Document)
	f, _, err := service.OpenGalleryImage(ctx, 41, canvasFixtureAsset, false)
	require.NoError(t, err)
	data, err := io.ReadAll(f)
	require.NoError(t, f.Close())
	require.NoError(t, err)
	assert.Equal(t, galleryPNG(t), data)
	// Lower limits below existing usage: an idempotent retry must still work.
	require.NoError(t, model.DB.Model(&model.GallerySettings{}).Where("id = ?", 1).Updates(map[string]any{"user_max_bytes": 1, "user_max_images": 1}).Error)
	retry, err := saveCanvasMetadata(t, 41, metadata)
	require.NoError(t, err)
	assert.Equal(t, saved.Revision, retry.Revision)
	assert.Equal(t, saved.ExpiresAt, retry.ExpiresAt)
	count, used, _, err := model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count)
	assert.Greater(t, used, int64(len(data)))
	require.NoError(t, model.DB.Model(&model.GallerySettings{}).Where("id = ?", 1).Update("user_max_bytes", 1<<20).Error)
	// Persist an earlier retention timestamp without sleeping.
	earlier := time.Now().Unix() - 1000
	require.NoError(t, model.DB.Model(&model.GalleryCanvas{}).Where("id = ?", saved.ID).Updates(map[string]any{"updated_at": earlier, "expires_at": earlier + 86400}).Error)
	metadata["base_revision"], metadata["mutation_id"] = 1, "mutation-viewport"
	metadata["document"].(map[string]any)["viewport"].(map[string]any)["x"] = 10
	viewport, err := saveCanvasMetadata(t, 41, metadata)
	require.NoError(t, err)
	assert.Equal(t, earlier+86400, viewport.ExpiresAt)
	assert.Equal(t, earlier, viewport.UpdatedAt)
	metadata["base_revision"], metadata["mutation_id"], metadata["name"] = viewport.Revision, "mutation-name", "雪狐"
	renamed, err := saveCanvasMetadata(t, 41, metadata)
	require.NoError(t, err)
	assert.Greater(t, renamed.ExpiresAt, viewport.ExpiresAt)
	assert.Greater(t, renamed.UpdatedAt, viewport.UpdatedAt)
	metadata["base_revision"], metadata["mutation_id"] = 1, "stale"
	_, err = saveCanvasMetadata(t, 41, metadata)
	assert.ErrorIs(t, err, model.ErrGalleryCanvasConflict)
}

func TestGalleryCanvasFailedSnapshotPreservesRevision(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	metadata := canvasSaveMetadata(t)
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	metadata["base_revision"], metadata["mutation_id"] = 1, "mutation-b"
	metadata["document"].(map[string]any)["settings"].(map[string]any)["prompt"] = "a much longer new prompt"
	_, used, _, err := model.GalleryTotals(context.Background(), 41)
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(&model.GallerySettings{}).Where("id = ?", 1).Update("user_max_bytes", used).Error)
	_, err = saveCanvasMetadata(t, 41, metadata)
	assert.ErrorIs(t, err, model.ErrGalleryCapacity)
	loaded, err := service.GetGalleryCanvas(context.Background(), 41, saved.ID)
	require.NoError(t, err)
	assert.Equal(t, saved.Document, loaded.Document)
	assert.Equal(t, saved.Revision, loaded.Revision)
}

func TestGalleryCanvasOwnerDeletionAndExpiredReconciliation(t *testing.T) {
	for _, reason := range []string{"deleted", "expired"} {
		t.Run(reason, func(t *testing.T) {
			galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
			ctx := context.Background()
			metadata := canvasSaveMetadata(t)
			saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
			require.NoError(t, err)
			_, err = service.GetGalleryCanvas(ctx, 42, saved.ID)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			assert.ErrorIs(t, service.DeleteGalleryCanvas(ctx, 42, saved.ID, 1), gorm.ErrRecordNotFound)
			_, err = service.DeleteGalleryCanvasAsset(ctx, 42, saved.ID, canvasFixtureAsset, 1)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			_, _, err = service.OpenGalleryImage(ctx, 42, canvasFixtureAsset, false)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			_, err = saveCanvasMetadata(t, 42, metadata)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			if reason == "deleted" {
				assert.ErrorIs(t, service.DeleteGalleryCanvas(ctx, 41, saved.ID, 0), model.ErrGalleryCanvasConflict)
				require.NoError(t, service.DeleteGalleryCanvas(ctx, 41, saved.ID, 1))
				require.NoError(t, service.DeleteGalleryCanvas(ctx, 41, saved.ID, 1))
				usage, usageErr := service.GetGalleryUsage(ctx, 41)
				require.NoError(t, usageErr)
				assert.Zero(t, usage.UsedImages)
				assert.Zero(t, usage.UsedBytes)
				images, imagesErr := service.ListGalleryImages(ctx, 41, 1, 24, "")
				require.NoError(t, imagesErr)
				assert.Empty(t, images.Items)
			} else {
				require.NoError(t, model.DB.Model(&model.GalleryCanvas{}).Where("id = ?", saved.ID).Update("expires_at", time.Now().Unix()-1).Error)
				require.NoError(t, service.CleanupGallery(ctx))
			}
			removed, err := service.GetGalleryCanvas(ctx, 41, saved.ID)
			require.NoError(t, err)
			assert.Equal(t, reason, removed.State)
			assert.Nil(t, removed.Document)
			assert.Empty(t, removed.Name)
			assert.Empty(t, removed.Assets)
			_, _, err = service.OpenGalleryImage(ctx, 41, canvasFixtureAsset, false)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			metadata["base_revision"], metadata["mutation_id"] = removed.Revision, "mutation-b"
			_, err = saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
			if reason == "deleted" {
				assert.ErrorIs(t, err, model.ErrGalleryCanvasDeleted)
			} else {
				assert.ErrorIs(t, err, model.ErrGalleryCanvasConflict)
				metadata["explicit_save"] = true
				revived, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
				require.NoError(t, err)
				assert.Equal(t, "ready", revived.State)
				assert.Greater(t, revived.Revision, removed.Revision)
			}
		})
	}
}

func TestGalleryCanvasDeleteAssetDetachesRelationsPreservesOtherImages(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	metadata := canvasSaveMetadata(t)
	doc := galleryCanvasDrawingReferences(t)
	otherID, maskID := "33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222"
	doc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)["asset"].(map[string]any)["id"] = otherID
	metadata["document"] = doc
	base := metadata["assets"].([]any)[0].(map[string]any)
	metadata["assets"] = []any{base, map[string]any{"id": otherID, "role": "generated", "node_id": "result-node", "bytes": base["bytes"], "sha256": base["sha256"]}, map[string]any{"id": maskID, "role": "mask", "node_id": "reference-node", "bytes": base["bytes"], "sha256": base["sha256"]}}
	fields := [][]string{{"file:" + canvasFixtureAsset, string(galleryPNG(t))}, {"file:" + otherID, string(galleryPNG(t))}, {"file:" + maskID, string(galleryPNG(t))}}
	_, err := saveCanvasMetadata(t, 41, metadata, fields...)
	require.NoError(t, err)
	count, _, _, err := model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	assert.EqualValues(t, 2, count)
	deleted, err := service.DeleteGalleryCanvasAsset(ctx, 41, canvasFixtureID, canvasFixtureAsset, 1)
	require.NoError(t, err)
	assert.EqualValues(t, 2, deleted.Revision)
	assert.Contains(t, deleted.RemovedAssetIDs, canvasFixtureAsset)
	assert.Contains(t, deleted.RemovedAssetIDs, maskID)
	assert.Len(t, deleted.Assets, 1)
	assert.Equal(t, otherID, deleted.Assets[0].ID)
	assert.Empty(t, deleted.Document["edges"])
	assert.Empty(t, deleted.Document["referenceIds"])
	assert.Nil(t, deleted.Document["mask"])
	nodes := deleted.Document["nodes"].([]any)
	require.Len(t, nodes, 1)
	data := nodes[0].(map[string]any)["data"].(map[string]any)
	assert.Empty(t, data["referenceIds"])
	assert.Nil(t, data["mask"])
	metadata["base_revision"], metadata["mutation_id"] = deleted.Revision, "resurrect"
	_, err = saveCanvasMetadata(t, 41, metadata, fields...)
	assert.ErrorIs(t, err, model.ErrGalleryCanvasConflict)
	// Linked legacy gallery deletion uses the same cascade and tombstone.
	require.NoError(t, service.DeleteGalleryImage(ctx, 41, otherID))
	loaded, err := service.GetGalleryCanvas(ctx, 41, canvasFixtureID)
	require.NoError(t, err)
	assert.Empty(t, loaded.Assets)
	assert.Empty(t, loaded.Document["nodes"])
	assert.Contains(t, loaded.RemovedAssetIDs, otherID)
	// Expiry must never discard the persistent explicit removal IDs.
	require.NoError(t, model.DB.Model(&model.GalleryCanvas{}).Where("id = ?", canvasFixtureID).Update("expires_at", time.Now().Unix()-1).Error)
	require.NoError(t, service.CleanupGallery(ctx))
	loaded, err = service.GetGalleryCanvas(ctx, 41, canvasFixtureID)
	require.NoError(t, err)
	assert.Contains(t, loaded.RemovedAssetIDs, canvasFixtureAsset)
}

func TestGalleryCanvasExplicitAssetDeletionAfterExpiry(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	metadata := canvasSaveMetadata(t)
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(&model.GalleryCanvas{}).Where("id = ?", saved.ID).Update("expires_at", time.Now().Unix()-1).Error)
	require.NoError(t, service.CleanupGallery(ctx))
	expired, err := service.GetGalleryCanvas(ctx, 41, saved.ID)
	require.NoError(t, err)
	_, err = service.DeleteGalleryCanvasAsset(ctx, 42, saved.ID, canvasFixtureAsset, expired.Revision)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	_, err = service.DeleteGalleryCanvasAsset(ctx, 41, saved.ID, canvasFixtureAsset, expired.Revision-1)
	require.ErrorIs(t, err, model.ErrGalleryCanvasConflict)
	removed, err := service.DeleteGalleryCanvasAsset(ctx, 41, saved.ID, canvasFixtureAsset, expired.Revision)
	require.NoError(t, err)
	require.Equal(t, "expired", removed.State)
	require.Nil(t, removed.Document)
	require.Empty(t, removed.Assets)
	require.Equal(t, expired.ExpiresAt, removed.ExpiresAt)
	require.Equal(t, expired.UpdatedAt, removed.UpdatedAt)
	require.Contains(t, removed.RemovedAssetIDs, canvasFixtureAsset)
	repeated, err := service.DeleteGalleryCanvasAsset(ctx, 41, saved.ID, canvasFixtureAsset, expired.Revision)
	require.NoError(t, err)
	require.Equal(t, removed.Revision, repeated.Revision)
	metadata["base_revision"], metadata["mutation_id"], metadata["explicit_save"] = removed.Revision, "revive-removed", true
	_, err = saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.ErrorIs(t, err, model.ErrGalleryCanvasConflict)
}

func TestGalleryCanvasBudgetListingAndHTTPContract(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	metadata := canvasSaveMetadata(t)
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	page, err := service.ListGalleryCanvases(ctx, 41, 1, 24, "drawing", "白狐", "updated_desc")
	require.NoError(t, err)
	assert.EqualValues(t, 1, page.Total)
	require.Len(t, page.Items, 1)
	assert.Equal(t, []string{canvasFixtureAsset}, page.Items[0].CoverAssetIDs)
	raw, err := common.Marshal(page.Items[0])
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "document")
	assert.NotContains(t, string(raw), "prompt")
	other, err := service.ListGalleryCanvases(ctx, 42, 1, 24, "", "", "updated_desc")
	require.NoError(t, err)
	assert.Empty(t, other.Items)
	_, err = service.ListGalleryCanvases(ctx, 41, 1, 24, "", "", "id; DROP TABLE gallery_canvas")
	assert.ErrorIs(t, err, model.ErrGalleryInvalid)
	usage, err := service.GetGalleryBudget(ctx, 41, 0, 0)
	require.NoError(t, err)
	assert.Greater(t, usage.AvailableBytes, int64(0))
	assert.EqualValues(t, 99, usage.AvailableImages)
	tooBig, err := service.GetGalleryBudget(ctx, 41, usage.AvailableBytes+1, 1)
	require.NoError(t, err)
	assert.False(t, tooBig.CanSave)
	tooMany, err := service.GetGalleryBudget(ctx, 41, 1, 100)
	require.NoError(t, err)
	assert.False(t, tooMany.CanSave)
	exact, err := service.GetGalleryBudget(ctx, 41, usage.AvailableBytes, 99)
	require.NoError(t, err)
	assert.True(t, exact.CanSave)
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("id", 41) })
	engine.GET("/canvases", controller.ListGalleryCanvases)
	engine.GET("/canvases/:id", controller.GetGalleryCanvas)
	engine.POST("/canvases", controller.SaveGalleryCanvas)
	engine.DELETE("/canvases/:id", controller.DeleteGalleryCanvas)
	engine.DELETE("/canvases/:id/assets/:assetId", controller.DeleteGalleryCanvasAsset)
	engine.GET("/usage", controller.GetGalleryUsage)
	for _, query := range []string{"required_bytes=-1", "required_images=abc", "required_bytes=9223372036854775808"} {
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/usage?"+query, nil))
		assert.Equal(t, http.StatusBadRequest, response.Code)
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/canvases/"+saved.ID+"?revision=0", nil))
	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Contains(t, response.Body.String(), `"code":"canvas_conflict"`)
	response = httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/canvases/"+saved.ID+"?revision=1", nil))
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), `"state":"deleted"`)
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	metadataRaw, err := common.Marshal(metadata)
	require.NoError(t, err)
	require.NoError(t, w.WriteField("metadata", string(metadataRaw)))
	require.NoError(t, w.Close())
	request := httptest.NewRequest(http.MethodPost, "/canvases", &body)
	request.Header.Set("Content-Type", w.FormDataContentType())
	response = httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	assert.Equal(t, http.StatusGone, response.Code)
	assert.Contains(t, response.Body.String(), `"code":"canvas_deleted"`)
}

func canvasMaskMetadata(t *testing.T) map[string]any {
	t.Helper()
	metadata := canvasSaveMetadata(t)
	metadata["document"] = galleryCanvasDrawingReferences(t)
	base := metadata["assets"].([]any)[0].(map[string]any)
	metadata["assets"] = append(metadata["assets"].([]any), map[string]any{"id": "22222222-2222-4222-8222-222222222222", "role": "mask", "node_id": "reference-node", "bytes": base["bytes"], "sha256": base["sha256"]})
	return metadata
}

func TestGalleryCanvasLegacyExactReuseAndMutationIntegrity(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	legacy, err := gallerySave(t, 41, "drawing", "old-job", galleryPNG(t))
	require.NoError(t, err)
	metadata := canvasSaveMetadata(t)
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	assert.Equal(t, legacy.ID, saved.AssetIDMap[canvasFixtureAsset])
	require.Len(t, saved.Assets, 1)
	assert.Equal(t, legacy.ID, saved.Assets[0].ID)
	count, _, _, err := model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count)
	retry, err := saveCanvasMetadata(t, 41, metadata)
	require.NoError(t, err)
	assert.Equal(t, saved.Revision, retry.Revision)
	assert.Equal(t, saved.AssetIDMap, retry.AssetIDMap)
	metadata["document"].(map[string]any)["viewport"].(map[string]any)["x"] = 2
	_, err = saveCanvasMetadata(t, 41, metadata)
	assert.ErrorIs(t, err, model.ErrGalleryCanvasConflict)
	metadata["document"].(map[string]any)["viewport"].(map[string]any)["x"] = 0
	metadata["assets"].([]any)[0].(map[string]any)["sha256"] = strings.Repeat("0", 64)
	_, err = saveCanvasMetadata(t, 41, metadata)
	assert.ErrorIs(t, err, model.ErrGalleryCanvasConflict)
}

func TestGalleryCanvasLegacyRedundantThumbnail(t *testing.T) {
	var thumbnail bytes.Buffer
	require.NoError(t, jpeg.Encode(&thumbnail, image.NewRGBA(image.Rect(0, 0, 8, 4)), &jpeg.Options{Quality: 60}))
	var baselineBytes int64
	for _, withThumbnail := range []bool{false, true} {
		t.Run(fmt.Sprintf("thumbnail=%t", withThumbnail), func(t *testing.T) {
			galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
			ctx := context.Background()
			legacy, err := gallerySave(t, 41, "drawing", "old-job", galleryPNG(t))
			require.NoError(t, err)
			root := os.Getenv("GALLERY_STORAGE_DIR")
			originalPath := filepath.Join(root, "gallery-"+legacy.ID+".original")
			thumbnailPath := filepath.Join(root, "gallery-"+legacy.ID+".thumbnail")
			original, err := os.ReadFile(originalPath)
			require.NoError(t, err)
			canonicalThumbnail, err := os.ReadFile(thumbnailPath)
			require.NoError(t, err)
			require.NotEqual(t, canonicalThumbnail, thumbnail.Bytes())
			fields := [][]string{{"file:" + canvasFixtureAsset, string(galleryPNG(t))}}
			if withThumbnail {
				fields = append(fields, []string{"thumbnail:" + canvasFixtureAsset, thumbnail.String()})
			}
			metadata := canvasSaveMetadata(t)
			saved, err := saveCanvasMetadata(t, 41, metadata, fields...)
			require.NoError(t, err)
			assert.Equal(t, legacy.ID, saved.AssetIDMap[canvasFixtureAsset])
			count, used, _, err := model.GalleryTotals(ctx, 41)
			require.NoError(t, err)
			assert.EqualValues(t, 1, count)
			if !withThumbnail {
				baselineBytes = used
			} else {
				assert.Equal(t, baselineBytes, used)
			}
			retry, err := saveCanvasMetadata(t, 41, metadata, fields...)
			require.NoError(t, err)
			assert.Equal(t, saved.Revision, retry.Revision)
			assert.Equal(t, saved.ExpiresAt, retry.ExpiresAt)
			assert.Equal(t, saved.AssetIDMap, retry.AssetIDMap)
			_, after, _, err := model.GalleryTotals(ctx, 41)
			require.NoError(t, err)
			assert.Equal(t, used, after)
			storedOriginal, err := os.ReadFile(originalPath)
			require.NoError(t, err)
			storedThumbnail, err := os.ReadFile(thumbnailPath)
			require.NoError(t, err)
			assert.Equal(t, original, storedOriginal)
			assert.Equal(t, canonicalThumbnail, storedThumbnail)
			_, err = os.Stat(filepath.Join(root, "gallery-"+canvasFixtureAsset+".thumbnail"))
			assert.True(t, os.IsNotExist(err))
		})
	}
}

func TestGalleryCanvasLegacyRedundantThumbnailRejectsInvalid(t *testing.T) {
	var thumbnail bytes.Buffer
	require.NoError(t, jpeg.Encode(&thumbnail, image.NewRGBA(image.Rect(0, 0, 8, 4)), &jpeg.Options{Quality: 60}))
	for _, retry := range []bool{false, true} {
		for _, invalid := range []string{"malformed", "oversized", "before original", "duplicate"} {
			t.Run(fmt.Sprintf("retry=%t/%s", retry, invalid), func(t *testing.T) {
				galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
				legacy, err := gallerySave(t, 41, "drawing", "old-job", galleryPNG(t))
				require.NoError(t, err)
				metadata := canvasSaveMetadata(t)
				if retry {
					_, err = saveCanvasMetadata(t, 41, metadata)
					require.NoError(t, err)
				}
				count, before, _, err := model.GalleryTotals(context.Background(), 41)
				require.NoError(t, err)
				fields := [][]string{{"file:" + canvasFixtureAsset, string(galleryPNG(t))}, {"thumbnail:" + canvasFixtureAsset, thumbnail.String()}}
				switch invalid {
				case "malformed":
					fields[1][1] = "not a JPEG"
				case "oversized":
					fields[1][1] = thumbnail.String() + strings.Repeat("x", 1<<20)
				case "before original":
					fields[0], fields[1] = fields[1], fields[0]
				case "duplicate":
					fields = append(fields, fields[1])
				}
				_, err = saveCanvasMetadata(t, 41, metadata, fields...)
				assert.ErrorIs(t, err, model.ErrGalleryInvalid)
				afterCount, after, _, err := model.GalleryTotals(context.Background(), 41)
				require.NoError(t, err)
				assert.Equal(t, count, afterCount)
				assert.Equal(t, before, after)
				file, _, err := service.OpenGalleryImage(context.Background(), 41, legacy.ID, true)
				require.NoError(t, err)
				require.NoError(t, file.Close())
			})
		}
	}
}

func TestGalleryCanvasMaskReplacementAndRoleQuota(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	metadata := canvasMaskMetadata(t)
	maskID := "22222222-2222-4222-8222-222222222222"
	newMaskID := "44444444-4444-4444-8444-444444444444"
	fields := [][]string{{"file:" + canvasFixtureAsset, string(galleryPNG(t))}, {"file:" + maskID, string(galleryPNG(t))}}
	saved, err := saveCanvasMetadata(t, 41, metadata, fields...)
	require.NoError(t, err)
	count, used, _, err := model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count) // duplicate node reference and masks add no originals.
	assert.Greater(t, used, int64(2*len(galleryPNG(t))))
	page, err := service.ListGalleryImages(ctx, 41, 1, 24, "")
	require.NoError(t, err)
	assert.Len(t, page.Items, 1)
	metadata["base_revision"], metadata["mutation_id"] = saved.Revision, "mask-edit"
	doc := metadata["document"].(map[string]any)
	doc["mask"].(map[string]any)["asset"].(map[string]any)["id"] = newMaskID
	doc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)["mask"].(map[string]any)["id"] = newMaskID
	metadata["assets"].([]any)[1].(map[string]any)["id"] = newMaskID
	_, err = saveCanvasMetadata(t, 41, metadata, []string{"file:" + newMaskID, "bad mask"})
	assert.ErrorIs(t, err, model.ErrGalleryInvalid)
	old, err := service.GetGalleryCanvas(ctx, 41, canvasFixtureID)
	require.NoError(t, err)
	assert.Equal(t, saved.Document, old.Document)
	replaced, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + newMaskID, string(galleryPNG(t))})
	require.NoError(t, err)
	assert.Len(t, replaced.Assets, 2)
	_, _, err = service.OpenGalleryImage(ctx, 41, maskID, false)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	// An original reused as a mask cannot lie about role to bypass image count.
	bad := canvasMaskMetadata(t)
	bad["id"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	badDoc := bad["document"].(map[string]any)
	badDoc["mask"].(map[string]any)["asset"].(map[string]any)["id"] = canvasFixtureAsset
	badDoc["mask"].(map[string]any)["asset"].(map[string]any)["name"] = "fox.png"
	badDoc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)["mask"].(map[string]any)["id"] = canvasFixtureAsset
	badDoc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)["mask"].(map[string]any)["name"] = "fox.png"
	bad["assets"] = bad["assets"].([]any)[:1]
	bad["assets"].([]any)[0].(map[string]any)["role"] = "mask"
	_, err = saveCanvasMetadata(t, 42, bad, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	assert.ErrorIs(t, err, model.ErrGalleryInvalid)
}

func TestGalleryCanvasSnapshotCannotOmitOriginalAndCountAdmission(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	metadata := canvasSaveMetadata(t)
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	metadata["base_revision"], metadata["mutation_id"] = 1, "omitted"
	metadata["document"] = galleryCanvasDocument(t, "drawing")
	metadata["assets"] = []any{}
	_, err = saveCanvasMetadata(t, 41, metadata)
	assert.ErrorIs(t, err, model.ErrGalleryCanvasConflict)
	metadata = canvasSaveMetadata(t)
	metadata["base_revision"], metadata["mutation_id"] = 1, "extra"
	doc := galleryCanvasDrawingReferences(t)
	doc["mask"] = nil
	data := doc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)
	delete(data, "mask")
	otherID := "33333333-3333-4333-8333-333333333333"
	data["asset"].(map[string]any)["id"] = otherID
	metadata["document"] = doc
	base := metadata["assets"].([]any)[0].(map[string]any)
	metadata["assets"] = append(metadata["assets"].([]any), map[string]any{"id": otherID, "role": "reference", "node_id": "result-node", "bytes": base["bytes"], "sha256": base["sha256"]})
	require.NoError(t, model.DB.Model(&model.GallerySettings{}).Where("id = ?", 1).Update("user_max_images", 1).Error)
	_, err = saveCanvasMetadata(t, 41, metadata, []string{"file:" + otherID, string(galleryPNG(t))})
	assert.ErrorIs(t, err, model.ErrGalleryCapacity)
	loaded, err := service.GetGalleryCanvas(context.Background(), 41, canvasFixtureID)
	require.NoError(t, err)
	assert.Equal(t, saved.Document, loaded.Document)
}

func TestGalleryCanvasFailedStagingRetainsOnlyUnremovedPhysicalBytes(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	metadata := canvasSaveMetadata(t)
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	_, beforeBytes, _, err := model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	newID := "44444444-4444-4444-8444-444444444444"
	path := filepath.Join(os.Getenv("GALLERY_STORAGE_DIR"), "gallery-"+newID+".thumbnail")
	// Inject a real filesystem removal failure after the ownership row exists.
	require.NoError(t, model.DB.Callback().Create().After("gorm:create").Register("canvas-test-obstruct", func(tx *gorm.DB) {
		if asset, ok := tx.Statement.Dest.(*model.GalleryImage); ok && asset.ID == newID {
			if err := os.Mkdir(path, 0700); err != nil {
				tx.AddError(err)
				return
			}
			tx.AddError(os.WriteFile(filepath.Join(path, "blocker"), []byte("x"), 0600))
		}
	}))
	t.Cleanup(func() { _ = model.DB.Callback().Create().Remove("canvas-test-obstruct") })
	metadata = canvasMaskMetadata(t)
	metadata["base_revision"], metadata["mutation_id"] = saved.Revision, "stage-fails"
	doc := metadata["document"].(map[string]any)
	doc["mask"].(map[string]any)["asset"].(map[string]any)["id"] = newID
	doc["nodes"].([]any)[1].(map[string]any)["data"].(map[string]any)["mask"].(map[string]any)["id"] = newID
	metadata["assets"].([]any)[1].(map[string]any)["id"] = newID
	_, err = saveCanvasMetadata(t, 41, metadata, []string{"file:" + newID, string(galleryPNG(t))}, []string{"unexpected", "bad"})
	assert.ErrorIs(t, err, model.ErrGalleryInvalid)
	_, afterBytes, _, err := model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	assert.Greater(t, afterBytes, beforeBytes)
	assert.Less(t, afterBytes-beforeBytes, int64(10000))
	var pending model.GalleryImage
	require.NoError(t, model.DB.Where("id = ?", newID).First(&pending).Error)
	assert.Equal(t, "deleting", pending.State)
	assert.Zero(t, pending.Bytes)
	_, err = os.Stat(filepath.Join(os.Getenv("GALLERY_STORAGE_DIR"), "gallery-"+newID+".original"))
	assert.True(t, os.IsNotExist(err))
	loaded, err := service.GetGalleryCanvas(ctx, 41, saved.ID)
	require.NoError(t, err)
	assert.Equal(t, saved.Document, loaded.Document)
	require.NoError(t, os.Remove(filepath.Join(path, "blocker")))
	require.NoError(t, service.CleanupGallery(ctx))
	_, afterBytes, _, err = model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	assert.Equal(t, beforeBytes, afterBytes)
}

type canvasGatedReader struct {
	reader  io.Reader
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *canvasGatedReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.started); <-r.release })
	return r.reader.Read(p)
}

func TestGalleryCanvasDeleteWinsLateSaveWithoutResurrection(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	metadata := canvasSaveMetadata(t)
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	metadata["base_revision"], metadata["mutation_id"] = saved.Revision, "late-save"
	raw, err := common.Marshal(metadata)
	require.NoError(t, err)
	var buffer bytes.Buffer
	w := multipart.NewWriter(&buffer)
	require.NoError(t, w.WriteField("metadata", string(raw)))
	require.NoError(t, w.Close())
	gate := &canvasGatedReader{reader: &buffer, started: make(chan struct{}), release: make(chan struct{})}
	result := make(chan error, 1)
	go func() {
		_, err := service.SaveGalleryCanvas(context.Background(), 41, multipart.NewReader(gate, w.Boundary()))
		result <- err
	}()
	<-gate.started
	deleteErr := service.DeleteGalleryCanvas(context.Background(), 41, saved.ID, saved.Revision)
	close(gate.release)
	require.NoError(t, deleteErr)
	assert.ErrorIs(t, <-result, model.ErrGalleryCanvasDeleted)
}

func TestGalleryCanvasPublicationRollbackAndUnownedFilePreservation(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	metadata := canvasSaveMetadata(t)
	path := filepath.Join(os.Getenv("GALLERY_STORAGE_DIR"), "gallery-"+canvasFixtureAsset+".original")
	require.NoError(t, os.WriteFile(path, []byte("unowned"), 0600))
	_, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.Error(t, err)
	unowned, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "unowned", string(unowned))
	require.NoError(t, os.Remove(path))
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register("canvas-test-reject-publish", func(tx *gorm.DB) {
		if canvas, ok := tx.Statement.Dest.(*model.GalleryCanvas); ok && canvas.Revision == 2 {
			tx.AddError(fmt.Errorf("test publication failure"))
		}
	}))
	t.Cleanup(func() { _ = model.DB.Callback().Update().Remove("canvas-test-reject-publish") })
	metadata = canvasMaskMetadata(t)
	metadata["base_revision"], metadata["mutation_id"] = 1, "failed-tx"
	_, err = saveCanvasMetadata(t, 41, metadata, []string{"file:22222222-2222-4222-8222-222222222222", string(galleryPNG(t))})
	assert.ErrorIs(t, err, model.ErrGallerySave)
	loaded, err := service.GetGalleryCanvas(context.Background(), 41, canvasFixtureID)
	require.NoError(t, err)
	assert.Equal(t, saved.Document, loaded.Document)
	assert.Equal(t, saved.Revision, loaded.Revision)
	var records int64
	require.NoError(t, model.DB.Model(&model.GalleryImage{}).Count(&records).Error)
	assert.EqualValues(t, 1, records)
}

func TestGalleryCanvasLinkedPreviewMetadataAndTombstoneAccounting(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	metadata := canvasSaveMetadata(t)
	data := metadata["document"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["data"].(map[string]any)
	data["prompt"] = strings.Repeat("白狐", 16000)
	data["settings"].(map[string]any)["model"] = "gpt-image-1"
	data["settings"].(map[string]any)["quality"] = "high"
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	page, err := service.SearchGalleryImages(ctx, 41, 1, 24, "drawing", "白狐", "created_desc")
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Equal(t, data["prompt"], page.Items[0].Prompt)
	assert.Equal(t, "gpt-image-1", page.Items[0].Model)
	assert.Equal(t, "high", page.Items[0].Parameters["quality"])
	require.NoError(t, service.DeleteGalleryCanvas(ctx, 41, saved.ID, saved.Revision))
	var removed model.GalleryCanvas
	require.NoError(t, model.DB.Where("id = ?", saved.ID).First(&removed).Error)
	var marker model.GalleryRemoval
	require.NoError(t, model.DB.Where("canvas_id = ?", saved.ID).First(&marker).Error)
	markerRaw, err := common.Marshal(marker)
	require.NoError(t, err)
	assert.Greater(t, removed.StorageBytes, int64(len(markerRaw)))
}

func TestGalleryCanvasThumbnailActualBytesAndNAICloudRoundtrip(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	metadata := canvasSaveMetadata(t)
	var thumb bytes.Buffer
	require.NoError(t, jpeg.Encode(&thumb, image.NewRGBA(image.Rect(0, 0, 16, 8)), &jpeg.Options{Quality: 80}))
	saved, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))}, []string{"thumbnail:" + canvasFixtureAsset, thumb.String()})
	require.NoError(t, err)
	require.Len(t, saved.Assets, 1)
	assert.True(t, saved.Assets[0].HasThumbnail)
	f, _, err := service.OpenGalleryImage(ctx, 41, canvasFixtureAsset, true)
	require.NoError(t, err)
	data, err := io.ReadAll(f)
	require.NoError(t, f.Close())
	require.NoError(t, err)
	assert.Equal(t, thumb.Bytes(), data)
	count, used, _, err := model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count)
	assert.Greater(t, used, int64(thumb.Len()+len(galleryPNG(t))))
	naiMetadata := map[string]any{"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "kind": "nai", "name": "NAI draft", "base_revision": 0, "mutation_id": "nai-create", "document": galleryCanvasDocument(t, "nai"), "assets": []any{}}
	nai, err := saveCanvasMetadata(t, 41, naiMetadata)
	require.NoError(t, err)
	reopened, err := service.GetGalleryCanvas(ctx, 41, nai.ID)
	require.NoError(t, err)
	assert.Equal(t, nai.Document, reopened.Document)
	assert.Empty(t, reopened.Assets)
}

func TestGalleryCanvasDeletionFailureScrubsPromptAndKeepsBytes(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	saved, err := saveCanvasMetadata(t, 41, canvasSaveMetadata(t), []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	path := filepath.Join(os.Getenv("GALLERY_STORAGE_DIR"), "gallery-"+canvasFixtureAsset+".original")
	require.NoError(t, os.Rename(path, path+".held"))
	require.NoError(t, os.Mkdir(path, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(path, "blocker"), []byte("x"), 0600))
	assert.ErrorIs(t, service.DeleteGalleryCanvas(ctx, 41, saved.ID, saved.Revision), model.ErrGalleryUnavailable)
	var pending model.GalleryImage
	require.NoError(t, model.DB.Where("id = ?", canvasFixtureAsset).First(&pending).Error)
	assert.Empty(t, pending.Prompt)
	assert.Empty(t, pending.ParametersJSON)
	assert.Greater(t, pending.StorageBytes, int64(len(galleryPNG(t))))
	removed, err := service.GetGalleryCanvas(ctx, 41, saved.ID)
	require.NoError(t, err)
	assert.Equal(t, "deleted", removed.State)
	assert.Nil(t, removed.Document)
	assert.Empty(t, removed.Name)
	require.NoError(t, os.Remove(filepath.Join(path, "blocker")))
	require.NoError(t, os.Remove(path))
	require.NoError(t, os.Rename(path+".held", path))
	require.NoError(t, service.DeleteGalleryCanvas(ctx, 41, saved.ID, saved.Revision))
}

func TestGalleryCanvasDeclaredLengthIsInvalidNotCapacity(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	metadata := canvasSaveMetadata(t)
	_, err := saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t)) + "extra"})
	assert.ErrorIs(t, err, model.ErrGalleryInvalid)
	var records int64
	require.NoError(t, model.DB.Model(&model.GalleryImage{}).Count(&records).Error)
	assert.Zero(t, records)
}

func TestGalleryCanvasReclaimedOriginalNoLongerConsumesImageCount(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	ctx := context.Background()
	saved, err := saveCanvasMetadata(t, 41, canvasSaveMetadata(t), []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	require.NoError(t, err)
	path := filepath.Join(os.Getenv("GALLERY_STORAGE_DIR"), "gallery-"+canvasFixtureAsset+".thumbnail")
	require.NoError(t, os.Mkdir(path, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(path, "blocker"), []byte("x"), 0600))
	assert.ErrorIs(t, service.DeleteGalleryCanvas(ctx, 41, saved.ID, saved.Revision), model.ErrGalleryUnavailable)
	count, used, _, err := model.GalleryTotals(ctx, 41)
	require.NoError(t, err)
	assert.Zero(t, count)
	assert.Positive(t, used)
	require.NoError(t, os.Remove(filepath.Join(path, "blocker")))
	require.NoError(t, service.CleanupGallery(ctx))
}

func TestGalleryCanvasAddedBytesCannotReplaceLastCompleteSnapshot(t *testing.T) {
	galleryFixture(t, sqlite.Open(filepath.Join(t.TempDir(), "gallery.db")))
	metadata := canvasSaveMetadata(t)
	metadata["document"], metadata["assets"] = galleryCanvasDocument(t, "drawing"), []any{}
	saved, err := saveCanvasMetadata(t, 41, metadata)
	require.NoError(t, err)
	_, used, _, err := model.GalleryTotals(context.Background(), 41)
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(&model.GallerySettings{}).Where("id = ?", 1).Update("user_max_bytes", used+int64(len(galleryPNG(t)))-1).Error)
	metadata = canvasSaveMetadata(t)
	metadata["base_revision"], metadata["mutation_id"] = saved.Revision, "too-many-bytes"
	_, err = saveCanvasMetadata(t, 41, metadata, []string{"file:" + canvasFixtureAsset, string(galleryPNG(t))})
	assert.ErrorIs(t, err, model.ErrGalleryCapacity)
	loaded, err := service.GetGalleryCanvas(context.Background(), 41, saved.ID)
	require.NoError(t, err)
	assert.Equal(t, saved.Document, loaded.Document)
	assert.Empty(t, loaded.Assets)
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
			largeMap := map[string]string{}
			for i := range 1000 {
				largeMap[fmt.Sprintf("%08d-1111-4111-8111-111111111111", i)] = "22222222-2222-4222-8222-222222222222"
			}
			mapRaw, err := common.Marshal(largeMap)
			require.NoError(t, err)
			require.Greater(t, len(mapRaw), 65535)
			canvas.MutationAssetIDMapJSON = string(mapRaw)
			require.NoError(t, model.DB.Create(&canvas).Error)
			for range 2 {
				require.NoError(t, model.MigrateGallery(model.DB))
			}
			var restored model.GalleryCanvas
			require.NoError(t, model.DB.First(&restored, "id = ?", canvas.ID).Error)
			assert.Equal(t, string(raw), restored.DocumentJSON)
			assert.Equal(t, string(mapRaw), restored.MutationAssetIDMapJSON)
			assert.Equal(t, info.Document, restored.Document)
			assert.Equal(t, int64(123), restored.UpdatedAt)
			assert.Equal(t, int64(456), restored.ExpiresAt)
			longPrompt := strings.Repeat("白狐", 16000)
			image := model.GalleryImage{ID: "unicode-preview", UserID: 1, SourceID: "unicode-preview", Prompt: longPrompt, NegativePrompt: longPrompt, ParametersJSON: `{"prompt":"` + longPrompt + `"}`}
			require.NoError(t, model.DB.Create(&image).Error)
			require.NoError(t, model.MigrateGallery(model.DB))
			require.NoError(t, model.MigrateGallery(model.DB))
			var restoredImage model.GalleryImage
			require.NoError(t, model.DB.Where("id = ?", image.ID).First(&restoredImage).Error)
			assert.Equal(t, longPrompt, restoredImage.Prompt)
			assert.Equal(t, longPrompt, restoredImage.NegativePrompt)
			assert.Equal(t, longPrompt, restoredImage.Parameters["prompt"])
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

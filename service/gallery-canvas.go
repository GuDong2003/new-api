package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime/multipart"
	"os"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// The metadata limit bounds structure/memory, not the streamed original quota.
const galleryCanvasMetadataLimit = 64 << 20

type GalleryCanvasSaveAsset struct {
	ID     string `json:"id"`
	Role   string `json:"role"`
	NodeID string `json:"node_id"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type GalleryCanvasSaveMetadata struct {
	ID           string                   `json:"id"`
	Kind         string                   `json:"kind"`
	Name         string                   `json:"name"`
	BaseRevision int64                    `json:"base_revision"`
	MutationID   string                   `json:"mutation_id"`
	ExplicitSave bool                     `json:"explicit_save"`
	Document     map[string]any           `json:"document"`
	Assets       []GalleryCanvasSaveAsset `json:"assets"`
}

type GalleryCanvasSummary struct {
	ID            string   `json:"id"`
	Kind          string   `json:"kind"`
	Name          string   `json:"name"`
	Revision      int64    `json:"revision"`
	State         string   `json:"state"`
	UpdatedAt     int64    `json:"updated_at"`
	ExpiresAt     int64    `json:"expires_at"`
	CoverAssetIDs []string `json:"cover_asset_ids" gorm:"-"`
}

type GalleryCanvasPage struct {
	Items    []GalleryCanvasSummary `json:"items"`
	Total    int64                  `json:"total"`
	Page     int                    `json:"page"`
	PageSize int                    `json:"page_size"`
}

func ListGalleryCanvases(ctx context.Context, user, page, pageSize int, source, search, sort string) (*GalleryCanvasPage, error) {
	order := map[string]string{"updated_desc": "updated_at DESC, id DESC", "updated_asc": "updated_at ASC, id ASC", "name_asc": "name ASC, id ASC", "name_desc": "name DESC, id DESC"}[sort]
	if user <= 0 || page < 1 || page > 1000000 || pageSize < 1 || pageSize > 100 || (source != "" && source != "drawing" && source != "nai") || order == "" || len(search) > 512 || !utf8.ValidString(search) {
		return nil, model.ErrGalleryInvalid
	}
	galleryMu.Lock()
	defer galleryMu.Unlock()
	result := &GalleryCanvasPage{Items: []GalleryCanvasSummary{}, Page: page, PageSize: pageSize}
	query := model.DB.WithContext(ctx).Model(&model.GalleryCanvas{}).Where("user_id = ? AND state = ? AND expires_at > ?", user, "ready", time.Now().Unix())
	if source != "" {
		query = query.Where("kind = ?", source)
	}
	if search != "" {
		query = query.Where("name LIKE ?", "%"+search+"%")
	}
	if err := query.Count(&result.Total).Error; err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	if err := query.Select("id, kind, name, revision, state, updated_at, expires_at").Order(order).Offset((page - 1) * pageSize).Limit(pageSize).Scan(&result.Items).Error; err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	for i := range result.Items {
		item := &result.Items[i]
		item.CoverAssetIDs = []string{}
		if err := model.DB.WithContext(ctx).Model(&model.GalleryImage{}).Where("user_id = ? AND canvas_id = ? AND state = ? AND expires_at > ? AND role = ?", user, item.ID, "ready", time.Now().Unix(), "generated").Order("created_at DESC, id DESC").Limit(4).Pluck("id", &item.CoverAssetIDs).Error; err != nil {
			return nil, model.ErrGalleryUnavailable
		}
	}
	return result, nil
}

func galleryCanvasUUID(id string) bool {
	parsed, err := uuid.Parse(id)
	return err == nil && parsed != uuid.Nil && parsed.String() == id
}

func galleryCanvasContentHash(name, documentHash string) string {
	hash := sha256.Sum256([]byte(name + "\x00" + documentHash))
	return hex.EncodeToString(hash[:])
}

// Count logical persisted metadata, not DB pages/index implementation overhead.
func galleryCanvasStorageBytes(canvas *model.GalleryCanvas) int64 {
	metadata, _ := common.Marshal([]any{canvas.ID, canvas.UserID, canvas.Kind, canvas.Name, canvas.DocumentVersion, canvas.Revision, canvas.State, canvas.UpdatedAt, canvas.ExpiresAt, canvas.MutationID, canvas.MutationHash, canvas.ContentHash, canvas.RemovedAssetIDs})
	return int64(len(metadata) + len(canvas.DocumentJSON) + len(canvas.MutationAssetIDMapJSON))
}

func galleryCanvasRecordLocked(ctx context.Context, user int, id string) (*model.GalleryCanvas, error) {
	var record model.GalleryCanvas
	err := model.DB.WithContext(ctx).Where("id = ? AND user_id = ?", id, user).First(&record).Error
	if err != nil {
		return nil, err
	}
	record.Assets, record.AssetIDMap = []model.GalleryCanvasRemoteAsset{}, map[string]string{}
	if record.State != "ready" {
		return &record, nil
	}
	var assets []model.GalleryImage
	if err = model.DB.WithContext(ctx).Where("user_id = ? AND canvas_id = ? AND state = ? AND expires_at > ?", user, id, "ready", time.Now().Unix()).Order("id ASC").Find(&assets).Error; err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	for _, asset := range assets {
		record.Assets = append(record.Assets, model.GalleryCanvasRemoteAsset{ID: asset.ID, Role: asset.Role, NodeID: asset.NodeID, SHA256: asset.SHA256, Bytes: asset.Bytes, Width: asset.Width, Height: asset.Height, MIMEType: asset.MIMEType, HasThumbnail: asset.HasThumbnail})
	}
	return &record, nil
}

func GetGalleryCanvas(ctx context.Context, user int, id string) (*model.GalleryCanvas, error) {
	galleryMu.Lock()
	defer galleryMu.Unlock()
	var canvas model.GalleryCanvas
	if err := model.DB.WithContext(ctx).Where("id = ? AND user_id = ?", id, user).First(&canvas).Error; err != nil {
		return nil, err
	}
	if canvas.State == "ready" && canvas.ExpiresAt <= time.Now().Unix() {
		if err := removeGalleryCanvasLocked(ctx, &canvas, "expired"); err != nil {
			return nil, err
		}
	}
	return galleryCanvasRecordLocked(ctx, user, id)
}

func SaveGalleryCanvas(ctx context.Context, user int, reader *multipart.Reader) (*model.GalleryCanvas, error) {
	if user <= 0 || reader == nil {
		return nil, model.ErrGalleryInvalid
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "metadata" || part.FileName() != "" {
		return nil, model.ErrGalleryInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(part, galleryCanvasMetadataLimit+1))
	if err != nil || len(raw) > galleryCanvasMetadataLimit || !utf8.Valid(raw) {
		return nil, model.ErrGalleryInvalid
	}
	var input GalleryCanvasSaveMetadata
	if common.Unmarshal(raw, &input) != nil || !galleryCanvasUUID(input.ID) || input.BaseRevision < 0 || len(input.MutationID) == 0 || len(input.MutationID) > 36 || strings.ContainsAny(input.MutationID, "\x00\r\n") || len(input.Name) == 0 || utf8.RuneCountInString(input.Name) > 255 || strings.ContainsAny(input.Name, "\x00\r\n") {
		return nil, model.ErrGalleryInvalid
	}
	info, err := NormalizeGalleryCanvasDocument(input.Kind, input.Document)
	if err != nil {
		return nil, err
	}
	manifest, err := validateGalleryCanvasManifest(info, input.Assets)
	if err != nil {
		return nil, err
	}
	mutationJSON, _ := common.Marshal([]any{input.Kind, input.Name, info.Document, manifest})
	mutationSum := sha256.Sum256(mutationJSON)
	mutationHash := hex.EncodeToString(mutationSum[:])
	galleryMu.Lock()
	defer galleryMu.Unlock()
	if err = cleanupGalleryLocked(ctx); err != nil {
		return nil, err
	}
	var previous model.GalleryCanvas
	err = model.DB.WithContext(ctx).Where("id = ?", input.ID).First(&previous).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, model.ErrGalleryUnavailable
	}
	exists := err == nil
	if exists && previous.UserID != user {
		return nil, gorm.ErrRecordNotFound
	}
	if previous.State == "deleted" {
		return nil, model.ErrGalleryCanvasDeleted
	}
	if exists && previous.Kind != input.Kind {
		return nil, model.ErrGalleryInvalid
	}
	contentHash := galleryCanvasContentHash(input.Name, info.ContentHash)
	if exists && previous.State == "ready" && previous.MutationID == input.MutationID {
		if previous.MutationHash != mutationHash {
			return nil, model.ErrGalleryCanvasConflict
		}
		if err = validateGalleryCanvasRetry(reader, manifest); err != nil {
			return nil, err
		}
		result, err := galleryCanvasRecordLocked(ctx, user, input.ID)
		if err == nil && previous.MutationAssetIDMapJSON != "" {
			if e := common.UnmarshalJsonStr(previous.MutationAssetIDMapJSON, &result.AssetIDMap); e != nil {
				return nil, model.ErrGalleryUnavailable
			}
		}
		return result, err
	}
	if input.BaseRevision != previous.Revision {
		return nil, model.ErrGalleryCanvasConflict
	}
	if previous.State == "expired" && (previous.MutationID == input.MutationID || (!input.ExplicitSave && previous.ContentHash == contentHash)) {
		return nil, model.ErrGalleryCanvasConflict
	}
	for id := range manifest {
		if slices.Contains(previous.RemovedAssetIDs, id) {
			return nil, model.ErrGalleryCanvasConflict
		}
	}
	settings, err := GetGallerySettings(ctx)
	if err != nil {
		return nil, err
	}
	if !settings.Enabled {
		return nil, model.ErrGalleryDisabled
	}
	root, err := galleryRoot()
	if err != nil {
		return nil, err
	}
	assets, remap, err := resolveGalleryCanvasAssets(ctx, root, user, input.ID, input.Kind, manifest, info)
	if err != nil {
		return nil, err
	}
	// Only masks can disappear as a normal content edit. Originals require DELETE.
	var oldAssets []model.GalleryImage
	if err = model.DB.WithContext(ctx).Where("user_id = ? AND canvas_id = ? AND state = ?", user, input.ID, "ready").Find(&oldAssets).Error; err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	for _, old := range oldAssets {
		if _, present := assets[old.ID]; !present && old.Role != "mask" {
			return nil, model.ErrGalleryCanvasConflict
		}
	}
	info, err = NormalizeGalleryCanvasDocument(input.Kind, info.Document)
	if err != nil {
		return nil, err
	}
	contentHash = galleryCanvasContentHash(input.Name, info.ContentHash)
	now := time.Now().Unix()
	next := model.GalleryCanvas{ID: input.ID, UserID: user, Kind: input.Kind, Name: input.Name, DocumentVersion: 1, Revision: previous.Revision + 1, State: "ready", UpdatedAt: previous.UpdatedAt, ExpiresAt: previous.ExpiresAt, MutationID: input.MutationID, Document: info.Document, ContentHash: contentHash, RemovedAssetIDs: previous.RemovedAssetIDs}
	next.MutationHash = mutationHash
	remapJSON, _ := common.Marshal(remap)
	next.MutationAssetIDMapJSON = string(remapJSON)
	if !exists || previous.State != "ready" || previous.ContentHash != contentHash {
		next.UpdatedAt, next.ExpiresAt = now, now+int64(settings.RetentionDays)*86400
	}
	if next.RemovedAssetIDs == nil {
		next.RemovedAssetIDs = []string{}
	}
	document, _ := common.Marshal(info.Document)
	removed, _ := common.Marshal(next.RemovedAssetIDs)
	next.DocumentJSON, next.RemovedAssetIDsJSON = string(document), string(removed)
	next.StorageBytes = galleryCanvasStorageBytes(&next) + max(0, previous.StorageBytes-galleryCanvasStorageBytes(&previous))
	var existingMetadataDelta int64
	for _, asset := range assets {
		previousMetadataBytes, wasLegacy := galleryCanvasImageMetadataBytes(asset), asset.CanvasID == ""
		asset.CanvasID, asset.ExpiresAt = input.ID, next.ExpiresAt
		for _, requested := range manifest {
			id := requested.ID
			if remap[id] != "" {
				id = remap[id]
			}
			if id == asset.ID {
				asset.NodeID = requested.NodeID
				break
			}
		}
		if asset.Role != "mask" {
			for _, value := range info.Document["nodes"].([]any) {
				node := value.(map[string]any)
				if node["id"] != asset.NodeID {
					continue
				}
				data := node["data"].(map[string]any)
				parameters := data["settings"].(map[string]any)
				asset.Prompt, _ = data["prompt"].(string)
				asset.NegativePrompt, _ = parameters["negativePrompt"].(string)
				asset.Model, _ = parameters["model"].(string)
				// The document retains the complete model name; legacy preview's
				// varchar remains bounded without changing the original schema.
				if utf8.RuneCountInString(asset.Model) > 255 {
					asset.Model = string([]rune(asset.Model)[:255])
				}
				asset.Parameters = parameters
				parameterJSON, _ := common.Marshal(parameters)
				asset.ParametersJSON = string(parameterJSON)
				break
			}
		}
		if asset.State == "ready" {
			delta := galleryCanvasImageMetadataBytes(asset) - previousMetadataBytes
			if wasLegacy {
				delta = galleryCanvasImageMetadataBytes(asset)
			}
			asset.StorageBytes += delta
			existingMetadataDelta += delta
		}
	}
	count, used, total, err := model.GalleryTotals(ctx, user)
	if err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	budget := min(settings.UserMaxBytes-used, settings.TotalMaxBytes-total) - (next.StorageBytes - previous.StorageBytes) - existingMetadataDelta
	newImages := int64(0)
	for _, asset := range assets {
		if asset.State == "pending" && asset.Role != "mask" {
			newImages++
		}
	}
	if budget < 0 || newImages > int64(settings.UserMaxImages)-count {
		return nil, model.ErrGalleryCapacity
	}
	free, err := galleryFreeBytes(root)
	if err != nil {
		return nil, err
	}
	budget = min(budget, free-max(0, next.StorageBytes-previous.StorageBytes+existingMetadataDelta))
	if budget < 0 {
		return nil, model.ErrGalleryCapacity
	}
	staged := []*model.GalleryImage{}
	published := false
	defer func() {
		if !published {
			for _, asset := range staged {
				actualBytes := galleryCanvasImageMetadataBytes(asset)
				for _, kind := range []string{"original", "thumbnail", "metadata"} {
					path, err := galleryFilePath(root, asset.ID, kind)
					if err == nil {
						if info, err := os.Lstat(path); err == nil {
							actualBytes += info.Size()
						}
					}
				}
				if model.DB.WithContext(context.Background()).Model(asset).Update("storage_bytes", actualBytes).Error == nil {
					asset.StorageBytes = actualBytes
				}
				_ = removeGalleryRecord(context.Background(), root, asset)
			}
		}
	}()
	if err = prepareGalleryCanvasAssets(ctx, root, reader, assets, remap, &staged, budget); err != nil {
		return nil, err
	}
	err = model.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Save(&next).Error; err != nil {
			return err
		}
		for _, asset := range assets {
			asset.CanvasID, asset.ExpiresAt, asset.State = next.ID, next.ExpiresAt, "ready"
			if err := tx.Save(asset).Error; err != nil {
				return err
			}
		}
		for _, old := range oldAssets {
			if _, present := assets[old.ID]; !present {
				if err := tx.Model(&model.GalleryImage{}).Where("user_id = ? AND id = ?", user, old.ID).Update("state", "deleting").Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, model.ErrGallerySave
	}
	published = true
	// Reclamation cannot turn a successfully published snapshot into a failure.
	for i := range oldAssets {
		if _, present := assets[oldAssets[i].ID]; !present {
			_ = removeGalleryRecord(context.Background(), root, &oldAssets[i])
		}
	}
	result, err := galleryCanvasRecordLocked(ctx, user, next.ID)
	if err == nil {
		result.AssetIDMap = remap
	}
	return result, err
}

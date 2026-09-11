package service

import (
	"context"
	"slices"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func DeleteGalleryCanvas(ctx context.Context, user int, id string, revision int64) error {
	galleryMu.Lock()
	defer galleryMu.Unlock()
	var canvas model.GalleryCanvas
	if err := model.DB.WithContext(ctx).Where("user_id = ? AND id = ?", user, id).First(&canvas).Error; err != nil {
		return err
	}
	if canvas.State != "deleted" {
		if canvas.Revision != revision {
			return model.ErrGalleryCanvasConflict
		}
		if err := removeGalleryCanvasLocked(ctx, &canvas, "deleted"); err != nil {
			return err
		}
	}
	return cleanupGalleryLocked(ctx)
}

// Publish the minimal removal state before physical reclamation. A failed
// reclamation remains counted in GalleryImage rows and can be retried safely.
func removeGalleryCanvasLocked(ctx context.Context, canvas *model.GalleryCanvas, reason string) error {
	canvas.Revision++
	canvas.State, canvas.Name, canvas.DocumentJSON, canvas.Document = reason, "", "", nil
	canvas.MutationHash, canvas.MutationAssetIDMapJSON = "", ""
	if reason == "deleted" {
		canvas.ContentHash, canvas.MutationID = "", ""
	}
	canvas.StorageBytes = galleryCanvasStorageBytes(canvas)
	removal := model.GalleryRemoval{UserID: canvas.UserID, CanvasID: canvas.ID, Revision: canvas.Revision, Reason: reason, CreatedAt: time.Now().Unix()}
	if err := model.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}, {Name: "canvas_id"}, {Name: "asset_id"}}, DoUpdates: clause.AssignmentColumns([]string{"revision", "reason", "created_at"})}).Create(&removal).Error; err != nil {
			return err
		}
		if err := accountGalleryCanvasRemovals(tx, canvas); err != nil {
			return err
		}
		if err := tx.Save(canvas).Error; err != nil {
			return err
		}
		return tx.Model(&model.GalleryImage{}).Where("user_id = ? AND canvas_id = ?", canvas.UserID, canvas.ID).Updates(map[string]any{"state": "deleting", "prompt": "", "negative_prompt": "", "parameters_json": "", "model": ""}).Error
	}); err != nil {
		return model.ErrGalleryUnavailable
	}
	return nil
}

func DeleteGalleryCanvasAsset(ctx context.Context, user int, id, assetID string, revision int64) (*model.GalleryCanvas, error) {
	galleryMu.Lock()
	defer galleryMu.Unlock()
	return deleteGalleryCanvasAssetLocked(ctx, user, id, assetID, revision)
}

func deleteGalleryCanvasAssetLocked(ctx context.Context, user int, id, assetID string, revision int64) (*model.GalleryCanvas, error) {
	var canvas model.GalleryCanvas
	if err := model.DB.WithContext(ctx).Where("user_id = ? AND id = ?", user, id).First(&canvas).Error; err != nil {
		return nil, err
	}
	if canvas.State == "deleted" {
		return nil, model.ErrGalleryCanvasDeleted
	}
	if slices.Contains(canvas.RemovedAssetIDs, assetID) {
		if err := cleanupGalleryLocked(ctx); err != nil {
			return nil, err
		}
		return galleryCanvasRecordLocked(ctx, user, id)
	}
	if canvas.Revision != revision {
		return nil, model.ErrGalleryCanvasConflict
	}
	if canvas.State == "expired" {
		if !galleryCanvasUUID(assetID) {
			return nil, model.ErrGalleryInvalid
		}
		// Expiry removed the binary, not the owner's ability to explicitly
		// remove it from retained drafts. Keep the canvas minimal and expired.
		canvas.RemovedAssetIDs = append(canvas.RemovedAssetIDs, assetID)
		slices.Sort(canvas.RemovedAssetIDs)
		raw, _ := common.Marshal(canvas.RemovedAssetIDs)
		canvas.RemovedAssetIDsJSON = string(raw)
		canvas.Revision++
		marker := model.GalleryRemoval{UserID: user, CanvasID: id, AssetID: assetID, Revision: canvas.Revision, Reason: "deleted", CreatedAt: time.Now().Unix()}
		if err := model.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&marker).Error; err != nil {
				return err
			}
			if err := accountGalleryCanvasRemovals(tx, &canvas); err != nil {
				return err
			}
			return tx.Save(&canvas).Error
		}); err != nil {
			return nil, model.ErrGalleryUnavailable
		}
		return galleryCanvasRecordLocked(ctx, user, id)
	}
	var asset model.GalleryImage
	if err := model.DB.WithContext(ctx).Where("user_id = ? AND canvas_id = ? AND id = ? AND state = ? AND expires_at > ?", user, id, assetID, "ready", time.Now().Unix()).First(&asset).Error; err != nil {
		return nil, err
	}
	if canvas.State != "ready" || canvas.ExpiresAt <= time.Now().Unix() {
		return nil, gorm.ErrRecordNotFound
	}
	before, err := NormalizeGalleryCanvasDocument(canvas.Kind, canvas.Document)
	if err != nil {
		return nil, err
	}
	document := before.Document
	removedNodes := map[string]bool{}
	nodes := []any{}
	for _, value := range document["nodes"].([]any) {
		node := value.(map[string]any)
		data := node["data"].(map[string]any)
		if ref, ok := data["asset"].(map[string]any); ok && ref["id"] == assetID {
			removedNodes[node["id"].(string)] = true
			continue
		}
		if mask, ok := data["mask"].(map[string]any); ok && mask["id"] == assetID {
			delete(data, "mask")
		}
		nodes = append(nodes, node)
	}
	document["nodes"] = nodes
	if canvas.Kind == "drawing" {
		document["referenceIds"] = detachGalleryCanvasReferences(document["referenceIds"], removedNodes)
		if mask, ok := document["mask"].(map[string]any); ok {
			ref := mask["asset"].(map[string]any)
			if removedNodes[mask["referenceId"].(string)] || ref["id"] == assetID {
				document["mask"] = nil
			}
		}
		for _, value := range nodes {
			data := value.(map[string]any)["data"].(map[string]any)
			if refs, ok := data["referenceIds"].([]any); ok {
				if len(refs) > 0 && removedNodes[refs[0].(string)] {
					delete(data, "mask")
				}
				data["referenceIds"] = detachGalleryCanvasReferences(refs, removedNodes)
			}
		}
		edges := []any{}
		for _, value := range document["edges"].([]any) {
			edge := value.(map[string]any)
			if !removedNodes[edge["source"].(string)] && !removedNodes[edge["target"].(string)] {
				edges = append(edges, edge)
			}
		}
		document["edges"] = edges
	}
	info, err := NormalizeGalleryCanvasDocument(canvas.Kind, document)
	if err != nil {
		return nil, err
	}
	retained := map[string]bool{}
	for _, ref := range info.Assets {
		retained[ref.ID] = true
	}
	removed := []string{}
	for _, ref := range before.Assets {
		if !retained[ref.ID] {
			removed = append(removed, ref.ID)
		}
	}
	canvas.RemovedAssetIDs = append(canvas.RemovedAssetIDs, removed...)
	slices.Sort(canvas.RemovedAssetIDs)
	canvas.RemovedAssetIDs = slices.Compact(canvas.RemovedAssetIDs)
	raw, _ := common.Marshal(info.Document)
	removalJSON, _ := common.Marshal(canvas.RemovedAssetIDs)
	canvas.DocumentJSON, canvas.RemovedAssetIDsJSON = string(raw), string(removalJSON)
	canvas.Revision++
	canvas.MutationID = ""
	canvas.MutationHash, canvas.MutationAssetIDMapJSON = "", ""
	canvas.ContentHash = galleryCanvasContentHash(canvas.Name, info.ContentHash)
	settings, err := GetGallerySettings(ctx)
	if err != nil {
		return nil, err
	}
	canvas.UpdatedAt = time.Now().Unix()
	canvas.ExpiresAt = canvas.UpdatedAt + int64(settings.RetentionDays)*86400
	canvas.StorageBytes = galleryCanvasStorageBytes(&canvas)
	if err := model.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, removedID := range removed {
			marker := model.GalleryRemoval{UserID: user, CanvasID: id, AssetID: removedID, Revision: canvas.Revision, Reason: "deleted", CreatedAt: canvas.UpdatedAt}
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&marker).Error; err != nil {
				return err
			}
		}
		if err := accountGalleryCanvasRemovals(tx, &canvas); err != nil {
			return err
		}
		if err := tx.Save(&canvas).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.GalleryImage{}).Where("user_id = ? AND canvas_id = ? AND id IN ?", user, id, removed).Updates(map[string]any{"state": "deleting", "prompt": "", "negative_prompt": "", "parameters_json": "", "model": ""}).Error; err != nil {
			return err
		}
		return tx.Model(&model.GalleryImage{}).Where("user_id = ? AND canvas_id = ? AND state = ?", user, id, "ready").Update("expires_at", canvas.ExpiresAt).Error
	}); err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	if err := cleanupGalleryLocked(ctx); err != nil {
		return nil, err
	}
	return galleryCanvasRecordLocked(ctx, user, id)
}

func accountGalleryCanvasRemovals(tx *gorm.DB, canvas *model.GalleryCanvas) error {
	var removals []model.GalleryRemoval
	if err := tx.Where("user_id = ? AND canvas_id = ?", canvas.UserID, canvas.ID).Find(&removals).Error; err != nil {
		return err
	}
	canvas.StorageBytes = galleryCanvasStorageBytes(canvas)
	for _, removal := range removals {
		metadata, err := common.Marshal([]any{removal.ID, removal.UserID, removal.CanvasID, removal.AssetID, removal.Revision, removal.Reason, removal.CreatedAt})
		if err != nil {
			return err
		}
		canvas.StorageBytes += int64(len(metadata))
	}
	return nil
}

func detachGalleryCanvasReferences(input any, removedNodes map[string]bool) []any {
	refs := []any{}
	for _, value := range input.([]any) {
		if !removedNodes[value.(string)] {
			refs = append(refs, value)
		}
	}
	return refs
}

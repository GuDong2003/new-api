package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"io"
	"mime/multipart"
	"os"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
)

func galleryCanvasImageMetadataBytes(asset *model.GalleryImage) int64 {
	metadata, _ := common.Marshal(asset)
	internal, _ := common.Marshal([]any{asset.UserID, asset.SHA256, "ready"})
	return int64(len(metadata) + len(internal))
}

func validateGalleryCanvasManifest(info *GalleryCanvasDocumentInfo, input []GalleryCanvasSaveAsset) (map[string]GalleryCanvasSaveAsset, error) {
	manifest := map[string]GalleryCanvasSaveAsset{}
	refs := map[string]GalleryCanvasAssetRef{}
	for _, ref := range info.Assets {
		refs[ref.ID] = ref
	}
	for _, asset := range input {
		hash, err := hex.DecodeString(asset.SHA256)
		if _, ok := refs[asset.ID]; !ok || err != nil || len(hash) != sha256.Size || strings.ToLower(asset.SHA256) != asset.SHA256 || asset.Bytes <= 0 || asset.Bytes > 1<<40 || len(asset.NodeID) > 128 {
			return nil, model.ErrGalleryInvalid
		}
		if asset.Role != "generated" && asset.Role != "reference" && asset.Role != "mask" {
			return nil, model.ErrGalleryInvalid
		}
		if previous, ok := manifest[asset.ID]; ok && previous != asset {
			return nil, model.ErrGalleryInvalid
		}
		linked := false
		for _, value := range info.Document["nodes"].([]any) {
			node := value.(map[string]any)
			data := node["data"].(map[string]any)
			if ref, ok := data["asset"].(map[string]any); ok && ref["id"] == asset.ID && asset.Role == "mask" {
				return nil, model.ErrGalleryInvalid
			}
			if node["id"] != asset.NodeID {
				continue
			}
			key := "asset"
			if asset.Role == "mask" {
				key = "mask"
			}
			if ref, ok := data[key].(map[string]any); ok && ref["id"] == asset.ID {
				linked = true
			}
		}
		if mask, ok := info.Document["mask"].(map[string]any); ok && asset.Role == "mask" && mask["referenceId"] == asset.NodeID {
			if ref, ok := mask["asset"].(map[string]any); ok && ref["id"] == asset.ID {
				linked = true
			}
		}
		if !linked {
			return nil, model.ErrGalleryInvalid
		}
		manifest[asset.ID] = asset
	}
	if len(manifest) != len(refs) {
		return nil, model.ErrGalleryInvalid
	}
	return manifest, nil
}

func galleryAssetChecksum(root string, asset *model.GalleryImage) (string, error) {
	f, err := openGalleryFile(root, asset.ID, "original")
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.CopyBuffer(hash, f, make([]byte, 32<<10))
	if err != nil || n != asset.Bytes {
		return "", model.ErrGalleryUnavailable
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func resolveGalleryCanvasAssets(ctx context.Context, root string, user int, canvasID, kind string, manifest map[string]GalleryCanvasSaveAsset, info *GalleryCanvasDocumentInfo) (map[string]*model.GalleryImage, map[string]string, error) {
	assets, remap := map[string]*model.GalleryImage{}, map[string]string{}
	for _, ref := range info.Assets {
		requested := manifest[ref.ID]
		var asset model.GalleryImage
		err := model.DB.WithContext(ctx).Where("id = ?", ref.ID).First(&asset).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, model.ErrGalleryUnavailable
		}
		if err == nil && (asset.UserID != user || asset.State != "ready" || asset.ExpiresAt <= time.Now().Unix() || (asset.CanvasID != "" && asset.CanvasID != canvasID)) {
			return nil, nil, gorm.ErrRecordNotFound
		}
		if errors.Is(err, gorm.ErrRecordNotFound) && requested.Role != "mask" {
			// Legacy reuse is byte identity only, never prompt/name/time similarity.
			var candidates []model.GalleryImage
			if err = model.DB.WithContext(ctx).Where("user_id = ? AND (canvas_id = ? OR canvas_id IS NULL) AND state = ? AND expires_at > ? AND bytes = ?", user, "", "ready", time.Now().Unix(), requested.Bytes).Order("id ASC").Find(&candidates).Error; err != nil {
				return nil, nil, model.ErrGalleryUnavailable
			}
			for _, candidate := range candidates {
				checksum := candidate.SHA256
				if checksum == "" {
					checksum, err = galleryAssetChecksum(root, &candidate)
					if err != nil {
						return nil, nil, err
					}
				}
				if checksum == requested.SHA256 {
					asset = candidate
					asset.SHA256 = checksum
					remap[ref.ID] = asset.ID
					break
				}
			}
		}
		if asset.ID == "" {
			asset = model.GalleryImage{ID: ref.ID, UserID: user, CanvasID: canvasID, SourceID: "canvas:" + ref.ID, Source: kind, NodeID: requested.NodeID, Role: requested.Role, SHA256: requested.SHA256, Bytes: requested.Bytes, Width: ref.Width, Height: ref.Height, MIMEType: ref.MIMEType, CreatedAt: time.Now().Unix(), State: "pending"}
		} else {
			if asset.SHA256 == "" {
				asset.SHA256, err = galleryAssetChecksum(root, &asset)
				if err != nil {
					return nil, nil, err
				}
			}
			if asset.Bytes != requested.Bytes || asset.SHA256 != requested.SHA256 || asset.Width != ref.Width || asset.Height != ref.Height || asset.MIMEType != ref.MIMEType {
				return nil, nil, model.ErrGalleryInvalid
			}
			if asset.CanvasID == "" {
				asset.NodeID = requested.NodeID
				if asset.Role == "" {
					asset.Role = "generated"
				}
			}
			if (asset.Role == "mask") != (requested.Role == "mask") {
				return nil, nil, model.ErrGalleryInvalid
			}
			f, err := openGalleryFile(root, asset.ID, "original")
			if err != nil {
				return nil, nil, err
			}
			if err = f.Close(); err != nil {
				return nil, nil, model.ErrGalleryUnavailable
			}
		}
		assets[asset.ID] = &asset
	}
	if len(remap) > 0 {
		for _, value := range info.Document["nodes"].([]any) {
			data := value.(map[string]any)["data"].(map[string]any)
			for _, key := range []string{"asset", "mask"} {
				if ref, ok := data[key].(map[string]any); ok {
					if id := remap[ref["id"].(string)]; id != "" {
						ref["id"] = id
					}
				}
			}
		}
		if mask, ok := info.Document["mask"].(map[string]any); ok {
			ref := mask["asset"].(map[string]any)
			if id := remap[ref["id"].(string)]; id != "" {
				ref["id"] = id
			}
		}
	}
	return assets, remap, nil
}

func validateGalleryCanvasRetry(reader *multipart.Reader, manifest map[string]GalleryCanvasSaveAsset) error {
	seen := map[string]bool{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return model.ErrGalleryInvalid
		}
		kind, id, ok := strings.Cut(part.FormName(), ":")
		asset, exists := manifest[id]
		if !ok || !exists || seen[part.FormName()] || (kind != "file" && kind != "thumbnail") {
			return model.ErrGalleryInvalid
		}
		seen[part.FormName()] = true
		if kind == "thumbnail" {
			if !seen["file:"+id] {
				return model.ErrGalleryInvalid
			}
			if err := discardGalleryCanvasThumbnail(part); err != nil {
				return err
			}
			continue
		}
		hash := sha256.New()
		n, err := io.CopyBuffer(hash, io.LimitReader(part, asset.Bytes+1), make([]byte, 32<<10))
		if err != nil || n != asset.Bytes || hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
			return model.ErrGalleryInvalid
		}
	}
}

func prepareGalleryCanvasAssets(ctx context.Context, root string, reader *multipart.Reader, assets map[string]*model.GalleryImage, remap map[string]string, staged *[]*model.GalleryImage, budget int64) error {
	seen := map[string]bool{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return model.ErrGalleryInvalid
		}
		kind, inputID, ok := strings.Cut(part.FormName(), ":")
		id := inputID
		if remap[id] != "" {
			id = remap[id]
		}
		asset := assets[id]
		if !ok || asset == nil || seen[part.FormName()] || (kind != "file" && kind != "thumbnail") {
			return model.ErrGalleryInvalid
		}
		seen[part.FormName()] = true
		if kind == "thumbnail" && !seen["file:"+inputID] {
			return model.ErrGalleryInvalid
		}
		if asset.State != "pending" {
			// Transparent legacy reuse can receive both redundant original and
			// thumbnail parts. Validate them without changing canonical files.
			if remap[inputID] == "" {
				return model.ErrGalleryInvalid
			}
			if kind == "thumbnail" {
				if err := discardGalleryCanvasThumbnail(part); err != nil {
					return err
				}
				continue
			}
			hash := sha256.New()
			n, e := io.CopyBuffer(hash, io.LimitReader(part, asset.Bytes+1), make([]byte, 32<<10))
			if e != nil || n != asset.Bytes || hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
				return model.ErrGalleryInvalid
			}
			continue
		}
		if kind == "file" {
			metadataBytes := galleryCanvasImageMetadataBytes(asset)
			if asset.Bytes+metadataBytes > budget {
				return model.ErrGalleryCapacity
			}
			for _, fileKind := range []string{"original", "thumbnail", "metadata"} {
				path, err := galleryFilePath(root, asset.ID, fileKind)
				if err != nil {
					return err
				}
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					return model.ErrGalleryUnavailable
				}
			}
			asset.StorageBytes = budget
			if err := model.DB.WithContext(ctx).Create(asset).Error; err != nil {
				return model.ErrGallerySave
			}
			*staged = append(*staged, asset)
			budget -= metadataBytes
		}
		fileKind, limit := "original", budget
		if kind == "thumbnail" {
			fileKind, limit = "thumbnail", min(budget, int64(1<<20))
		}
		writer, err := newGalleryWriter(ctx, root, asset.ID, fileKind, limit)
		if err != nil {
			return err
		}
		hash := sha256.New()
		var source io.Reader = part
		if kind == "file" {
			source = io.LimitReader(part, asset.Bytes+1)
		}
		_, copyErr := io.CopyBuffer(io.MultiWriter(writer, hash), source, make([]byte, 32<<10))
		closeErr := writer.Close()
		if writer.failure != nil {
			return writer.failure
		}
		if copyErr != nil || closeErr != nil {
			return model.ErrGallerySave
		}
		budget -= writer.written
		if kind == "file" {
			if writer.written != asset.Bytes || hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
				return model.ErrGalleryInvalid
			}
			mime, width, height, e := validateGalleryOriginal(root, asset.ID, writer.written)
			if e != nil || mime != asset.MIMEType || width != asset.Width || height != asset.Height {
				return model.ErrGalleryInvalid
			}
			// Existing safe decoder catches invalid pixel streams for bounded images.
			if _, e = makeGalleryThumbnail(ctx, root, asset); e != nil {
				return e
			}
			asset.StorageBytes = asset.Bytes + galleryCanvasImageMetadataBytes(asset)
		} else {
			file, err := openGalleryFile(root, asset.ID, "thumbnail")
			if err != nil {
				return err
			}
			validationErr := validateGalleryCanvasThumbnail(file)
			closeErr := file.Close()
			if validationErr != nil {
				return validationErr
			}
			if closeErr != nil {
				return model.ErrGallerySave
			}
			asset.HasThumbnail = true
			asset.StorageBytes += writer.written
		}
		if err := model.DB.WithContext(ctx).Save(asset).Error; err != nil {
			return model.ErrGallerySave
		}
	}
	for id, asset := range assets {
		if asset.State == "pending" && !seen["file:"+id] {
			return model.ErrGalleryInvalid
		}
	}
	return nil
}

func discardGalleryCanvasThumbnail(reader io.Reader) error {
	data, err := io.ReadAll(io.LimitReader(reader, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return model.ErrGalleryInvalid
	}
	return validateGalleryCanvasThumbnail(bytes.NewReader(data))
}

func validateGalleryCanvasThumbnail(reader io.ReadSeeker) error {
	config, format, err := image.DecodeConfig(reader)
	if err != nil || format != "jpeg" || config.Width < 1 || config.Height < 1 || config.Width > 512 || config.Height > 512 {
		return model.ErrGalleryInvalid
	}
	if _, err = reader.Seek(0, io.SeekStart); err != nil {
		return model.ErrGalleryInvalid
	}
	if _, _, err = image.Decode(reader); err != nil {
		return model.ErrGalleryInvalid
	}
	return nil
}

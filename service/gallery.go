package service

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// One instance owns this store. Holding the lock through streaming also counts
// pending writes against admission without a reservation/lease subsystem.
var galleryMu sync.Mutex
var galleryLifecycleMu sync.Mutex
var galleryCancel context.CancelFunc
var galleryDone chan struct{}
var gallerySourceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$`)

type GalleryUsage struct {
	Enabled       bool   `json:"enabled"`
	RetentionDays int    `json:"retention_days"`
	MaxImages     int    `json:"max_images"`
	MaxBytes      int64  `json:"max_bytes"`
	UsedImages    int64  `json:"used_images"`
	UsedBytes     int64  `json:"used_bytes"`
	CanSave       bool   `json:"can_save"`
	Reason        string `json:"reason"`
}

type GalleryPage struct {
	Items    []model.GalleryImage `json:"items"`
	Total    int64                `json:"total"`
	Page     int                  `json:"page"`
	PageSize int                  `json:"page_size"`
}

type GalleryMetadata struct {
	SourceID       string         `json:"source_id"`
	Source         string         `json:"source"`
	Model          string         `json:"model"`
	Prompt         string         `json:"prompt"`
	NegativePrompt string         `json:"negative_prompt"`
	Parameters     map[string]any `json:"parameters"`
}

func GetGallerySettings(ctx context.Context) (*model.GallerySettings, error) {
	settings, err := model.ReadGallerySettings(ctx)
	if err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	return settings, nil
}

func UpdateGallerySettings(ctx context.Context, settings model.GallerySettings) (*model.GallerySettings, error) {
	if !settings.Valid() {
		return nil, model.ErrGallerySettings
	}
	galleryMu.Lock()
	defer galleryMu.Unlock()
	if err := model.WriteGallerySettings(ctx, settings); err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	return &settings, nil
}

func GetGalleryUsage(ctx context.Context, user int) (*GalleryUsage, error) {
	galleryMu.Lock()
	defer galleryMu.Unlock()
	settings, err := GetGallerySettings(ctx)
	if err != nil {
		return nil, err
	}
	count, used, total, err := model.GalleryTotals(ctx, user)
	if err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	usage := &GalleryUsage{Enabled: settings.Enabled, RetentionDays: settings.RetentionDays, MaxImages: settings.UserMaxImages, MaxBytes: settings.UserMaxBytes, UsedImages: count, UsedBytes: used, CanSave: true}
	switch {
	case !settings.Enabled:
		usage.Reason = model.ErrGalleryDisabled.Error()
	case count >= int64(settings.UserMaxImages) || used >= settings.UserMaxBytes || total >= settings.TotalMaxBytes:
		usage.Reason = model.ErrGalleryCapacity.Error()
	default:
		root, rootErr := galleryRoot()
		if rootErr != nil {
			usage.Reason = model.ErrGalleryUnavailable.Error()
		} else if _, diskErr := galleryFreeBytes(root); diskErr != nil {
			usage.Reason = model.ErrGalleryUnavailable.Error()
		}
	}
	usage.CanSave = usage.Reason == ""
	return usage, nil
}

func ListGalleryImages(ctx context.Context, user, page, pageSize int, source string) (*GalleryPage, error) {
	if page < 1 || page > 1000000 || pageSize < 1 || pageSize > 100 || (source != "" && source != "drawing" && source != "nai") {
		return nil, model.ErrGalleryInvalid
	}
	result := &GalleryPage{Items: []model.GalleryImage{}, Page: page, PageSize: pageSize}
	query := model.DB.WithContext(ctx).Model(&model.GalleryImage{}).Where("user_id = ? AND state = ? AND expires_at > ?", user, "ready", time.Now().Unix())
	if source != "" {
		query = query.Where("source = ?", source)
	}
	if err := query.Count(&result.Total).Error; err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	if err := query.Order("created_at DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&result.Items).Error; err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	return result, nil
}

func SaveGalleryImage(ctx context.Context, user int, reader *multipart.Reader) (*model.GalleryImage, error) {
	if user <= 0 || reader == nil {
		return nil, model.ErrGalleryInvalid
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "metadata" || part.FileName() != "" {
		return nil, model.ErrGalleryInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(part, 65537))
	if err != nil || len(raw) > 65536 {
		return nil, model.ErrGalleryInvalid
	}
	var metadata GalleryMetadata
	if common.Unmarshal(raw, &metadata) != nil || !gallerySourceID.MatchString(metadata.SourceID) || (metadata.Source != "drawing" && metadata.Source != "nai") || len(metadata.Model) == 0 || len(metadata.Model) > 255 || len(metadata.Prompt) > 32768 || len(metadata.NegativePrompt) > 16384 || !utf8.Valid(raw) {
		return nil, model.ErrGalleryInvalid
	}
	if strings.ContainsAny(metadata.Model, "\x00\r\n") || strings.ContainsRune(metadata.Prompt, 0) || strings.ContainsRune(metadata.NegativePrompt, 0) {
		return nil, model.ErrGalleryInvalid
	}
	parameters := map[string]any{}
	for key, value := range metadata.Parameters {
		switch key {
		case "seed", "steps", "scale", "cfg_scale", "cfg_rescale", "width", "height", "n", "strength", "noise", "uncond_scale", "params_version", "n_samples", "ucPresetId", "tag_hint_qt":
			v, ok := value.(float64)
			if !ok || v < -1e15 || v > 1e15 {
				return nil, model.ErrGalleryInvalid
			}
			parameters[key] = v
		case "qualityToggle", "sm", "sm_dyn", "dynamic_thresholding", "add_original_image", "deliberate_euler_ancestral_bug", "prefer_brownian", "legacy_v3_extend", "normalize_reference_strength_multiple", "variety_boost", "legacy":
			v, ok := value.(bool)
			if !ok {
				return nil, model.ErrGalleryInvalid
			}
			parameters[key] = v
		case "sampler", "noise_schedule", "quality", "size", "style", "response_format", "qualityPresetId", "image_format":
			v, ok := value.(string)
			if !ok || len(v) > 128 || strings.ContainsAny(v, "/\\:\x00\r\n") {
				return nil, model.ErrGalleryInvalid
			}
			parameters[key] = v
		}
	}
	metadata.Parameters = parameters
	normalized, err := common.Marshal(metadata)
	if err != nil {
		return nil, model.ErrGalleryInvalid
	}
	part, err = reader.NextPart()
	if err != nil || (part.FormName() != "file" && part.FormName() != "url") {
		return nil, model.ErrGalleryInvalid
	}
	galleryMu.Lock()
	defer galleryMu.Unlock()
	if err := cleanupGalleryLocked(ctx); err != nil {
		return nil, err
	}
	var existing model.GalleryImage
	err = model.DB.WithContext(ctx).Where("user_id = ? AND source_id = ? AND state = ?", user, metadata.SourceID, "ready").First(&existing).Error
	if err == nil {
		// A retry avoids another remote fetch/publication, but must still obey
		// the bounded, exactly-one-source multipart contract.
		limit := existing.Bytes
		if part.FormName() == "url" {
			limit = 8192
		}
		n, readErr := io.CopyBuffer(io.Discard, io.LimitReader(part, limit+1), make([]byte, 32<<10))
		if readErr != nil || n > limit {
			return nil, model.ErrGalleryInvalid
		}
		if _, nextErr := reader.NextPart(); nextErr != io.EOF {
			return nil, model.ErrGalleryInvalid
		}
		return &existing, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, model.ErrGalleryUnavailable
	}
	settings, err := GetGallerySettings(ctx)
	if err != nil {
		return nil, err
	}
	if !settings.Enabled {
		return nil, model.ErrGalleryDisabled
	}
	count, used, total, err := model.GalleryTotals(ctx, user)
	if err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	budget := min(settings.UserMaxBytes-used, settings.TotalMaxBytes-total)
	if count >= int64(settings.UserMaxImages) || budget <= int64(len(normalized)) {
		return nil, model.ErrGalleryCapacity
	}
	root, err := galleryRoot()
	if err != nil {
		return nil, err
	}
	free, err := galleryFreeBytes(root)
	if err != nil {
		return nil, err
	}
	budget = min(budget, free)
	if budget <= int64(len(normalized)) {
		return nil, model.ErrGalleryUnavailable
	}
	now := time.Now().Unix()
	parameterJSON, _ := common.Marshal(parameters)
	record := &model.GalleryImage{ID: uuid.NewString(), UserID: user, SourceID: metadata.SourceID, Source: metadata.Source, Model: metadata.Model, Prompt: metadata.Prompt, NegativePrompt: metadata.NegativePrompt, Parameters: parameters, ParametersJSON: string(parameterJSON), CreatedAt: now, ExpiresAt: now + int64(settings.RetentionDays)*86400, State: "pending", StorageBytes: budget}
	// Record ownership before creating any file. A crash leaves a recoverable row.
	if err = model.DB.WithContext(ctx).Create(record).Error; err != nil {
		return nil, model.ErrGallerySave
	}
	published := false
	defer func() {
		if !published {
			_ = removeGalleryRecord(context.Background(), root, record)
		}
	}()
	writer, err := newGalleryWriter(ctx, root, record.ID, "original", budget-int64(len(normalized)))
	if err != nil {
		return nil, err
	}
	if part.FormName() == "file" {
		_, err = io.CopyBuffer(writer, part, make([]byte, 32<<10))
	} else {
		var rawURL []byte
		rawURL, err = io.ReadAll(io.LimitReader(part, 8193))
		if err == nil && len(rawURL) <= 8192 {
			client := newContentAuditImageClient()
			var declared string
			err = streamContentAuditImage(ctx, client, string(rawURL), writer, &declared)
			client.CloseIdleConnections()
		} else {
			err = model.ErrGalleryInvalid
		}
	}
	closeErr := writer.Close()
	if writer.failure != nil {
		return nil, writer.failure
	}
	if err != nil {
		return nil, model.ErrGalleryInvalid
	}
	if closeErr != nil {
		return nil, model.ErrGallerySave
	}
	if _, err = reader.NextPart(); err != io.EOF {
		return nil, model.ErrGalleryInvalid
	}
	record.Bytes = writer.written
	record.MIMEType, record.Width, record.Height, err = validateGalleryOriginal(root, record.ID, record.Bytes)
	if err != nil {
		return nil, model.ErrGalleryInvalid
	}
	thumbnail := makeGalleryThumbnail(ctx, root, record)
	record.StorageBytes = record.Bytes + int64(len(normalized))
	if len(thumbnail) > 0 && int64(len(thumbnail)) <= budget-record.StorageBytes {
		tw, e := newGalleryWriter(ctx, root, record.ID, "thumbnail", budget-record.StorageBytes)
		if e != nil {
			return nil, e
		}
		_, e = tw.Write(thumbnail)
		ce := tw.Close()
		if e != nil || ce != nil {
			return nil, model.ErrGallerySave
		}
		record.HasThumbnail = true
		record.StorageBytes += int64(len(thumbnail))
	}
	mw, err := newGalleryWriter(ctx, root, record.ID, "metadata", int64(len(normalized)))
	if err != nil {
		return nil, err
	}
	_, err = mw.Write(normalized)
	closeErr = mw.Close()
	if err != nil || closeErr != nil {
		return nil, model.ErrGallerySave
	}
	record.State = "ready"
	if err = model.DB.WithContext(ctx).Save(record).Error; err != nil {
		return nil, model.ErrGallerySave
	}
	published = true
	return record, nil
}

func OpenGalleryImage(ctx context.Context, user int, id string, thumbnail bool) (*os.File, *model.GalleryImage, error) {
	galleryMu.Lock()
	defer galleryMu.Unlock()
	record, err := model.OwnedGalleryImage(ctx, user, id, time.Now().Unix())
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, gorm.ErrRecordNotFound
		}
		return nil, nil, model.ErrGalleryUnavailable
	}
	root, err := galleryRoot()
	if err != nil {
		return nil, nil, err
	}
	kind := "original"
	if thumbnail && record.HasThumbnail {
		kind = "thumbnail"
	}
	file, err := openGalleryFile(root, id, kind)
	if err != nil {
		return nil, nil, model.ErrGalleryUnavailable
	}
	return file, record, nil
}

func DeleteGalleryImage(ctx context.Context, user int, id string) error {
	galleryMu.Lock()
	defer galleryMu.Unlock()
	var record model.GalleryImage
	err := model.DB.WithContext(ctx).Where("id = ? AND user_id = ? AND state IN ? AND expires_at > ?", id, user, []string{"ready", "deleting"}, time.Now().Unix()).First(&record).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return gorm.ErrRecordNotFound
		}
		return model.ErrGalleryUnavailable
	}
	root, err := galleryRoot()
	if err != nil {
		return err
	}
	return removeGalleryRecord(ctx, root, &record)
}

func CleanupGallery(ctx context.Context) error {
	galleryMu.Lock()
	defer galleryMu.Unlock()
	return cleanupGalleryLocked(ctx)
}

func cleanupGalleryLocked(ctx context.Context) error {
	root, err := galleryRoot()
	if err != nil {
		return err
	}
	// Only records created by this feature authorize file removal. No directory scan.
	for {
		var records []model.GalleryImage
		if err := model.DB.WithContext(ctx).Where("state <> ? OR expires_at <= ?", "ready", time.Now().Unix()).Limit(100).Find(&records).Error; err != nil {
			return model.ErrGalleryUnavailable
		}
		if len(records) == 0 {
			return nil
		}
		for i := range records {
			if err := removeGalleryRecord(ctx, root, &records[i]); err != nil {
				return err
			}
		}
	}
}

func StartGallery() {
	galleryLifecycleMu.Lock()
	defer galleryLifecycleMu.Unlock()
	if galleryCancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	galleryCancel = cancel
	galleryDone = make(chan struct{})
	if err := CleanupGallery(ctx); err != nil {
		common.SysError("Gallery storage is unavailable.")
	}
	go func() {
		defer close(galleryDone)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := CleanupGallery(ctx); err != nil && ctx.Err() == nil {
					common.SysError("Gallery storage is unavailable.")
				}
			}
		}
	}()
}

func StopGallery() {
	galleryLifecycleMu.Lock()
	defer galleryLifecycleMu.Unlock()
	if galleryCancel == nil {
		return
	}
	galleryCancel()
	<-galleryDone
	galleryCancel = nil
}

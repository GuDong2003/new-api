package service

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
)

type ContentAuditSettingsUpdate struct {
	ExpectedVersion int64 `json:"expected_version"`
	model.ContentAuditSettings
}

type ContentAuditInitializeRequest struct {
	ExpectedVersion       int64 `json:"expected_version"`
	PlaintextAcknowledged bool  `json:"plaintext_acknowledged"`
}

type ContentAuditDeleteRequest struct {
	IDs []string `json:"ids"`
}

func normalizeContentAuditOperation(scope string, raw json.RawMessage, fields map[string]json.RawMessage) (any, error) {
	switch scope {
	case VerificationScopeContentAuditInitialize:
		var input ContentAuditInitializeRequest
		if len(fields) != 2 || common.Unmarshal(raw, &input) != nil || input.ExpectedVersion < 1 {
			return nil, ErrVerificationContextInvalid
		}
		if _, ok := fields["expected_version"]; !ok {
			return nil, ErrVerificationContextInvalid
		}
		if _, ok := fields["plaintext_acknowledged"]; !ok {
			return nil, ErrVerificationContextInvalid
		}
		return input, nil
	case VerificationScopeContentAuditSettings:
		var input ContentAuditSettingsUpdate
		if len(fields) != 8 || common.Unmarshal(raw, &input) != nil || input.ExpectedVersion < 1 || input.ContentAuditSettings.Validate() != nil {
			return nil, ErrVerificationContextInvalid
		}
		for _, key := range []string{"expected_version", "enabled", "retention_days", "request_limit", "response_limit", "capacity_bytes", "thumbnail_enabled", "plaintext_acknowledged"} {
			if _, ok := fields[key]; !ok {
				return nil, ErrVerificationContextInvalid
			}
		}
		return input, nil
	case VerificationScopeContentAuditDelete:
		var input ContentAuditDeleteRequest
		if len(fields) != 1 || common.Unmarshal(raw, &input) != nil || len(input.IDs) < 1 || len(input.IDs) > 100 {
			return nil, ErrVerificationContextInvalid
		}
		for _, id := range input.IDs {
			if !model.ValidContentAuditID(id) {
				return nil, ErrVerificationContextInvalid
			}
		}
		slices.Sort(input.IDs)
		input.IDs = slices.Compact(input.IDs)
		return input, nil
	}
	return nil, ErrProofScope
}

type ContentAuditStatus struct {
	State               model.ContentAuditStorageState `json:"state"`
	Ready               bool                           `json:"ready"`
	StableKeyConfigured bool                           `json:"stable_key_configured"`
	StorageConfigured   bool                           `json:"storage_configured"`
	EarliestExpiry      *int64                         `json:"earliest_expiry"`
}

func GetContentAuditStatus(ctx context.Context) (*ContentAuditStatus, error) {
	state, err := model.GetContentAuditState(ctx)
	if err != nil {
		return nil, err
	}
	result := &ContentAuditStatus{State: *state, StableKeyConfigured: stableCryptoSecretConfigured(), StorageConfigured: os.Getenv("CONTENT_AUDIT_STORAGE_DIR") != ""}
	snapshot := contentAuditEngine.snapshot.Load()
	result.Ready = snapshot != nil && snapshot.ready && snapshot.expires > time.Now().Unix() && snapshot.state.ConfigVersion == state.ConfigVersion && state.HealthyUntil > time.Now().Unix() && !state.Reconciling && state.PauseReason == ""
	if !result.Ready && result.State.PauseReason == "" {
		result.State.PauseReason = "local_refresh_pending"
	}
	if err := model.DB.WithContext(ctx).Model(&model.ContentAudit{}).Select("MIN(expires_at)").Scan(&result.EarliestExpiry).Error; err != nil {
		return nil, err
	}
	return result, nil
}

func InitializeContentAudit(ctx context.Context, input ContentAuditInitializeRequest) error {
	state, err := model.GetContentAuditState(ctx)
	if err != nil {
		return err
	}
	if state.ConfigVersion != input.ExpectedVersion || state.StorageID != "" {
		return model.ErrContentAuditConflict
	}
	store, err := newContentAuditStore(os.Getenv("CONTENT_AUDIT_STORAGE_DIR"))
	if err != nil {
		return err
	}
	if err := store.initialize(input.PlaintextAcknowledged); err != nil {
		return err
	}
	if err := model.InitializeContentAuditStorage(ctx, input.ExpectedVersion, store.namespace.StorageID, store.namespace.Mode, store.namespace.KeyID, input.PlaintextAcknowledged); err != nil {
		return err
	}
	contentAuditEngine.store.Store(store)
	contentAuditEngine.refreshLocal(ctx)
	return nil
}

func UpdateContentAudit(ctx context.Context, input ContentAuditSettingsUpdate) error {
	if err := model.UpdateContentAuditSettings(ctx, input.ExpectedVersion, input.ContentAuditSettings); err != nil {
		return err
	}
	contentAuditEngine.refreshLocal(ctx)
	if snapshot := contentAuditEngine.snapshot.Load(); snapshot != nil && (snapshot.state.Reconciling || snapshot.state.CapacityPaused || snapshot.state.RecordLimitPaused) {
		contentAuditEngine.wakeMaintenance()
	}
	return nil
}

func RequestContentAuditDeletion(ctx context.Context, input ContentAuditDeleteRequest) error {
	if err := model.RequestContentAuditDeletion(ctx, input.IDs); err != nil {
		return err
	}
	contentAuditEngine.wakeMaintenance()
	return nil
}

func contentAuditReadable(ctx context.Context, id string) (*model.ContentAudit, *model.ContentAuditStorageState, *contentAuditStore, error) {
	record, err := model.GetContentAudit(ctx, id)
	if err != nil {
		return nil, nil, nil, err
	}
	if record.ExpiresAt <= time.Now().Unix() {
		return nil, nil, nil, model.ErrContentAuditExpired
	}
	if record.Status != model.ContentAuditReady {
		return nil, nil, nil, model.ErrContentAuditUnavailable
	}
	state, err := model.GetContentAuditState(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	if record.StorageID != state.StorageID || record.Mode != state.Mode || record.KeyID != state.KeyID || (record.FormatVersion != 1 && record.FormatVersion != 2) {
		return nil, nil, nil, model.ErrContentAuditUnavailable
	}
	store := contentAuditEngine.store.Load()
	if store == nil {
		store, err = newContentAuditStore(os.Getenv("CONTENT_AUDIT_STORAGE_DIR"))
		if err != nil {
			return nil, nil, nil, err
		}
	}
	return record, state, store, nil
}

// Authorization and durable access logging belong to the management controller;
// these readers additionally enforce expiry, state, namespace and file identity.
func ReadContentAuditPayload(ctx context.Context, id string) (*model.ContentAudit, *ContentAuditPayload, error) {
	record, state, store, err := contentAuditReadable(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	var files []model.ContentAuditFile
	if common.UnmarshalJsonStr(record.FilesJSON, &files) != nil || len(files) < 1 || len(files) > 5 || files[0].Kind != "payload" {
		return nil, nil, model.ErrContentAuditUnavailable
	}
	data, err := store.read(state, record, files[0])
	if err != nil {
		return nil, nil, err
	}
	var payload ContentAuditPayload
	if common.Unmarshal(data, &payload) != nil || len(payload.Images) > 4 || len(payload.Request) > 2<<20 || len(payload.Response) > 4<<20 {
		return nil, nil, model.ErrContentAuditUnavailable
	}
	if record.FormatVersion == 2 {
		page, err := ReadContentAuditImagePage(ctx, id, -1, 20)
		if err != nil {
			return nil, nil, err
		}
		payload.Images, payload.ImageNextAfter, payload.ImageTotal = page.Items, page.NextAfter, page.Total
	} else {
		payload.ImageTotal = int64(len(payload.Images))
		for i := range payload.Images {
			payload.Images[i].OriginalStatus = "not_saved"
		}
	}
	current, _, _, err := contentAuditReadable(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	var semantic any
	if common.Unmarshal(payload.Response, &semantic) == nil {
		view := contentAuditTextView{}
		view.appendSemantic(semantic)
		payload.ResponseText, payload.TextViewTruncated = view.text.String(), view.truncated
	}
	return current, &payload, nil
}

// The optional text projection is derived on read, never a second persisted
// copy. Protocol structure, tool calls and ordered events remain in response.
type contentAuditTextView struct {
	text      strings.Builder
	truncated bool
}

func (v *contentAuditTextView) appendText(text string) {
	remaining := (64 << 10) - v.text.Len()
	if len(text) > remaining {
		text = strings.ToValidUTF8(text[:remaining], "")
		v.truncated = true
	}
	v.text.WriteString(text)
}

func (v *contentAuditTextView) appendSemantic(value any) {
	switch value := value.(type) {
	case []any:
		for _, child := range value {
			v.appendSemantic(child)
		}
	case map[string]any:
		if events, ok := value["events"].([]any); ok {
			for _, event := range events {
				event, ok := event.(map[string]any)
				if !ok {
					continue
				}
				data, ok := event["data"].(map[string]any)
				if !ok {
					continue
				}
				kind, _ := event["event"].(string)
				if kind == "" {
					kind, _ = data["type"].(string)
				}
				switch kind {
				case "response.output_text.delta", "response.refusal.delta":
					if text, ok := data["delta"].(string); ok {
						v.appendText(text)
					}
				case "response.completed":
					if v.text.Len() == 0 {
						v.appendSemantic(data["response"])
					}
				default:
					v.appendSemantic(data)
				}
			}
			return
		}
		for _, key := range []string{"text", "refusal", "completion"} {
			if text, ok := value[key].(string); ok {
				v.appendText(text)
			}
		}
		if text, ok := value["content"].(string); ok {
			v.appendText(text)
		}
		for _, key := range []string{"choices", "candidates", "output", "message", "content", "content_block", "parts", "delta"} {
			if _, text := value[key].(string); !text {
				v.appendSemantic(value[key])
			}
		}
	}
}

func ReadContentAuditThumbnail(ctx context.Context, id string, index int) ([]byte, error) {
	if index < 0 {
		return nil, model.ErrContentAuditInvalid
	}
	record, state, store, err := contentAuditReadable(ctx, id)
	if err != nil {
		return nil, err
	}
	var files []model.ContentAuditFile
	if record.FormatVersion == 2 {
		var row model.ContentAuditImage
		if err := model.DB.WithContext(ctx).Where("audit_id = ? AND attempt = ? AND image_index = ? AND committed = ?", id, record.Attempt, index, true).First(&row).Error; err != nil {
			return nil, err
		}
		descriptor, _, err := store.imageDescriptor(ctx, state, record, row)
		if err != nil {
			return nil, err
		}
		if descriptor.Thumbnail == nil {
			return nil, gorm.ErrRecordNotFound
		}
		files = []model.ContentAuditFile{*descriptor.Thumbnail}
	} else if common.UnmarshalJsonStr(record.FilesJSON, &files) != nil || len(files) > 5 {
		return nil, model.ErrContentAuditUnavailable
	}
	for _, file := range files {
		if file.Kind != "thumbnail" || file.ImageIndex != index {
			continue
		}
		if file.MIME != "image/jpeg" || file.PlainBytes > contentAuditMaxThumbnailBytes {
			return nil, model.ErrContentAuditUnavailable
		}
		data, err := store.read(state, record, file)
		if err != nil {
			return nil, err
		}
		if _, _, _, err := contentAuditReadable(ctx, id); err != nil {
			return nil, err
		}
		return data, nil
	}
	return nil, gorm.ErrRecordNotFound
}

func ReadContentAuditImagePage(ctx context.Context, id string, after, limit int) (*ContentAuditImagePage, error) {
	if after < -1 || limit < 1 || limit > 100 {
		return nil, model.ErrContentAuditInvalid
	}
	record, state, store, err := contentAuditReadable(ctx, id)
	if err != nil {
		return nil, err
	}
	page := &ContentAuditImagePage{Items: []ContentAuditImageView{}}
	if record.FormatVersion == 1 {
		_, payload, err := ReadContentAuditPayload(ctx, id)
		if err != nil {
			return nil, err
		}
		page.Total = int64(len(payload.Images))
		for _, view := range payload.Images {
			if view.Index > after {
				if len(page.Items) == limit {
					last := page.Items[len(page.Items)-1].Index
					page.NextAfter = &last
					break
				}
				page.Items = append(page.Items, view)
			}
		}
		return page, nil
	}
	if err := model.DB.WithContext(ctx).Model(&model.ContentAuditImage{}).Where("audit_id = ? AND attempt = ? AND committed = ?", id, record.Attempt, true).Count(&page.Total).Error; err != nil {
		return nil, err
	}
	rows, err := model.ListContentAuditImages(ctx, record, after, limit)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		descriptor, _, err := store.imageDescriptor(ctx, state, record, row)
		if err != nil {
			return nil, err
		}
		page.Items = append(page.Items, descriptor.View)
	}
	if len(rows) > 0 {
		last := rows[len(rows)-1].ImageIndex
		next, err := model.ListContentAuditImages(ctx, record, last, 1)
		if err != nil {
			return nil, err
		}
		if len(next) > 0 {
			page.NextAfter = &last
		}
	}
	if _, _, _, err := contentAuditReadable(ctx, id); err != nil {
		return nil, err
	}
	return page, nil
}

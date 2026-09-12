package model

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	ContentAuditFormatVersion          = 1
	ContentAuditRedactionVersion       = 1
	ContentAuditMaxRecords       int64 = 100000
	ContentAuditMaxCapacity      int64 = 10 << 30
	ContentAuditPending                = "pending"
	ContentAuditReady                  = "ready"
	ContentAuditFailed                 = "failed"
	ContentAuditDeleting               = "deleting"
)

var (
	ErrContentAuditConflict    = errors.New("content_audit_conflict")
	ErrContentAuditDisabled    = errors.New("content_audit_disabled")
	ErrContentAuditUnavailable = errors.New("content_audit_unavailable")
	ErrContentAuditCapacity    = errors.New("content_audit_capacity")
	ErrContentAuditInvalid     = errors.New("content_audit_invalid")
	ErrContentAuditExpired     = errors.New("content_audit_expired")
	ErrContentAuditOwnership   = errors.New("content_audit_ownership_lost")
)

// ContentAuditSettings is deliberately not registered with the generic options
// registry. Its only management writer requires a session-bound operation proof.
type ContentAuditSettings struct {
	Enabled               bool  `json:"enabled"`
	RetentionDays         int   `json:"retention_days"`
	RequestLimit          int   `json:"request_limit"`
	ResponseLimit         int   `json:"response_limit"`
	CapacityBytes         int64 `json:"capacity_bytes"`
	ThumbnailEnabled      bool  `json:"thumbnail_enabled"`
	PlaintextAcknowledged bool  `json:"plaintext_acknowledged"`
}

func DefaultContentAuditSettings() ContentAuditSettings {
	return ContentAuditSettings{RetentionDays: 7, RequestLimit: 512 << 10, ResponseLimit: 1 << 20, CapacityBytes: 512 << 20, ThumbnailEnabled: true}
}

func (s ContentAuditSettings) Validate() error {
	if s.RetentionDays < 1 || s.RetentionDays > 30 || s.RequestLimit < 64<<10 || s.RequestLimit > 2<<20 || s.ResponseLimit < 64<<10 || s.ResponseLimit > 4<<20 || s.CapacityBytes < 64<<20 || s.CapacityBytes > ContentAuditMaxCapacity {
		return ErrContentAuditInvalid
	}
	return nil
}

// The durable ledger lives in the primary database, including installations
// with a separate (possibly ClickHouse) log database. Revision protects local
// concurrent transactions, including SQLite's deferred transactions.
type ContentAuditStorageState struct {
	ID                   int    `json:"-" gorm:"primaryKey"`
	StorageID            string `json:"storage_id" gorm:"type:varchar(32);uniqueIndex"`
	ContentAuditSettings `gorm:"embedded"`
	ConfigVersion        int64  `json:"config_version"`
	Epoch                int64  `json:"epoch"`
	Revision             int64  `json:"-"`
	LedgerVersion        int64  `json:"-"`
	Mode                 string `json:"mode" gorm:"type:varchar(16)"`
	KeyID                string `json:"key_id" gorm:"type:varchar(32)"`
	UsedBytes            int64  `json:"used_bytes"`
	ReservedBytes        int64  `json:"reserved_bytes"`
	UsedRecords          int64  `json:"used_records"`
	ReservedRecords      int64  `json:"reserved_records"`
	QuarantinedBytes     int64  `json:"quarantined_bytes"`
	PauseReason          string `json:"pause_reason" gorm:"type:varchar(64)"`
	CapacityPaused       bool   `json:"capacity_paused"`
	RecordLimitPaused    bool   `json:"record_limit_paused"`
	HealthyUntil         int64  `json:"healthy_until"`
	Reconciling          bool   `json:"reconciling"`
	LastReconciledAt     int64  `json:"last_reconciled_at"`
	LastCleanupAt        int64  `json:"last_cleanup_at"`
}

type ContentAudit struct {
	ID                    int64  `json:"-" gorm:"primaryKey"`
	AuditID               string `json:"id" gorm:"type:varchar(32);uniqueIndex"`
	CreatedAt             int64  `json:"created_at" gorm:"index;index:idx_content_audit_user_time,priority:2"`
	ExpiresAt             int64  `json:"expires_at" gorm:"index"`
	CompletedAt           int64  `json:"completed_at"`
	UserID                int    `json:"user_id" gorm:"index:idx_content_audit_user_time,priority:1"`
	Username              string `json:"username" gorm:"type:varchar(64)"`
	ChannelID             int    `json:"channel_id" gorm:"index"`
	ChannelName           string `json:"channel_name" gorm:"type:varchar(128)"`
	Model                 string `json:"model" gorm:"type:varchar(128);index"`
	GroupName             string `json:"group" gorm:"type:varchar(64)"`
	RequestID             string `json:"request_id" gorm:"type:varchar(64);index"`
	UpstreamRequestID     string `json:"upstream_request_id" gorm:"type:varchar(128)"`
	Path                  string `json:"path" gorm:"type:varchar(255)"`
	Protocol              string `json:"protocol" gorm:"type:varchar(32)"`
	Kind                  string `json:"kind" gorm:"type:varchar(16)"`
	IsStream              bool   `json:"is_stream"`
	HTTPStatus            int    `json:"http_status"`
	DurationMS            int64  `json:"duration_ms"`
	CompletionReason      string `json:"completion_reason" gorm:"type:varchar(32)"`
	RetryCount            int    `json:"retry_count"`
	RequestObserved       int64  `json:"request_observed"`
	ResponseObserved      int64  `json:"response_observed"`
	RequestSaved          int    `json:"request_saved"`
	ResponseSaved         int    `json:"response_saved"`
	RequestTruncated      bool   `json:"request_truncated"`
	ResponseTruncated     bool   `json:"response_truncated"`
	OmittedImages         int    `json:"omitted_images"`
	Integrity             string `json:"integrity" gorm:"type:varchar(16);index"`
	RedactionVersion      int    `json:"redaction_version"`
	FormatVersion         int    `json:"format_version"`
	StorageID             string `json:"-" gorm:"type:varchar(32);index"`
	Mode                  string `json:"mode" gorm:"type:varchar(16)"`
	KeyID                 string `json:"key_id" gorm:"type:varchar(32)"`
	FilesJSON             string `json:"-" gorm:"type:text"`
	DeletionAuthorization string `json:"-" gorm:"type:varchar(2048)"`
	Status                string `json:"status" gorm:"type:varchar(16);index:idx_content_audit_cleanup,priority:1"`
	ErrorCode             string `json:"error_code" gorm:"type:varchar(64)"`
	CleanupAfter          int64  `json:"-" gorm:"index:idx_content_audit_cleanup,priority:2"`
	Attempt               string `json:"-" gorm:"type:varchar(32)"`
	Owner                 string `json:"-" gorm:"type:varchar(32);index"`
	Fence                 int64  `json:"-"`
	Epoch                 int64  `json:"-"`
	LeaseUntil            int64  `json:"-"`
	WriterStopped         bool   `json:"-"`
	ReservedBytes         int64  `json:"-"`
	FileBytes             int64  `json:"file_bytes"`
}

// File references never cross the management API. The bounded public image
// manifest is projected by the service, without paths or remote signed URLs.
type ContentAuditFile struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Bytes      int64  `json:"bytes"`
	PlainBytes int    `json:"plain_bytes"`
	MIME       string `json:"mime"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	ImageIndex int    `json:"image_index,omitempty"`
}

// Only opaque references and irreversible identities live in SQL. Display
// metadata and original/preview references are in charged encrypted descriptors.
type ContentAuditImage struct {
	ID                   int64  `gorm:"primaryKey"`
	AuditID              string `gorm:"type:varchar(32);uniqueIndex:idx_content_audit_image,priority:1;index:idx_content_audit_image_identity,priority:1;index:idx_content_audit_image_descriptor,priority:1;index:idx_content_audit_image_original,priority:1;index:idx_content_audit_image_thumbnail,priority:1"`
	Attempt              string `gorm:"type:varchar(32);uniqueIndex:idx_content_audit_image,priority:2;index:idx_content_audit_image_identity,priority:2;index:idx_content_audit_image_descriptor,priority:2;index:idx_content_audit_image_original,priority:2;index:idx_content_audit_image_thumbnail,priority:2"`
	ImageIndex           int    `gorm:"uniqueIndex:idx_content_audit_image,priority:3"`
	Identity             string `gorm:"type:varchar(64);index:idx_content_audit_image_identity,priority:3"`
	DescriptorID         string `gorm:"type:varchar(32);index:idx_content_audit_image_descriptor,priority:3"`
	DescriptorBytes      int64
	DescriptorPlainBytes int
	GroupID              int64 `gorm:"index"`
	Committed            bool
	// Rebuildable lookup hints are deliberately excluded from the immutable
	// row serialization used by already-persisted deletion authorizations.
	OriginalLookup  string `json:"-" gorm:"type:varchar(64);index:idx_content_audit_image_original,priority:3"`
	ThumbnailLookup string `json:"-" gorm:"type:varchar(64);index:idx_content_audit_image_thumbnail,priority:3"`
}

func ListContentAuditImages(ctx context.Context, record *ContentAudit, after, limit int) ([]ContentAuditImage, error) {
	var rows []ContentAuditImage
	err := DB.WithContext(ctx).Where("audit_id = ? AND attempt = ? AND image_index > ? AND committed = ?", record.AuditID, record.Attempt, after, true).Order("image_index").Limit(min(max(limit, 1), 100)).Find(&rows).Error
	return rows, err
}

type ContentAuditOrphan struct {
	Path      string `gorm:"type:varchar(65);primaryKey"`
	Bytes     int64
	FirstSeen int64
	LastSeen  int64
	Scans     int
	Closed    bool
}

func MigrateContentAudit(db *gorm.DB) error {
	if err := db.AutoMigrate(&ContentAuditStorageState{}, &ContentAudit{}, &ContentAuditOrphan{}, &ContentAuditImage{}); err != nil {
		return err
	}
	state := ContentAuditStorageState{ID: 1, ContentAuditSettings: DefaultContentAuditSettings(), ConfigVersion: 1, Epoch: 1, Revision: 1, LedgerVersion: 1, PauseReason: "not_initialized"}
	return db.Clauses(clause.OnConflict{DoNothing: true}).Create(&state).Error
}

// Content access never relies on a cached role/session remaining current. This
// single primary-DB statement checks both sides of the live session identity.
func ValidateContentAuditSession(ctx context.Context, identity AuthSessionIdentity) error {
	var count int64
	err := DB.WithContext(ctx).Model(&UserSession{}).Joins("JOIN users ON users.id = user_sessions.user_id").
		Where("users.id = ? AND users.role = ? AND users.status = ? AND users.auth_version = ?", identity.UserID, common.RoleRootUser, common.UserStatusEnabled, identity.UserAuthVersion).
		Where("user_sessions.sid = ? AND user_sessions.version = ? AND user_sessions.user_auth_version = ? AND user_sessions.status = ? AND user_sessions.revoked_at = ? AND user_sessions.expires_at > ?", identity.SessionID, identity.SessionVersion, identity.UserAuthVersion, UserSessionStatusActive, 0, time.Now().Unix()).Count(&count).Error
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrUserSessionInactive
	}
	return nil
}

func GetContentAuditState(ctx context.Context) (*ContentAuditStorageState, error) {
	var state ContentAuditStorageState
	err := DB.WithContext(ctx).First(&state, 1).Error
	return &state, err
}

// Retry only transactional conflicts, with a fixed bound. An unavailable DB
// never turns into an unbounded relay wait (these calls run off the relay path).
func contentAuditTransaction(ctx context.Context, action func(*gorm.DB, *ContentAuditStorageState) error) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var err error
	for attempt := range 3 {
		err = DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var state ContentAuditStorageState
			if err := lockForUpdate(tx).First(&state, 1).Error; err != nil {
				return err
			}
			revision := state.Revision
			if err := action(tx, &state); err != nil {
				return err
			}
			state.Revision++
			result := tx.Model(&ContentAuditStorageState{}).Where("id = ? AND revision = ?", 1, revision).Select("*").Updates(&state)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return ErrContentAuditConflict
			}
			return nil
		})
		if err == nil || ctx.Err() != nil {
			return err
		}
		message := strings.ToLower(err.Error())
		if !errors.Is(err, ErrContentAuditConflict) && !strings.Contains(message, "locked") && !strings.Contains(message, "deadlock") && !strings.Contains(message, "serialization") {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 10 * time.Millisecond):
		}
	}
	return err
}

func InitializeContentAuditStorage(ctx context.Context, expected int64, storageID, mode, keyID string, plaintext bool) error {
	if !ValidContentAuditID(storageID) || (mode != "aes-gcm" && mode != "plaintext") || (mode == "plaintext" && !plaintext) {
		return ErrContentAuditInvalid
	}
	return contentAuditTransaction(ctx, func(_ *gorm.DB, state *ContentAuditStorageState) error {
		if state.ConfigVersion != expected {
			return ErrContentAuditConflict
		}
		if state.StorageID != "" && (state.StorageID != storageID || state.Mode != mode || state.KeyID != keyID) {
			return ErrContentAuditConflict
		}
		state.StorageID, state.Mode, state.KeyID = storageID, mode, keyID
		state.PlaintextAcknowledged = plaintext
		state.ConfigVersion++
		state.Reconciling, state.PauseReason, state.HealthyUntil = true, "reconciling", 0
		return nil
	})
}

func UpdateContentAuditSettings(ctx context.Context, expected int64, settings ContentAuditSettings) error {
	if err := settings.Validate(); err != nil {
		return err
	}
	return contentAuditTransaction(ctx, func(_ *gorm.DB, state *ContentAuditStorageState) error {
		if state.ConfigVersion != expected {
			return ErrContentAuditConflict
		}
		if state.Mode == "plaintext" && !settings.PlaintextAcknowledged {
			return ErrContentAuditInvalid
		}
		if settings.Enabled && !state.Enabled && (state.StorageID == "" || state.Reconciling || state.HealthyUntil <= time.Now().Unix() || state.PauseReason != "") {
			return ErrContentAuditUnavailable
		}
		if state.Enabled != settings.Enabled {
			state.Epoch++
		}
		state.ContentAuditSettings = settings
		state.ConfigVersion++
		state.CapacityPaused, state.RecordLimitPaused = false, false
		if state.PauseReason == "capacity" || state.PauseReason == "record_limit" {
			state.PauseReason = ""
		}
		return nil
	})
}

func SetContentAuditHealth(ctx context.Context, version int64, healthy bool, reason string) error {
	return contentAuditTransaction(ctx, func(_ *gorm.DB, state *ContentAuditStorageState) error {
		if state.ConfigVersion != version {
			return ErrContentAuditConflict
		}
		state.HealthyUntil = 0
		if healthy {
			state.HealthyUntil = time.Now().Unix() + 15
		}
		if state.Reconciling {
			if !healthy {
				state.PauseReason = reason
			}
			return nil
		}
		if !healthy {
			if state.PauseReason != "capacity" && state.PauseReason != "record_limit" {
				state.PauseReason = reason
			}
			return nil
		}
		state.CapacityPaused, state.RecordLimitPaused, state.PauseReason = false, false, ""
		return nil
	})
}

func ValidContentAuditID(value string) bool {
	return len(value) == 32 && strings.Trim(value, "0123456789abcdef") == ""
}

// Initial reservation covers bounded text and closure. Images acquire their
// actual envelope bytes incrementally from the same ledger before physical I/O.
func ContentAuditReservation(settings ContentAuditSettings) int64 {
	n := int64(settings.RequestLimit + settings.ResponseLimit + 16384)
	n += n/8 + 8192
	return n
}

func ReserveContentAudit(ctx context.Context, record *ContentAudit) error {
	if record == nil || !ValidContentAuditID(record.AuditID) || !ValidContentAuditID(record.Owner) || !ValidContentAuditID(record.Attempt) || record.UserID <= 0 {
		return ErrContentAuditInvalid
	}
	var rejected error
	err := contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		rejected = nil
		now := time.Now().Unix()
		if !state.Enabled || record.Epoch != state.Epoch {
			return ErrContentAuditDisabled
		}
		if record.ExpiresAt <= now {
			return ErrContentAuditExpired
		}
		if state.HealthyUntil <= now || state.PauseReason != "" || state.Reconciling {
			return ErrContentAuditUnavailable
		}
		if record.RequestSaved > state.RequestLimit || record.ResponseSaved > state.ResponseLimit {
			return ErrContentAuditInvalid
		}
		reserved := ContentAuditReservation(state.ContentAuditSettings)
		if state.UsedBytes < 0 || state.ReservedBytes < 0 || state.UsedRecords < 0 || state.ReservedRecords < 0 || state.UsedBytes > ContentAuditMaxCapacity || state.ReservedBytes > ContentAuditMaxCapacity || state.ReservedRecords == math.MaxInt64 {
			return ErrContentAuditUnavailable
		}
		if reserved > state.CapacityBytes-state.UsedBytes-state.ReservedBytes {
			rejected = ErrContentAuditCapacity
			return nil
		}
		record.StorageID, record.Mode, record.KeyID = state.StorageID, state.Mode, state.KeyID
		record.Status, record.Fence, record.LeaseUntil = ContentAuditPending, 1, now+90
		record.ReservedBytes, record.FileBytes = reserved, 0
		record.FormatVersion, record.RedactionVersion = ContentAuditFormatVersion, ContentAuditRedactionVersion
		record.ID = 0
		if err := tx.Create(record).Error; err != nil {
			return err
		}
		state.ReservedBytes += reserved
		state.ReservedRecords++
		state.LedgerVersion++
		return nil
	})
	if err != nil {
		return err
	}
	return rejected
}

func GrowContentAuditReservation(ctx context.Context, record *ContentAudit, amount int64) error {
	if record == nil || amount <= 0 || amount > ContentAuditMaxCapacity {
		return ErrContentAuditInvalid
	}
	err := contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		if !state.Enabled || state.Epoch != record.Epoch {
			return ErrContentAuditDisabled
		}
		if state.Reconciling || state.StorageID != record.StorageID || state.Mode != record.Mode || state.KeyID != record.KeyID || record.ExpiresAt <= time.Now().Unix() {
			return ErrContentAuditUnavailable
		}
		if state.UsedBytes < 0 || state.ReservedBytes < 0 || state.UsedBytes > ContentAuditMaxCapacity || state.ReservedBytes > ContentAuditMaxCapacity || record.ReservedBytes > ContentAuditMaxCapacity-amount {
			return ErrContentAuditUnavailable
		}
		if amount > state.CapacityBytes-state.UsedBytes-state.ReservedBytes {
			return ErrContentAuditCapacity
		}
		result := tx.Model(&ContentAudit{}).Where("audit_id = ? AND attempt = ? AND owner = ? AND fence = ? AND status = ? AND writer_stopped = ? AND reserved_bytes = ?", record.AuditID, record.Attempt, record.Owner, record.Fence, ContentAuditPending, false, record.ReservedBytes).Updates(map[string]any{"reserved_bytes": record.ReservedBytes + amount, "lease_until": time.Now().Unix() + 90})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrContentAuditOwnership
		}
		state.ReservedBytes += amount
		state.LedgerVersion++
		return nil
	})
	if err == nil {
		record.ReservedBytes += amount
	}
	return err
}

// Renew a live local writer after storage revalidation without claiming bytes.
// Expiry is a liveness signal, never proof that a fenced writer has stopped.
func RenewContentAuditAttempt(ctx context.Context, record *ContentAudit) error {
	if record == nil {
		return ErrContentAuditInvalid
	}
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		now := time.Now().Unix()
		if !state.Enabled || state.Epoch != record.Epoch {
			return ErrContentAuditDisabled
		}
		if state.Reconciling || state.PauseReason != "" || state.HealthyUntil <= now || state.StorageID != record.StorageID || state.Mode != record.Mode || state.KeyID != record.KeyID {
			return ErrContentAuditUnavailable
		}
		if record.ExpiresAt <= now {
			return ErrContentAuditExpired
		}
		// Always change the matched row even when renewed within one second;
		// MySQL may otherwise report zero affected rows for an owned attempt.
		// The column expression also anchors CASE's result to bigint in
		// PostgreSQL, where two untyped result parameters otherwise infer text.
		lease := gorm.Expr("CASE WHEN lease_until = ? THEN lease_until + 1 ELSE ? END", now+90, now+90)
		result := tx.Model(&ContentAudit{}).Where("audit_id = ? AND attempt = ? AND owner = ? AND fence = ? AND status = ? AND writer_stopped = ? AND reserved_bytes = ?", record.AuditID, record.Attempt, record.Owner, record.Fence, ContentAuditPending, false, record.ReservedBytes).Update("lease_until", lease)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrContentAuditOwnership
		}
		return nil
	})
}

// Call only after closing handles and positively confirming removal and sync.
func ReleaseContentAuditReservation(ctx context.Context, record *ContentAudit, amount int64) error {
	if record == nil || amount <= 0 || amount >= record.ReservedBytes {
		return ErrContentAuditInvalid
	}
	err := contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		if state.ReservedBytes < amount {
			return ErrContentAuditUnavailable
		}
		result := tx.Model(&ContentAudit{}).Where("audit_id = ? AND attempt = ? AND owner = ? AND fence = ? AND status = ? AND reserved_bytes = ?", record.AuditID, record.Attempt, record.Owner, record.Fence, ContentAuditPending, record.ReservedBytes).Update("reserved_bytes", record.ReservedBytes-amount)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrContentAuditOwnership
		}
		state.ReservedBytes -= amount
		state.LedgerVersion++
		return nil
	})
	if err == nil {
		record.ReservedBytes -= amount
	}
	return err
}

func GetContentAudit(ctx context.Context, id string) (*ContentAudit, error) {
	if !ValidContentAuditID(id) {
		return nil, ErrContentAuditInvalid
	}
	var record ContentAudit
	err := DB.WithContext(ctx).Where("audit_id = ?", id).First(&record).Error
	return &record, err
}

func PublishContentAudit(ctx context.Context, record *ContentAudit, files []ContentAuditFile, actual int64) error {
	if len(files) < 1 || len(files) > 5 || actual <= 0 || actual > record.ReservedBytes {
		return ErrContentAuditInvalid
	}
	encoded, err := common.Marshal(files)
	if err != nil || len(encoded) > 8192 {
		return ErrContentAuditInvalid
	}
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		now := time.Now().Unix()
		if !state.Enabled || record.Epoch != state.Epoch {
			return ErrContentAuditDisabled
		}
		if state.Reconciling || state.HealthyUntil <= now || state.StorageID != record.StorageID || state.Mode != record.Mode || state.KeyID != record.KeyID {
			return ErrContentAuditUnavailable
		}
		if record.ExpiresAt <= now {
			return ErrContentAuditExpired
		}
		if record.RequestSaved > state.RequestLimit || record.ResponseSaved > state.ResponseLimit || (record.FormatVersion == 1 && !state.ThumbnailEnabled && len(files) > 1) || state.UsedBytes+state.ReservedBytes > state.CapacityBytes {
			return ErrContentAuditCapacity
		}
		if state.ReservedBytes < record.ReservedBytes || state.ReservedRecords < 1 {
			return ErrContentAuditUnavailable
		}
		result := tx.Model(&ContentAudit{}).Where("audit_id = ? AND status = ? AND owner = ? AND attempt = ? AND fence = ? AND lease_until > ?", record.AuditID, ContentAuditPending, record.Owner, record.Attempt, record.Fence, now).Updates(map[string]any{
			"status": ContentAuditReady, "files_json": string(encoded), "file_bytes": actual, "reserved_bytes": 0, "writer_stopped": true,
			"integrity": record.Integrity, "omitted_images": record.OmittedImages,
			"error_code":     record.ErrorCode,
			"format_version": record.FormatVersion, "kind": record.Kind, "completed_at": record.CompletedAt, "duration_ms": record.DurationMS,
			"channel_id": record.ChannelID, "channel_name": record.ChannelName, "group_name": record.GroupName, "upstream_request_id": record.UpstreamRequestID,
			"http_status": record.HTTPStatus, "is_stream": record.IsStream, "retry_count": record.RetryCount, "request_saved": record.RequestSaved, "response_saved": record.ResponseSaved,
			"request_observed": record.RequestObserved, "response_observed": record.ResponseObserved, "request_truncated": record.RequestTruncated, "response_truncated": record.ResponseTruncated, "completion_reason": record.CompletionReason,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrContentAuditOwnership
		}
		state.ReservedBytes -= record.ReservedBytes
		state.ReservedRecords--
		state.UsedBytes += actual
		state.UsedRecords++
		state.LedgerVersion++
		return nil
	})
}

// The writer calls this only after closing all filesystem handles. Local
// maintenance may also stop an attempt after excluding all background writers.
func StopContentAuditAttempt(ctx context.Context, record *ContentAudit, code string) error {
	if len(code) > 64 {
		return ErrContentAuditInvalid
	}
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		result := tx.Model(&ContentAudit{}).Where("audit_id = ? AND status = ? AND owner = ? AND attempt = ? AND fence = ?", record.AuditID, ContentAuditPending, record.Owner, record.Attempt, record.Fence).Updates(map[string]any{
			"status": ContentAuditFailed, "writer_stopped": true, "error_code": code, "cleanup_after": time.Now().Unix(), "fence": record.Fence + 1,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrContentAuditOwnership
		}
		state.LedgerVersion++
		return nil
	})
}

// Recovery runs under exclusive local maintenance. At startup the previous
// process has stopped; its unfinished attempts cannot publish.
func RecoverContentAuditAttempts(ctx context.Context, owner string) error {
	if !ValidContentAuditID(owner) {
		return ErrContentAuditInvalid
	}
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		if !state.Reconciling {
			return ErrContentAuditConflict
		}
		result := tx.Model(&ContentAudit{}).Where("status = ? AND owner <> ?", ContentAuditPending, owner).
			Updates(map[string]any{"status": ContentAuditFailed, "writer_stopped": true, "error_code": "restart_interrupted", "cleanup_after": time.Now().Unix(), "fence": gorm.Expr("fence + ?", 1)})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected > 0 {
			state.LedgerVersion++
		}
		return nil
	})
}

func BeginContentAuditDelete(ctx context.Context, id string) (*ContentAudit, error) {
	var record ContentAudit
	err := contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		if err := tx.Where("audit_id = ?", id).First(&record).Error; err != nil {
			return err
		}
		if record.Status == ContentAuditDeleting {
			return nil
		}
		if !record.WriterStopped || (record.Status != ContentAuditReady && record.Status != ContentAuditFailed) {
			return ErrContentAuditOwnership
		}
		result := tx.Model(&ContentAudit{}).Where("id = ? AND status = ? AND fence = ?", record.ID, record.Status, record.Fence).Updates(map[string]any{"status": ContentAuditDeleting, "fence": record.Fence + 1})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrContentAuditConflict
		}
		record.Status = ContentAuditDeleting
		record.Fence++
		state.LedgerVersion++
		return nil
	})
	return &record, err
}

// Manual deletion closes the entire normalized selection atomically. Missing
// records are already deleted; one still-active writer rejects the whole set.
func RequestContentAuditDeletion(ctx context.Context, ids []string) error {
	if len(ids) < 1 || len(ids) > 100 {
		return ErrContentAuditInvalid
	}
	for _, id := range ids {
		if !ValidContentAuditID(id) {
			return ErrContentAuditInvalid
		}
	}
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		var records []ContentAudit
		if err := tx.Where("audit_id IN ?", ids).Find(&records).Error; err != nil {
			return err
		}
		for _, record := range records {
			if !record.WriterStopped || (record.Status != ContentAuditReady && record.Status != ContentAuditFailed && record.Status != ContentAuditDeleting) {
				return ErrContentAuditOwnership
			}
		}
		result := tx.Model(&ContentAudit{}).Where("audit_id IN ? AND status IN ?", ids, []string{ContentAuditReady, ContentAuditFailed}).Updates(map[string]any{"status": ContentAuditDeleting, "fence": gorm.Expr("fence + ?", 1)})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected > 0 {
			state.LedgerVersion++
		}
		return nil
	})
}

// RequestContentAuditReset marks every completed, stopped capture for
// asynchronous physical cleanup. Pending writers are deliberately excluded so
// an administrative reset cannot interrupt an in-flight request.
func RequestContentAuditReset(ctx context.Context) (int64, error) {
	var count int64
	err := contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		result := tx.Model(&ContentAudit{}).
			Where("writer_stopped = ? AND status IN ?", true, []string{ContentAuditReady, ContentAuditFailed}).
			Updates(map[string]any{"status": ContentAuditDeleting, "fence": gorm.Expr("fence + ?", 1)})
		if result.Error != nil {
			return result.Error
		}
		count = result.RowsAffected
		if count > 0 {
			state.LedgerVersion++
		}
		return nil
	})
	return count, err
}

// Authorization is private, bounded, and owned by this exact stopped deletion
// fence. It changes no charge; child references survive until Finish succeeds.
func AuthorizeContentAuditDeletion(ctx context.Context, record *ContentAudit, authorization string) error {
	if len(authorization) < 1 || len(authorization) > 2048 {
		return ErrContentAuditInvalid
	}
	query := DB.WithContext(ctx).Model(&ContentAudit{}).Where("audit_id = ? AND attempt = ? AND fence = ? AND status = ? AND writer_stopped = ?", record.AuditID, record.Attempt, record.Fence, ContentAuditDeleting, true)
	if record.DeletionAuthorization == "" {
		// Rows migrated from an older version have a NULL private field.
		query = query.Where("(deletion_authorization = ? OR deletion_authorization IS NULL)", "")
	} else {
		query = query.Where("deletion_authorization = ?", record.DeletionAuthorization)
	}
	result := query.Update("deletion_authorization", authorization)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrContentAuditOwnership
	}
	record.DeletionAuthorization = authorization
	return nil
}

func FinishContentAuditDelete(ctx context.Context, record *ContentAudit) error {
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		var current ContentAudit
		err := tx.Where("audit_id = ?", record.AuditID).First(&current).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if current.Status != ContentAuditDeleting || current.Fence != record.Fence || !current.WriterStopped {
			return ErrContentAuditOwnership
		}
		if current.ReservedBytes > 0 {
			if state.ReservedBytes < current.ReservedBytes || state.ReservedRecords < 1 {
				return ErrContentAuditUnavailable
			}
			state.ReservedBytes -= current.ReservedBytes
			state.ReservedRecords--
		} else {
			if state.UsedBytes < current.FileBytes || state.UsedRecords < 1 {
				return ErrContentAuditUnavailable
			}
			state.UsedBytes -= current.FileBytes
			state.UsedRecords--
		}
		state.LedgerVersion++
		if err := tx.Where("audit_id = ? AND attempt = ?", current.AuditID, current.Attempt).Delete(&ContentAuditImage{}).Error; err != nil {
			return err
		}
		return tx.Delete(&current).Error
	})
}

func ContentAuditCleanupCandidates(ctx context.Context, afterID int64, limit int) ([]ContentAudit, error) {
	var records []ContentAudit
	now := time.Now().Unix()
	err := DB.WithContext(ctx).Where("id > ?", afterID).Where("(status = ? AND expires_at <= ?) OR (status IN ? AND cleanup_after <= ?) OR (status = ? AND lease_until <= ?)", ContentAuditReady, now, []string{ContentAuditFailed, ContentAuditDeleting}, now, ContentAuditPending, now).Order("id").Limit(min(max(limit, 1), 100)).Find(&records).Error
	return records, err
}

func DeferContentAuditCleanup(ctx context.Context, record *ContentAudit, code string) error {
	return contentAuditTransaction(ctx, func(tx *gorm.DB, _ *ContentAuditStorageState) error {
		result := tx.Model(&ContentAudit{}).Where("audit_id = ? AND status = ? AND fence = ?", record.AuditID, ContentAuditDeleting, record.Fence).Updates(map[string]any{"cleanup_after": time.Now().Unix() + 60, "error_code": code})
		if result.Error != nil {
			return result.Error
		}
		return nil
	})
}

type ContentAuditFilter struct {
	Start      int64
	End        int64
	UserID     int
	ChannelID  int
	Model      string
	RequestID  string
	Kind       string
	HTTPStatus int
	Integrity  string
	Page       int
	PageSize   int
}

func ListContentAudits(ctx context.Context, filter ContentAuditFilter) ([]ContentAudit, int64, error) {
	if filter.Start <= 0 || filter.End < filter.Start || filter.End-filter.Start > 31*86400 || filter.Page < 1 || filter.Page > 10000 || filter.PageSize < 1 || filter.PageSize > 100 || len(filter.Model) > 128 || len(filter.RequestID) > 64 {
		return nil, 0, ErrContentAuditInvalid
	}
	query := DB.WithContext(ctx).Model(&ContentAudit{}).Where("created_at >= ? AND created_at <= ?", filter.Start, filter.End)
	if filter.UserID > 0 {
		query = query.Where("user_id = ?", filter.UserID)
	}
	if filter.ChannelID > 0 {
		query = query.Where("channel_id = ?", filter.ChannelID)
	}
	if filter.Model != "" {
		query = query.Where("model = ?", filter.Model)
	}
	if filter.RequestID != "" {
		query = query.Where("request_id = ?", filter.RequestID)
	}
	if filter.Kind != "" {
		query = query.Where("kind = ?", filter.Kind)
	}
	if filter.HTTPStatus > 0 {
		query = query.Where("http_status = ?", filter.HTTPStatus)
	}
	if filter.Integrity != "" {
		query = query.Where("integrity = ?", filter.Integrity)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	records := []ContentAudit{}
	err := query.Order("created_at DESC").Order("id DESC").Limit(filter.PageSize).Offset((filter.Page - 1) * filter.PageSize).Find(&records).Error
	return records, total, err
}

func BeginContentAuditReconciliation(ctx context.Context) error {
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		if state.StorageID == "" {
			return ErrContentAuditUnavailable
		}
		state.Reconciling, state.PauseReason, state.HealthyUntil = true, "reconciling", 0
		return nil
	})
}

// Reconciliation never overwrites a changing ledger. Publishing and admission
// are frozen first; the caller checks files outside the transaction, then CASes
// the observed revision. Deletion may proceed and simply forces a new scan.
func CompleteContentAuditReconciliation(ctx context.Context, revision int64, used, reserved, records, pending, quarantine int64, reason string) error {
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		if !state.Reconciling || state.LedgerVersion != revision {
			return ErrContentAuditConflict
		}
		if used < 0 || reserved < 0 || records < 0 || pending < 0 || quarantine < 0 {
			return ErrContentAuditInvalid
		}
		state.UsedBytes, state.ReservedBytes = used, reserved
		state.UsedRecords, state.ReservedRecords, state.QuarantinedBytes = records, pending, quarantine
		state.PauseReason = reason
		if reason == "capacity" {
			state.CapacityPaused = true
		}
		if reason == "record_limit" {
			state.RecordLimitPaused = true
		}
		state.Reconciling = reason != ""
		state.LastReconciledAt = time.Now().Unix()
		state.LedgerVersion++
		return nil
	})
}

func MarkContentAuditCleanupCompleted(ctx context.Context) error {
	return contentAuditTransaction(ctx, func(tx *gorm.DB, state *ContentAuditStorageState) error {
		state.LastCleanupAt = time.Now().Unix()
		return nil
	})
}

func ObserveContentAuditOrphan(ctx context.Context, orphan *ContentAuditOrphan) error {
	return contentAuditTransaction(ctx, func(tx *gorm.DB, _ *ContentAuditStorageState) error {
		return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "path"}}, DoUpdates: clause.AssignmentColumns([]string{"bytes", "last_seen", "scans", "closed"})}).Create(orphan).Error
	})
}

func RemoveContentAuditOrphan(ctx context.Context, path string) error {
	return contentAuditTransaction(ctx, func(tx *gorm.DB, _ *ContentAuditStorageState) error {
		return tx.Where("path = ?", path).Delete(&ContentAuditOrphan{}).Error
	})
}

package service

import (
	"context"
	"errors"
	"io"
	"math"
	"os"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
)

// Maintenance is owned and cancelled by the audit runtime. Excluding only
// background writers lets relay capture continue into its bounded queue.
func (r *contentAuditRuntime) maintain(parent context.Context, recoverPrevious bool) error {
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	r.ioMu.Lock()
	defer r.ioMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	store := r.store.Load()
	if store == nil {
		return model.ErrContentAuditUnavailable
	}
	state, err := model.GetContentAuditState(ctx)
	if err != nil {
		return err
	}
	root, err := store.open(state)
	if err != nil {
		return err
	}
	_ = root.Close()
	if recoverPrevious {
		if err := model.BeginContentAuditReconciliation(ctx); err != nil {
			return err
		}
		if err := model.RecoverContentAuditAttempts(ctx, r.processID); err != nil {
			return err
		}
	}
	if err := cleanupContentAudits(ctx, store); err != nil {
		return err
	}
	state, err = model.GetContentAuditState(ctx)
	if err != nil {
		return err
	}
	reason := ""
	if _, _, err := store.space(state.CapacityBytes); err != nil {
		reason = "storage_space"
	}
	// Reconciliation invalidates admission. Restore local health before
	// unlocking so queued writers cannot race the next periodic refresh.
	return model.SetContentAuditHealth(ctx, state.ConfigVersion, reason == "", reason)
}

// The caller holds the runtime's exclusive I/O lock.
func cleanupContentAudits(ctx context.Context, store *contentAuditStore) error {
	state, err := model.GetContentAuditState(ctx)
	if err != nil {
		return err
	}
	root, err := store.open(state)
	if err != nil {
		return err
	}
	_ = root.Close()
	var afterID int64
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		records, err := model.ContentAuditCleanupCandidates(ctx, afterID, 100)
		if err != nil {
			return err
		}
		for i := range records {
			record := &records[i]
			// Unknown writers keep their reservation, but cannot block later
			// expired/deleting rows from receiving their own cleanup attempt.
			afterID = record.ID
			if _, active := contentAuditEngine.activeAttempts.Load(record.AuditID); active {
				continue
			}
			if contentAuditEngine.deferOriginalDeletion(record.AuditID) {
				continue
			}
			if record.Status == model.ContentAuditPending {
				closed, err := store.closedAttempt(state, record.AuditID, record.Attempt)
				if err != nil || closed.Owner != record.Owner || closed.Fence != record.Fence {
					continue
				}
				if err := model.StopContentAuditAttempt(ctx, record, "writer_closed_before_publish"); err != nil {
					return err
				}
				record.WriterStopped = true
			}
			if !record.WriterStopped {
				continue
			}
			deleting, err := model.BeginContentAuditDelete(ctx, record.AuditID)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if err := store.deleteAttempt(ctx, state, deleting.AuditID, deleting.Attempt); err != nil {
				_ = model.DeferContentAuditCleanup(ctx, deleting, "delete_failed")
				continue
			}
			if err := model.FinishContentAuditDelete(ctx, deleting); err != nil {
				return err
			}
		}
		if len(records) < 100 {
			break
		}
	}
	if err := model.MarkContentAuditCleanupCompleted(ctx); err != nil {
		return err
	}
	if err := model.BeginContentAuditReconciliation(ctx); err != nil {
		return err
	}
	return reconcileContentAudits(ctx, store)
}

// Flat directories are scanned in fixed batches. Unknown files/symlinks stop
// reconciliation; arbitrary image counts do not grow an in-memory file map.
func inspectContentAuditAttempt(root *os.Root, name string) (int64, int64, error) {
	directory, err := openContentAuditDirectory(root, name)
	if err != nil {
		return 0, 0, err
	}
	defer directory.Close()
	entries, err := directory.Open(".")
	if err != nil {
		return 0, 0, err
	}
	defer entries.Close()
	var total, count int64
	for {
		files, err := entries.ReadDir(100)
		if err != nil && err != io.EOF {
			return 0, 0, err
		}
		for _, file := range files {
			base, extension, ok := strings.Cut(file.Name(), ".")
			if !ok || (!model.ValidContentAuditID(base) && base != "closed") || (extension != "bin" && extension != "tmp") || !file.Type().IsRegular() {
				return 0, 0, errContentAuditFile
			}
			info, err := directory.Lstat(file.Name())
			if err != nil {
				return 0, 0, err
			}
			if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() < 0 || info.Size() > math.MaxInt64-total || count == math.MaxInt64 {
				return 0, 0, errContentAuditFile
			}
			total += info.Size()
			count++
		}
		if err == io.EOF {
			return total, count, nil
		}
	}
}

func reconcileContentAudits(ctx context.Context, store *contentAuditStore) error {
	state, err := model.GetContentAuditState(ctx)
	if err != nil {
		return err
	}
	if !state.Reconciling {
		return model.ErrContentAuditConflict
	}
	root, err := store.open(state)
	if err != nil {
		return err
	}
	defer root.Close()
	attempts, err := openContentAuditDirectory(root, "attempts")
	if err != nil {
		return err
	}
	defer attempts.Close()
	var used, reserved, records, pending, quarantine int64
	reason := ""
	var lastID int64
	for {
		var batch []model.ContentAudit
		if err := model.DB.WithContext(ctx).Where("id > ?", lastID).Order("id").Limit(100).Find(&batch).Error; err != nil {
			return err
		}
		for _, record := range batch {
			lastID = record.ID
			if record.StorageID != state.StorageID || record.Mode != state.Mode || record.KeyID != state.KeyID {
				reason = "record_identity_mismatch"
			}
			if record.ReservedBytes > 0 {
				if record.ReservedBytes > math.MaxInt64-reserved || pending == math.MaxInt64 {
					return model.ErrContentAuditUnavailable
				}
				reserved += record.ReservedBytes
				pending++
			} else {
				if record.FileBytes < 0 || record.FileBytes > math.MaxInt64-used || records == math.MaxInt64 {
					return model.ErrContentAuditUnavailable
				}
				used += record.FileBytes
				records++
			}
			if contentAuditEngine.hasOriginalReaders(record.AuditID) {
				continue
			}
			if !record.WriterStopped {
				if _, active := contentAuditEngine.activeAttempts.Load(record.AuditID); active {
					continue
				}
				// Current-process attempts without a stopped marker retain their
				// reservation; expiry alone never establishes writer completion.
				reason = "writer_unconfirmed"
				continue
			}
			name, err := contentAuditAttemptDirectory(record.AuditID, record.Attempt)
			if err != nil {
				return err
			}
			actual, files, err := inspectContentAuditAttempt(attempts, name)
			if errors.Is(err, os.ErrNotExist) && record.Status != model.ContentAuditReady {
				continue
			}
			if err != nil {
				reason = "files_unavailable"
				continue
			}
			if record.ReservedBytes > 0 {
				if actual > record.ReservedBytes {
					reason = "ledger_mismatch"
				}
				continue
			}
			if actual != record.FileBytes {
				reason = "ledger_mismatch"
				continue
			}
			closed, err := store.closedAttempt(state, record.AuditID, record.Attempt)
			if err != nil || closed.Owner != record.Owner {
				reason = "files_unavailable"
				continue
			}
			directory, err := openContentAuditDirectory(attempts, name)
			if err != nil {
				reason = "files_unavailable"
				continue
			}
			err = store.verifyAttemptManifest(ctx, state, &record, directory, closed, actual, files)
			_ = directory.Close()
			if err != nil {
				reason = "files_unavailable"
			}
		}
		if len(batch) < 100 {
			break
		}
	}
	// Traverse in bounded batches; never materialize 100,000 payload manifests
	// or trust "not found" when a database operation itself failed.
	entries, err := attempts.Open(".")
	if err != nil {
		return err
	}
	defer entries.Close()
	for {
		batch, readErr := entries.ReadDir(100)
		if readErr != nil && readErr != io.EOF {
			return readErr
		}
		for _, entry := range batch {
			auditID, attempt, ok := strings.Cut(entry.Name(), "-")
			if !ok || !model.ValidContentAuditID(auditID) || !model.ValidContentAuditID(attempt) || !entry.IsDir() {
				reason = "unknown_files"
				continue
			}
			var count int64
			if err := model.DB.WithContext(ctx).Model(&model.ContentAudit{}).Where("audit_id = ? AND attempt = ?", auditID, attempt).Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				continue
			}
			size, _, err := inspectContentAuditAttempt(attempts, entry.Name())
			if err != nil {
				reason = "unknown_files"
				continue
			}
			_, closedErr := store.closedAttempt(state, auditID, attempt)
			closed := closedErr == nil
			if !closed {
				reason = "orphan_incomplete"
			}
			var orphan model.ContentAuditOrphan
			err = model.DB.WithContext(ctx).Where("path = ?", entry.Name()).First(&orphan).Error
			now := time.Now().Unix()
			if errors.Is(err, gorm.ErrRecordNotFound) {
				orphan = model.ContentAuditOrphan{Path: entry.Name(), Bytes: size, FirstSeen: now, LastSeen: now, Scans: 1, Closed: closed}
				if err := model.ObserveContentAuditOrphan(ctx, &orphan); err != nil {
					return err
				}
			} else if err != nil {
				return err
			} else if closed && orphan.Closed && now-orphan.FirstSeen >= 3600 && orphan.Scans >= 1 {
				// A valid closed marker establishes ownership. First discovery
				// is charged and quarantined for a full hour before deletion.
				if err := store.deleteAttempt(ctx, state, auditID, attempt); err != nil {
					reason = "orphan_delete_failed"
				} else {
					if err := model.RemoveContentAuditOrphan(ctx, orphan.Path); err != nil {
						return err
					}
					continue
				}
			} else {
				orphan.Bytes, orphan.LastSeen, orphan.Scans, orphan.Closed = size, now, min(orphan.Scans+1, 1000000), closed
				if err := model.ObserveContentAuditOrphan(ctx, &orphan); err != nil {
					return err
				}
			}
			if size > math.MaxInt64-quarantine || records == math.MaxInt64 {
				return model.ErrContentAuditUnavailable
			}
			quarantine += size
			records++
		}
		if readErr == io.EOF {
			break
		}
	}
	// Orphan rows whose deletion completed before a failed DB commit no longer
	// correspond to disk bytes; clear only after a positive ENOENT on this mount.
	var after string
	for {
		var batch []model.ContentAuditOrphan
		if err := model.DB.WithContext(ctx).Where("path > ?", after).Order("path").Limit(100).Find(&batch).Error; err != nil {
			return err
		}
		for _, orphan := range batch {
			after = orphan.Path
			if _, err := attempts.Lstat(orphan.Path); errors.Is(err, os.ErrNotExist) {
				if err := model.RemoveContentAuditOrphan(ctx, orphan.Path); err != nil {
					return err
				}
			} else if err != nil {
				return err
			}
		}
		if len(batch) < 100 {
			break
		}
	}
	if used > math.MaxInt64-reserved || used+reserved > math.MaxInt64-quarantine {
		return model.ErrContentAuditUnavailable
	}
	if used+reserved+quarantine > state.CapacityBytes {
		reason = "capacity"
	}
	return model.CompleteContentAuditReconciliation(ctx, state.LedgerVersion, used+quarantine, reserved, records, pending, quarantine, reason)
}

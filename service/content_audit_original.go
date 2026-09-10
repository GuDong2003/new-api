package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"math"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
)

type ContentAuditOriginal struct {
	Reader io.ReadCloser
	MIME   string
	Bytes  int64
}

type contentAuditOriginalFile struct {
	ID         string `json:"id"`
	Bytes      int64  `json:"bytes"`
	PlainBytes int64  `json:"plain_bytes"`
	MIME       string `json:"mime"`
}

const contentAuditOriginalBlock = 128 << 10

type contentAuditImageDescriptor struct {
	View      ContentAuditImageView     `json:"view"`
	Original  *contentAuditOriginalFile `json:"original,omitempty"`
	Thumbnail *model.ContentAuditFile   `json:"thumbnail,omitempty"`
}

func contentAuditImageCode(err error) string {
	if errors.Is(err, model.ErrContentAuditCapacity) {
		return "capacity"
	}
	if errors.Is(err, errContentAuditFile) {
		return "protocol_invalid"
	}
	return "image_unavailable"
}

func (s *contentAuditStore) imageDescriptor(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, row model.ContentAuditImage) (*contentAuditImageDescriptor, []byte, error) {
	if row.AuditID != record.AuditID || row.Attempt != record.Attempt || row.DescriptorPlainBytes < 1 || row.DescriptorPlainBytes > 8192 || row.DescriptorBytes > 16384 {
		return nil, nil, errContentAuditFile
	}
	file := model.ContentAuditFile{ID: row.DescriptorID, Kind: "image_descriptor", Bytes: row.DescriptorBytes, PlainBytes: row.DescriptorPlainBytes}
	data, err := s.read(state, record, file)
	if err != nil {
		return nil, nil, err
	}
	var descriptor contentAuditImageDescriptor
	if common.Unmarshal(data, &descriptor) != nil || descriptor.View.Index != row.ImageIndex {
		return nil, nil, errContentAuditFile
	}
	if descriptor.Original != nil && (!model.ValidContentAuditID(descriptor.Original.ID) || descriptor.Original.Bytes < 8 || descriptor.Original.Bytes > model.ContentAuditMaxCapacity || descriptor.Original.PlainBytes <= 0 || descriptor.Original.PlainBytes > descriptor.Original.Bytes) {
		return nil, nil, errContentAuditFile
	}
	if descriptor.Thumbnail != nil && (!model.ValidContentAuditID(descriptor.Thumbnail.ID) || descriptor.Thumbnail.Kind != "thumbnail" || descriptor.Thumbnail.PlainBytes < 1 || descriptor.Thumbnail.PlainBytes > contentAuditMaxThumbnailBytes || descriptor.Thumbnail.Bytes > contentAuditMaxThumbnailBytes+128) {
		return nil, nil, errContentAuditFile
	}
	return &descriptor, data, nil
}

func removeContentAuditImageFiles(ctx context.Context, directory *os.Root, record *model.ContentAudit, ids []string, charged int64) error {
	for _, id := range ids {
		if !model.ValidContentAuditID(id) {
			return errContentAuditFile
		}
		for _, ext := range []string{".tmp", ".bin"} {
			info, err := directory.Lstat(id + ext)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil || !info.Mode().IsRegular() {
				return errContentAuditFile
			}
			if directory.Remove(id+ext) != nil {
				return errContentAuditStore
			}
		}
	}
	if syncContentAuditDirectory(directory) != nil {
		return errContentAuditStore
	}
	if charged > 0 {
		return model.ReleaseContentAuditReservation(ctx, record, charged)
	}
	return nil
}

func (s *contentAuditStore) discardImage(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, directory *os.Root, row model.ContentAuditImage) error {
	descriptor, _, err := s.imageDescriptor(ctx, state, record, row)
	if err != nil {
		return err
	}
	ids, charged := []string{row.DescriptorID}, row.DescriptorBytes
	if descriptor.Original != nil {
		ids = append(ids, descriptor.Original.ID)
		charged += descriptor.Original.Bytes
	}
	if descriptor.Thumbnail != nil {
		ids = append(ids, descriptor.Thumbnail.ID)
		charged += descriptor.Thumbnail.Bytes
	}
	if err := removeContentAuditImageFiles(ctx, directory, record, ids, charged); err != nil {
		return err
	}
	return model.DB.WithContext(ctx).Where("id = ? AND audit_id = ? AND attempt = ?", row.ID, record.AuditID, record.Attempt).Delete(&model.ContentAuditImage{}).Error
}

func (s *contentAuditStore) commitImageGroup(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, directory *os.Root, group int64, valid bool) error {
	var after int64
	for {
		var rows []model.ContentAuditImage
		if err := model.DB.WithContext(ctx).Where("audit_id = ? AND attempt = ? AND group_id = ? AND committed = ? AND id > ?", record.AuditID, record.Attempt, group, false, after).Order("id").Limit(100).Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			after = row.ID
			if !valid {
				if err := s.discardImage(ctx, state, record, directory, row); err != nil {
					return err
				}
				continue
			}
			if row.Identity != "" {
				var previous model.ContentAuditImage
				err := model.DB.WithContext(ctx).Where("audit_id = ? AND attempt = ? AND identity = ? AND committed = ?", record.AuditID, record.Attempt, row.Identity, true).First(&previous).Error
				if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				if err == nil {
					descriptor, _, err := s.imageDescriptor(ctx, state, record, row)
					if err != nil {
						return err
					}
					if descriptor.Original == nil {
						if err := s.discardImage(ctx, state, record, directory, row); err != nil {
							return err
						}
						continue
					}
					if err := s.discardImage(ctx, state, record, directory, previous); err != nil {
						return err
					}
					descriptor.View.Index = previous.ImageIndex
					row.ImageIndex = previous.ImageIndex
					if err := s.saveImageDescriptor(ctx, record, directory, &row, descriptor); err != nil {
						return err
					}
				}
			}
			if err := model.DB.WithContext(ctx).Model(&model.ContentAuditImage{}).Where("id = ?", row.ID).Update("committed", true).Error; err != nil {
				return err
			}
		}
		if len(rows) < 100 {
			return nil
		}
	}
}

// Replacements are charged before writing and keep both descriptor files until
// the database reference update is confirmed. An ambiguous update fails closed.
func (s *contentAuditStore) saveImageDescriptor(ctx context.Context, record *model.ContentAudit, directory *os.Root, row *model.ContentAuditImage, descriptor *contentAuditImageDescriptor) error {
	data, err := common.Marshal(descriptor)
	if err != nil || len(data) > 8192 {
		return errContentAuditFile
	}
	id := contentAuditRandomID()
	encoded, err := s.envelope(record.StorageID, record.AuditID, record.Attempt, id, "image_descriptor", data, false)
	if err != nil {
		return err
	}
	if err := model.GrowContentAuditReservation(ctx, record, int64(len(encoded))); err != nil {
		return err
	}
	remaining := int64(len(encoded))
	n, err := s.write(ctx, directory, record.StorageID, record.AuditID, record.Attempt, id, "image_descriptor", data, false, &remaining)
	if err != nil {
		return err
	}
	previousID, previousBytes := row.DescriptorID, row.DescriptorBytes
	next := *row
	next.DescriptorID, next.DescriptorBytes, next.DescriptorPlainBytes = id, n, len(data)
	result := model.DB.WithContext(ctx).Model(&model.ContentAuditImage{}).Where("id = ? AND audit_id = ? AND attempt = ? AND descriptor_id = ?", row.ID, record.AuditID, record.Attempt, previousID).Select("*").Updates(&next)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return model.ErrContentAuditOwnership
	}
	*row = next
	return removeContentAuditImageFiles(ctx, directory, record, []string{previousID}, previousBytes)
}

func (r *contentAuditRuntime) prepareOriginalPreview(ctx context.Context, store *contentAuditStore, state *model.ContentAuditStorageState, record *model.ContentAudit, file contentAuditOriginalFile) (*contentAuditThumbnail, error) {
	// This is only the decoder input-work allowance, never an original limit.
	if file.PlainBytes < 1 || file.PlainBytes > contentAuditMaxImageBytes || !r.memory.acquire(file.PlainBytes) {
		return nil, errContentAuditImage
	}
	defer r.memory.release(file.PlainBytes)
	reader, err := store.openOriginal(ctx, state, record, file)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data := make([]byte, int(file.PlainBytes))
	if _, err := io.ReadFull(reader, data); err != nil {
		return nil, err
	}
	var extra [1]byte
	if n, err := reader.Read(extra[:]); n != 0 || err != io.EOF {
		return nil, errContentAuditFile
	}
	return makeContentAuditThumbnail(ctx, data, file.MIME)
}

func (r *contentAuditRuntime) saveOriginalPreview(ctx context.Context, store *contentAuditStore, state *model.ContentAuditStorageState, record *model.ContentAudit, directory *os.Root, row *model.ContentAuditImage, descriptor *contentAuditImageDescriptor) error {
	if descriptor.Original == nil || descriptor.Thumbnail != nil || !state.ThumbnailEnabled || descriptor.View.Status == "thumbnail_disabled" {
		return nil
	}
	thumbnail, err := r.prepareOriginalPreview(ctx, store, state, record, *descriptor.Original)
	if err != nil {
		return nil
	}
	file := model.ContentAuditFile{ID: contentAuditRandomID(), Kind: "thumbnail", MIME: "image/jpeg", PlainBytes: len(thumbnail.Data), Width: thumbnail.Width, Height: thumbnail.Height, ImageIndex: row.ImageIndex}
	encoded, err := store.envelope(record.StorageID, record.AuditID, record.Attempt, file.ID, "thumbnail", thumbnail.Data, false)
	if err != nil {
		return err
	}
	if err := model.GrowContentAuditReservation(ctx, record, int64(len(encoded))); err != nil {
		if errors.Is(err, model.ErrContentAuditCapacity) {
			return nil
		}
		return err
	}
	remaining := int64(len(encoded))
	file.Bytes, err = store.write(ctx, directory, record.StorageID, record.AuditID, record.Attempt, file.ID, "thumbnail", thumbnail.Data, false, &remaining)
	if err != nil {
		return err
	}
	next := *descriptor
	next.Thumbnail = &file
	next.View.Status, next.View.MIME, next.View.Width, next.View.Height = "ready", "image/jpeg", file.Width, file.Height
	if err := store.saveImageDescriptor(ctx, record, directory, row, &next); err != nil {
		if errors.Is(err, model.ErrContentAuditCapacity) {
			return removeContentAuditImageFiles(ctx, directory, record, []string{file.ID}, file.Bytes)
		}
		return err
	}
	*descriptor = next
	return nil
}

// A session has one active candidate; closed candidates are immediately charged
// descriptors in SQL, not retained images/maps. Only the worker performs I/O.
func (r *contentAuditRuntime) runOriginalJob(ctx context.Context, job *contentAuditJob) {
	defer r.release(job)
	session := job.images.session
	record := session.initial
	var state *model.ContentAuditStorageState
	store := r.store.Load()
	var directory *os.Root
	var active *contentAuditOriginalWriter
	var activeInput contentAuditImageInput
	var candidateErr error
	var failed error
	initialReservation := int64(0)
	published := false
	r.ioMu.RLock()
	if ctx.Err() != nil || store == nil {
		failed = model.ErrContentAuditUnavailable
	} else {
		state, failed = model.GetContentAuditState(ctx)
		if failed == nil {
			_, _, failed = store.space(state.CapacityBytes)
		}
		if failed == nil {
			failed = model.ReserveContentAudit(ctx, &record)
		}
		if failed == nil {
			record.FormatVersion = 2
			initialReservation = record.ReservedBytes
			r.activeAttempts.Store(record.AuditID, true)
			directory, failed = store.beginAttempt(state, &record)
		}
	}
	r.ioMu.RUnlock()
	defer func() {
		r.ioMu.RLock()
		defer r.ioMu.RUnlock()
		if active != nil && active.handle != nil {
			_ = active.handle.Close()
		}
		if directory != nil {
			_ = directory.Close()
		}
		r.activeAttempts.Delete(record.AuditID)
		if !published && record.ReservedBytes > 0 {
			stopCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = model.StopContentAuditAttempt(stopCtx, &record, "write_failed")
			r.wakeMaintenance()
		}
		if !published {
			r.dropped.Add(1)
			r.storageDrops.Add(1)
		}
	}()
	finished := false
	if failed != nil {
		session.stop()
		finished = true
	}
	for {
		var event contentAuditImageEvent
		if finished {
			select {
			case event = <-session.events:
			default:
				goto drained
			}
		} else {
			select {
			case event = <-session.events:
			case <-ctx.Done():
				session.stop()
				failed, finished = ctx.Err(), true
				continue
			case <-session.done:
				finished = true
				continue
			}
		}
		if ctx.Err() != nil {
			failed = ctx.Err()
			session.stop()
		}
		r.ioMu.RLock()
		if failed == nil {
			switch event.kind {
			case "begin":
				if active != nil {
					failed = errContentAuditFile
					break
				}
				activeInput = event.input
				activeInput.Data = nil
				candidateErr = nil
				if activeInput.URL == "" && activeInput.Error == "" {
					active, candidateErr = newContentAuditOriginalWriter(ctx, store, &record, directory)
				}
			case "data":
				if activeInput.Index != event.input.Index {
					failed = errContentAuditFile
					break
				}
				if candidateErr == nil && active != nil {
					_, candidateErr = active.Write(event.input.Data)
				}
			case "end":
				if activeInput.Index != event.input.Index {
					failed = errContentAuditFile
					break
				}
				input := event.input
				if !event.valid || input.Error != "" {
					candidateErr = errContentAuditFile
				}
				var original contentAuditOriginalFile
				if event.valid && candidateErr == nil && input.URL != "" {
					active, candidateErr = newContentAuditOriginalWriter(ctx, store, &record, directory)
					if candidateErr == nil {
						client := newContentAuditImageClient()
						candidateErr = streamContentAuditImage(ctx, client, input.URL, active, &input.MIME)
						client.CloseIdleConnections()
					}
				}
				if candidateErr == nil && active != nil {
					original, candidateErr = active.finish()
				}
				if active != nil && active.handle != nil {
					if err := active.handle.Close(); err != nil {
						failed = errContentAuditStore
					}
					active.handle = nil
				}
				if candidateErr == nil && active != nil {
					original.MIME, candidateErr = store.validateOriginalImage(ctx, state, &record, original, input.MIME)
				}
				if candidateErr != nil && active != nil {
					if err := removeContentAuditImageFiles(ctx, directory, &record, []string{active.file.ID}, active.charged); err != nil {
						failed = err
					}
					original = contentAuditOriginalFile{}
				}
				if failed == nil && event.valid {
					descriptor := contentAuditImageDescriptor{View: ContentAuditImageView{Index: input.Index, Status: "preview_unavailable", OriginalStatus: "ready"}}
					if input.URL != "" {
						descriptor.View.Address = redactContentAuditURL(input.URL)
					}
					identity := ""
					if input.sourceID != "" {
						sum := sha256.Sum256([]byte(input.sourceID))
						identity = hex.EncodeToString(sum[:])
					} else if job.images.protocol != "openai_images" && active != nil && candidateErr == nil {
						identity = hex.EncodeToString(active.digest.Sum(nil))
					}
					if candidateErr != nil || original.ID == "" {
						descriptor.View.OriginalStatus = contentAuditImageCode(candidateErr)
						descriptor.View.Status = descriptor.View.OriginalStatus
						record.Integrity = "partial"
					} else {
						descriptor.Original = &original
						descriptor.View.OriginalMIME, descriptor.View.OriginalBytes = original.MIME, original.PlainBytes
					}
					if !job.images.enabled {
						descriptor.View.Status = "thumbnail_disabled"
					}
					data, err := common.Marshal(descriptor)
					if err != nil || len(data) > 8192 {
						failed = errContentAuditFile
						break
					}
					fileID := contentAuditRandomID()
					encoded, err := store.envelope(record.StorageID, record.AuditID, record.Attempt, fileID, "image_descriptor", data, false)
					if err == nil {
						err = model.GrowContentAuditReservation(ctx, &record, int64(len(encoded)))
					}
					if errors.Is(err, model.ErrContentAuditCapacity) {
						if original.ID != "" {
							err = removeContentAuditImageFiles(ctx, directory, &record, []string{original.ID}, original.Bytes)
						}
						record.OmittedImages = min(record.OmittedImages, math.MaxInt-1) + 1
						record.Integrity = "partial"
						if err != nil && !errors.Is(err, model.ErrContentAuditCapacity) {
							failed = err
						}
					} else if err != nil {
						failed = err
					} else {
						remaining := int64(len(encoded))
						n, err := store.write(ctx, directory, record.StorageID, record.AuditID, record.Attempt, fileID, "image_descriptor", data, false, &remaining)
						if err != nil {
							failed = err
						} else {
							row := model.ContentAuditImage{AuditID: record.AuditID, Attempt: record.Attempt, ImageIndex: input.Index, Identity: identity, DescriptorID: fileID, DescriptorBytes: n, DescriptorPlainBytes: len(data), GroupID: input.group}
							failed = model.DB.WithContext(ctx).Create(&row).Error
						}
					}
				}
				active, candidateErr = nil, nil
			case "group":
				failed = store.commitImageGroup(ctx, state, &record, directory, event.group, event.valid)
			}
		}
		r.ioMu.RUnlock()
		if event.input.charged > 0 {
			r.memory.release(event.input.charged)
		}
	}
drained:
	if failed != nil {
		return
	}
	r.ioMu.RLock()
	defer r.ioMu.RUnlock()
	if active != nil {
		if active.handle != nil {
			if active.handle.Close() != nil {
				return
			}
			active.handle = nil
		}
		if removeContentAuditImageFiles(ctx, directory, &record, []string{active.file.ID}, active.charged) != nil {
			return
		}
		active = nil
		record.Integrity = "partial"
	}
	if store.commitImageGroup(ctx, state, &record, directory, session.lastGroup, session.lastValid) != nil {
		return
	}
	// Any earlier invalid/unfinished event remains unpublished and is removed.
	var groups []model.ContentAuditImage
	for {
		if model.DB.WithContext(ctx).Where("audit_id = ? AND attempt = ? AND committed = ?", record.AuditID, record.Attempt, false).Limit(100).Find(&groups).Error != nil {
			return
		}
		for _, row := range groups {
			if store.discardImage(ctx, state, &record, directory, row) != nil {
				return
			}
			r.ioMu.RUnlock()
			r.ioMu.RLock()
		}
		if len(groups) < 100 {
			break
		}
	}
	reserved, storageID, mode, keyID, fence := record.ReservedBytes, record.StorageID, record.Mode, record.KeyID, record.Fence
	partial, omitted := record.Integrity == "partial", record.OmittedImages
	record = job.record
	record.ReservedBytes, record.StorageID, record.Mode, record.KeyID, record.Fence, record.FormatVersion = reserved, storageID, mode, keyID, fence, 2
	if partial {
		record.Integrity = "partial"
	}
	record.OmittedImages = min(math.MaxInt-record.OmittedImages, omitted) + record.OmittedImages
	closed := contentAuditClosedAttempt{Version: 2, AuditID: record.AuditID, Attempt: record.Attempt, Owner: record.Owner, Fence: record.Fence}
	digest := sha256.New()
	after := -1
	for {
		rows, err := model.ListContentAuditImages(ctx, &record, after, 100)
		if err != nil {
			return
		}
		for _, row := range rows {
			descriptor, _, err := store.imageDescriptor(ctx, state, &record, row)
			if err != nil {
				return
			}
			current, err := model.GetContentAuditState(ctx)
			if err != nil {
				return
			}
			if err := r.saveOriginalPreview(ctx, store, current, &record, directory, &row, descriptor); err != nil {
				return
			}
			_, data, err := store.imageDescriptor(ctx, state, &record, row)
			if err != nil {
				return
			}
			_, _ = digest.Write(data)
			closed.ImageCount++
			after = row.ImageIndex
			// Active ownership keeps this attempt excluded from maintenance;
			// let unrelated cleanup run between bounded per-image operations.
			r.ioMu.RUnlock()
			r.ioMu.RLock()
		}
		if len(rows) < 100 {
			break
		}
	}
	closed.ImageDigest = hex.EncodeToString(digest.Sum(nil))
	record.Kind = session.initial.Kind
	if closed.ImageCount > 0 {
		record.Kind = "image"
	}
	actual := record.ReservedBytes - initialReservation
	job.payload.Images = []ContentAuditImageView{}
	body, err := common.Marshal(job.payload)
	if err != nil {
		return
	}
	remaining := initialReservation
	file := model.ContentAuditFile{ID: contentAuditRandomID(), Kind: "payload", MIME: "application/json", PlainBytes: len(body)}
	file.Bytes, err = store.write(ctx, directory, record.StorageID, record.AuditID, record.Attempt, file.ID, "payload", body, true, &remaining)
	if err != nil {
		return
	}
	actual += file.Bytes
	closed.Files, closed.FileBytes = []model.ContentAuditFile{file}, actual
	marker, err := common.Marshal(closed)
	if err != nil {
		return
	}
	n, err := store.write(ctx, directory, record.StorageID, record.AuditID, record.Attempt, "closed", "closed", marker, false, &remaining)
	if err != nil {
		return
	}
	actual += n
	if directory.Close() != nil {
		return
	}
	directory = nil
	current, err := model.GetContentAuditState(ctx)
	if err != nil || current.Reconciling || current.PauseReason != "" {
		return
	}
	root, err := store.open(current)
	if err != nil {
		return
	}
	if root.Close() != nil {
		return
	}
	if _, _, err := store.space(current.CapacityBytes); err != nil {
		return
	}
	if model.SetContentAuditHealth(ctx, current.ConfigVersion, true, "") != nil {
		return
	}
	if model.RenewContentAuditAttempt(ctx, &record) != nil {
		return
	}
	if err := model.PublishContentAudit(ctx, &record, closed.Files, actual); err != nil {
		current, lookupErr := model.GetContentAudit(context.Background(), record.AuditID)
		if lookupErr != nil || current.Status != model.ContentAuditReady || current.Attempt != record.Attempt {
			return
		}
	}
	published = true
	r.saved.Add(1)
	if record.Integrity == "partial" {
		r.partial.Add(1)
	}
}

type contentAuditOriginalWriter struct {
	ctx       context.Context
	store     *contentAuditStore
	record    *model.ContentAudit
	directory *os.Root
	handle    *os.File
	file      contentAuditOriginalFile
	digest    hash.Hash
	sequence  uint64
	buffer    []byte
	charged   int64
	err       error
}

func newContentAuditOriginalWriter(ctx context.Context, store *contentAuditStore, record *model.ContentAudit, directory *os.Root) (*contentAuditOriginalWriter, error) {
	w := &contentAuditOriginalWriter{ctx: ctx, store: store, record: record, directory: directory, file: contentAuditOriginalFile{ID: contentAuditRandomID()}, digest: sha256.New(), buffer: make([]byte, 0, contentAuditOriginalBlock)}
	store.physicalMu.Lock()
	defer store.physicalMu.Unlock()
	if err := store.checkWriteSpace(ctx, 8); err != nil {
		return nil, err
	}
	if err := model.GrowContentAuditReservation(ctx, record, 8); err != nil {
		return nil, err
	}
	w.charged = 8
	var err error
	w.handle, err = directory.OpenFile(w.file.ID+".tmp", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return w, errContentAuditStore
	}
	if _, err := w.handle.Write([]byte("NACA0002")); err != nil {
		return w, errContentAuditStore
	}
	w.file.Bytes = 8
	return w, nil
}

func (w *contentAuditOriginalWriter) frame(kind byte, plain []byte) error {
	if err := w.ctx.Err(); err != nil {
		return err
	}
	identity := "original/" + strconv.Itoa(int(kind)) + "/" + strconv.FormatUint(w.sequence, 10)
	encoded, err := w.store.envelope(w.record.StorageID, w.record.AuditID, w.record.Attempt, w.file.ID, identity, plain, false)
	if err != nil {
		return err
	}
	amount := int64(5 + len(encoded))
	w.store.physicalMu.Lock()
	defer w.store.physicalMu.Unlock()
	if err := w.store.checkWriteSpace(w.ctx, amount); err != nil {
		return err
	}
	if err := model.GrowContentAuditReservation(w.ctx, w.record, amount); err != nil {
		return err
	}
	w.charged += amount
	var header [5]byte
	header[0] = kind
	binary.BigEndian.PutUint32(header[1:], uint32(len(encoded)))
	if _, err := w.handle.Write(header[:]); err != nil {
		return errContentAuditStore
	}
	if _, err := w.handle.Write(encoded); err != nil {
		return errContentAuditStore
	}
	w.file.Bytes += amount
	return nil
}

func (w *contentAuditOriginalWriter) Write(data []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	n := len(data)
	for len(data) > 0 {
		count := min(contentAuditOriginalBlock-len(w.buffer), len(data))
		w.buffer = append(w.buffer, data[:count]...)
		data = data[count:]
		if len(w.buffer) == contentAuditOriginalBlock {
			if w.err = w.flush(); w.err != nil {
				return n - len(data), w.err
			}
		}
	}
	return n, nil
}

func (w *contentAuditOriginalWriter) flush() error {
	if len(w.buffer) == 0 {
		return nil
	}
	if err := w.frame(0, w.buffer); err != nil {
		return err
	}
	w.file.PlainBytes += int64(len(w.buffer))
	_, _ = w.digest.Write(w.buffer)
	w.sequence++
	w.buffer = w.buffer[:0]
	return nil
}

func (w *contentAuditOriginalWriter) finish() (contentAuditOriginalFile, error) {
	if w.err != nil {
		return w.file, w.err
	}
	if w.err = w.flush(); w.err != nil {
		return w.file, w.err
	}
	var final [48]byte
	binary.BigEndian.PutUint64(final[:8], uint64(w.file.PlainBytes))
	binary.BigEndian.PutUint64(final[8:16], w.sequence)
	copy(final[16:], w.digest.Sum(nil))
	if w.err = w.frame(1, final[:]); w.err != nil {
		return w.file, w.err
	}
	if w.handle.Sync() != nil {
		return w.file, errContentAuditStore
	}
	if w.handle.Close() != nil {
		return w.file, errContentAuditStore
	}
	w.handle = nil
	if _, err := w.directory.Lstat(w.file.ID + ".bin"); !errors.Is(err, os.ErrNotExist) {
		return w.file, errContentAuditFile
	}
	if w.directory.Rename(w.file.ID+".tmp", w.file.ID+".bin") != nil || syncContentAuditDirectory(w.directory) != nil {
		return w.file, errContentAuditStore
	}
	return w.file, nil
}

func (s *contentAuditStore) writeOriginal(ctx context.Context, record *model.ContentAudit, directory *os.Root, reader io.Reader) (contentAuditOriginalFile, error) {
	w, err := newContentAuditOriginalWriter(ctx, s, record, directory)
	if w != nil {
		defer func() {
			if w.handle != nil {
				_ = w.handle.Close()
			}
		}()
	}
	if err != nil {
		return contentAuditOriginalFile{}, err
	}
	if _, err := io.CopyBuffer(w, reader, make([]byte, contentAuditOriginalBlock)); err != nil {
		return w.file, err
	}
	return w.finish()
}

type contentAuditOriginalReader struct {
	ctx           context.Context
	store         *contentAuditStore
	record        *model.ContentAudit
	file          contentAuditOriginalFile
	handle        *os.File
	digest        hash.Hash
	sequence      uint64
	plainBytes    int64
	physicalBytes int64
	buffer        []byte
	final         bool
	err           error
}

func (r *contentAuditOriginalReader) Close() error { return r.handle.Close() }

func (r *contentAuditOriginalReader) Read(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	if r.err != nil {
		return 0, r.err
	}
	if err := r.ctx.Err(); err != nil {
		r.err = err
		return 0, err
	}
	if len(r.buffer) > 0 {
		n := copy(data, r.buffer)
		r.buffer = r.buffer[n:]
		return n, nil
	}
	if r.final {
		return 0, io.EOF
	}
	var header [5]byte
	if _, err := io.ReadFull(r.handle, header[:]); err != nil {
		r.err = errContentAuditFile
		return 0, r.err
	}
	size := binary.BigEndian.Uint32(header[1:])
	if header[0] > 1 || size < contentAuditHeaderSize || size > contentAuditOriginalBlock+contentAuditHeaderSize+16 || int64(size)+5 > r.file.Bytes-r.physicalBytes {
		r.err = errContentAuditFile
		return 0, r.err
	}
	encoded := make([]byte, int(size))
	if _, err := io.ReadFull(r.handle, encoded); err != nil {
		r.err = errContentAuditFile
		return 0, r.err
	}
	r.physicalBytes += int64(size) + 5
	identity := "original/" + strconv.Itoa(int(header[0])) + "/" + strconv.FormatUint(r.sequence, 10)
	plain, err := r.store.decode(r.record.StorageID, r.record.AuditID, r.record.Attempt, r.file.ID, identity, encoded, contentAuditOriginalBlock)
	if err != nil {
		r.err = errContentAuditFile
		return 0, r.err
	}
	if header[0] == 1 {
		if len(plain) != 48 || binary.BigEndian.Uint64(plain[:8]) != uint64(r.plainBytes) || binary.BigEndian.Uint64(plain[8:16]) != r.sequence || !bytes.Equal(plain[16:], r.digest.Sum(nil)) || r.plainBytes != r.file.PlainBytes || r.physicalBytes != r.file.Bytes {
			r.err = errContentAuditFile
			return 0, r.err
		}
		var extra [1]byte
		if n, err := r.handle.Read(extra[:]); n != 0 || err != io.EOF {
			r.err = errContentAuditFile
			return 0, r.err
		}
		r.final = true
		return 0, io.EOF
	}
	if len(plain) == 0 || int64(len(plain)) > r.file.PlainBytes-r.plainBytes {
		r.err = errContentAuditFile
		return 0, r.err
	}
	r.sequence++
	r.plainBytes += int64(len(plain))
	_, _ = r.digest.Write(plain)
	n := copy(data, plain)
	r.buffer = plain[n:]
	return n, nil
}

func (s *contentAuditStore) openOriginal(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, file contentAuditOriginalFile) (io.ReadCloser, error) {
	if !model.ValidContentAuditID(file.ID) || file.Bytes < 8 || file.Bytes > model.ContentAuditMaxCapacity || file.PlainBytes < 0 || file.PlainBytes > file.Bytes {
		return nil, errContentAuditFile
	}
	root, err := s.open(state)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	attempts, err := openContentAuditDirectory(root, "attempts")
	if err != nil {
		return nil, errContentAuditStore
	}
	defer attempts.Close()
	name, err := contentAuditAttemptDirectory(record.AuditID, record.Attempt)
	if err != nil {
		return nil, err
	}
	directory, err := openContentAuditDirectory(attempts, name)
	if err != nil {
		return nil, errContentAuditStore
	}
	defer directory.Close()
	info, err := directory.Lstat(file.ID + ".bin")
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() != file.Bytes {
		return nil, errContentAuditFile
	}
	handle, err := directory.Open(file.ID + ".bin")
	if err != nil {
		return nil, errContentAuditFile
	}
	opened, err := handle.Stat()
	var magic [8]byte
	_, readErr := io.ReadFull(handle, magic[:])
	if err != nil || !os.SameFile(info, opened) || readErr != nil || string(magic[:]) != "NACA0002" {
		_ = handle.Close()
		return nil, errContentAuditFile
	}
	return &contentAuditOriginalReader{ctx: ctx, store: s, record: record, file: file, handle: handle, digest: sha256.New(), physicalBytes: 8}, nil
}

func (s *contentAuditStore) verifyAttemptManifest(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, directory *os.Root, closed *contentAuditClosedAttempt, actual, fileCount int64) error {
	if closed.Owner != record.Owner || len(closed.Files) < 1 || len(closed.Files) > 5 || (closed.Version != 0 && closed.Version != 2) {
		return errContentAuditFile
	}
	var knownBytes, knownFiles int64
	for _, file := range closed.Files {
		if _, err := s.read(state, record, file); err != nil {
			return err
		}
		knownBytes += file.Bytes
		knownFiles++
	}
	if closed.Version == 2 {
		if record.FormatVersion != 2 || len(closed.Files) != 1 || closed.Files[0].Kind != "payload" || closed.ImageCount < 0 || len(closed.ImageDigest) != 64 {
			return errContentAuditFile
		}
		digest := sha256.New()
		var count int64
		after := -1
		for {
			rows, err := model.ListContentAuditImages(ctx, record, after, 100)
			if err != nil {
				return err
			}
			for _, row := range rows {
				descriptor, data, err := s.imageDescriptor(ctx, state, record, row)
				if err != nil {
					return err
				}
				_, _ = digest.Write(data)
				knownBytes += row.DescriptorBytes
				knownFiles++
				count++
				after = row.ImageIndex
				if descriptor.Original != nil {
					reader, err := s.openOriginal(ctx, state, record, *descriptor.Original)
					if err != nil {
						return err
					}
					_, readErr := io.CopyBuffer(io.Discard, reader, make([]byte, contentAuditOriginalBlock))
					closeErr := reader.Close()
					if readErr != nil || closeErr != nil {
						return errContentAuditFile
					}
					knownBytes += descriptor.Original.Bytes
					knownFiles++
				}
				if descriptor.Thumbnail != nil {
					if _, err := s.read(state, record, *descriptor.Thumbnail); err != nil {
						return err
					}
					knownBytes += descriptor.Thumbnail.Bytes
					knownFiles++
				}
				if knownBytes > actual || knownFiles >= fileCount {
					return errContentAuditFile
				}
			}
			if len(rows) < 100 {
				break
			}
		}
		if count != closed.ImageCount || hex.EncodeToString(digest.Sum(nil)) != closed.ImageDigest {
			return errContentAuditFile
		}
	} else if record.FormatVersion != 1 {
		return errContentAuditFile
	}
	info, err := directory.Lstat("closed.bin")
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 || info.Size() < 1 {
		return errContentAuditFile
	}
	if knownBytes != closed.FileBytes || knownBytes+info.Size() != actual || knownFiles+1 != fileCount {
		return errContentAuditFile
	}
	return nil
}

func (r *contentAuditRuntime) hasOriginalReaders(id string) bool {
	r.readersMu.Lock()
	defer r.readersMu.Unlock()
	return r.originalReaders[id] > 0
}

func (r *contentAuditRuntime) deferOriginalDeletion(id string) bool {
	r.readersMu.Lock()
	defer r.readersMu.Unlock()
	if r.originalReaders[id] == 0 {
		return false
	}
	if r.originalCleanup == nil {
		r.originalCleanup = make(map[string]bool)
	}
	r.originalCleanup[id] = true
	return true
}

// A public read owns the attempt from before prevalidation until its physical
// handle closes. The registry is small live-request state, not retained images.
type contentAuditOriginalLease struct {
	io.ReadCloser
	runtime *contentAuditRuntime
	auditID string
	once    sync.Once
	err     error
}

func (l *contentAuditOriginalLease) Close() error {
	l.once.Do(func() {
		if l.ReadCloser != nil {
			l.err = l.ReadCloser.Close()
		}
		if l.err != nil {
			return
		} // An unconfirmed close retains the charge.
		l.runtime.readersMu.Lock()
		l.runtime.originalReaders[l.auditID]--
		wake := false
		if l.runtime.originalReaders[l.auditID] == 0 {
			delete(l.runtime.originalReaders, l.auditID)
			wake = l.runtime.originalCleanup[l.auditID]
			delete(l.runtime.originalCleanup, l.auditID)
		}
		l.runtime.readersMu.Unlock()
		if wake {
			l.runtime.wakeMaintenance()
		}
	})
	return l.err
}

func OpenContentAuditOriginal(ctx context.Context, id string, index int) (*ContentAuditOriginal, error) {
	if index < 0 {
		return nil, model.ErrContentAuditInvalid
	}
	runtime := contentAuditEngine
	runtime.ioMu.RLock()
	record, state, store, err := contentAuditReadable(ctx, id)
	if err != nil {
		runtime.ioMu.RUnlock()
		return nil, err
	}
	runtime.readersMu.Lock()
	if runtime.originalReaders == nil {
		runtime.originalReaders = make(map[string]int)
	}
	runtime.originalReaders[id]++
	runtime.readersMu.Unlock()
	runtime.ioMu.RUnlock()
	lease := &contentAuditOriginalLease{runtime: runtime, auditID: id}
	returned := false
	defer func() {
		if !returned {
			_ = lease.Close()
		}
	}()
	if record.FormatVersion != 2 {
		return nil, gorm.ErrRecordNotFound
	}
	var row model.ContentAuditImage
	if err := model.DB.WithContext(ctx).Where("audit_id = ? AND attempt = ? AND image_index = ? AND committed = ?", id, record.Attempt, index, true).First(&row).Error; err != nil {
		return nil, err
	}
	descriptor, _, err := store.imageDescriptor(ctx, state, record, row)
	if err != nil {
		return nil, err
	}
	file := descriptor.Original
	if file == nil || descriptor.View.OriginalStatus != "ready" || (file.MIME != "image/png" && file.MIME != "image/jpeg" && file.MIME != "image/webp") {
		return nil, gorm.ErrRecordNotFound
	}
	reader, err := store.openOriginal(ctx, state, record, *file)
	if err != nil {
		return nil, err
	}
	lease.ReadCloser = reader
	if _, err := io.CopyBuffer(io.Discard, reader, make([]byte, contentAuditOriginalBlock)); err != nil {
		return nil, errContentAuditFile
	}
	if _, _, _, err := contentAuditReadable(ctx, id); err != nil {
		return nil, err
	}
	stream := reader.(*contentAuditOriginalReader)
	if _, err := stream.handle.Seek(8, io.SeekStart); err != nil {
		return nil, errContentAuditFile
	}
	stream.digest, stream.sequence, stream.plainBytes, stream.physicalBytes, stream.buffer, stream.final = sha256.New(), 0, 0, 8, nil, false
	returned = true
	return &ContentAuditOriginal{Reader: lease, MIME: file.MIME, Bytes: file.PlainBytes}, nil
}

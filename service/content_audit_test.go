package service

import (
	"bufio"
	"bytes"
	"context"
	"crypto/cipher"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/shirou/gopsutil/disk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/net/dns/dnsmessage"
	"gorm.io/driver/clickhouse"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

func contentAuditTestDatabase(t *testing.T, db *gorm.DB, dialect common.DatabaseType) {
	t.Helper()
	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
	model.DB, model.LOG_DB = db, db
	common.SetDatabaseTypes(dialect, dialect)
	t.Cleanup(func() { model.DB, model.LOG_DB = oldDB, oldLogDB; common.SetDatabaseTypes(oldMain, oldLog) })
	require.NoError(t, model.MigrateContentAudit(db))
}

func contentAuditTestRuntime(t *testing.T, plaintext ...bool) (*contentAuditRuntime, *contentAuditStore, *model.ContentAuditStorageState) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "audit.db")+"?_pragma=busy_timeout(1000)"), &gorm.Config{Logger: gormlogger.Default.LogMode(gormlogger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { _ = sqlDB.Close() })
	contentAuditTestDatabase(t, db, common.DatabaseTypeSQLite)
	t.Setenv("CRYPTO_SECRET", "content-audit-independent-test-key")
	usePlaintext := len(plaintext) > 0 && plaintext[0]
	if usePlaintext {
		t.Setenv("CRYPTO_SECRET", "")
	}
	t.Setenv("SESSION_SECRET", "")
	directory := t.TempDir()
	require.NoError(t, os.Chmod(directory, 0700))
	t.Setenv("CONTENT_AUDIT_STORAGE_DIR", directory)
	store, err := newContentAuditStore(directory)
	require.NoError(t, err)
	require.NoError(t, store.initialize(usePlaintext))
	require.NoError(t, model.InitializeContentAuditStorage(context.Background(), 1, store.namespace.StorageID, store.namespace.Mode, store.namespace.KeyID, usePlaintext))
	require.NoError(t, db.Model(&model.ContentAuditStorageState{}).Where("id = ?", 1).Updates(map[string]any{"enabled": true, "epoch": 42, "reconciling": false, "pause_reason": "", "healthy_until": time.Now().Unix() + 300}).Error)
	state, err := model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	r := &contentAuditRuntime{processID: contentAuditRandomID(), queue: make(chan *contentAuditJob, 64), maintenanceWake: make(chan struct{}, 1)}
	r.store.Store(store)
	r.snapshot.Store(&contentAuditConfigSnapshot{state: *state, expires: time.Now().Unix() + 300, ready: true})
	previous := contentAuditEngine
	contentAuditEngine = r
	t.Cleanup(func() { contentAuditEngine = previous })
	return r, store, state
}

func contentAuditTestPNG(t *testing.T) []byte {
	t.Helper()
	picture := image.NewNRGBA(image.Rect(0, 0, 8, 4))
	picture.Set(1, 1, color.NRGBA{R: 255, A: 255})
	var data bytes.Buffer
	require.NoError(t, png.Encode(&data, picture))
	return data.Bytes()
}

func contentAuditTestLargePNG(t *testing.T) []byte {
	t.Helper()
	picture := contentAuditTestPNG(t)
	text := bytes.Repeat([]byte{'x'}, 13<<20)
	copy(text, []byte("Comment\x00"))
	var chunk [8]byte
	binary.BigEndian.PutUint32(chunk[:4], uint32(len(text)))
	copy(chunk[4:], "tEXt")
	checksum := crc32.NewIEEE()
	_, _ = checksum.Write(chunk[4:])
	_, _ = checksum.Write(text)
	var crc [4]byte
	binary.BigEndian.PutUint32(crc[:], checksum.Sum32())
	result := make([]byte, 0, len(picture)+len(text)+12)
	result = append(result, picture[:len(picture)-12]...)
	result = append(result, chunk[:]...)
	result = append(result, text...)
	result = append(result, crc[:]...)
	return append(result, picture[len(picture)-12:]...)
}

func TestContentAuditOriginalLargeSixImagesContinuousCapture(t *testing.T) {
	for _, plaintext := range []bool{false, true} {
		t.Run(fmt.Sprint(plaintext), func(t *testing.T) {
			r, _, state := contentAuditTestRuntime(t, plaintext)
			source := contentAuditTestLargePNG(t)
			encoded := base64.StdEncoding.EncodeToString(source)
			images := &contentAuditImages{budget: &r.memory, enabled: true, protocol: "openai_images"}
			response := newContentAuditResponse(64<<10, images)
			record := model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600, Kind: "image", Integrity: "complete"}
			images.session.initial = record
			job := &contentAuditJob{images: images, record: record}
			progress := make(chan struct{}, 1)
			const callback = "test:original_continuous_progress"
			require.NoError(t, model.DB.Callback().Update().After("gorm:update").Register(callback, func(tx *gorm.DB) {
				if tx.Statement.Table == "content_audits" && tx.Error == nil && tx.RowsAffected == 1 {
					select {
					case progress <- struct{}{}:
					default:
					}
				}
			}))
			t.Cleanup(func() { _ = model.DB.Callback().Update().Remove(callback) })
			done := make(chan struct{})
			go func() { r.runJob(context.Background(), job); close(done) }()
			completed := false
			defer func() {
				if !completed {
					_ = response.snapshot()
					close(images.session.done)
					<-done
				}
			}()
			response.write([]byte(`{"data":[`), false)
			for index := range 6 {
				if index > 0 {
					response.write([]byte(","), false)
				}
				response.write([]byte(`{"b64_json":"`), false)
				for offset := 0; offset < len(encoded); offset += 174764 {
					response.write([]byte(encoded[offset:min(offset+174764, len(encoded))]), false)
					if offset+174764 < len(encoded) {
						// Only the fixture waits for durable progress. Production
						// relay Write never waits for its background consumer.
						select {
						case <-progress:
						case <-time.After(5 * time.Second):
							t.Fatal("background writer made no progress")
						}
					}
				}
				response.write([]byte(`"}`), false)
			}
			response.write([]byte("]}"), false)
			job.payload = ContentAuditPayload{Request: []byte("{}"), Response: response.snapshot(), Images: []ContentAuditImageView{}}
			job.record.ResponseObserved = response.observed
			job.record.ResponseTruncated = response.truncated
			close(images.session.done)
			completed = true
			<-done
			require.Greater(t, response.observed, int64(64<<20))
			page, err := ReadContentAuditImagePage(context.Background(), record.AuditID, -1, 20)
			require.NoError(t, err)
			require.Len(t, page.Items, 6)
			want := sha256.Sum256(source)
			for _, view := range page.Items {
				original, err := OpenContentAuditOriginal(context.Background(), record.AuditID, view.Index)
				require.NoError(t, err)
				digest := sha256.New()
				n, err := io.Copy(digest, original.Reader)
				require.NoError(t, err)
				require.NoError(t, original.Reader.Close())
				assert.Equal(t, int64(len(source)), n)
				assert.Equal(t, want[:], digest.Sum(nil))
				assert.Equal(t, "ready", view.OriginalStatus)
				assert.Equal(t, "preview_unavailable", view.Status, "decoder-work allowance must not discard original")
			}
			assert.Zero(t, r.memory.used.Load())
		})
	}
}

func TestContentAuditOriginalSixthImageByteIdentity(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	source := contentAuditTestPNG(t)
	item := fmt.Sprintf(`{"b64_json":%q}`, base64.StdEncoding.EncodeToString(source))
	response := []byte(`{"data":[` + strings.TrimSuffix(strings.Repeat(item+",", 6), ",") + `]}`)
	_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte(`{"prompt":"draw"}`), response, false, false)
	require.NotNil(t, job)
	r.runJob(context.Background(), job)
	original, err := OpenContentAuditOriginal(context.Background(), job.record.AuditID, 5)
	require.NoError(t, err)
	defer original.Reader.Close()
	digest := sha256.New()
	n, err := io.Copy(digest, original.Reader)
	require.NoError(t, err)
	assert.Equal(t, int64(len(source)), n)
	want := sha256.Sum256(source)
	assert.Equal(t, want[:], digest.Sum(nil))
	assert.Equal(t, "image/png", original.MIME)
}

func TestContentAuditCapacityUsesRemainingBytesWithoutRecordGate(t *testing.T) {
	r, _, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	require.NoError(t, model.DB.Model(&model.ContentAuditStorageState{}).Where("id = ?", 1).Updates(map[string]any{"used_bytes": state.CapacityBytes * 96 / 100, "used_records": 100001}).Error)
	record := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
	require.NoError(t, model.ReserveContentAudit(ctx, record))
	current, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.LessOrEqual(t, current.UsedBytes+current.ReservedBytes, current.CapacityBytes)
	assert.Empty(t, current.PauseReason)
}

func TestContentAuditOriginalImagePagesAndCleanup(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	ctx := context.Background()
	item := fmt.Sprintf(`{"b64_json":%q}`, base64.StdEncoding.EncodeToString(contentAuditTestPNG(t)))
	response := []byte(`{"data":[` + strings.TrimSuffix(strings.Repeat(item+",", 6), ",") + `]}`)
	_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte(`{"prompt":"draw"}`), response, false, false)
	require.NotNil(t, job)
	r.runJob(ctx, job)
	page, err := ReadContentAuditImagePage(ctx, job.record.AuditID, -1, 2)
	require.NoError(t, err)
	require.Len(t, page.Items, 2)
	assert.EqualValues(t, 6, page.Total)
	require.NotNil(t, page.NextAfter)
	assert.Equal(t, 1, *page.NextAfter)
	page, err = ReadContentAuditImagePage(ctx, job.record.AuditID, 3, 2)
	require.NoError(t, err)
	require.Len(t, page.Items, 2)
	assert.Equal(t, 5, page.Items[1].Index)
	assert.Nil(t, page.NextAfter)
	require.NoError(t, model.RequestContentAuditDeletion(ctx, []string{job.record.AuditID}))
	require.NoError(t, r.maintain(ctx, false))
	_, err = model.GetContentAudit(ctx, job.record.AuditID)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	var children int64
	require.NoError(t, model.DB.Model(&model.ContentAuditImage{}).Where("audit_id = ?", job.record.AuditID).Count(&children).Error)
	assert.Zero(t, children)
	_, err = os.Stat(filepath.Join(store.directory, "attempts", job.record.AuditID+"-"+job.record.Attempt))
	assert.ErrorIs(t, err, os.ErrNotExist)
	state, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Zero(t, state.UsedBytes)
	assert.Zero(t, state.ReservedBytes)
}

func TestContentAuditOriginalDeletionResumesAfterPhysicalInterruption(t *testing.T) {
	for _, stage := range []string{"first_image", "empty_directory"} {
		for _, unknown := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/unknown=%v", stage, unknown), func(t *testing.T) {
				r, store, _ := contentAuditTestRuntime(t)
				ctx := context.Background()
				source := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
				wire := []byte(fmt.Sprintf("{\"data\":[{\"b64_json\":%q},{\"b64_json\":%q}]}", source, source))
				_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false)
				require.NotNil(t, job)
				r.runJob(ctx, job)
				require.NoError(t, model.RequestContentAuditDeletion(ctx, []string{job.record.AuditID}))
				record, err := model.BeginContentAuditDelete(ctx, job.record.AuditID)
				require.NoError(t, err)
				before, err := model.GetContentAuditState(ctx)
				require.NoError(t, err)
				path := filepath.Join(store.directory, "attempts", record.AuditID+"-"+record.Attempt)
				entries, err := os.ReadDir(path)
				require.NoError(t, err)
				require.Greater(t, len(entries), 3)
				directory, err := os.OpenRoot(path)
				require.NoError(t, err)
				authorization, err := store.prepareAttemptDeletion(ctx, before, record, directory)
				require.NoError(t, err)
				// Execute the same irreversible unit as production, then discard
				// runtime memory before the fresh maintenance retry.
				if stage == "first_image" {
					rows, err := model.ListContentAuditImages(ctx, record, -1, 2)
					require.NoError(t, err)
					require.Len(t, rows, 2)
					require.NoError(t, store.deleteAuthorizedImage(ctx, before, record, directory, rows[0]))
				} else {
					require.NoError(t, store.deleteAuthorizedAttemptContents(ctx, before, record, directory, authorization))
				}
				require.NoError(t, directory.Close())
				remaining, err := os.ReadDir(path)
				require.NoError(t, err)
				require.Less(t, len(remaining), len(entries), "the interruption follows actual file removal")
				if stage == "empty_directory" {
					require.Empty(t, remaining)
				} else {
					require.NotEmpty(t, remaining)
				}
				var children int64
				require.NoError(t, model.DB.Model(&model.ContentAuditImage{}).Where("audit_id = ?", record.AuditID).Count(&children).Error)
				require.EqualValues(t, 2, children)
				charged, err := model.GetContentAuditState(ctx)
				require.NoError(t, err)
				require.Equal(t, before.UsedBytes, charged.UsedBytes)
				unknownPath := filepath.Join(path, "0123456789abcdef0123456789abcdef.bin")
				if unknown {
					require.NoError(t, os.WriteFile(unknownPath, []byte("unreferenced after interruption"), 0600))
				}
				// Upgraded databases have no hints, including for a previously
				// persisted images/metadata authorization. Rebuilding them must
				// neither invalidate that proof nor require missing descriptors.
				require.NoError(t, model.DB.Model(&model.ContentAuditImage{}).Where("audit_id = ?", record.AuditID).
					Updates(map[string]any{"original_lookup": nil, "thumbnail_lookup": nil}).Error)
				freshStore, err := newContentAuditStore(store.directory)
				require.NoError(t, err)
				fresh := &contentAuditRuntime{processID: contentAuditRandomID(), queue: make(chan *contentAuditJob, 64), maintenanceWake: make(chan struct{}, 1)}
				fresh.store.Store(freshStore)
				contentAuditEngine = fresh
				_ = fresh.maintain(ctx, true)
				_, err = model.GetContentAudit(ctx, record.AuditID)
				if unknown {
					require.NoError(t, err)
					data, err := os.ReadFile(unknownPath)
					require.NoError(t, err)
					assert.Equal(t, "unreferenced after interruption", string(data))
					afterEntries, err := os.ReadDir(path)
					require.NoError(t, err)
					assert.Len(t, afterEntries, len(remaining)+1, "quarantine removes no further known file")
					require.NoError(t, model.DB.Model(&model.ContentAuditImage{}).Where("audit_id = ?", record.AuditID).Count(&children).Error)
					assert.EqualValues(t, 2, children)
					after, err := model.GetContentAuditState(ctx)
					require.NoError(t, err)
					assert.GreaterOrEqual(t, after.UsedBytes+after.ReservedBytes, before.UsedBytes)
					return
				}
				require.ErrorIs(t, err, gorm.ErrRecordNotFound, "fresh maintenance must complete authorized partial deletion")
				_, err = os.Stat(path)
				require.ErrorIs(t, err, os.ErrNotExist)
				require.NoError(t, model.DB.Model(&model.ContentAuditImage{}).Where("audit_id = ?", record.AuditID).Count(&children).Error)
				assert.Zero(t, children)
				require.NoError(t, fresh.maintain(ctx, true))
				require.NoError(t, model.FinishContentAuditDelete(ctx, record))
				after, err := model.GetContentAuditState(ctx)
				require.NoError(t, err)
				assert.Zero(t, after.UsedBytes)
				assert.Zero(t, after.UsedRecords)
				assert.Zero(t, after.ReservedBytes)
			})
		}
	}
}

func TestContentAuditOriginalDeletionRequiresDurableAuthorization(t *testing.T) {
	for _, boundary := range []string{"initial_cas", "metadata_cas", "tampered_authorization", "missing_without_authorization"} {
		t.Run(boundary, func(t *testing.T) {
			r, store, _ := contentAuditTestRuntime(t)
			ctx := context.Background()
			source := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
			wire := []byte(fmt.Sprintf("{\"data\":[{\"b64_json\":%q},{\"b64_json\":%q}]}", source, source))
			_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false)
			require.NotNil(t, job)
			r.runJob(ctx, job)
			require.NoError(t, model.RequestContentAuditDeletion(ctx, []string{job.record.AuditID}))
			record, err := model.BeginContentAuditDelete(ctx, job.record.AuditID)
			require.NoError(t, err)
			before, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			path := filepath.Join(store.directory, "attempts", record.AuditID+"-"+record.Attempt)
			directory, err := os.OpenRoot(path)
			require.NoError(t, err)
			defer directory.Close()
			initial, err := os.ReadDir(path)
			require.NoError(t, err)
			rows, err := model.ListContentAuditImages(ctx, record, -1, 2)
			require.NoError(t, err)
			require.Len(t, rows, 2)
			var authorization *contentAuditDeletionAuthorization
			if boundary != "initial_cas" && boundary != "missing_without_authorization" {
				authorization, err = store.prepareAttemptDeletion(ctx, before, record, directory)
				require.NoError(t, err)
			}
			switch boundary {
			case "initial_cas", "metadata_cas":
				const callback = "test:content_audit_deletion_authorization_failure"
				require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register(callback, func(tx *gorm.DB) {
					values, ok := tx.Statement.Dest.(map[string]any)
					if !ok {
						return
					}
					if _, ok := values["deletion_authorization"]; ok {
						tx.AddError(errors.New("authorization commit unavailable"))
					}
				}))
				t.Cleanup(func() { _ = model.DB.Callback().Update().Remove(callback) })
				if boundary == "initial_cas" {
					_, err = store.prepareAttemptDeletion(ctx, before, record, directory)
				} else {
					err = store.deleteAuthorizedAttemptContents(ctx, before, record, directory, authorization)
				}
				require.Error(t, err)
				require.NoError(t, model.DB.Callback().Update().Remove(callback))
				// Both failed commits leave every descriptor available; only a
				// successfully persisted initial proof permits body removal.
				for _, row := range rows {
					_, _, err := store.imageDescriptor(ctx, before, record, row)
					require.NoError(t, err)
				}
				current, err := model.GetContentAudit(ctx, record.AuditID)
				require.NoError(t, err)
				if boundary == "initial_cas" {
					assert.Empty(t, current.DeletionAuthorization)
					actual, err := os.ReadDir(path)
					require.NoError(t, err)
					assert.Equal(t, initial, actual, "no physical remove before durable authorization")
				} else {
					assert.Equal(t, record.DeletionAuthorization, current.DeletionAuthorization)
					actual, err := os.ReadDir(path)
					require.NoError(t, err)
					assert.Less(t, len(actual), len(initial), "image bodies really disappeared before the failed phase commit")
				}
			case "tampered_authorization":
				require.NoError(t, store.deleteAuthorizedImage(ctx, before, record, directory, rows[0]))
				encoded, err := base64.StdEncoding.DecodeString(record.DeletionAuthorization)
				require.NoError(t, err)
				encoded[len(encoded)-1] ^= 1
				require.NoError(t, model.DB.Model(&model.ContentAudit{}).Where("audit_id = ?", record.AuditID).Update("deletion_authorization", base64.StdEncoding.EncodeToString(encoded)).Error)
			case "missing_without_authorization":
				descriptor, _, err := store.imageDescriptor(ctx, before, record, rows[0])
				require.NoError(t, err)
				require.NotNil(t, descriptor.Original)
				require.NoError(t, directory.Remove(descriptor.Original.ID+".bin"))
			}
			var children int64
			require.NoError(t, model.DB.Model(&model.ContentAuditImage{}).Where("audit_id = ?", record.AuditID).Count(&children).Error)
			assert.EqualValues(t, 2, children)
			charged, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			assert.Equal(t, before.UsedBytes, charged.UsedBytes)
			remaining, err := os.ReadDir(path)
			require.NoError(t, err)
			freshStore, err := newContentAuditStore(store.directory)
			require.NoError(t, err)
			err = freshStore.deleteAttempt(ctx, before, record.AuditID, record.Attempt)
			if boundary == "tampered_authorization" || boundary == "missing_without_authorization" {
				require.Error(t, err, "deleting status alone never authorizes missing files")
				actual, err := os.ReadDir(path)
				require.NoError(t, err)
				assert.Equal(t, remaining, actual, "failed authentication removes no further file")
				return
			}
			require.NoError(t, err, "a failed CAS must leave a safely resumable phase")
			require.NoError(t, model.FinishContentAuditDelete(ctx, record))
			after, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			assert.Zero(t, after.UsedBytes)
		})
	}
}

func TestContentAuditDeletionSubsetHasBoundedMultiBatchWork(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(fmt.Sprintf("multibatch_unknown=%v", unknown), func(t *testing.T) {
			r, store, state := contentAuditTestRuntime(t)
			ctx := context.Background()
			images := &contentAuditImages{budget: &r.memory, enabled: true, protocol: "openai_images"}
			response := newContentAuditResponse(64<<10, images)
			record := model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600, Kind: "image", Integrity: "complete"}
			images.session.initial = record
			job := &contentAuditJob{images: images, record: record}
			created := make(chan struct{}, 1)
			const captureCallback = "test:deletion_multibatch_capture"
			require.NoError(t, model.DB.Callback().Create().After("gorm:create").Register(captureCallback, func(tx *gorm.DB) {
				if tx.Statement.Table == "content_audit_images" && tx.Error == nil {
					created <- struct{}{}
				}
			}))
			t.Cleanup(func() { _ = model.DB.Callback().Create().Remove(captureCallback) })
			done := make(chan struct{})
			go func() { r.runJob(ctx, job); close(done) }()
			finished := false
			defer func() {
				if !finished {
					_ = response.snapshot()
					close(images.session.done)
					<-done
				}
			}()
			item := fmt.Sprintf("{\"b64_json\":%q}", base64.StdEncoding.EncodeToString(contentAuditTestPNG(t)))
			response.write([]byte("{\"data\":["), false)
			for index := range 101 {
				if index != 0 {
					response.write([]byte(","), false)
				}
				response.write([]byte(item), false)
				select {
				case <-created:
				case <-time.After(5 * time.Second):
					t.Fatal("fixture image did not reach the actual background store")
				}
			}
			response.write([]byte("]}"), false)
			job.payload = ContentAuditPayload{Request: []byte("{}"), Response: response.snapshot(), Images: []ContentAuditImageView{}}
			close(images.session.done)
			finished = true
			<-done
			require.NoError(t, model.DB.Callback().Create().Remove(captureCallback))
			require.NoError(t, model.RequestContentAuditDeletion(ctx, []string{record.AuditID}))
			deleting, err := model.BeginContentAuditDelete(ctx, record.AuditID)
			require.NoError(t, err)
			path := filepath.Join(store.directory, "attempts", record.AuditID+"-"+record.Attempt)
			directory, err := os.OpenRoot(path)
			require.NoError(t, err)
			defer directory.Close()
			authorization, err := store.prepareAttemptDeletion(ctx, state, deleting, directory)
			require.NoError(t, err)
			names, err := os.ReadDir(path)
			require.NoError(t, err)
			require.Len(t, names, 305, "101 originals, previews and descriptors plus payload/closed")
			if unknown {
				const unknownName = "ffffffffffffffffffffffffffffffff.bin"
				require.NoError(t, os.WriteFile(filepath.Join(path, unknownName), []byte("unknown final batch"), 0600))
				// ReadDir ordering is filesystem-defined. The source traversal
				// must complete every batch before any removal is authorized.
			}
			before, err := os.ReadDir(path)
			require.NoError(t, err)
			var scannedRows int64
			const queryCallback = "test:deletion_multibatch_work"
			require.NoError(t, model.DB.Callback().Query().After("gorm:query").Register(queryCallback, func(tx *gorm.DB) {
				if tx.Statement.Table == "content_audit_images" && tx.Error == nil {
					scannedRows += tx.RowsAffected
				}
			}))
			t.Cleanup(func() { _ = model.DB.Callback().Query().Remove(queryCallback) })
			err = store.verifyDeletionSubset(ctx, state, deleting, directory, authorization)
			require.NoError(t, model.DB.Callback().Query().Remove(queryCallback))
			assert.LessOrEqual(t, scannedRows, int64(404), "one linear hint pass and at most three ownership matches per image, not a full-index rescan per directory batch")
			if unknown {
				require.Error(t, err)
				require.Error(t, store.deleteAttempt(ctx, state, record.AuditID, record.Attempt))
				after, err := os.ReadDir(path)
				require.NoError(t, err)
				assert.Equal(t, before, after, "an unknown in a multi-batch directory is rejected before the first removal")
				return
			}
			require.NoError(t, err)
			require.NoError(t, store.deleteAttempt(ctx, state, record.AuditID, record.Attempt))
			require.NoError(t, model.FinishContentAuditDelete(ctx, deleting))
			_, err = os.Stat(path)
			assert.ErrorIs(t, err, os.ErrNotExist)
			current, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			assert.Zero(t, current.UsedBytes)
		})
	}
}

func TestContentAuditOriginalAfterRetainedEventBudget(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	source := contentAuditTestPNG(t)
	event := "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"text\"}\n\n"
	final := fmt.Sprintf("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"image_generation_call\",\"result\":%q,\"id\":\"late-image\"}]}}\n\n", base64.StdEncoding.EncodeToString(source))
	wire := strings.Repeat(event, 4100) + final
	_, job := contentAuditServeCaptured(t, r, "/v1/responses", "application/json", []byte("{}"), []byte(wire), true, false)
	require.NotNil(t, job)
	r.runJob(context.Background(), job)
	original, err := OpenContentAuditOriginal(context.Background(), job.record.AuditID, 0)
	require.NoError(t, err)
	defer original.Reader.Close()
	actual, err := io.ReadAll(original.Reader)
	require.NoError(t, err)
	assert.Equal(t, source, actual)
	_, payload, err := ReadContentAuditPayload(context.Background(), job.record.AuditID)
	require.NoError(t, err)
	assert.NotContains(t, string(payload.Response), base64.StdEncoding.EncodeToString(source))
}

func TestContentAuditOriginalShutdownDoesNotWaitForActiveProducer(t *testing.T) {
	r, _, state := contentAuditTestRuntime(t)
	images := &contentAuditImages{budget: &r.memory, enabled: true, protocol: "openai_images"}
	response := newContentAuditResponse(1024, images)
	record := model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600, Kind: "image", Integrity: "complete"}
	job := &contentAuditJob{images: images, record: record, charged: 1024}
	job.owners.Store(2)
	images.session.initial = record
	require.True(t, r.memory.acquire(job.charged))
	partial := `{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
	response.write([]byte(partial), false)
	started := make(chan struct{})
	const callback = "test:original_shutdown_admitted"
	require.NoError(t, model.DB.Callback().Create().After("gorm:create").Register(callback, func(tx *gorm.DB) {
		if _, ok := tx.Statement.Dest.(*model.ContentAudit); ok && tx.Error == nil {
			close(started)
		}
	}))
	t.Cleanup(func() { _ = model.DB.Callback().Create().Remove(callback) })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.runJob(ctx, job); close(done) }()
	<-started
	cancel()
	exited := false
	select {
	case <-done:
		exited = true
	case <-time.After(time.Second):
		t.Error("cancelled worker waited for the still-active HTTP producer")
	}
	if exited {
		assert.Positive(t, r.memory.used.Load(), "producer still owns its live text/current block")
	}
	response.write([]byte(`"}]}`), false)
	job.payload = ContentAuditPayload{Request: []byte("{}"), Response: response.snapshot(), Images: []ContentAuditImageView{}}
	close(images.session.done)
	if !exited {
		<-done
	}
	r.release(job)
	assert.Zero(t, r.memory.used.Load())
}

func TestContentAuditOriginalIncrementalLastByteClaim(t *testing.T) {
	r, _, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	records := make([]*model.ContentAudit, 2)
	for i := range records {
		records[i] = &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
		require.NoError(t, model.ReserveContentAudit(ctx, records[i]))
	}
	current, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	require.NoError(t, model.DB.Model(current).Update("used_bytes", current.CapacityBytes-current.ReservedBytes-1).Error)
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, record := range records {
		go func() { <-start; results <- model.GrowContentAuditReservation(ctx, record, 1) }()
	}
	close(start)
	first, second := <-results, <-results
	assert.True(t, (first == nil && errors.Is(second, model.ErrContentAuditCapacity)) || (second == nil && errors.Is(first, model.ErrContentAuditCapacity)))
	current, err = model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Equal(t, current.CapacityBytes, current.UsedBytes+current.ReservedBytes)
	assert.Empty(t, current.PauseReason)
}

func TestContentAuditOriginalChunkRoundTripAndTamper(t *testing.T) {
	for _, plaintext := range []bool{false, true} {
		t.Run(fmt.Sprint(plaintext), func(t *testing.T) {
			r, store, state := contentAuditTestRuntime(t, plaintext)
			ctx := context.Background()
			record := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
			require.NoError(t, model.ReserveContentAudit(ctx, record))
			directory, err := store.beginAttempt(state, record)
			require.NoError(t, err)
			defer directory.Close()
			source := bytes.Repeat([]byte("original-image-source-not-reencoded"), 400000)
			file, err := store.writeOriginal(ctx, record, directory, bytes.NewReader(source))
			require.NoError(t, err)
			reader, err := store.openOriginal(ctx, state, record, file)
			require.NoError(t, err)
			digest := sha256.New()
			n, err := io.Copy(digest, reader)
			require.NoError(t, err)
			require.NoError(t, reader.Close())
			want := sha256.Sum256(source)
			assert.Equal(t, want[:], digest.Sum(nil))
			assert.Equal(t, int64(len(source)), n)
			path := filepath.Join(store.directory, "attempts", record.AuditID+"-"+record.Attempt, file.ID+".bin")
			handle, err := os.OpenFile(path, os.O_RDWR, 0600)
			require.NoError(t, err)
			// Ciphertext is random: writing a fixed 0xff can be a no-op.
			// Flip one actual byte so this fixture always corrupts the frame.
			var before [1]byte
			_, err = handle.ReadAt(before[:], 128)
			require.NoError(t, err)
			tampered := []byte{before[0] ^ 0xff}
			require.NotEqual(t, before[0], tampered[0])
			_, err = handle.WriteAt(tampered, 128)
			require.NoError(t, err)
			require.NoError(t, handle.Close())
			reader, err = store.openOriginal(ctx, state, record, file)
			require.NoError(t, err)
			n, err = io.Copy(io.Discard, reader)
			assert.Error(t, err)
			assert.Zero(t, n, "tampered block must not expose plaintext")
			require.NoError(t, reader.Close())
		})
	}
}

func TestContentAuditOriginalQueueOverflowPreservesCompletedImages(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	source := contentAuditTestPNG(t)
	item := fmt.Sprintf(`{"b64_json":%q}`, base64.StdEncoding.EncodeToString(source))
	wire := []byte(`{"data":[` + strings.TrimSuffix(strings.Repeat(item+",", 22), ",") + `]}`)
	// No worker runs during this deterministic relay fixture: its bounded
	// data channel overflows, but status/body and terminal completion survive.
	_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false)
	require.NotNil(t, job)
	r.runJob(context.Background(), job)
	record, _, err := ReadContentAuditPayload(context.Background(), job.record.AuditID)
	require.NoError(t, err)
	assert.Equal(t, "partial", record.Integrity)
	assert.Equal(t, "resource_busy", record.ErrorCode)
	assert.Positive(t, record.OmittedImages)
	page, err := ReadContentAuditImagePage(context.Background(), record.AuditID, -1, 100)
	require.NoError(t, err)
	require.Positive(t, page.Total)
	require.Less(t, page.Total, int64(22))
	for _, view := range page.Items {
		original, err := OpenContentAuditOriginal(context.Background(), record.AuditID, view.Index)
		require.NoError(t, err)
		actual, err := io.ReadAll(original.Reader)
		require.NoError(t, err)
		require.NoError(t, original.Reader.Close())
		assert.Equal(t, source, actual, "no incomplete original is published")
	}
	assert.Zero(t, r.memory.used.Load())
}

func TestContentAuditOriginalCapacityFailureThenSmallerImage(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	base := model.ContentAuditReservation(state.ContentAuditSettings)
	require.NoError(t, model.DB.Model(state).Update("used_bytes", state.CapacityBytes-base-(64<<10)).Error)
	record := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
	require.NoError(t, model.ReserveContentAudit(ctx, record))
	directory, err := store.beginAttempt(state, record)
	require.NoError(t, err)
	defer directory.Close()
	large, err := newContentAuditOriginalWriter(ctx, store, record, directory)
	require.NoError(t, err)
	_, err = large.Write(make([]byte, contentAuditOriginalBlock))
	require.ErrorIs(t, err, model.ErrContentAuditCapacity)
	require.NoError(t, large.handle.Close())
	large.handle = nil
	before, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Greater(t, before.ReservedBytes, base, "failed physical write remains reserved until removed")
	require.NoError(t, removeContentAuditImageFiles(ctx, directory, record, []string{large.file.ID}, large.charged))
	source := contentAuditTestPNG(t)
	small, err := store.writeOriginal(ctx, record, directory, bytes.NewReader(source))
	require.NoError(t, err)
	reader, err := store.openOriginal(ctx, state, record, small)
	require.NoError(t, err)
	actual, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	assert.Equal(t, source, actual)
	after, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.LessOrEqual(t, after.UsedBytes+after.ReservedBytes, after.CapacityBytes)
	assert.Empty(t, after.PauseReason, "a rejected large write must not pause smaller writes")
}

func TestContentAuditOriginalKeptWhenPreviewHasNoCapacity(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	const callback = "test:original_priority_capacity"
	require.NoError(t, model.DB.Callback().Create().After("gorm:create").Register(callback, func(tx *gorm.DB) {
		if _, ok := tx.Statement.Dest.(*model.ContentAuditImage); ok && tx.Error == nil {
			var state model.ContentAuditStorageState
			if err := tx.Session(&gorm.Session{NewDB: true}).First(&state).Error; err != nil {
				tx.AddError(err)
				return
			}
			tx.AddError(tx.Session(&gorm.Session{NewDB: true}).Model(&state).Update("used_bytes", state.CapacityBytes-state.ReservedBytes).Error)
		}
	}))
	t.Cleanup(func() { _ = model.DB.Callback().Create().Remove(callback) })
	source := contentAuditTestPNG(t)
	wire := []byte(fmt.Sprintf(`{"data":[{"b64_json":%q}]}`, base64.StdEncoding.EncodeToString(source)))
	_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false)
	require.NotNil(t, job)
	r.runJob(context.Background(), job)
	_, payload, err := ReadContentAuditPayload(context.Background(), job.record.AuditID)
	require.NoError(t, err)
	require.Len(t, payload.Images, 1)
	assert.Equal(t, "ready", payload.Images[0].OriginalStatus)
	assert.NotEqual(t, "ready", payload.Images[0].Status)
	original, err := OpenContentAuditOriginal(context.Background(), job.record.AuditID, 0)
	require.NoError(t, err)
	actual, err := io.ReadAll(original.Reader)
	require.NoError(t, err)
	require.NoError(t, original.Reader.Close())
	assert.Equal(t, source, actual)
}

func TestContentAuditOriginalChecksDiskBeforeEveryBlock(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	record := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
	require.NoError(t, model.ReserveContentAudit(ctx, record))
	directory, err := store.beginAttempt(state, record)
	require.NoError(t, err)
	defer directory.Close()
	floor := uint64(max(int64(64<<20), state.CapacityBytes/20))
	free := floor + 1<<20
	store.usage = func(string) (*disk.UsageStat, error) {
		return &disk.UsageStat{Free: free, InodesTotal: 10000, InodesFree: 2000}, nil
	}
	writer, err := newContentAuditOriginalWriter(ctx, store, record, directory)
	require.NoError(t, err)
	defer writer.handle.Close()
	_, err = writer.Write(make([]byte, contentAuditOriginalBlock))
	require.NoError(t, err)
	before, err := writer.handle.Stat()
	require.NoError(t, err)
	reserved := record.ReservedBytes
	free = floor + 1 // Still above the idle threshold; next frame would cross it.
	_, err = writer.Write(make([]byte, contentAuditOriginalBlock))
	assert.ErrorIs(t, err, errContentAuditStore)
	after, err := writer.handle.Stat()
	require.NoError(t, err)
	assert.Equal(t, before.Size(), after.Size(), "no portion of the rejected block reaches disk")
	assert.Equal(t, reserved, record.ReservedBytes, "rejected preflight does not claim more capacity")
}

func TestContentAuditOriginalURLStreaming(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	source := contentAuditTestLargePNG(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		assert.Equal(t, "identity", request.Header.Get("Accept-Encoding"))
		assert.Empty(t, request.Header.Get("Authorization"))
		assert.Empty(t, request.Header.Get("Cookie"))
		w.Header().Set("Content-Type", "image/png")
		if request.URL.Path == "/compressed" {
			w.Header().Set("Content-Encoding", "gzip")
		}
		if request.URL.Path == "/short" {
			w.Header().Set("Content-Length", strconv.Itoa(len(source)+1))
		}
		_, _ = w.Write(source)
	}))
	defer upstream.Close()
	client := newContentAuditImageClient()
	defer client.CloseIdleConnections()
	client.Transport.(*http.Transport).DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		return contentAuditPinnedDial(ctx, network, "80", []netip.Addr{netip.MustParseAddr("8.8.8.8")}, func(ctx context.Context, network, pinned string) (net.Conn, error) {
			assert.Equal(t, "8.8.8.8:80", pinned)
			return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
		})
	}
	ctx := context.Background()
	record := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
	require.NoError(t, model.ReserveContentAudit(ctx, record))
	directory, err := store.beginAttempt(state, record)
	require.NoError(t, err)
	defer directory.Close()
	for _, path := range []string{"/image", "/compressed", "/short", "/cancelled", "/capacity"} {
		t.Run(path, func(t *testing.T) {
			writer, err := newContentAuditOriginalWriter(ctx, store, record, directory)
			require.NoError(t, err)
			downloadCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			if path == "/cancelled" {
				cancel()
			}
			if path == "/capacity" {
				current, err := model.GetContentAuditState(ctx)
				require.NoError(t, err)
				require.NoError(t, model.DB.Model(current).Update("used_bytes", current.CapacityBytes-current.ReservedBytes).Error)
			}
			var mime string
			err = streamContentAuditImage(downloadCtx, client, "http://public.example"+path, writer, &mime)
			if path != "/image" {
				if path == "/capacity" {
					assert.ErrorIs(t, err, model.ErrContentAuditCapacity)
				} else {
					assert.Error(t, err)
				}
				require.NoError(t, writer.handle.Close())
				writer.handle = nil
				require.NoError(t, removeContentAuditImageFiles(ctx, directory, record, []string{writer.file.ID}, writer.charged))
				return
			}
			require.NoError(t, err)
			file, err := writer.finish()
			require.NoError(t, err)
			detected, err := store.validateOriginalImage(ctx, state, record, file, mime)
			require.NoError(t, err)
			assert.Equal(t, "image/png", detected)
			reader, err := store.openOriginal(ctx, state, record, file)
			require.NoError(t, err)
			digest := sha256.New()
			n, err := io.Copy(digest, reader)
			require.NoError(t, err)
			require.NoError(t, reader.Close())
			want := sha256.Sum256(source)
			assert.Equal(t, want[:], digest.Sum(nil))
			assert.Equal(t, int64(len(source)), n)
		})
	}
}

func TestContentAuditOriginalRejectsBrokenFrameSequences(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	record := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
	require.NoError(t, model.ReserveContentAudit(ctx, record))
	directory, err := store.beginAttempt(state, record)
	require.NoError(t, err)
	defer directory.Close()
	file, err := store.writeOriginal(ctx, record, directory, bytes.NewReader(bytes.Repeat([]byte{1}, contentAuditOriginalBlock*3)))
	require.NoError(t, err)
	path := filepath.Join(store.directory, "attempts", record.AuditID+"-"+record.Attempt, file.ID+".bin")
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	end := 8 + 5 + int(binary.BigEndian.Uint32(raw[9:13]))
	secondEnd := end + 5 + int(binary.BigEndian.Uint32(raw[end+1:end+5]))
	final := secondEnd + 5 + int(binary.BigEndian.Uint32(raw[secondEnd+1:secondEnd+5]))
	for _, kind := range []string{"reordered", "duplicate", "missing_final", "extra_tail", "forged_length"} {
		t.Run(kind, func(t *testing.T) {
			broken := bytes.Clone(raw)
			switch kind {
			case "reordered":
				broken = append(bytes.Clone(raw[:8]), raw[end:secondEnd]...)
				broken = append(broken, raw[8:end]...)
				broken = append(broken, raw[secondEnd:]...)
			case "duplicate":
				copy(broken[end:secondEnd], raw[8:end])
			case "missing_final":
				broken = broken[:final]
			case "extra_tail":
				broken = append(broken, 0)
			case "forged_length":
				binary.BigEndian.PutUint32(broken[9:13], math.MaxUint32)
			}
			require.NoError(t, os.WriteFile(path, broken, 0600))
			metadata := file
			metadata.Bytes = int64(len(broken)) // Test frame validation, not only stat-size mismatch.
			reader, err := store.openOriginal(ctx, state, record, metadata)
			require.NoError(t, err)
			_, err = io.Copy(io.Discard, reader)
			assert.Error(t, err)
			require.NoError(t, reader.Close())
		})
	}
}

func TestContentAuditNativeFinalImageReplacesEarlierSuccessfulResult(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	var final bytes.Buffer
	require.NoError(t, png.Encode(&final, image.NewGray(image.Rect(0, 0, 2, 3))))
	early := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
	last := base64.StdEncoding.EncodeToString(final.Bytes())
	response := fmt.Sprintf("event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"image_generation_call\",\"id\":\"image-1\",\"result\":%q}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"image_generation_call\",\"id\":\"image-1\",\"result\":%q}],\"status\":\"completed\"}}\n\n", early, last)
	_, job := contentAuditServeCaptured(t, r, "/v1/responses", "application/json", []byte("{}"), []byte(response), true, false)
	require.NotNil(t, job)
	r.runJob(context.Background(), job)
	page, err := ReadContentAuditImagePage(context.Background(), job.record.AuditID, -1, 100)
	require.NoError(t, err)
	require.EqualValues(t, 1, page.Total)
	assert.Equal(t, 0, page.Items[0].Index)
	original, err := OpenContentAuditOriginal(context.Background(), job.record.AuditID, 0)
	require.NoError(t, err)
	actual, err := io.ReadAll(original.Reader)
	require.NoError(t, err)
	require.NoError(t, original.Reader.Close())
	assert.Equal(t, final.Bytes(), actual, "the final event owns the source ID's successful bytes")
}

func TestContentAuditOriginalLifecycleRecoveryAndQuarantine(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	source := contentAuditTestPNG(t)
	wire := []byte(fmt.Sprintf(`{"data":[{"b64_json":%q}]}`, base64.StdEncoding.EncodeToString(source)))
	_, imageJob := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false)
	require.NotNil(t, imageJob)
	r.runJob(ctx, imageJob)
	_, legacy := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte("{}"), []byte(`{"choices":[{"text":"legacy"}]}`), false, false)
	require.NotNil(t, legacy)
	r.runJob(ctx, legacy)
	pending := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
	require.NoError(t, model.ReserveContentAudit(ctx, pending))
	dir, err := store.beginAttempt(state, pending)
	require.NoError(t, err)
	writer, err := newContentAuditOriginalWriter(ctx, store, pending, dir)
	require.NoError(t, err)
	_, err = writer.Write(make([]byte, contentAuditOriginalBlock))
	require.NoError(t, err)
	require.NoError(t, writer.handle.Close())
	require.NoError(t, dir.Close())
	restarted := &contentAuditRuntime{processID: contentAuditRandomID(), queue: make(chan *contentAuditJob, 64), maintenanceWake: make(chan struct{}, 1)}
	restarted.store.Store(store)
	contentAuditEngine = restarted
	restarted.refreshLocal(ctx)
	require.True(t, restarted.snapshot.Load().ready)
	_, err = model.GetContentAudit(ctx, pending.AuditID)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	_, _, err = ReadContentAuditPayload(ctx, legacy.record.AuditID)
	require.NoError(t, err)
	original, err := OpenContentAuditOriginal(ctx, imageJob.record.AuditID, 0)
	require.NoError(t, err)
	actual, err := io.ReadAll(original.Reader)
	require.NoError(t, err)
	require.NoError(t, original.Reader.Close())
	assert.Equal(t, source, actual)
	before, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	imageRecord, err := model.GetContentAudit(ctx, imageJob.record.AuditID)
	require.NoError(t, err)
	unknown := filepath.Join(store.directory, "attempts", imageRecord.AuditID+"-"+imageRecord.Attempt, "operator-owned.txt")
	require.NoError(t, os.WriteFile(unknown, []byte("retain"), 0600))
	require.NoError(t, model.DB.Model(imageRecord).Update("expires_at", time.Now().Unix()-1).Error)
	_ = cleanupContentAudits(ctx, store)
	after, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, after.UsedBytes+after.ReservedBytes, before.UsedBytes+before.ReservedBytes, "failed deletion never releases uncertain files")
	var children int64
	require.NoError(t, model.DB.Model(&model.ContentAuditImage{}).Where("audit_id = ?", imageRecord.AuditID).Count(&children).Error)
	assert.EqualValues(t, 1, children)
	retained, err := os.ReadFile(unknown)
	require.NoError(t, err)
	assert.Equal(t, "retain", string(retained))
}

func TestContentAuditOriginalGrowthHonorsDisableAndEpoch(t *testing.T) {
	for _, change := range []string{"disable", "epoch"} {
		t.Run(change, func(t *testing.T) {
			r, store, state := contentAuditTestRuntime(t)
			ctx := context.Background()
			record := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
			require.NoError(t, model.ReserveContentAudit(ctx, record))
			dir, err := store.beginAttempt(state, record)
			require.NoError(t, err)
			defer dir.Close()
			writer, err := newContentAuditOriginalWriter(ctx, store, record, dir)
			require.NoError(t, err)
			defer writer.handle.Close()
			reserved := record.ReservedBytes
			if change == "disable" {
				require.NoError(t, model.DB.Model(state).Update("enabled", false).Error)
			} else {
				require.NoError(t, model.DB.Model(state).Update("epoch", state.Epoch+1).Error)
			}
			_, err = writer.Write(make([]byte, contentAuditOriginalBlock))
			assert.ErrorIs(t, err, model.ErrContentAuditDisabled)
			info, err := writer.handle.Stat()
			require.NoError(t, err)
			assert.EqualValues(t, 8, info.Size())
			assert.Equal(t, reserved, record.ReservedBytes)
		})
	}
}

func TestContentAuditOriginalFinalizationHasNoWholeBatchDeadline(t *testing.T) {
	for _, stale := range []string{"health", "lease"} {
		t.Run(stale, func(t *testing.T) {
			r, _, state := contentAuditTestRuntime(t)
			require.NoError(t, model.DB.Model(state).Update("thumbnail_enabled", false).Error)
			r.refreshLocal(context.Background())
			const callback = "test:original_stale_finalization"
			require.NoError(t, model.DB.Callback().Create().After("gorm:create").Register(callback, func(tx *gorm.DB) {
				if row, ok := tx.Statement.Dest.(*model.ContentAuditImage); ok && tx.Error == nil {
					db := tx.Session(&gorm.Session{NewDB: true})
					if stale == "lease" {
						tx.AddError(db.Model(&model.ContentAudit{}).Where("audit_id = ?", row.AuditID).Update("lease_until", time.Now().Unix()-1).Error)
					} else {
						tx.AddError(db.Model(&model.ContentAuditStorageState{}).Where("id = ?", 1).Update("healthy_until", time.Now().Unix()-1).Error)
					}
				}
			}))
			t.Cleanup(func() { _ = model.DB.Callback().Create().Remove(callback) })
			source := contentAuditTestPNG(t)
			wire := []byte(fmt.Sprintf("{\"data\":[{\"b64_json\":%q}]}", base64.StdEncoding.EncodeToString(source)))
			_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false)
			require.NotNil(t, job)
			r.runJob(context.Background(), job)
			original, err := OpenContentAuditOriginal(context.Background(), job.record.AuditID, 0)
			require.NoError(t, err, "successful local finalization renews stale liveness after revalidation")
			actual, err := io.ReadAll(original.Reader)
			require.NoError(t, err)
			require.NoError(t, original.Reader.Close())
			assert.Equal(t, source, actual)
		})
	}
}

// Small controlled network fixtures retain bytes only in the test, not the
// production download path. Large-original accounting uses the real writer.
func downloadContentAuditImage(ctx context.Context, client *http.Client, raw string) ([]byte, string, error) {
	var data bytes.Buffer
	var mime string
	err := streamContentAuditImage(ctx, client, raw, &data, &mime)
	if err != nil {
		return nil, "", errContentAuditImage
	}
	return data.Bytes(), mime, nil
}

type contentAuditBlockingAEAD struct {
	cipher.AEAD
	entered chan struct{}
	resume  chan struct{}
	once    sync.Once
}

func (a *contentAuditBlockingAEAD) Open(dst, nonce, ciphertext, additional []byte) ([]byte, error) {
	if strings.Contains(string(additional), "/original/0/0/") {
		a.once.Do(func() { close(a.entered); <-a.resume })
	}
	return a.AEAD.Open(dst, nonce, ciphertext, additional)
}

func TestContentAuditOriginalReadLifetimeRetainsCharge(t *testing.T) {
	for _, phase := range []string{"returned_reader", "cancelled_prevalidation"} {
		t.Run(phase, func(t *testing.T) {
			r, store, _ := contentAuditTestRuntime(t)
			ctx := context.Background()
			source := contentAuditTestPNG(t)
			wire := []byte(fmt.Sprintf("{\"data\":[{\"b64_json\":%q}]}", base64.StdEncoding.EncodeToString(source)))
			_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false)
			require.NotNil(t, job)
			r.runJob(ctx, job)
			record, err := model.GetContentAudit(ctx, job.record.AuditID)
			require.NoError(t, err)
			before, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			var original *ContentAuditOriginal
			var gate *contentAuditBlockingAEAD
			var cancelled context.CancelFunc
			var result chan error
			if phase == "returned_reader" {
				original, err = OpenContentAuditOriginal(ctx, record.AuditID, 0)
				require.NoError(t, err)
				defer original.Reader.Close()
			} else {
				gate = &contentAuditBlockingAEAD{AEAD: store.aead, entered: make(chan struct{}), resume: make(chan struct{})}
				store.aead = gate
				var validating context.Context
				validating, cancelled = context.WithCancel(ctx)
				defer cancelled()
				result = make(chan error, 1)
				go func() {
					value, err := OpenContentAuditOriginal(validating, record.AuditID, 0)
					if value != nil {
						_ = value.Reader.Close()
					}
					result <- err
				}()
				<-gate.entered
			}
			require.NoError(t, model.DB.Model(record).Update("expires_at", time.Now().Unix()-1).Error)
			require.NoError(t, r.maintain(ctx, false))
			retained, err := model.GetContentAudit(ctx, record.AuditID)
			assert.NoError(t, err, "physical charge remains while a public original handle is retained")
			if err == nil {
				assert.Equal(t, record.FileBytes, retained.FileBytes)
			}
			during, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			assert.Equal(t, before.UsedBytes+before.ReservedBytes, during.UsedBytes+during.ReservedBytes)
			if original != nil {
				_, err = OpenContentAuditOriginal(ctx, record.AuditID, 0)
				assert.Error(t, err, "expiry denies new reader acquisition")
				require.NoError(t, original.Reader.Close())
			} else {
				cancelled()
				close(gate.resume)
				assert.Error(t, <-result)
			}
			require.NoError(t, r.maintain(ctx, false))
			_, err = model.GetContentAudit(ctx, record.AuditID)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			after, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			assert.Equal(t, before.UsedBytes-record.FileBytes, after.UsedBytes)
			assert.Zero(t, after.ReservedBytes)
			require.NoError(t, r.maintain(ctx, false))
			final, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			assert.Equal(t, after.UsedBytes, final.UsedBytes, "repeated cleanup cannot release twice")
		})
	}
}

func TestContentAuditOriginalOverflowRetainsCompletedSSEGroup(t *testing.T) {
	for _, valid := range []bool{true, false} {
		t.Run(fmt.Sprint(valid), func(t *testing.T) {
			r, _, _ := contentAuditTestRuntime(t)
			small := contentAuditTestPNG(t)
			chunk := make([]byte, (140<<10)+12)
			binary.BigEndian.PutUint32(chunk[:4], 140<<10)
			copy(chunk[4:8], "tEXt")
			binary.BigEndian.PutUint32(chunk[len(chunk)-4:], crc32.ChecksumIEEE(chunk[4:len(chunk)-4]))
			large := append(bytes.Clone(small[:len(small)-12]), chunk...)
			large = append(large, small[len(small)-12:]...)
			var wire strings.Builder
			for index := range 17 {
				source := small
				if index == 15 {
					source = large
				}
				event := fmt.Sprintf("{\"type\":\"response.output_item.done\",\"item\":{\"type\":\"image_generation_call\",\"id\":\"image-%d\",\"result\":%q}}", index, base64.StdEncoding.EncodeToString(source))
				if index == 15 && !valid {
					event += " invalid"
				}
				fmt.Fprintf(&wire, "event: response.output_item.done\ndata: %s\n\n", event)
			}
			// Fifteen 4-event groups occupy 60 slots. The next larger original
			// has begin + two data blocks + end, filling slot 64 with its end.
			// Its group verdict overflows, and a later ignored group follows.
			relay, job := contentAuditServeCaptured(t, r, "/v1/responses", "application/json", []byte("{}"), []byte(wire.String()), true, false)
			require.NotNil(t, job)
			assert.Equal(t, wire.String(), relay.Body.String())
			r.runJob(context.Background(), job)
			record, _, err := ReadContentAuditPayload(context.Background(), job.record.AuditID)
			require.NoError(t, err)
			assert.Equal(t, "partial", record.Integrity)
			assert.Equal(t, "resource_busy", record.ErrorCode)
			original, err := OpenContentAuditOriginal(context.Background(), record.AuditID, 15)
			if !valid {
				assert.Error(t, err, "a complete image in an invalid JSON event is not published")
			} else {
				require.NoError(t, err, "later ignored SSE events cannot replace the overflowed group's verdict")
				actual, err := io.ReadAll(original.Reader)
				require.NoError(t, err)
				require.NoError(t, original.Reader.Close())
				assert.Equal(t, large, actual)
			}
			_, err = OpenContentAuditOriginal(context.Background(), record.AuditID, 16)
			assert.Error(t, err, "the unqueued later candidate is never ready")
			assert.Zero(t, r.memory.used.Load())
		})
	}
}

func TestContentAuditOriginalSingleOverflowCountsOmission(t *testing.T) {
	for _, failure := range []string{"data_queue", "next_block_memory"} {
		t.Run(failure, func(t *testing.T) {
			r, _, _ := contentAuditTestRuntime(t)
			source := contentAuditTestLargePNG(t)
			wire := []byte(fmt.Sprintf("{\"data\":[{\"b64_json\":%q}]}", base64.StdEncoding.EncodeToString(source)))
			var fixtureCharge int64
			relay, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false, func(*gin.Context) {
				if failure == "next_block_memory" {
					// Capture already owns its snapshot allocation. Leave exactly
					// one decoded block, so acquiring its successor fails.
					fixtureCharge = contentAuditMemoryLimit - r.memory.used.Load() - contentAuditOriginalBlock
					require.True(t, r.memory.acquire(fixtureCharge))
				}
			})
			if fixtureCharge > 0 {
				r.memory.release(fixtureCharge)
			}
			require.NotNil(t, job)
			assert.Equal(t, wire, relay.Body.Bytes())
			r.runJob(context.Background(), job)
			record, _, err := ReadContentAuditPayload(context.Background(), job.record.AuditID)
			require.NoError(t, err)
			assert.Equal(t, "partial", record.Integrity)
			assert.Equal(t, "resource_busy", record.ErrorCode)
			assert.Equal(t, 1, record.OmittedImages, "one aborted candidate is counted once even without a later candidate")
			page, err := ReadContentAuditImagePage(context.Background(), record.AuditID, -1, 20)
			require.NoError(t, err)
			assert.Zero(t, page.Total, "an incomplete original is never ready")
			assert.Zero(t, r.memory.used.Load())
		})
	}
}

func TestContentAuditConcurrentPhysicalHeadroom(t *testing.T) {
	for _, other := range []string{"frame", "bounded_file", "header"} {
		t.Run(other, func(t *testing.T) {
			r, store, state := contentAuditTestRuntime(t)
			ctx := context.Background()
			first := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
			second := &model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600}
			require.NoError(t, model.ReserveContentAudit(ctx, first))
			require.NoError(t, model.ReserveContentAudit(ctx, second))
			firstDir, err := store.beginAttempt(state, first)
			require.NoError(t, err)
			defer firstDir.Close()
			secondDir, err := store.beginAttempt(state, second)
			require.NoError(t, err)
			defer secondDir.Close()
			writer, err := newContentAuditOriginalWriter(ctx, store, first, firstDir)
			require.NoError(t, err)
			defer writer.handle.Close()
			var otherWriter *contentAuditOriginalWriter
			if other == "frame" {
				otherWriter, err = newContentAuditOriginalWriter(ctx, store, second, secondDir)
				require.NoError(t, err)
				defer otherWriter.handle.Close()
			}
			paths := []string{filepath.Join(store.directory, "attempts", first.AuditID+"-"+first.Attempt), filepath.Join(store.directory, "attempts", second.AuditID+"-"+second.Attempt)}
			physicalBytes := func() (int64, error) {
				var total int64
				for _, path := range paths {
					entries, err := os.ReadDir(path)
					if err != nil {
						return 0, err
					}
					for _, entry := range entries {
						info, err := entry.Info()
						if err != nil {
							return 0, err
						}
						total += info.Size()
					}
				}
				return total, nil
			}
			base, err := physicalBytes()
			require.NoError(t, err)
			block := make([]byte, contentAuditOriginalBlock)
			encoded, err := store.envelope(first.StorageID, first.AuditID, first.Attempt, writer.file.ID, "original/0/0", block, false)
			require.NoError(t, err)
			headroom := int64(5 + len(encoded))
			floor := max(int64(64<<20), state.CapacityBytes/20)
			var checks atomic.Int32
			secondSnapshot := make(chan struct{}, 1)
			store.usage = func(string) (*disk.UsageStat, error) {
				written, err := physicalBytes()
				if err != nil {
					return nil, err
				}
				free := uint64(floor + headroom - (written - base))
				if checks.Add(1) == 2 {
					secondSnapshot <- struct{}{}
				}
				return &disk.UsageStat{Free: free, InodesTotal: 10000, InodesFree: 2000}, nil
			}
			paused, resume := make(chan struct{}), make(chan struct{})
			var pauseOnce, resumeOnce sync.Once
			defer resumeOnce.Do(func() { close(resume) })
			const callback = "test:physical_headroom_first_claim"
			require.NoError(t, model.DB.Callback().Update().After("gorm:update").Register(callback, func(tx *gorm.DB) {
				if tx.Statement.Table == "content_audits" {
					pauseOnce.Do(func() { close(paused); <-resume })
				}
			}))
			t.Cleanup(func() { _ = model.DB.Callback().Update().Remove(callback) })
			firstResult, secondResult := make(chan error, 1), make(chan error, 1)
			firstClaim, secondClaim := first.ReservedBytes, second.ReservedBytes
			go func() { _, err := writer.Write(block); firstResult <- err }()
			waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			select {
			case <-paused:
			case <-waitCtx.Done():
				t.Fatal("first writer did not reach its reserved but unwritten frame")
			}
			// Only fixture scheduling uses TryLock: if the production boundary
			// is absent, force both free-space snapshots before either frame.
			unprotected := store.physicalMu.TryLock()
			if unprotected {
				store.physicalMu.Unlock()
			}
			remaining := second.ReservedBytes
			go func() {
				var err error
				switch other {
				case "frame":
					_, err = otherWriter.Write(block)
				case "bounded_file":
					_, err = store.write(ctx, secondDir, second.StorageID, second.AuditID, second.Attempt, contentAuditRandomID(), "payload", block, false, &remaining)
				case "header":
					var value *contentAuditOriginalWriter
					value, err = newContentAuditOriginalWriter(ctx, store, second, secondDir)
					if value != nil && value.handle != nil {
						_ = value.handle.Close()
					}
				}
				secondResult <- err
			}()
			if unprotected {
				select {
				case <-secondSnapshot:
				case <-waitCtx.Done():
					t.Fatal("second writer did not take its concurrent headroom snapshot")
				}
			}
			resumeOnce.Do(func() { close(resume) })
			require.NoError(t, <-firstResult)
			assert.ErrorIs(t, <-secondResult, errContentAuditStore)
			written, err := physicalBytes()
			require.NoError(t, err)
			assert.LessOrEqual(t, written-base, headroom, "internal writers cannot spend the same physical headroom twice")
			assert.Equal(t, secondClaim, second.ReservedBytes, "rejected physical write must not add a capacity claim")
			if other == "bounded_file" {
				assert.Equal(t, secondClaim, remaining, "preflight rejection leaves its reserved allowance untouched")
			}
			current, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			assert.Equal(t, firstClaim+secondClaim+headroom, current.ReservedBytes)
		})
	}
}

func TestContentAuditReadyOriginalQuarantinesUnreferencedFile(t *testing.T) {
	for _, extension := range []string{".bin", ".tmp"} {
		t.Run(extension, func(t *testing.T) {
			r, store, _ := contentAuditTestRuntime(t)
			ctx := context.Background()
			source := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
			wire := []byte(fmt.Sprintf("{\"data\":[{\"b64_json\":%q},{\"b64_json\":%q}]}", source, source))
			_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte("{}"), wire, false, false)
			require.NotNil(t, job)
			r.runJob(ctx, job)
			record, err := model.GetContentAudit(ctx, job.record.AuditID)
			require.NoError(t, err)
			before, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			path := filepath.Join(store.directory, "attempts", record.AuditID+"-"+record.Attempt)
			unknown := filepath.Join(path, "0123456789abcdef0123456789abcdef"+extension)
			_, err = os.Stat(unknown)
			require.ErrorIs(t, err, os.ErrNotExist)
			require.NoError(t, os.WriteFile(unknown, []byte("unreferenced operator bytes"), 0600))
			entries, err := os.ReadDir(path)
			require.NoError(t, err)
			beforeNames := make([]string, 0, len(entries))
			for _, entry := range entries {
				beforeNames = append(beforeNames, entry.Name())
			}
			require.NoError(t, RequestContentAuditDeletion(ctx, ContentAuditDeleteRequest{IDs: []string{record.AuditID}}))
			_ = r.maintain(ctx, false)
			retained, err := os.ReadFile(unknown)
			assert.NoError(t, err, "UUID shape is not authenticated manifest membership")
			assert.Equal(t, "unreferenced operator bytes", string(retained))
			entries, err = os.ReadDir(path)
			assert.NoError(t, err)
			afterNames := make([]string, 0, len(entries))
			for _, entry := range entries {
				afterNames = append(afterNames, entry.Name())
			}
			assert.Equal(t, beforeNames, afterNames, "strict preflight removes no known or unknown entry")
			_, err = model.GetContentAudit(ctx, record.AuditID)
			assert.NoError(t, err)
			var children int64
			require.NoError(t, model.DB.Model(&model.ContentAuditImage{}).Where("audit_id = ?", record.AuditID).Count(&children).Error)
			assert.EqualValues(t, 2, children)
			after, err := model.GetContentAuditState(ctx)
			require.NoError(t, err)
			assert.GreaterOrEqual(t, after.UsedBytes+after.ReservedBytes, before.UsedBytes+before.ReservedBytes, "uncertain physical bytes cannot release the original charge")
			assert.NotEmpty(t, after.PauseReason)
		})
	}
}

func contentAuditServeCaptured(t *testing.T, r *contentAuditRuntime, path, contentType string, request, response []byte, stream, disk bool, configure ...func(*gin.Context)) (*httptest.ResponseRecorder, *contentAuditJob) {
	t.Helper()
	previous := common.GetDiskCacheConfig()
	common.SetDiskCacheConfig(common.DiskCacheConfig{Enabled: disk, ThresholdMB: 0, MaxSizeMB: 128, Path: t.TempDir()})
	defer common.SetDiskCacheConfig(previous)
	storage, err := common.CreateBodyStorage(request)
	require.NoError(t, err)
	assert.Equal(t, disk, storage.IsDisk())
	_, err = storage.Seek(3, io.SeekStart)
	require.NoError(t, err)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(common.KeyBodyStorage, storage)
		c.Set("id", 7)
		c.Set("username", "audit-user")
		c.Set("channel_id", 1)
		c.Set("channel_name", "first")
		c.Set("original_model", "model-a")
		c.Set("group", "default")
		c.Set(common.RequestIdKey, "logical-request")
		common.SetContextKey(c, constant.ContextKeyRequestStartTime, time.Now())
		defer common.CleanupBodyStorage(c)
		c.Next()
	})
	router.Use(CaptureContentAudit)
	router.POST(path, func(c *gin.Context) {
		position, err := storage.Seek(0, io.SeekCurrent)
		require.NoError(t, err)
		assert.EqualValues(t, 3, position, "audit reader must not move the business cursor")
		reader, err := storage.NewReader()
		require.NoError(t, err)
		actual, err := io.ReadAll(reader)
		require.NoError(t, err)
		require.NoError(t, reader.Close())
		assert.Equal(t, request, actual)
		c.Set("channel_id", 9)
		c.Set("channel_name", "final-channel")
		c.Set("use_channel", []string{"1", "9"})
		c.Set(common.UpstreamRequestIdKey, "upstream-final")
		for _, apply := range configure {
			apply(c)
		}
		if stream {
			c.Header("Content-Type", "text/event-stream")
		} else {
			c.Header("Content-Type", "application/json")
		}
		c.Status(http.StatusOK)
		// Both writer APIs and arbitrary token/event boundaries must preserve
		// exactly the original bytes and flush immediately to the client.
		middle := len(response) / 2
		n, err := c.Writer.Write(response[:middle])
		require.NoError(t, err)
		assert.Equal(t, middle, n)
		c.Writer.Flush()
		n, err = c.Writer.WriteString(string(response[middle:]))
		require.NoError(t, err)
		assert.Equal(t, len(response)-middle, n)
	})
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(request))
	req.Header.Set("Content-Type", contentType)
	router.ServeHTTP(recorder, req)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, response, recorder.Body.Bytes())
	assert.True(t, recorder.Flushed)
	_, err = storage.NewReader()
	require.ErrorIs(t, err, common.ErrStorageClosed)
	select {
	case job := <-r.queue:
		return recorder, job
	default:
		return recorder, nil
	}
}

func TestContentAuditCaptureProtocolsAndBodyOwnership(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	imageResult := fmt.Sprintf(`{"data":[{"b64_json":%q,"revised_prompt":"safe image"}]}`, base64.StdEncoding.EncodeToString(contentAuditTestPNG(t)))
	var multipartBody bytes.Buffer
	form := multipart.NewWriter(&multipartBody)
	require.NoError(t, form.WriteField("prompt", "edit this picture"))
	require.NoError(t, form.WriteField("password", "multipart-secret"))
	part, err := form.CreateFormFile("image", "private-input.png")
	require.NoError(t, err)
	_, err = part.Write([]byte("original-file-never-at-rest"))
	require.NoError(t, err)
	require.NoError(t, form.Close())
	cases := []struct {
		name, path, request, response, contains string
		stream, multipart                       bool
	}{
		{"chat", "/v1/chat/completions", `{"model":"m","messages":[{"role":"user","content":"hello 世界"}],"Authorization":"request-secret"}`, `{"choices":[{"message":{"content":"hello 世界","tool_calls":[{"function":{"name":"lookup","arguments":"{\"token\":\"tool-secret\",\"n\":0}"}}]},"finish_reason":"tool_calls"}]}`, "lookup", false, false},
		{"completion", "/v1/completions", `{"prompt":"hello"}`, `{"choices":[{"text":"answer","finish_reason":"stop"}]}`, "answer", false, false},
		{"responses", "/v1/responses", `{"input":"hello"}`, `{"output":[{"type":"function_call","name":"lookup","arguments":"{\"secret\":\"tool-secret\",\"n\":0}"}],"status":"completed"}`, "lookup", false, false},
		{"compact", "/v1/responses/compact", `{"input":[],"instructions":"summarize"}`, `{"output":[{"type":"message","content":[{"type":"output_text","text":"summary"}]}]}`, "summary", false, false},
		{"claude", "/v1/messages", `{"messages":[{"role":"user","content":"hi"}]}`, `{"content":[{"type":"tool_use","id":"call-1","name":"lookup","input":{"api-key":"tool-secret","n":0}}],"stop_reason":"tool_use"}`, "lookup", false, false},
		{"gemini", "/v1beta/models/gemini:generateContent", `{"contents":[{"parts":[{"text":"hi"},{"inlineData":{"mimeType":"image/png","data":"original-base64"}}]}]}`, `{"candidates":[{"content":{"parts":[{"text":"answer"},{"functionCall":{"name":"lookup","args":{"TOKEN":"tool-secret"}}}]},"finishReason":"STOP"}]}`, "lookup", false, false},
		{"gemini-stream", "/v1beta/models/gemini:streamGenerateContent", `{"contents":[]}`, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"answer\"}]},\"finishReason\":\"STOP\"}]}\n\n", "answer", true, false},
		{"chat-stream", "/pg/chat/completions", `{"messages":[]}`, "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"se\"}}]}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"cret\\\":\\\"tool-secret\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n", "lookup", true, false},
		{"claude-stream", "/v1/messages", `{"messages":[]}`, "event: content_block_delta\ndata: {\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"password\\\":\\\"tool-secret\\\"}\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", "input_json_delta", true, false},
		{"responses-stream", "/v1/responses", `{"input":"hi"}`, "event: response.function_call_arguments.delta\ndata: {\"item_id\":\"call-1\",\"delta\":\"{\\\"token\\\":\\\"tool-secret\\\"}\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\"}\n\n", "function_call_arguments", true, false},
		{"images", "/v1/images/generations", `{"prompt":"draw","n":1}`, imageResult, "safe image", false, false},
		{"playground-images", "/pg/images/generations", `{"prompt":"draw","n":1}`, imageResult, "safe image", false, false},
		{"edit", "/v1/images/edits", multipartBody.String(), imageResult, "edit this picture", false, true},
		{"playground-edit", "/pg/images/edits", multipartBody.String(), imageResult, "edit this picture", false, true},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			contentType := "application/json"
			if tc.multipart {
				contentType = form.FormDataContentType()
			}
			_, job := contentAuditServeCaptured(t, r, tc.path, contentType, []byte(tc.request), []byte(tc.response), tc.stream, i%2 == 1)
			require.NotNil(t, job)
			id := job.record.AuditID
			assert.Equal(t, 7, job.record.UserID)
			assert.Equal(t, 9, job.record.ChannelID)
			assert.Equal(t, 1, job.record.RetryCount)
			assert.Equal(t, "logical-request", job.record.RequestID)
			assert.Equal(t, "upstream-final", job.record.UpstreamRequestID)
			assert.False(t, job.record.RequestTruncated)
			assert.False(t, job.record.ResponseTruncated)
			r.runJob(context.Background(), job)
			record, payload, err := ReadContentAuditPayload(context.Background(), id)
			require.NoError(t, err)
			assert.Equal(t, model.ContentAuditReady, record.Status)
			encoded, err := common.Marshal(payload)
			require.NoError(t, err)
			assert.Contains(t, string(encoded), tc.contains)
			for _, secret := range []string{"request-secret", "tool-secret", "multipart-secret", "original-file-never-at-rest", "original-base64"} {
				assert.NotContains(t, string(encoded), secret)
			}
			if record.Kind == "image" {
				require.Len(t, payload.Images, 1)
				assert.Equal(t, "ready", payload.Images[0].Status)
				thumbnail, err := ReadContentAuditThumbnail(context.Background(), id, 0)
				require.NoError(t, err)
				assert.LessOrEqual(t, len(thumbnail), contentAuditMaxThumbnailBytes)
				config, format, err := image.DecodeConfig(bytes.NewReader(thumbnail))
				require.NoError(t, err)
				assert.Equal(t, "jpeg", format)
				assert.LessOrEqual(t, max(config.Width, config.Height), 1024)
			}
			assert.Zero(t, r.memory.used.Load())
			assert.Zero(t, r.active.Load())
			path := filepath.Join(store.directory, "attempts", id+"-"+record.Attempt)
			entries, err := os.ReadDir(path)
			require.NoError(t, err)
			for _, entry := range entries {
				data, err := os.ReadFile(filepath.Join(path, entry.Name()))
				require.NoError(t, err)
				if string(data[:8]) == "NACA0001" {
					assert.Equal(t, byte(1), data[8])
				} else {
					original, err := OpenContentAuditOriginal(context.Background(), id, 0)
					require.NoError(t, err)
					digest := sha256.New()
					_, err = io.Copy(digest, original.Reader)
					require.NoError(t, err)
					require.NoError(t, original.Reader.Close())
					want := sha256.Sum256(contentAuditTestPNG(t))
					assert.Equal(t, want[:], digest.Sum(nil))
					assert.NotContains(t, string(data), string(contentAuditTestPNG(t)))
				}
				assert.NotContains(t, string(data), tc.contains)
			}
		})
	}
}

func TestContentAuditNativeGeneratedImagesAreReadableWithoutChangingRelay(t *testing.T) {
	picture := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
	// Put the discriminator after the bytes: JSON field order is not a contract.
	item := fmt.Sprintf(`{"id":"image-final","result":%q,"type":"image_generation_call","status":"completed"}`, picture)
	gemini := fmt.Sprintf(`{"candidates":[{"content":{"parts":[{"text":"drawn reply"},{"inlineData":{"data":%q,"mimeType":"image/png"}}]},"finishReason":"STOP"}]}`, picture)
	for _, tc := range []struct {
		name, path, request, response string
		stream                        bool
	}{
		{"responses-json", "/v1/responses", `{"input":"draw a fox"}`, `{"output":[{"type":"message","content":[{"type":"output_text","text":"drawn reply"}]},` + item + `],"status":"completed"}`, false},
		{"responses-stream", "/v1/responses", `{"input":"draw a fox"}`, "event: response.image_generation_call.partial_image\ndata: {\"type\":\"response.image_generation_call.partial_image\",\"partial_image_b64\":\"partial-image-never-in-text\"}\n\nevent: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":" + item + "}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[" + item + "],\"status\":\"completed\"}}\n\n", true},
		{"gemini-json", "/v1beta/models/gemini:generateContent", `{"contents":[{"parts":[{"text":"draw a fox"},{"inlineData":{"mimeType":"image/png","data":"private-input-image"}}]}]}`, gemini, false},
		{"gemini-stream", "/v1beta/models/gemini:streamGenerateContent", `{"contents":[{"parts":[{"text":"draw a fox"}]}]}`, "data: " + strings.ReplaceAll(strings.ReplaceAll(gemini, "inlineData", "inline_data"), "mimeType", "mime_type") + "\n\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, _ := contentAuditTestRuntime(t)
			_, job := contentAuditServeCaptured(t, r, tc.path, "application/json", []byte(tc.request), []byte(tc.response), tc.stream, true)
			require.NotNil(t, job)
			id := job.record.AuditID
			r.runJob(context.Background(), job)
			record, payload, err := ReadContentAuditPayload(context.Background(), id)
			require.NoError(t, err)
			assert.Equal(t, "image", record.Kind)
			assert.Equal(t, "complete", record.Integrity)
			require.Len(t, payload.Images, 1, "a completed Responses image repeated in the terminal event is one preview")
			assert.Equal(t, "ready", payload.Images[0].Status)
			thumbnail, err := ReadContentAuditThumbnail(context.Background(), id, 0)
			require.NoError(t, err)
			decoded, format, err := image.Decode(bytes.NewReader(thumbnail))
			require.NoError(t, err)
			assert.Equal(t, "jpeg", format)
			assert.Equal(t, image.Rect(0, 0, 8, 4), decoded.Bounds())
			encoded, err := common.Marshal(payload)
			require.NoError(t, err)
			assert.Contains(t, string(encoded), "draw a fox")
			if !tc.stream || tc.name == "gemini-stream" {
				assert.Contains(t, string(encoded), "drawn reply")
			}
			for _, excluded := range []string{picture, "private-input-image", "partial-image-never-in-text"} {
				assert.NotContains(t, string(encoded), excluded)
			}
			assert.Zero(t, record.OmittedImages)
			assert.Zero(t, r.memory.used.Load())
		})
	}
}

func TestContentAuditNativeImagesExcludeInputsAndNonImageOutputs(t *testing.T) {
	picture := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
	for _, tc := range []struct{ name, path, request, response string }{
		{"responses-tool", "/v1/responses", `{"input":"hello"}`, fmt.Sprintf(`{"output":[{"result":%q,"type":"function_call","name":"lookup","arguments":"{}"}]}`, picture)},
		{"gemini-audio", "/v1beta/models/gemini:generateContent", `{"contents":[]}`, fmt.Sprintf(`{"candidates":[{"content":{"parts":[{"inlineData":{"data":%q,"mimeType":"audio/pcm"}},{"text":"text reply"}]}}]}`, picture)},
		{"gemini-input-only", "/v1beta/models/gemini:generateContent", fmt.Sprintf(`{"contents":[{"parts":[{"inlineData":{"data":%q,"mimeType":"image/png"}}]}]}`, picture), `{"candidates":[{"content":{"parts":[{"text":"text reply"}]}}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, _ := contentAuditTestRuntime(t)
			_, job := contentAuditServeCaptured(t, r, tc.path, "application/json", []byte(tc.request), []byte(tc.response), false, false)
			require.NotNil(t, job)
			id := job.record.AuditID
			r.runJob(context.Background(), job)
			record, payload, err := ReadContentAuditPayload(context.Background(), id)
			require.NoError(t, err)
			assert.Equal(t, "text", record.Kind)
			assert.Empty(t, payload.Images)
			encoded, err := common.Marshal(payload)
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), picture)
			assert.Zero(t, r.memory.used.Load())
		})
	}
}

func TestContentAuditNativeImageFailuresRespectThumbnailSwitch(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		t.Run(fmt.Sprintf("enabled-%t", enabled), func(t *testing.T) {
			r, _, _ := contentAuditTestRuntime(t)
			config := *r.snapshot.Load()
			config.state.ThumbnailEnabled = enabled
			r.snapshot.Store(&config)
			response := []byte(`{"output":[{"result":"invalid-image-base64!","type":"image_generation_call"}],"status":"completed"}`)
			_, job := contentAuditServeCaptured(t, r, "/v1/responses", "application/json", []byte(`{"input":"draw"}`), response, false, false)
			require.NotNil(t, job)
			id := job.record.AuditID
			r.runJob(context.Background(), job)
			_, payload, err := ReadContentAuditPayload(context.Background(), id)
			require.NoError(t, err)
			require.Len(t, payload.Images, 1)
			if enabled {
				assert.Equal(t, "protocol_invalid", payload.Images[0].Status)
			} else {
				assert.Equal(t, "thumbnail_disabled", payload.Images[0].Status)
			}
			_, err = ReadContentAuditThumbnail(context.Background(), id, 0)
			assert.Error(t, err)
			assert.NotContains(t, string(payload.Response), "invalid-image-base64!")
			assert.Zero(t, r.memory.used.Load())
		})
	}
}

func contentAuditPersistParser(t *testing.T, r *contentAuditRuntime, images *contentAuditImages, response []byte) (string, *ContentAuditPayload) {
	t.Helper()
	record := model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, Epoch: r.snapshot.Load().state.Epoch, UserID: 7, ExpiresAt: time.Now().Unix() + 600, Kind: "text", Integrity: "complete"}
	images.session.initial = record
	job := &contentAuditJob{images: images, record: record, payload: ContentAuditPayload{Request: []byte("{}"), Response: response, Images: []ContentAuditImageView{}}}
	close(images.session.done)
	r.runJob(context.Background(), job)
	_, payload, err := ReadContentAuditPayload(context.Background(), record.AuditID)
	require.NoError(t, err)
	return record.AuditID, payload
}

func TestContentAuditNativeImageBoundsAndPendingReservations(t *testing.T) {
	picture := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
	items := make([]string, 0, 5)
	for index := range 5 {
		items = append(items, fmt.Sprintf(`{"result":%q,"type":"image_generation_call","id":"image-%d"}`, picture, index))
	}
	for _, tc := range []struct {
		name, body      string
		fullBudget      bool
		images, omitted int
	}{
		{"text-limit", `{"text":"` + strings.Repeat("x", 600) + `","output":[` + items[0] + `]}`, false, 1, 0},
		{"five-images-without-count-cap", `{"output":[` + strings.Join(items, ",") + `]}`, false, 5, 0},
		{"duplicate-image-key", fmt.Sprintf(`{"output":[{"result":%q,"result":%q,"type":"image_generation_call"}]}`, picture, picture), false, 1, 0},
		{"unfinished-image-object", `{"output":[{"type":"image_generation_call","result":"` + picture + `"`, false, 0, 0},
		{"image-budget-exhausted", `{"output":[` + items[0] + `]}`, true, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, _ := contentAuditTestRuntime(t)
			budget := &r.memory
			if tc.fullBudget {
				require.True(t, budget.acquire(contentAuditMemoryLimit))
			}
			images := &contentAuditImages{budget: budget, enabled: true, protocol: "openai_responses"}
			parser := newContentAuditJSON(256, images)
			for offset := 0; offset < len(tc.body); offset += 7 {
				_, err := parser.Write([]byte(tc.body[offset:min(offset+7, len(tc.body))]))
				require.NoError(t, err)
			}
			snapshot := contentAuditSnapshot(parser.value(), 256, &parser.truncated)
			assert.NotContains(t, string(snapshot), picture)
			assert.LessOrEqual(t, len(snapshot), 256)
			id, payload := contentAuditPersistParser(t, r, images, snapshot)
			require.Len(t, payload.Images, tc.images)
			for _, view := range payload.Images {
				original, err := OpenContentAuditOriginal(context.Background(), id, view.Index)
				require.NoError(t, err)
				actual, err := io.ReadAll(original.Reader)
				require.NoError(t, err)
				require.NoError(t, original.Reader.Close())
				assert.Equal(t, contentAuditTestPNG(t), actual)
			}
			images.release()
			if tc.fullBudget {
				budget.release(contentAuditMemoryLimit)
			}
			assert.Zero(t, budget.used.Load())
		})
	}
}

func TestContentAuditNativeStreamImageLimitCountsUniqueOutputs(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	picture := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
	items := make([]string, 0, 5)
	var response strings.Builder
	for index := range 5 {
		item := fmt.Sprintf(`{"type":"image_generation_call","id":"image-%d","result":%q}`, index, picture)
		items = append(items, item)
		response.WriteString("event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":" + item + "}\n\n")
	}
	response.WriteString("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[" + strings.Join(items, ",") + "],\"status\":\"completed\"}}\n\n")
	_, job := contentAuditServeCaptured(t, r, "/v1/responses", "application/json", []byte(`{"input":"draw five images"}`), []byte(response.String()), true, true)
	require.NotNil(t, job)
	id := job.record.AuditID
	r.runJob(context.Background(), job)
	record, payload, err := ReadContentAuditPayload(context.Background(), id)
	require.NoError(t, err)
	require.Len(t, payload.Images, 5)
	assert.Zero(t, record.OmittedImages, "terminal events repeat source identities without dropping the fifth original")
	for index, preview := range payload.Images {
		assert.Equal(t, "ready", preview.Status)
		_, err := ReadContentAuditThumbnail(context.Background(), id, index)
		assert.NoError(t, err)
	}
	assert.Zero(t, r.memory.used.Load())
}

func TestContentAuditNativeFinalImageReplacesEarlierFailedResult(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	picture := base64.StdEncoding.EncodeToString(contentAuditTestPNG(t))
	response := "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"image_generation_call\",\"id\":\"image-1\",\"result\":\"invalid-base64!\"}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"image_generation_call\",\"id\":\"image-1\",\"result\":\"" + picture + "\"}],\"status\":\"completed\"}}\n\n"
	_, job := contentAuditServeCaptured(t, r, "/v1/responses", "application/json", []byte(`{"input":"draw"}`), []byte(response), true, false)
	require.NotNil(t, job)
	id := job.record.AuditID
	r.runJob(context.Background(), job)
	_, payload, err := ReadContentAuditPayload(context.Background(), id)
	require.NoError(t, err)
	require.Len(t, payload.Images, 1)
	assert.Equal(t, "ready", payload.Images[0].Status)
	_, err = ReadContentAuditThumbnail(context.Background(), id, 0)
	assert.NoError(t, err)
	assert.Zero(t, r.memory.used.Load())
}

func TestContentAuditDefaultOffEpochAndAdmissionFailureDoNotChangeRelay(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	request, response := []byte(`{"prompt":"hello"}`), []byte(`{"choices":[{"text":"answer"}]}`)
	config := *r.snapshot.Load()
	config.state.Enabled = false
	r.snapshot.Store(&config)
	_, job := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", request, response, false, false)
	assert.Nil(t, job)
	var count int64
	require.NoError(t, model.DB.Model(&model.ContentAudit{}).Count(&count).Error)
	assert.Zero(t, count)
	files, err := os.ReadDir(filepath.Join(store.directory, "attempts"))
	require.NoError(t, err)
	assert.Empty(t, files)
	config.state.Enabled = true
	r.snapshot.Store(&config)
	_, job = contentAuditServeCaptured(t, r, "/v1/completions", "application/json", request, response, false, true)
	require.NotNil(t, job)
	settings := state.ContentAuditSettings
	settings.Enabled = false
	require.NoError(t, model.UpdateContentAuditSettings(context.Background(), state.ConfigVersion, settings))
	r.runJob(context.Background(), job)
	require.NoError(t, model.DB.Model(&model.ContentAudit{}).Count(&count).Error)
	assert.Zero(t, count)
	assert.Zero(t, r.memory.used.Load())
	_, job = contentAuditServeCaptured(t, r, "/v1/embeddings", "application/json", request, response, false, false)
	assert.Nil(t, job)
	assert.True(t, r.memory.acquire(contentAuditMemoryLimit))
	_, job = contentAuditServeCaptured(t, r, "/v1/completions", "application/json", request, response, false, false)
	assert.Nil(t, job)
	r.memory.release(contentAuditMemoryLimit)
	assert.Zero(t, r.active.Load())
}

func TestContentAuditBinaryBeforeTextLimitAndRedactionBoundaries(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	budget := &r.memory
	images := &contentAuditImages{budget: budget, enabled: true}
	picture := contentAuditTestPNG(t)
	data := `{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(picture) + `","url":"https://example.com/token/credential/image.png?sig=original-secret#fragment","revised_prompt":"` + strings.Repeat("界", 1000) + `"}],"COOKIE":"credential","zero":0,"no":false}`
	parser := newContentAuditJSON(256, images)
	for chunk := 0; chunk < len(data); chunk += 7 {
		_, err := parser.Write([]byte(data[chunk:min(chunk+7, len(data))]))
		require.NoError(t, err)
	}
	value := parser.value()
	encoded := contentAuditSnapshot(value, 256, &parser.truncated)
	assert.True(t, parser.truncated)
	assert.LessOrEqual(t, len(encoded), 256)
	var decoded any
	require.NoError(t, common.Unmarshal(encoded, &decoded))
	// This parser boundary test consumes the original from the real queued
	// block events; no retained full-image list is part of capture any more.
	var captured bytes.Buffer
	for len(images.session.events) > 0 {
		event := <-images.session.events
		if event.kind == "data" && event.input.Index == 0 {
			_, _ = captured.Write(event.input.Data)
		}
		if event.input.charged > 0 {
			budget.release(event.input.charged)
		}
	}
	assert.Equal(t, picture, captured.Bytes())
	assert.NotContains(t, string(encoded), "original-secret")
	assert.NotContains(t, string(encoded), base64.StdEncoding.EncodeToString(picture))
	images.release()
	assert.Zero(t, budget.used.Load())
	for _, raw := range []string{`{"secret":"credential"`, strings.Repeat(`{"nested":`, 40) + `"credential"` + strings.Repeat("}", 40), `{"text":"safe","secret":"credential",}`} {
		parser := newContentAuditJSON(1024, nil)
		_, err := parser.Write([]byte(raw))
		require.NoError(t, err)
		snapshot := contentAuditSnapshot(parser.value(), 1024, &parser.truncated)
		assert.True(t, parser.truncated)
		assert.NotContains(t, string(snapshot), "credential")
		require.NoError(t, common.Unmarshal(snapshot, &decoded))
	}
}

func TestContentAuditThumbnailMandatorySSRFAndDecodeLimits(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "0.0.0.0", "10.0.0.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "198.51.100.1", "203.0.113.1", "240.0.0.1", "::1", "::ffff:8.8.8.8", "fe80::1", "fc00::1", "2001:db8::1", "2002:0808:0808::1"} {
		t.Run(address, func(t *testing.T) { assert.False(t, contentAuditPublicIP(netip.MustParseAddr(address))) })
	}
	assert.True(t, contentAuditPublicIP(netip.MustParseAddr("8.8.8.8")))
	assert.True(t, contentAuditPublicIP(netip.MustParseAddr("2606:4700:4700::1111")))
	for _, raw := range []string{"http://127.0.0.1/a", "https://[::ffff:8.8.8.8]/a", "file:///tmp/private", "http://2130706433/a", "http://0177.0.0.1/a", "http://0x7f000001/a", "https://user:password@example.com/a", "https://example.com:8080/a"} {
		_, err := contentAuditImageURL(raw)
		assert.Error(t, err, raw)
	}
	url, err := contentAuditImageURL("https://example.com/a?sig=private")
	require.NoError(t, err)
	redirect := &http.Request{URL: url}
	previous := &http.Request{URL: url}
	require.NoError(t, contentAuditImageRedirect(redirect, []*http.Request{previous, previous, previous}))
	assert.Error(t, contentAuditImageRedirect(redirect, []*http.Request{previous, previous, previous, previous}))
	down, err := contentAuditImageURL("http://example.com/a")
	require.NoError(t, err)
	assert.Error(t, contentAuditImageRedirect(&http.Request{URL: down}, []*http.Request{previous}))
	// Even an environment proxy and relay TLS opt-out cannot override this
	// client's literal-IP rejection. There is no generic SSRF feature toggle.
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	client := newContentAuditImageClient()
	defer client.CloseIdleConnections()
	_, _, err = downloadContentAuditImage(context.Background(), client, "http://127.0.0.1/private")
	assert.Error(t, err)
	picture := contentAuditTestPNG(t)
	_, err = makeContentAuditThumbnail(context.Background(), picture, "image/jpeg")
	assert.Error(t, err)
	for _, data := range [][]byte{[]byte("<svg>private</svg>"), []byte("GIF89a"), make([]byte, contentAuditMaxImageBytes+1)} {
		_, err := makeContentAuditThumbnail(context.Background(), data, "")
		assert.Error(t, err)
	}
	assert.Equal(t, "https://example.com/token/%5Bredacted%5D/image.png", redactContentAuditURL("https://user:pass@example.com/token/secret/image.png?sig=private#fragment"))
}

func TestContentAuditEncryptionOwnershipExpiryAndDeletion(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	_, job := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte(`{"prompt":"private prompt"}`), []byte(`{"choices":[{"text":"private reply"}]}`), false, false)
	require.NotNil(t, job)
	id := job.record.AuditID
	r.runJob(context.Background(), job)
	record, payload, err := ReadContentAuditPayload(context.Background(), id)
	require.NoError(t, err)
	assert.Contains(t, string(payload.Request), "private prompt")
	restarted, err := newContentAuditStore(store.directory)
	require.NoError(t, err)
	r.store.Store(restarted)
	_, _, err = ReadContentAuditPayload(context.Background(), id)
	require.NoError(t, err)
	t.Setenv("CRYPTO_SECRET", "wrong-stable-key")
	wrong, err := newContentAuditStore(store.directory)
	require.NoError(t, err)
	r.store.Store(wrong)
	_, _, err = ReadContentAuditPayload(context.Background(), id)
	assert.Error(t, err)
	r.store.Store(store)
	var files []model.ContentAuditFile
	require.NoError(t, common.UnmarshalJsonStr(record.FilesJSON, &files))
	path := filepath.Join(store.directory, "attempts", id+"-"+record.Attempt, files[0].ID+".bin")
	original, err := os.ReadFile(path)
	require.NoError(t, err)
	corrupt := bytes.Clone(original)
	corrupt[len(corrupt)-1] ^= 1
	require.NoError(t, os.WriteFile(path, corrupt, 0600))
	_, _, err = ReadContentAuditPayload(context.Background(), id)
	assert.Error(t, err)
	require.NoError(t, os.WriteFile(path, original, 0600))
	_, err = store.decode(record.StorageID, contentAuditRandomID(), record.Attempt, files[0].ID, "payload", original, contentAuditMaxFile)
	assert.Error(t, err, "AAD binds the record identity")
	_, err = store.decode(record.StorageID, id, record.Attempt, files[0].ID, "payload", original, 2)
	assert.Error(t, err, "decompression output is bounded")
	require.NoError(t, model.DB.Model(record).Update("expires_at", time.Now().Unix()-1).Error)
	_, _, err = ReadContentAuditPayload(context.Background(), id)
	assert.ErrorIs(t, err, model.ErrContentAuditExpired)
	deleting, err := model.BeginContentAuditDelete(context.Background(), id)
	require.NoError(t, err)
	require.NoError(t, store.deleteAttempt(context.Background(), state, id, record.Attempt))
	require.NoError(t, store.deleteAttempt(context.Background(), state, id, record.Attempt))
	_, err = os.Stat(filepath.Join(store.directory, "attempts", id+"-"+record.Attempt))
	require.ErrorIs(t, err, os.ErrNotExist)
	const deleteFailure = "test:content_audit_delete_after_files"
	require.NoError(t, model.DB.Callback().Delete().Before("gorm:delete").Register(deleteFailure, func(tx *gorm.DB) { tx.AddError(errors.New("delete commit unavailable")) }))
	assert.Error(t, model.FinishContentAuditDelete(context.Background(), deleting))
	stillDeleting, err := model.GetContentAudit(context.Background(), id)
	require.NoError(t, err)
	assert.Equal(t, model.ContentAuditDeleting, stillDeleting.Status)
	retained, err := model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	assert.Equal(t, record.FileBytes, retained.UsedBytes, "deleting files is not yet permission to release database accounting")
	require.NoError(t, model.DB.Callback().Delete().Remove(deleteFailure))
	require.NoError(t, model.FinishContentAuditDelete(context.Background(), deleting))
	require.NoError(t, model.FinishContentAuditDelete(context.Background(), deleting))
	state, err = model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	assert.Zero(t, state.UsedBytes)
	assert.Zero(t, state.UsedRecords)
	assert.Zero(t, state.ReservedBytes)
}

func TestContentAuditSingleInstanceLocalReadiness(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	oldMaster := common.IsMasterNode
	common.IsMasterNode = false
	t.Cleanup(func() { common.IsMasterNode = oldMaster })
	ctx := context.Background()
	r.refreshLocal(context.Background())
	snapshot := r.snapshot.Load()
	require.NotNil(t, snapshot)
	require.True(t, snapshot.ready, "initialized private storage must be usable without node registration or a master: %s", snapshot.state.PauseReason)
	settings := ContentAuditSettingsUpdate{ExpectedVersion: snapshot.state.ConfigVersion, ContentAuditSettings: snapshot.state.ContentAuditSettings}
	settings.Enabled = false
	require.NoError(t, UpdateContentAudit(ctx, settings))
	status, err := GetContentAuditStatus(ctx)
	require.NoError(t, err)
	require.True(t, status.Ready, "turning capture off does not make local storage unready")
	require.False(t, status.State.Enabled)
	encoded, err := common.Marshal(status)
	require.NoError(t, err)
	var wireStatus map[string]any
	require.NoError(t, common.Unmarshal(encoded, &wireStatus))
	assert.Equal(t, true, wireStatus["ready"])
	assert.NotContains(t, wireStatus, "cluster_ready")
	assert.NotContains(t, wireStatus, "nodes")
	assert.NotContains(t, wireStatus, "missing_nodes")
	settings.ExpectedVersion = status.State.ConfigVersion
	settings.Enabled = true
	require.NoError(t, UpdateContentAudit(ctx, settings))
	response := []byte(`{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(contentAuditTestPNG(t)) + `"}]}`)
	_, job := contentAuditServeCaptured(t, r, "/v1/images/generations", "application/json", []byte(`{"prompt":"local fox"}`), response, false, false)
	require.NotNil(t, job)
	r.runJob(ctx, job)
	record, payload, err := ReadContentAuditPayload(ctx, job.record.AuditID)
	require.NoError(t, err)
	assert.Contains(t, string(payload.Request), "local fox")
	thumbnail, err := ReadContentAuditThumbnail(ctx, record.AuditID, 0)
	require.NoError(t, err)
	_, format, err := image.Decode(bytes.NewReader(thumbnail))
	require.NoError(t, err)
	assert.Equal(t, "jpeg", format)
	require.NoError(t, RequestContentAuditDeletion(ctx, ContentAuditDeleteRequest{IDs: []string{record.AuditID}}))
	require.NoError(t, cleanupContentAudits(ctx, store))
	_, err = model.GetContentAudit(ctx, record.AuditID)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	state, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Zero(t, state.UsedBytes)
	assert.Zero(t, state.ReservedBytes)
}

func TestContentAuditSingleInstanceRestartRecovery(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	_, ready := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte(`{"prompt":"retained request"}`), []byte(`{"choices":[{"text":"retained reply"}]}`), false, false)
	require.NotNil(t, ready)
	r.runJob(ctx, ready)
	old := model.ContentAudit{AuditID: contentAuditRandomID(), Owner: r.processID, Attempt: contentAuditRandomID(), UserID: 7, CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Unix() + 86400, Epoch: state.Epoch}
	require.NoError(t, model.ReserveContentAudit(ctx, &old))
	directory, err := store.beginAttempt(state, &old)
	require.NoError(t, err)
	remaining := old.ReservedBytes
	_, err = store.write(ctx, directory, old.StorageID, old.AuditID, old.Attempt, contentAuditRandomID(), "payload", []byte("interrupted payload"), true, &remaining)
	require.NoError(t, err)
	require.NoError(t, directory.Close())
	restarted := &contentAuditRuntime{processID: contentAuditRandomID(), queue: make(chan *contentAuditJob, 64), maintenanceWake: make(chan struct{}, 1)}
	restarted.store.Store(store)
	contentAuditEngine = restarted
	restarted.refreshLocal(context.Background())
	_, err = model.GetContentAudit(ctx, old.AuditID)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound, "the preceding process has stopped; its unclosed reservation must be recovered immediately")
	_, err = os.Stat(filepath.Join(store.directory, "attempts", old.AuditID+"-"+old.Attempt))
	assert.ErrorIs(t, err, os.ErrNotExist)
	_, payload, err := ReadContentAuditPayload(ctx, ready.record.AuditID)
	require.NoError(t, err)
	assert.Contains(t, string(payload.Response), "retained reply")
	_, next := contentAuditServeCaptured(t, restarted, "/v1/completions", "application/json", []byte(`{"prompt":"after restart"}`), []byte(`{"choices":[{"text":"new reply"}]}`), false, false)
	require.NotNil(t, next)
	restarted.runJob(ctx, next)
	_, _, err = ReadContentAuditPayload(ctx, next.record.AuditID)
	require.NoError(t, err)
}

func TestContentAuditSingleInstanceRejectsUnsafeLocalStorage(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	ctx := context.Background()
	r.refreshLocal(ctx)
	require.True(t, r.snapshot.Load().ready)
	require.NoError(t, os.Chmod(filepath.Join(store.directory, "attempts"), 0777))
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(store.directory, "attempts"), 0700) })
	r.refreshLocal(ctx)
	status, err := GetContentAuditStatus(ctx)
	require.NoError(t, err)
	assert.False(t, status.Ready, "world-readable attempt storage must pause local collection")
	assert.NotEmpty(t, status.State.PauseReason)
}

func TestContentAuditSingleInstanceExpiredReadinessExplainsPause(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	r.refreshLocal(context.Background())
	snapshot := *r.snapshot.Load()
	snapshot.expires = time.Now().Unix() - 1
	r.snapshot.Store(&snapshot)
	status, err := GetContentAuditStatus(context.Background())
	require.NoError(t, err)
	assert.False(t, status.Ready)
	assert.NotEmpty(t, status.State.PauseReason, "stale local checks must explain why enabled capture is paused")
}

func TestContentAuditSingleInstanceLegacyStoreAndSchema(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	ctx := context.Background()
	_, job := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte(`{"prompt":"legacy payload"}`), []byte(`{"choices":[{"text":"legacy reply"}]}`), false, false)
	require.NotNil(t, job)
	r.runJob(ctx, job)
	legacy := filepath.Join(store.directory, "probes")
	require.NoError(t, os.Mkdir(legacy, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(legacy, "retained.bin"), []byte("legacy probe bytes"), 0600))
	require.NoError(t, model.DB.Exec("CREATE TABLE content_audit_nodes (process_id varchar(32) PRIMARY KEY, node_name varchar(128))").Error)
	require.NoError(t, model.DB.Exec("INSERT INTO content_audit_nodes (process_id, node_name) VALUES (?, ?)", contentAuditRandomID(), "retained-node").Error)
	require.NoError(t, model.DB.Exec("ALTER TABLE content_audit_storage_states ADD COLUMN probe_id varchar(32)").Error)
	require.NoError(t, model.DB.Exec("UPDATE content_audit_storage_states SET probe_id = ?", "retained-probe").Error)
	require.NoError(t, model.MigrateContentAudit(model.DB))
	r.refreshLocal(ctx)
	require.True(t, r.snapshot.Load().ready)
	_, payload, err := ReadContentAuditPayload(ctx, job.record.AuditID)
	require.NoError(t, err)
	assert.Contains(t, string(payload.Response), "legacy reply")
	var node, probe string
	require.NoError(t, model.DB.Table("content_audit_nodes").Select("node_name").Scan(&node).Error)
	require.NoError(t, model.DB.Table("content_audit_storage_states").Select("probe_id").Scan(&probe).Error)
	assert.Equal(t, "retained-node", node)
	assert.Equal(t, "retained-probe", probe)
	data, err := os.ReadFile(filepath.Join(legacy, "retained.bin"))
	require.NoError(t, err)
	assert.Equal(t, "legacy probe bytes", string(data))
}

func TestContentAuditSingleInstanceDeletionWakeAndShutdown(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.refreshLocal(ctx)
	_, job := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte(`{"prompt":"delete locally"}`), []byte(`{"choices":[{"text":"reply"}]}`), false, false)
	require.NotNil(t, job)
	r.runJob(ctx, job)
	r.cancel = cancel
	r.start(ctx)
	t.Cleanup(func() {
		stop, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopCancel()
		require.NoError(t, StopContentAudit(stop))
	})
	require.NoError(t, RequestContentAuditDeletion(ctx, ContentAuditDeleteRequest{IDs: []string{job.record.AuditID}}))
	for range 100 {
		r.wakeMaintenance()
	}
	require.Eventually(t, func() bool {
		_, err := model.GetContentAudit(ctx, job.record.AuditID)
		return errors.Is(err, gorm.ErrRecordNotFound)
	}, 5*time.Second, 10*time.Millisecond)
	_, err := os.Stat(filepath.Join(store.directory, "attempts", job.record.AuditID+"-"+job.record.Attempt))
	assert.ErrorIs(t, err, os.ErrNotExist)
	require.Eventually(t, func() bool {
		status, err := GetContentAuditStatus(ctx)
		return err == nil && status.Ready && status.State.UsedBytes == 0 && status.State.ReservedBytes == 0
	}, 5*time.Second, 10*time.Millisecond)
}

func TestContentAuditSingleInstanceUnidentifiedOrphanIsRetained(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	ctx := context.Background()
	r.refreshLocal(ctx)
	name := contentAuditRandomID() + "-" + contentAuditRandomID()
	directory := filepath.Join(store.directory, "attempts", name)
	require.NoError(t, os.Mkdir(directory, 0700))
	path := filepath.Join(directory, contentAuditRandomID()+".bin")
	require.NoError(t, os.WriteFile(path, []byte("unidentified retained file"), 0600))
	require.NoError(t, r.maintain(ctx, false))
	require.NoError(t, model.DB.Model(&model.ContentAuditOrphan{}).Where("path = ?", name).Update("first_seen", time.Now().Unix()-3601).Error)
	require.NoError(t, r.maintain(ctx, false))
	data, err := os.ReadFile(path)
	require.NoError(t, err, "a filename alone is not ownership evidence for orphan deletion")
	assert.Equal(t, "unidentified retained file", string(data))
	state, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, len(data), state.QuarantinedBytes)
	assert.NotEmpty(t, state.PauseReason)
}

func TestContentAuditSingleInstanceMaintenanceWaitsForLiveWriter(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	ctx := context.Background()
	r.refreshLocal(ctx)
	_, job := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte(`{"prompt":"live writer"}`), []byte(`{"choices":[{"text":"live reply"}]}`), false, false)
	require.NotNil(t, job)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	const pause = "test:content_audit_live_publish"
	require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register(pause, func(tx *gorm.DB) {
		values, ok := tx.Statement.Dest.(map[string]any)
		if tx.Statement.Table == "content_audits" && ok && values["status"] == model.ContentAuditReady {
			once.Do(func() { close(entered); <-release })
		}
	}))
	writerDone := make(chan struct{})
	go func() { r.runJob(ctx, job); close(writerDone) }()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
		<-writerDone
		_ = model.DB.Callback().Update().Remove(pause)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("writer did not reach publication")
	}
	directory := filepath.Join(store.directory, "attempts", job.record.AuditID+"-"+job.record.Attempt)
	before, err := os.ReadDir(directory)
	require.NoError(t, err)
	require.Len(t, before, 2)
	maintenanceDone := make(chan error, 1)
	go func() { maintenanceDone <- r.maintain(ctx, false) }()
	select {
	case err := <-maintenanceDone:
		t.Fatalf("maintenance ran while the writer still owned its reservation: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	after, err := os.ReadDir(directory)
	require.NoError(t, err)
	assert.Len(t, after, 2)
	close(release)
	<-writerDone
	require.NoError(t, <-maintenanceDone)
	_, payload, err := ReadContentAuditPayload(ctx, job.record.AuditID)
	require.NoError(t, err)
	assert.Contains(t, string(payload.Response), "live reply")
	state, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Zero(t, state.ReservedRecords)
	assert.EqualValues(t, 1, state.UsedRecords)
	assert.True(t, r.snapshot.Load().ready)
	_, next := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte(`{"prompt":"after maintenance"}`), []byte(`{"choices":[{"text":"next reply"}]}`), false, false)
	require.NotNil(t, next)
	r.runJob(ctx, next)
	_, _, err = ReadContentAuditPayload(ctx, next.record.AuditID)
	require.NoError(t, err, "maintenance must restore admission before releasing queued writers")
}

func TestContentAuditPendingWriterFencingAndOrphanGrace(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	record := model.ContentAudit{AuditID: contentAuditRandomID(), Owner: r.processID, Attempt: contentAuditRandomID(), UserID: 7, CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Unix() + 86400, Epoch: state.Epoch}
	require.NoError(t, model.ReserveContentAudit(ctx, &record))
	require.NoError(t, model.DB.Model(&model.ContentAudit{}).Where("id = ?", record.ID).Update("lease_until", time.Now().Unix()-1).Error)
	require.NoError(t, model.BeginContentAuditReconciliation(ctx))
	require.NoError(t, reconcileContentAudits(ctx, store))
	current, err := model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Equal(t, "writer_unconfirmed", current.PauseReason)
	assert.Equal(t, record.ReservedBytes, current.ReservedBytes)
	_, err = model.BeginContentAuditDelete(ctx, record.AuditID)
	assert.ErrorIs(t, err, model.ErrContentAuditOwnership)
	// A process that actually closes its handles may mark the attempt failed;
	// cleanup then returns its reservation exactly once.
	require.NoError(t, model.StopContentAuditAttempt(ctx, &record, "test_closed"))
	require.NoError(t, cleanupContentAudits(ctx, store))
	current, err = model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Zero(t, current.ReservedBytes)
	assert.Zero(t, current.ReservedRecords)
	// An unknown but cryptographically closed attempt must survive its first
	// scan even though there is no metadata row.
	record.AuditID, record.Attempt = contentAuditRandomID(), contentAuditRandomID()
	directory, err := store.beginAttempt(state, &record)
	require.NoError(t, err)
	remaining := int64(16384)
	closed, err := common.Marshal(contentAuditClosedAttempt{AuditID: record.AuditID, Attempt: record.Attempt, Owner: r.processID, Fence: 1})
	require.NoError(t, err)
	_, err = store.write(ctx, directory, state.StorageID, record.AuditID, record.Attempt, "closed", "closed", closed, false, &remaining)
	require.NoError(t, err)
	require.NoError(t, directory.Close())
	require.NoError(t, model.BeginContentAuditReconciliation(ctx))
	require.NoError(t, reconcileContentAudits(ctx, store))
	name := record.AuditID + "-" + record.Attempt
	_, err = os.Stat(filepath.Join(store.directory, "attempts", name))
	require.NoError(t, err)
	current, err = model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Positive(t, current.QuarantinedBytes)
	assert.Equal(t, current.QuarantinedBytes, current.UsedBytes)
	require.NoError(t, model.DB.Model(&model.ContentAuditOrphan{}).Where("path = ?", name).Update("first_seen", time.Now().Unix()-3601).Error)
	require.NoError(t, model.BeginContentAuditReconciliation(ctx))
	require.NoError(t, reconcileContentAudits(ctx, store))
	_, err = os.Stat(filepath.Join(store.directory, "attempts", name))
	assert.ErrorIs(t, err, os.ErrNotExist)
	current, err = model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.Zero(t, current.QuarantinedBytes)
	assert.Zero(t, current.UsedBytes)
}

// The matrix uses ONLY explicitly named ephemeral databases. A DSN for a live
// project database is rejected, and nothing drops a database/container itself.
func TestContentAuditDatabaseMatrix(t *testing.T) {
	for _, dialect := range []common.DatabaseType{common.DatabaseTypeSQLite, common.DatabaseTypeMySQL, common.DatabaseTypePostgreSQL} {
		t.Run(string(dialect), func(t *testing.T) {
			var dialector gorm.Dialector
			dsn := ""
			switch dialect {
			case common.DatabaseTypeSQLite:
				dsn = filepath.Join(t.TempDir(), "content_audit_ephemeral.db") + "?_pragma=busy_timeout(3000)"
				dialector = sqlite.Open(dsn)
			case common.DatabaseTypeMySQL:
				dsn = os.Getenv("CONTENT_AUDIT_TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("CONTENT_AUDIT_TEST_MYSQL_DSN not configured")
				}
				require.Contains(t, dsn, "content_audit_ephemeral")
				dialector = mysql.Open(dsn)
			case common.DatabaseTypePostgreSQL:
				dsn = os.Getenv("CONTENT_AUDIT_TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("CONTENT_AUDIT_TEST_POSTGRES_DSN not configured")
				}
				require.Contains(t, dsn, "content_audit_ephemeral")
				dialector = postgres.Open(dsn)
			}
			db, err := gorm.Open(dialector, &gorm.Config{Logger: gormlogger.Default.LogMode(gormlogger.Silent)})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			t.Cleanup(func() { _ = sqlDB.Close() })
			// Representative pre-feature records are created before the additive
			// audit migration. Preserve values and unique request/session indexes.
			require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}))
			user := model.User{Username: "content-audit-upgrade", Password: "not-a-credential", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1, Quota: 1234, AffCode: "content-audit-upgrade"}
			require.NoError(t, db.Create(&user).Error)
			contentAuditTestDatabase(t, db, dialect)
			require.NoError(t, model.MigrateContentAudit(db))
			require.NoError(t, model.MigrateContentAudit(db))
			var saved model.User
			require.NoError(t, db.First(&saved, user.Id).Error)
			assert.Equal(t, 1234, saved.Quota)
			assert.Equal(t, user.Username, saved.Username)
			state, err := model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			assert.False(t, state.Enabled)
			state.StorageID = contentAuditRandomID()
			state.Mode = "plaintext"
			state.PlaintextAcknowledged = true
			state.Enabled = true
			state.Reconciling = false
			state.PauseReason = ""
			state.HealthyUntil = time.Now().Unix() + 300
			state.CapacityBytes = 64 << 20
			state.RequestLimit = 2 << 20
			state.ResponseLimit = 4 << 20
			require.NoError(t, db.Save(state).Error)
			record := model.ContentAudit{AuditID: contentAuditRandomID(), Owner: contentAuditRandomID(), Attempt: contentAuditRandomID(), UserID: user.Id, Epoch: state.Epoch, CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Unix() + 86400}
			require.NoError(t, model.ReserveContentAudit(context.Background(), &record))
			duplicate := record
			duplicate.ID = 0
			assert.Error(t, db.Create(&duplicate).Error, "logical request uniqueness must survive repeated migration")
			child := model.ContentAuditImage{AuditID: record.AuditID, Attempt: record.Attempt, ImageIndex: 5, Identity: strings.Repeat("a", 64), DescriptorID: contentAuditRandomID(), DescriptorBytes: 240, DescriptorPlainBytes: 160}
			require.NoError(t, db.Create(&child).Error)
			// Real-engine lazy upgrade: authenticated private descriptor, old
			// NULL hints, two rebuilds and two migrations, no ownership rewrite.
			t.Setenv("CRYPTO_SECRET", "")
			t.Setenv("SESSION_SECRET", "")
			lookupPath := t.TempDir()
			require.NoError(t, os.Chmod(lookupPath, 0700))
			lookupStore, err := newContentAuditStore(lookupPath)
			require.NoError(t, err)
			require.NoError(t, lookupStore.initialize(true))
			lookupState := *state
			lookupState.StorageID = lookupStore.namespace.StorageID
			lookupRecord := record
			lookupRecord.StorageID = lookupState.StorageID
			lookupDirectory, err := lookupStore.beginAttempt(&lookupState, &lookupRecord)
			require.NoError(t, err)
			descriptor := contentAuditImageDescriptor{
				View:      ContentAuditImageView{Index: 5},
				Original:  &contentAuditOriginalFile{ID: contentAuditRandomID(), Bytes: 128, PlainBytes: 1},
				Thumbnail: &model.ContentAuditFile{ID: contentAuditRandomID(), Kind: "thumbnail", Bytes: 128, PlainBytes: 1},
			}
			descriptorData, err := common.Marshal(descriptor)
			require.NoError(t, err)
			remaining := int64(16384)
			child.DescriptorBytes, err = lookupStore.write(context.Background(), lookupDirectory, lookupRecord.StorageID, record.AuditID, record.Attempt, child.DescriptorID, "image_descriptor", descriptorData, false, &remaining)
			require.NoError(t, err)
			require.NoError(t, lookupDirectory.Close())
			child.DescriptorPlainBytes = len(descriptorData)
			child.Committed = true
			require.NoError(t, db.Save(&child).Error)
			immutableBefore, err := common.Marshal(child)
			require.NoError(t, err)
			require.NoError(t, db.Model(&child).Updates(map[string]any{"original_lookup": nil, "thumbnail_lookup": nil}).Error)
			require.NoError(t, lookupStore.rebuildDeletionLookups(context.Background(), &lookupState, &lookupRecord))
			require.NoError(t, lookupStore.rebuildDeletionLookups(context.Background(), &lookupState, &lookupRecord))
			require.NoError(t, model.MigrateContentAudit(db))
			require.NoError(t, model.MigrateContentAudit(db))
			require.NoError(t, db.First(&child, child.ID).Error)
			assert.Equal(t, contentAuditDeletionLookup(&lookupRecord, descriptor.Original.ID), child.OriginalLookup)
			assert.Equal(t, contentAuditDeletionLookup(&lookupRecord, descriptor.Thumbnail.ID), child.ThumbnailLookup)
			immutableAfter, err := common.Marshal(child)
			require.NoError(t, err)
			assert.Equal(t, immutableBefore, immutableAfter, "rebuildable hints cannot invalidate a pre-upgrade deletion authorization")
			for _, index := range []string{"idx_content_audit_image_descriptor", "idx_content_audit_image_original", "idx_content_audit_image_thumbnail"} {
				assert.True(t, db.Migrator().HasIndex(&model.ContentAuditImage{}, index), "reverse lookup index survives repeated migration: %s", index)
			}
			duplicateChild := child
			duplicateChild.ID = 0
			assert.Error(t, db.Create(&duplicateChild).Error, "audit/attempt/index uniqueness survives repeated additive migration")
			state, err = model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			assert.Equal(t, record.ReservedBytes, state.ReservedBytes)
			settings := state.ContentAuditSettings
			settings.Enabled = false
			require.NoError(t, model.UpdateContentAuditSettings(context.Background(), state.ConfigVersion, settings))
			assert.ErrorIs(t, model.PublishContentAudit(context.Background(), &record, []model.ContentAuditFile{{ID: contentAuditRandomID(), Kind: "payload"}}, 100), model.ErrContentAuditDisabled)
			require.NoError(t, model.BeginContentAuditReconciliation(context.Background()))
			require.NoError(t, model.RecoverContentAuditAttempts(context.Background(), record.Owner))
			pending, err := model.GetContentAudit(context.Background(), record.AuditID)
			require.NoError(t, err)
			assert.Equal(t, model.ContentAuditPending, pending.Status, "recovery cannot stop its current owner")
			require.NoError(t, model.RecoverContentAuditAttempts(context.Background(), contentAuditRandomID()))
			interrupted, err := model.GetContentAudit(context.Background(), record.AuditID)
			require.NoError(t, err)
			assert.Equal(t, model.ContentAuditFailed, interrupted.Status)
			assert.True(t, interrupted.WriterStopped)
			assert.Equal(t, record.Fence+1, interrupted.Fence)
			assert.Equal(t, record.ReservedBytes, interrupted.ReservedBytes, "recovery retains accounting until files are deleted")
			assert.ErrorIs(t, model.StopContentAuditAttempt(context.Background(), &record, "stale_writer"), model.ErrContentAuditOwnership)
			deleting, err := model.BeginContentAuditDelete(context.Background(), record.AuditID)
			require.NoError(t, err)
			// The additive private field can be NULL in upgraded rows. Exercise
			// both first authorization and phase CAS on each real SQL engine.
			require.NoError(t, db.Model(&model.ContentAudit{}).Where("audit_id = ?", deleting.AuditID).Update("deletion_authorization", nil).Error)
			staleDeletion := *deleting
			staleDeletion.Fence++
			assert.ErrorIs(t, model.AuthorizeContentAuditDeletion(context.Background(), &staleDeletion, "sealed-images"), model.ErrContentAuditOwnership)
			require.NoError(t, model.AuthorizeContentAuditDeletion(context.Background(), deleting, "sealed-images"))
			staleDeletion = *deleting
			require.NoError(t, model.AuthorizeContentAuditDeletion(context.Background(), deleting, "sealed-metadata"))
			assert.ErrorIs(t, model.AuthorizeContentAuditDeletion(context.Background(), &staleDeletion, "stale-phase"), model.ErrContentAuditOwnership)
			require.NoError(t, model.MigrateContentAudit(db))
			require.NoError(t, model.MigrateContentAudit(db))
			authorized, err := model.GetContentAudit(context.Background(), deleting.AuditID)
			require.NoError(t, err)
			assert.Equal(t, "sealed-metadata", authorized.DeletionAuthorization)
			charged, err := model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			assert.Equal(t, record.ReservedBytes, charged.ReservedBytes, "authorization changes no retained charge")
			require.NoError(t, os.Remove(filepath.Join(lookupPath, "attempts", record.AuditID+"-"+record.Attempt, child.DescriptorID+".bin")))
			require.NoError(t, os.Remove(filepath.Join(lookupPath, "attempts", record.AuditID+"-"+record.Attempt)))
			require.NoError(t, model.FinishContentAuditDelete(context.Background(), deleting))
			require.NoError(t, model.FinishContentAuditDelete(context.Background(), deleting))
			var children int64
			require.NoError(t, db.Model(&model.ContentAuditImage{}).Where("audit_id = ?", record.AuditID).Count(&children).Error)
			assert.Zero(t, children)
			state, err = model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			assert.Zero(t, state.ReservedBytes)
			assert.Zero(t, state.ReservedRecords)
			// The two background writers compete for the same capacity ledger.
			reservation := model.ContentAuditReservation(state.ContentAuditSettings)
			require.NoError(t, db.Model(state).Updates(map[string]any{"enabled": true, "healthy_until": time.Now().Unix() + 300, "used_bytes": state.CapacityBytes - reservation, "pause_reason": "", "reconciling": false}).Error)
			results := make(chan error, 2)
			for range 2 {
				go func() {
					record := model.ContentAudit{AuditID: contentAuditRandomID(), Owner: contentAuditRandomID(), Attempt: contentAuditRandomID(), UserID: user.Id, Epoch: state.Epoch, CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Unix() + 86400}
					results <- model.ReserveContentAudit(context.Background(), &record)
				}()
			}
			for range 2 {
				err := <-results
				assert.True(t, err == nil || errors.Is(err, model.ErrContentAuditCapacity) || errors.Is(err, model.ErrContentAuditUnavailable), "unexpected reservation result: %v", err)
			}
			state, err = model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			assert.LessOrEqual(t, state.UsedBytes+state.ReservedBytes, state.CapacityBytes)
			assert.EqualValues(t, 1, state.ReservedRecords)
			assert.Equal(t, state.CapacityBytes, state.UsedBytes+state.ReservedBytes)
			// Incremental growth uses the same row lock on every real engine,
			// not merely the initial admission transaction.
			require.NoError(t, db.Model(state).Update("used_bytes", 0).Error)
			var first model.ContentAudit
			require.NoError(t, db.Where("status = ?", model.ContentAuditPending).First(&first).Error)
			second := model.ContentAudit{AuditID: contentAuditRandomID(), Owner: contentAuditRandomID(), Attempt: contentAuditRandomID(), UserID: user.Id, Epoch: state.Epoch, ExpiresAt: time.Now().Unix() + 600}
			require.NoError(t, model.ReserveContentAudit(context.Background(), &second))
			current, err := model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			require.NoError(t, db.Model(current).Update("used_bytes", current.CapacityBytes-current.ReservedBytes-1).Error)
			growth := make(chan error, 2)
			for _, candidate := range []*model.ContentAudit{&first, &second} {
				go func() { growth <- model.GrowContentAuditReservation(context.Background(), candidate, 1) }()
			}
			success, rejected := 0, 0
			for range 2 {
				err := <-growth
				if err == nil {
					success++
				} else {
					require.ErrorIs(t, err, model.ErrContentAuditCapacity)
					rejected++
				}
			}
			assert.Equal(t, 1, success)
			assert.Equal(t, 1, rejected)
			current, err = model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			assert.Equal(t, current.CapacityBytes, current.UsedBytes+current.ReservedBytes)
			total := current.UsedBytes + current.ReservedBytes
			require.NoError(t, model.RenewContentAuditAttempt(context.Background(), &first))
			require.NoError(t, model.RenewContentAuditAttempt(context.Background(), &first))
			stale := first
			stale.Fence++
			assert.ErrorIs(t, model.RenewContentAuditAttempt(context.Background(), &stale), model.ErrContentAuditOwnership)
			renewed, err := model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			assert.Equal(t, total, renewed.UsedBytes+renewed.ReservedBytes, "renewal cannot claim capacity")
			t.Logf("%s: repeated additive migration, existing row preservation, epoch fence, idempotent release, concurrent local reservation passed", dialect)
		})
	}
}

func TestContentAuditLogDatabaseMatrix(t *testing.T) {
	for _, dialect := range []common.DatabaseType{common.DatabaseTypeSQLite, common.DatabaseTypeMySQL, common.DatabaseTypePostgreSQL, common.DatabaseTypeClickHouse} {
		t.Run(string(dialect), func(t *testing.T) {
			var dialector gorm.Dialector
			switch dialect {
			case common.DatabaseTypeSQLite:
				dialector = sqlite.Open(filepath.Join(t.TempDir(), "audit_log_ephemeral.db"))
			case common.DatabaseTypeMySQL:
				dsn := os.Getenv("CONTENT_AUDIT_TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("ephemeral MySQL not configured")
				}
				require.Contains(t, dsn, "content_audit_ephemeral")
				dialector = mysql.Open(dsn)
			case common.DatabaseTypePostgreSQL:
				dsn := os.Getenv("CONTENT_AUDIT_TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("ephemeral PostgreSQL not configured")
				}
				require.Contains(t, dsn, "content_audit_ephemeral")
				dialector = postgres.Open(dsn)
			case common.DatabaseTypeClickHouse:
				dsn := os.Getenv("CONTENT_AUDIT_TEST_CLICKHOUSE_DSN")
				if dsn == "" {
					t.Skip("ephemeral ClickHouse not configured")
				}
				require.Contains(t, dsn, "content_audit_ephemeral")
				dialector = clickhouse.Open(dsn)
			}
			db, err := gorm.Open(dialector, &gorm.Config{Logger: gormlogger.Default.LogMode(gormlogger.Silent)})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			t.Cleanup(func() { _ = sqlDB.Close() })
			previous := model.LOG_DB
			previousLog := common.LogDatabaseType()
			model.LOG_DB = db
			common.SetDatabaseTypes(common.MainDatabaseType(), dialect)
			t.Cleanup(func() { model.LOG_DB = previous; common.SetDatabaseTypes(common.MainDatabaseType(), previousLog) })
			require.NoError(t, model.MigrateAuditLogs())
			require.NoError(t, model.MigrateAuditLogs())
			requestID := "content-audit-durable-" + contentAuditRandomID()
			require.NoError(t, model.RecordAuditLogDurable(nil, model.AuditLog{UserId: 1, Username: "root", ActorRole: common.RoleRootUser, RequestId: requestID, Category: model.AuditCategorySecurity, Action: "content_audit.read", Content: "Authorized content access", Success: true, Other: model.AuditOther{RootInfo: model.AuditFields{"operation_id": "test-operation", "record_ids": []string{contentAuditRandomID()}, "phase": "authorized"}}}))
			events, total, err := model.GetAuditLogs(model.AuditLogFilter{RequestId: requestID}, 0, 10, common.RoleRootUser)
			require.NoError(t, err)
			require.EqualValues(t, 1, total)
			require.Len(t, events, 1)
			assert.Equal(t, "content_audit.read", events[0].Action)
			assert.True(t, events[0].Success)
			assert.NotNil(t, events[0].Other.RootInfo)
			const callback = "test:content_audit_durable_failure"
			require.NoError(t, db.Callback().Create().Before("gorm:create").Register(callback, func(tx *gorm.DB) { tx.AddError(errors.New("forced persistence failure")) }))
			assert.Error(t, model.RecordAuditLogDurable(nil, model.AuditLog{Username: "root", ActorRole: common.RoleRootUser, Category: model.AuditCategorySecurity}))
			require.NoError(t, db.Callback().Create().Remove(callback))
			versionQuery := "SELECT version()"
			if dialect == common.DatabaseTypeSQLite {
				versionQuery = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Logf("%s %s: independent LOG_DB durable insert/read and failure propagation passed", dialect, version)
		})
	}
}

type contentAuditChildReply struct {
	Ready bool   `json:"ready"`
	Error string `json:"error"`
}

type contentAuditTestStderr struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (s *contentAuditTestStderr) Write(data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buffer.Write(data)
}

func (s *contentAuditTestStderr) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buffer.String()
}

type contentAuditTestProcess struct {
	command *exec.Cmd
	input   io.WriteCloser
	output  *bufio.Reader
	stderr  contentAuditTestStderr
	killed  bool
}

func startContentAuditTestProcess(t *testing.T, dsn, auditID string) *contentAuditTestProcess {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	process := &contentAuditTestProcess{command: exec.CommandContext(ctx, executable, "-test.run=^TestContentAuditRecoveryChild$", "-test.v")}
	process.command.Env = append(os.Environ(), "CONTENT_AUDIT_RECOVERY_CHILD_DSN="+dsn, "CONTENT_AUDIT_RECOVERY_CHILD_ID="+auditID)
	process.input, err = process.command.StdinPipe()
	require.NoError(t, err)
	output, err := process.command.StdoutPipe()
	require.NoError(t, err)
	process.output = bufio.NewReader(output)
	process.command.Stderr = &process.stderr
	require.NoError(t, process.command.Start())
	t.Cleanup(func() {
		defer cancel()
		if process.killed {
			return
		}
		_, _ = fmt.Fprintln(process.input, "exit")
		_ = process.input.Close()
		err := process.command.Wait()
		cancel()
		assert.NoError(t, err, process.stderr.String())
	})
	return process
}

func (p *contentAuditTestProcess) send(t *testing.T, command string) {
	t.Helper()
	_, err := fmt.Fprintln(p.input, command)
	require.NoError(t, err)
}
func (p *contentAuditTestProcess) receive(t *testing.T) contentAuditChildReply {
	t.Helper()
	for {
		line, err := p.output.ReadString('\n')
		require.NoError(t, err, p.stderr.String())
		if raw, ok := strings.CutPrefix(line, "AUDIT_REPLY:"); ok {
			var result contentAuditChildReply
			require.NoError(t, common.UnmarshalJsonStr(raw, &result))
			require.Empty(t, result.Error)
			return result
		}
	}
}

func TestContentAuditRecoveryChild(t *testing.T) {
	dsn := os.Getenv("CONTENT_AUDIT_RECOVERY_CHILD_DSN")
	if dsn == "" {
		t.Skip("interactive subprocess fixture")
	}
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: gormlogger.Default.LogMode(gormlogger.Silent)})
	require.NoError(t, err)
	model.DB = db
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	common.IsMasterNode = false
	store, err := newContentAuditStore(os.Getenv("CONTENT_AUDIT_STORAGE_DIR"))
	require.NoError(t, err)
	r := &contentAuditRuntime{processID: contentAuditRandomID(), queue: make(chan *contentAuditJob, 64), maintenanceWake: make(chan struct{}, 1)}
	r.store.Store(store)
	contentAuditEngine = r
	id := os.Getenv("CONTENT_AUDIT_RECOVERY_CHILD_ID")
	var interrupted model.ContentAudit
	var writing *os.Root
	var file model.ContentAuditFile
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		command := scanner.Text()
		result := contentAuditChildReply{}
		switch {
		case command == "exit":
			return
		case command == "refresh":
			r.refreshLocal(context.Background())
			snapshot := r.snapshot.Load()
			result.Ready = snapshot != nil && snapshot.ready
		case command == "reserve":
			state, stateErr := model.GetContentAuditState(context.Background())
			require.NoError(t, stateErr)
			interrupted = model.ContentAudit{AuditID: id, Attempt: contentAuditRandomID(), Owner: r.processID, UserID: 7, CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Unix() + 86400, Epoch: state.Epoch}
			err = model.ReserveContentAudit(context.Background(), &interrupted)
		case command == "temporary":
			state, stateErr := model.GetContentAuditState(context.Background())
			require.NoError(t, stateErr)
			writing, err = store.beginAttempt(state, &interrupted)
			require.NoError(t, err)
			data := []byte(`{"request":{"prompt":"crash fixture"},"response":{"text":"reply"},"images":[]}`)
			file = model.ContentAuditFile{ID: contentAuditRandomID(), Kind: "payload", PlainBytes: len(data), MIME: "application/json"}
			encoded, encodeErr := store.envelope(state.StorageID, id, interrupted.Attempt, file.ID, file.Kind, data, true)
			require.NoError(t, encodeErr)
			file.Bytes = int64(len(encoded))
			handle, openErr := writing.OpenFile(file.ID+".tmp", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			require.NoError(t, openErr)
			_, err = handle.Write(encoded)
			require.NoError(t, err)
			require.NoError(t, handle.Sync())
			require.NoError(t, handle.Close())
		case command == "rename":
			err = writing.Rename(file.ID+".tmp", file.ID+".bin")
			require.NoError(t, err)
			err = syncContentAuditDirectory(writing)
		case command == "closed":
			closed, encodeErr := common.Marshal(contentAuditClosedAttempt{AuditID: id, Attempt: interrupted.Attempt, Owner: r.processID, Fence: interrupted.Fence, Files: []model.ContentAuditFile{file}, FileBytes: file.Bytes})
			require.NoError(t, encodeErr)
			remaining := interrupted.ReservedBytes - file.Bytes
			_, err = store.write(context.Background(), writing, interrupted.StorageID, id, interrupted.Attempt, "closed", "closed", closed, false, &remaining)
			require.NoError(t, err)
			err = writing.Close()
		default:
			t.Fatal("unknown fixture command")
		}
		if err != nil {
			result.Error = err.Error()
		}
		encoded, marshalErr := common.Marshal(result)
		require.NoError(t, marshalErr)
		_, _ = fmt.Println("AUDIT_REPLY:" + string(encoded))
	}
	require.NoError(t, scanner.Err())
}

func TestContentAuditResultURLSurvivesTextLimit(t *testing.T) {
	memory := &contentAuditMemory{}
	images := &contentAuditImages{budget: memory, enabled: true}
	t.Cleanup(images.release)
	const address = "https://example.com/result.png?sig=download-secret#fragment"
	body := `{"data":[{"revised_prompt":"` + strings.Repeat("text", 256) + `","url":"` + address + `"}]}`
	response := newContentAuditResponse(256, images)
	response.write([]byte(body), false)
	snapshot := response.snapshot()
	found := ""
	for len(images.session.events) > 0 {
		event := <-images.session.events
		if event.kind == "end" && event.valid {
			found = event.input.URL
			assert.Empty(t, event.input.Error)
		}
		if event.input.charged > 0 {
			memory.release(event.input.charged)
		}
	}
	assert.Equal(t, address, found, "complete URL candidate must reach the worker despite exhausted text budget")
	assert.True(t, response.truncated)
	assert.NotContains(t, string(snapshot), "download-secret")
	assert.LessOrEqual(t, len(snapshot), 256)
}

func TestContentAuditMultipartAndStreamAggregateLimits(t *testing.T) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for i := range 129 {
		require.NoError(t, form.WriteField(fmt.Sprintf("parameter_%d", i), "value"))
	}
	require.NoError(t, form.Close())
	snapshot, _, truncated := captureContentAuditRequest(bytes.NewReader(body.Bytes()), form.FormDataContentType(), 64<<10)
	assert.True(t, truncated, "reaching the part limit must report omitted fields")
	assert.NotContains(t, string(snapshot), "parameter_128")

	// The wire JSON contains only one string field, but joining tool deltas
	// must not bypass the same structured field budget enforced on JSON bodies.
	arguments := "[" + strings.Repeat("0,", contentAuditMaxFields) + "0]"
	wire, err := common.Marshal(map[string]any{"type": "response.function_call_arguments.delta", "item_id": "call-1", "delta": arguments})
	require.NoError(t, err)
	response := newContentAuditResponse(64<<10, nil)
	response.write(append(append([]byte("event: response.function_call_arguments.delta\ndata: "), wire...), []byte("\n\nevent: response.completed\ndata: {\"type\":\"response.completed\"}\n\n")...), true)
	snapshot = response.snapshot()
	assert.NotContains(t, string(snapshot), "[0,0,0,0,0,0,0,0,0,0,0,0")
	assert.Contains(t, string(snapshot), "omitted")
}

func TestContentAuditUpstreamStreamFailureIsPartial(t *testing.T) {
	r, _, _ := contentAuditTestRuntime(t)
	response := []byte("data: {\"choices\":[{\"delta\":{\"content\":\"partial reply\"}}]}\n\n")
	client, job := contentAuditServeCaptured(t, r, "/v1/chat/completions", "application/json", []byte(`{"messages":[]}`), response, true, false, func(c *gin.Context) { c.Set("content_audit_relay_error", true) })
	require.NotNil(t, job)
	defer r.release(job)
	assert.Equal(t, http.StatusOK, client.Code)
	assert.Equal(t, response, client.Body.Bytes())
	assert.Equal(t, "upstream_error", job.record.CompletionReason)
	assert.Equal(t, "partial", job.record.Integrity)
}

func TestContentAuditClaudeStructuredToolResultRedaction(t *testing.T) {
	parser := newContentAuditJSON(64<<10, nil)
	_, err := parser.Write([]byte(`{"messages":[{"role":"user","content":[{"type":"tool_result","content":"{\"password\":\"tool-result-secret\",\"n\":0}"},{"type":"tool_result","content":"ordinary password prose stays unchanged"},{"type":"text","text":"{\"password\":\"free text is not anonymized\"}"}]}]}`))
	require.NoError(t, err)
	snapshot := contentAuditSnapshot(parser.value(), 64<<10, &parser.truncated)
	assert.False(t, parser.truncated)
	assert.NotContains(t, string(snapshot), "tool-result-secret")
	assert.Contains(t, string(snapshot), "ordinary password prose stays unchanged")
	assert.Contains(t, string(snapshot), "free text is not anonymized")
}

func TestContentAuditCleanupDoesNotStarveBehindPendingAttempts(t *testing.T) {
	r, store, state := contentAuditTestRuntime(t)
	ctx := context.Background()
	for range 100 {
		record := model.ContentAudit{AuditID: contentAuditRandomID(), Attempt: contentAuditRandomID(), Owner: r.processID, UserID: 7, CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Unix() + 86400, Epoch: state.Epoch}
		require.NoError(t, model.ReserveContentAudit(ctx, &record))
	}
	_, job := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte(`{"prompt":"hello"}`), []byte(`{"choices":[{"text":"reply"}]}`), false, false)
	require.NotNil(t, job)
	r.runJob(ctx, job)
	record, err := model.GetContentAudit(ctx, job.record.AuditID)
	require.NoError(t, err)
	require.Equal(t, model.ContentAuditReady, record.Status)
	require.NoError(t, model.DB.Model(&model.ContentAudit{}).Where("status = ?", model.ContentAuditPending).Update("lease_until", time.Now().Unix()-1).Error)
	require.NoError(t, model.DB.Model(record).Update("expires_at", time.Now().Unix()-1).Error)
	require.NoError(t, cleanupContentAudits(ctx, store))
	_, err = model.GetContentAudit(ctx, record.AuditID)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound, "pending attempts cannot starve unrelated expired content")
	state, err = model.GetContentAuditState(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 100, state.ReservedRecords)
	assert.Equal(t, "writer_unconfirmed", state.PauseReason)
	assert.Zero(t, state.UsedRecords)
}

type contentAuditSchemaSnapshot struct {
	Rows          map[string]int64    `json:"rows"`
	Indexes       map[string][]string `json:"indexes"`
	ClickHouseDDL string              `json:"clickhouse_ddl"`
}

func contentAuditSchema(t *testing.T, db *gorm.DB, clickHouse bool) contentAuditSchemaSnapshot {
	t.Helper()
	result := contentAuditSchemaSnapshot{Rows: map[string]int64{}, Indexes: map[string][]string{}}
	db = db.Session(&gorm.Session{Logger: gormlogger.Discard})
	var tables []string
	if clickHouse {
		// This driver version compares information_schema.table_type to an
		// integer; SHOW TABLES is the supported ClickHouse inspection command.
		require.NoError(t, db.Raw("SHOW TABLES").Scan(&tables).Error)
	} else {
		var err error
		tables, err = db.Migrator().GetTables()
		require.NoError(t, err)
	}
	for _, table := range tables {
		if strings.HasPrefix(table, "sqlite_") {
			continue
		}
		var count int64
		require.NoError(t, db.Table(table).Count(&count).Error)
		result.Rows[table] = count
		if clickHouse {
			continue
		}
		indexes, err := db.Migrator().GetIndexes(table)
		require.NoError(t, err)
		values := []string{}
		for _, index := range indexes {
			unique, _ := index.Unique()
			primary, _ := index.PrimaryKey()
			values = append(values, fmt.Sprintf("%s|%t|%t|%s", index.Name(), unique, primary, strings.Join(index.Columns(), ",")))
		}
		slices.Sort(values)
		result.Indexes[table] = values
	}
	if clickHouse {
		require.NoError(t, db.Raw("SHOW CREATE TABLE audit_logs").Scan(&result.ClickHouseDDL).Error)
	}
	return result
}

func TestContentAuditStartupMatrix(t *testing.T) {
	dialect := os.Getenv("CONTENT_AUDIT_STARTUP_DIALECT")
	if dialect == "" {
		t.Skip("full released-source startup fixture is run by e2e/content-audit-matrix.sh")
	}
	scenario := os.Getenv("CONTENT_AUDIT_STARTUP_SCENARIO")
	require.Contains(t, []string{"fresh", "upgrade"}, scenario)
	for key, source := range map[string]string{"SQL_DSN": "CONTENT_AUDIT_STARTUP_DSN", "LOG_SQL_DSN": "CONTENT_AUDIT_STARTUP_LOG_DSN"} {
		dsn := os.Getenv(source)
		require.True(t, dsn == "local" || strings.Contains(dsn, "content_audit_ephemeral"), "refusing non-ephemeral database")
		t.Setenv(key, dsn)
	}
	path := os.Getenv("CONTENT_AUDIT_STARTUP_SQLITE")
	require.Contains(t, path, "content_audit_ephemeral")
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousPath, previousMaster, previousDebug := common.SQLitePath, common.IsMasterNode, common.DebugEnabled
	common.SQLitePath, common.IsMasterNode, common.DebugEnabled = path, true, false
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.SQLitePath, common.IsMasterNode, common.DebugEnabled = previousPath, previousMaster, previousDebug
	})
	var baseline map[string]contentAuditSchemaSnapshot
	if scenario == "upgrade" {
		data, err := os.ReadFile(os.Getenv("CONTENT_AUDIT_BASELINE_MANIFEST"))
		require.NoError(t, err)
		require.NoError(t, common.Unmarshal(data, &baseline))
		require.Greater(t, len(baseline["main"].Rows), 40, "baseline must run all released migrations, not two representative models")
		require.NotContains(t, baseline["main"].Rows, "content_audits")
		require.EqualValues(t, 1, baseline["log"].Rows["audit_logs"])
	}
	var firstMain, firstLog contentAuditSchemaSnapshot
	for pass := range 2 {
		require.NoError(t, model.InitDB())
		require.NoError(t, model.InitLogDB())
		state, err := model.GetContentAuditState(context.Background())
		require.NoError(t, err)
		assert.False(t, state.Enabled)
		assert.Empty(t, state.StorageID)
		if pass == 0 {
			settings := state.ContentAuditSettings
			settings.RetentionDays = 9
			require.NoError(t, model.UpdateContentAuditSettings(context.Background(), state.ConfigVersion, settings))
		} else {
			assert.Equal(t, 9, state.RetentionDays, "repeated migration cannot reset saved audit protection settings")
			assert.EqualValues(t, 2, state.ConfigVersion)
		}
		currentMain := contentAuditSchema(t, model.DB, false)
		currentLog := contentAuditSchema(t, model.LOG_DB, dialect == "clickhouse")
		if pass == 0 {
			firstMain, firstLog = currentMain, currentLog
		} else {
			assert.Equal(t, firstMain, currentMain, "primary rows and indexes must be idempotent")
			assert.Equal(t, firstLog, currentLog, "log rows/indexes/ClickHouse DDL must be idempotent")
		}
		if scenario == "upgrade" {
			for name, actual := range map[string]contentAuditSchemaSnapshot{"main": currentMain, "log": currentLog} {
				for table, count := range baseline[name].Rows {
					assert.Equal(t, count, actual.Rows[table], "%s.%s release rows", name, table)
				}
				for table, indexes := range baseline[name].Indexes {
					assert.Equal(t, indexes, actual.Indexes[table], "%s.%s release indexes", name, table)
				}
				assert.Equal(t, baseline[name].ClickHouseDDL, actual.ClickHouseDDL)
			}
			var user model.User
			require.NoError(t, model.DB.Where("username = ?", "content-audit-released-user").First(&user).Error)
			assert.EqualValues(t, 9876543210, user.Quota)
			assert.EqualValues(t, 4321, user.UsedQuota)
			require.NoError(t, model.ValidateContentAuditSession(context.Background(), model.AuthSessionIdentity{UserID: user.Id, SessionID: "audit-released-session", SessionVersion: 1, UserAuthVersion: 1}))
			var option model.Option
			require.NoError(t, model.DB.Where(&model.Option{Key: "content-audit-baseline-preserved"}).First(&option).Error)
			assert.Equal(t, "released-value", option.Value)
			events, count, err := model.GetAuditLogs(model.AuditLogFilter{RequestId: "content-audit-release-request"}, 0, 10, common.RoleRootUser)
			require.NoError(t, err)
			require.EqualValues(t, 1, count)
			require.Len(t, events, 1)
			other, err := common.Marshal(events[0].Other.RootInfo)
			require.NoError(t, err)
			assert.JSONEq(t, `{"baseline":"preserve"}`, string(other))
			duplicate := user
			duplicate.Id, duplicate.AffCode = 0, "audit-duplicate"
			assert.Error(t, model.DB.Create(&duplicate).Error, "released username uniqueness remains enforced")
			var session model.UserSession
			require.NoError(t, model.DB.Where("sid = ?", "audit-released-session").First(&session).Error)
			assert.Error(t, model.DB.Create(&session).Error, "released session uniqueness remains enforced")
			var token model.Token
			require.NoError(t, model.DB.Where(&model.Token{Key: "audit-released-token"}).First(&token).Error)
			assert.Equal(t, 123456, token.RemainQuota)
			token.Id = 0
			assert.Error(t, model.DB.Create(&token).Error, "released API token uniqueness remains enforced")
		}
		require.NoError(t, model.CloseDB())
	}
	t.Logf("%s %s: full startup twice; primary %d tables and log %d tables; release %s; row/index/uniqueness and saved settings preserved", dialect, scenario, len(firstMain.Rows), len(firstLog.Rows), os.Getenv("CONTENT_AUDIT_BASELINE_COMMIT"))
}

func TestContentAuditThumbnailNetworkIsolation(t *testing.T) {
	picture := contentAuditTestPNG(t)
	var requests atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requests.Add(1)
		assert.Empty(t, req.Header.Get("Authorization"))
		assert.Empty(t, req.Header.Get("Proxy-Authorization"))
		assert.Empty(t, req.Header.Get("Cookie"))
		assert.Equal(t, "identity", req.Header.Get("Accept-Encoding"))
		w.Header().Set("Content-Type", "image/png")
		switch req.URL.Path {
		case "/private-ip":
			http.Redirect(w, req, "http://127.0.0.1/private", http.StatusFound)
			return
		case "/private-dns":
			http.Redirect(w, req, "http://private.example/image", http.StatusFound)
			return
		case "/mixed-dns":
			http.Redirect(w, req, "http://mixed.example/image", http.StatusFound)
			return
		case "/redirect":
			n, _ := strconv.Atoi(req.URL.Query().Get("n"))
			if n > 0 {
				http.Redirect(w, req, "/redirect?n="+strconv.Itoa(n-1), http.StatusFound)
				return
			}
		case "/compressed":
			w.Header().Set("Content-Encoding", "gzip")
		case "/mime":
			w.Header().Set("Content-Type", "text/html")
		case "/headers":
			w.Header().Set("X-Oversized", strings.Repeat("x", 33<<10))
		case "/length":
			w.Header().Set("Content-Length", strconv.Itoa(contentAuditMaxImageBytes+1))
		case "/chunked":
			w.(http.Flusher).Flush()
			_, _ = w.Write(make([]byte, contentAuditMaxImageBytes+1))
			return
		}
		_, _ = w.Write(picture)
	}))
	defer upstream.Close()
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	oldTLS := common.TLSInsecureSkipVerify
	common.TLSInsecureSkipVerify = true
	t.Cleanup(func() { common.TLSInsecureSkipVerify = oldTLS })
	client := newContentAuditImageClient()
	defer client.CloseIdleConnections()
	// Use the unmodified transport directly as well: URL validation alone must
	// not hide an accidentally replaced/unsafe production DialContext.
	_, err := client.Get(upstream.URL)
	require.Error(t, err)
	assert.Zero(t, requests.Load(), "the production dialer cannot hit an owned loopback server")
	transport := client.Transport.(*http.Transport)
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		addresses := []netip.Addr{netip.MustParseAddr("8.8.8.8")}
		if host == "private.example" {
			addresses = []netip.Addr{netip.MustParseAddr("127.0.0.1")}
		}
		if host == "mixed.example" {
			addresses = append(addresses, netip.MustParseAddr("127.0.0.1"))
		}
		return contentAuditPinnedDial(ctx, network, port, addresses, func(ctx context.Context, network, pinned string) (net.Conn, error) {
			assert.Equal(t, "8.8.8.8:80", pinned, "connection uses a vetted IP, never re-resolves the original hostname")
			return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
		})
	}
	for _, path := range []string{"/image", "/redirect?n=3"} {
		data, mime, err := downloadContentAuditImage(context.Background(), client, "http://public.example"+path)
		require.NoError(t, err)
		assert.Equal(t, picture, data)
		assert.Equal(t, "image/png", mime)
	}
	for _, path := range []string{"/private-ip", "/private-dns", "/mixed-dns", "/redirect?n=4", "/compressed", "/mime", "/headers", "/length"} {
		t.Run(path, func(t *testing.T) {
			before := requests.Load()
			_, _, err := downloadContentAuditImage(context.Background(), client, "http://public.example"+path)
			assert.ErrorIs(t, err, errContentAuditImage)
			if strings.HasPrefix(path, "/private") || path == "/mixed-dns" {
				assert.EqualValues(t, 1, requests.Load()-before, "forbidden redirect never reaches another server")
			}
		})
	}
	var dialed bool
	_, err = contentAuditPinnedDial(context.Background(), "tcp", "443", []netip.Addr{netip.MustParseAddr("127.0.0.1")}, func(context.Context, string, string) (net.Conn, error) { dialed = true; return nil, nil })
	assert.Error(t, err)
	assert.False(t, dialed, "a subsequent rebound DNS answer cannot reach the dialer")
}

func TestContentAuditThumbnailTLSAndDecodeBudget(t *testing.T) {
	picture := contentAuditTestPNG(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "example.com", r.TLS.ServerName)
		if r.URL.Path == "/downgrade" {
			http.Redirect(w, r, "http://example.com/image", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(picture)
	}))
	defer server.Close()
	oldTLS := common.TLSInsecureSkipVerify
	common.TLSInsecureSkipVerify = true
	t.Cleanup(func() { common.TLSInsecureSkipVerify = oldTLS })
	client := newContentAuditImageClient()
	defer client.CloseIdleConnections()
	transport := client.Transport.(*http.Transport)
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		assert.Equal(t, "example.com:443", address)
		return contentAuditPinnedDial(ctx, network, "443", []netip.Addr{netip.MustParseAddr("8.8.8.8")}, func(ctx context.Context, network, pinned string) (net.Conn, error) {
			assert.Equal(t, "8.8.8.8:443", pinned)
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		})
	}
	_, _, err := downloadContentAuditImage(context.Background(), client, "https://example.com/image")
	assert.Error(t, err, "untrusted TLS is not bypassed")
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	data, _, err := downloadContentAuditImage(context.Background(), client, "https://example.com/image")
	require.NoError(t, err)
	assert.Equal(t, picture, data)
	_, _, err = downloadContentAuditImage(context.Background(), client, "https://example.com/downgrade")
	assert.Error(t, err)
	// These are fully decodable images, not just patched IHDRs with incompatible
	// scanlines. Removing either dimension guard would produce a thumbnail.
	for _, dimensions := range [][2]int{{8193, 1}, {4096, 4097}} {
		var oversized bytes.Buffer
		require.NoError(t, png.Encode(&oversized, image.NewGray(image.Rect(0, 0, dimensions[0], dimensions[1]))))
		decoded, _, err := image.Decode(bytes.NewReader(oversized.Bytes()))
		require.NoError(t, err)
		assert.Equal(t, image.Rect(0, 0, dimensions[0], dimensions[1]), decoded.Bounds())
		_, err = makeContentAuditThumbnail(context.Background(), oversized.Bytes(), "image/png")
		assert.Error(t, err)
	}
	contentAuditDecodeSlot <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = makeContentAuditThumbnail(ctx, picture, "image/png")
	assert.Error(t, err, "an already-cancelled decode request is rejected")
	<-contentAuditDecodeSlot
	thumbnail, err := makeContentAuditThumbnail(context.Background(), picture, "image/png")
	require.NoError(t, err)
	assert.LessOrEqual(t, len(thumbnail.Data), 300<<10)
}

type contentAuditLostCommitPool struct {
	gorm.ConnPool
	db   *sql.DB
	lost atomic.Bool
}
type contentAuditLostCommitTx struct {
	*sql.Tx
	pool      *contentAuditLostCommitPool
	publishes bool
}

func (p *contentAuditLostCommitPool) BeginTx(ctx context.Context, opts *sql.TxOptions) (gorm.ConnPool, error) {
	tx, err := p.db.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &contentAuditLostCommitTx{Tx: tx, pool: p}, nil
}
func (tx *contentAuditLostCommitTx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	if strings.HasPrefix(query, "UPDATE") && strings.Contains(query, "content_audits") && slices.ContainsFunc(args, func(value any) bool { return value == model.ContentAuditReady }) {
		tx.publishes = true
	}
	return tx.Tx.ExecContext(ctx, query, args...)
}
func (tx *contentAuditLostCommitTx) Commit() error {
	if err := tx.Tx.Commit(); err != nil {
		return err
	}
	if tx.publishes && tx.pool.lost.CompareAndSwap(false, true) {
		return errors.New("commit acknowledgement lost")
	}
	return nil
}

func TestContentAuditPublicationUnknownCommitRetainsReadyFiles(t *testing.T) {
	r, store, _ := contentAuditTestRuntime(t)
	_, job := contentAuditServeCaptured(t, r, "/v1/completions", "application/json", []byte(`{"prompt":"keep after uncertain commit"}`), []byte(`{"choices":[{"text":"retained reply"}]}`), false, false)
	require.NotNil(t, job)
	original := model.DB
	sqlDB, err := original.DB()
	require.NoError(t, err)
	pool := &contentAuditLostCommitPool{ConnPool: sqlDB, db: sqlDB}
	wrapped := original.Session(&gorm.Session{NewDB: true})
	wrapped.Statement = &gorm.Statement{DB: wrapped, ConnPool: pool, Context: context.Background()}
	model.DB = wrapped
	t.Cleanup(func() { model.DB = original })
	r.runJob(context.Background(), job)
	require.True(t, pool.lost.Load(), "fault must occur after the real publication commit")
	record, payload, err := ReadContentAuditPayload(context.Background(), job.record.AuditID)
	require.NoError(t, err)
	assert.Equal(t, model.ContentAuditReady, record.Status)
	assert.Contains(t, string(payload.Response), "retained reply")
	state, err := model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	assert.Equal(t, record.FileBytes, state.UsedBytes)
	assert.Zero(t, state.ReservedBytes)
	assert.EqualValues(t, 1, state.UsedRecords)
	_, err = os.Stat(filepath.Join(store.directory, "attempts", record.AuditID+"-"+record.Attempt))
	require.NoError(t, err)
	assert.Zero(t, r.memory.used.Load())
}

func TestContentAuditCrashRecoveryProcesses(t *testing.T) {
	for _, stage := range []string{"reserve", "temporary", "rename", "closed"} {
		t.Run(stage, func(t *testing.T) {
			_, store, _ := contentAuditTestRuntime(t)
			dialector, ok := model.DB.Dialector.(*sqlite.Dialector)
			require.True(t, ok)
			id := contentAuditRandomID()
			writer := startContentAuditTestProcess(t, dialector.DSN, id)
			for _, command := range []string{"reserve", "temporary", "rename", "closed"} {
				writer.send(t, command)
				writer.receive(t)
				if command == stage {
					break
				}
			}
			record, err := model.GetContentAudit(context.Background(), id)
			require.NoError(t, err)
			_, _, err = ReadContentAuditPayload(context.Background(), id)
			assert.Error(t, err, "renamed files are unreadable until the publication transaction commits")
			require.NoError(t, writer.command.Process.Kill())
			require.Error(t, writer.command.Wait())
			writer.killed = true
			cleaner := startContentAuditTestProcess(t, dialector.DSN, id)
			cleaner.send(t, "refresh")
			require.True(t, cleaner.receive(t).Ready)
			state, err := model.GetContentAuditState(context.Background())
			require.NoError(t, err)
			_, err = model.GetContentAudit(context.Background(), id)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			_, err = os.Stat(filepath.Join(store.directory, "attempts", id+"-"+record.Attempt))
			assert.ErrorIs(t, err, os.ErrNotExist)
			assert.Zero(t, state.ReservedBytes)
			assert.Zero(t, state.ReservedRecords)
		})
	}
}

func TestContentAuditProductionDNSRejectsPrivateAnswer(t *testing.T) {
	var queries atomic.Int64
	dns, err := net.ListenPacket("udp", "127.0.0.1:0")
	require.NoError(t, err)
	var workers sync.WaitGroup
	workers.Go(func() {
		buffer := make([]byte, 4096)
		for {
			n, address, err := dns.ReadFrom(buffer)
			if err != nil {
				return
			}
			var request dnsmessage.Message
			if request.Unpack(buffer[:n]) != nil {
				continue
			}
			queries.Add(1)
			response := dnsmessage.Message{Header: dnsmessage.Header{ID: request.Header.ID, Response: true, RecursionAvailable: true}, Questions: request.Questions}
			for _, question := range request.Questions {
				if question.Type == dnsmessage.TypeA {
					response.Answers = append(response.Answers, dnsmessage.Resource{Header: dnsmessage.ResourceHeader{Name: question.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}, Body: &dnsmessage.AResource{A: [4]byte{127, 0, 0, 1}}})
					if strings.HasPrefix(question.Name.String(), "mixed-") {
						response.Answers = append(response.Answers, dnsmessage.Resource{Header: dnsmessage.ResourceHeader{Name: question.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}, Body: &dnsmessage.AResource{A: [4]byte{8, 8, 8, 8}}})
					}
				}
			}
			encoded, err := response.Pack()
			if err == nil {
				_, _ = dns.WriteTo(encoded, address)
			}
		}
	})
	defer func() { _ = dns.Close(); workers.Wait() }()
	previous := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "udp", dns.LocalAddr().String())
	}}
	defer func() { net.DefaultResolver = previous }()
	client := newContentAuditImageClient()
	defer client.CloseIdleConnections()
	for _, host := range []string{"private-audit.example", "mixed-audit.example"} {
		before := queries.Load()
		response, err := client.Get("http://" + host + "/image")
		if response != nil {
			_ = response.Body.Close()
		}
		// Exercise the production resolver and dialer without the download wrapper's
		// error normalization. This sentinel alone does not prove zero TCP connects:
		// resolver and connection failures are normalized by the dialer as well.
		assert.ErrorIs(t, err, errContentAuditImage)
		assert.Greater(t, queries.Load(), before, "the unmodified contentAuditDial must query the controlled resolver")
	}
}

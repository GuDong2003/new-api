package service

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/shirou/gopsutil/disk"
	"golang.org/x/crypto/hkdf"
)

const (
	contentAuditMarker     = "namespace.json"
	contentAuditHeaderSize = 64
	contentAuditMaxFile    = 8 << 20
)

var errContentAuditStore = errors.New("content_audit_storage_unavailable")
var errContentAuditFile = errors.New("content_audit_file_invalid")

type contentAuditNamespace struct {
	Version   int    `json:"version"`
	StorageID string `json:"storage_id"`
	Mode      string `json:"mode"`
	KeyID     string `json:"key_id"`
}

type contentAuditStore struct {
	directory  string
	rootInfo   os.FileInfo
	namespace  contentAuditNamespace
	aead       cipher.AEAD
	usage      func(string) (*disk.UsageStat, error)
	physicalMu sync.Mutex
}

type contentAuditClosedAttempt struct {
	Version     int                      `json:"version,omitempty"`
	ImageCount  int64                    `json:"image_count,omitempty"`
	ImageDigest string                   `json:"image_digest,omitempty"`
	AuditID     string                   `json:"audit_id"`
	Attempt     string                   `json:"attempt"`
	Owner       string                   `json:"owner"`
	Fence       int64                    `json:"fence"`
	Files       []model.ContentAuditFile `json:"files"`
	FileBytes   int64                    `json:"file_bytes"`
}

func contentAuditRandomID() string {
	var value [16]byte
	_, _ = rand.Read(value[:]) // crypto/rand.Read cannot fail on supported Go runtimes.
	return hex.EncodeToString(value[:])
}

func newContentAuditStore(directory string) (*contentAuditStore, error) {
	if directory == "" || !filepath.IsAbs(directory) {
		return nil, errContentAuditStore
	}
	absolute, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, errContentAuditStore
	}
	// The private namespace cannot overlap host-managed caches, public files,
	// backups, or the application source.
	for _, other := range []string{common.GetDiskCacheDir(), avatarStorageDir(), *common.LogDir, "data", "uploads", "backups", "web", "public", "static"} {
		path, err := filepath.Abs(other)
		if err != nil {
			return nil, errContentAuditStore
		}
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			path = resolved
		}
		if absolute == path || strings.HasPrefix(absolute, path+string(os.PathSeparator)) || strings.HasPrefix(path, absolute+string(os.PathSeparator)) {
			return nil, errContentAuditStore
		}
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errContentAuditStore
	}
	s := &contentAuditStore{directory: absolute, rootInfo: info, namespace: contentAuditNamespace{Version: model.ContentAuditFormatVersion, Mode: "plaintext"}}
	// Do not mistake common.CryptoSecret's process-random default for a stable
	// at-rest key. Never fall back to plaintext after cryptographic failure.
	if !stableCryptoSecretConfigured() {
		return s, nil
	}
	secret := os.Getenv("CRYPTO_SECRET")
	if strings.TrimSpace(secret) == "" {
		secret = os.Getenv("SESSION_SECRET")
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, []byte(secret), nil, []byte("new-api/content-audit/storage/v1")), key); err != nil {
		return nil, errContentAuditStore
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errContentAuditStore
	}
	s.aead, err = cipher.NewGCM(block)
	if err != nil {
		return nil, errContentAuditStore
	}
	digest := sha256.Sum256(key)
	s.namespace.Mode, s.namespace.KeyID = "aes-gcm", hex.EncodeToString(digest[:16])
	return s, nil
}

// initialize is an explicit root operation. Ordinary startup never creates a
// missing mount, marker, or namespace. A half-completed initialization can only
// be adopted explicitly, with the same key and mode, never silently replaced.
func (s *contentAuditStore) initialize(allowPlaintext bool) error {
	if s.aead == nil && !allowPlaintext {
		return model.ErrContentAuditInvalid
	}
	root, err := os.OpenRoot(s.directory)
	if err != nil {
		return errContentAuditStore
	}
	defer root.Close()
	var existing contentAuditNamespace
	data, err := readContentAuditFile(root, contentAuditMarker, 2048)
	if err == nil {
		if common.Unmarshal(data, &existing) != nil || existing.Version != model.ContentAuditFormatVersion || !model.ValidContentAuditID(existing.StorageID) || existing.Mode != s.namespace.Mode || existing.KeyID != s.namespace.KeyID {
			return errContentAuditStore
		}
		s.namespace = existing
	} else {
		if !errors.Is(err, os.ErrNotExist) {
			return errContentAuditStore
		}
		entries, err := root.Open(".")
		if err != nil {
			return errContentAuditStore
		}
		names, readErr := entries.ReadDir(1)
		_ = entries.Close()
		if readErr != io.EOF || len(names) != 0 {
			return errContentAuditStore
		}
		s.namespace.StorageID = contentAuditRandomID()
		data, err := common.Marshal(s.namespace)
		if err != nil {
			return errContentAuditStore
		}
		file, err := root.OpenFile(contentAuditMarker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return errContentAuditStore
		}
		_, writeErr := file.Write(data)
		syncErr := file.Sync()
		closeErr := file.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			return errContentAuditStore
		}
	}
	for _, directory := range []string{"attempts"} {
		if err := root.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return errContentAuditStore
		}
		info, err := root.Lstat(directory)
		if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
			return errContentAuditStore
		}
	}
	return syncContentAuditDirectory(root)
}

func (s *contentAuditStore) open(state *model.ContentAuditStorageState) (*os.Root, error) {
	if state.StorageID == "" || state.Mode != s.namespace.Mode || state.KeyID != s.namespace.KeyID {
		return nil, errContentAuditStore
	}
	root, err := os.OpenRoot(s.directory)
	if err != nil {
		return nil, errContentAuditStore
	}
	data, err := readContentAuditFile(root, contentAuditMarker, 2048)
	var marker contentAuditNamespace
	if err != nil || common.Unmarshal(data, &marker) != nil || marker.StorageID != state.StorageID || marker.Mode != state.Mode || marker.KeyID != state.KeyID || marker.Version != model.ContentAuditFormatVersion {
		_ = root.Close()
		return nil, errContentAuditStore
	}
	info, err := root.Stat(".")
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 || !os.SameFile(info, s.rootInfo) {
		_ = root.Close()
		return nil, errContentAuditStore
	}
	info, err = root.Lstat("attempts")
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		_ = root.Close()
		return nil, errContentAuditStore
	}
	entries, err := root.Open(".")
	if err != nil {
		_ = root.Close()
		return nil, errContentAuditStore
	}
	names, readErr := entries.ReadDir(4)
	_ = entries.Close()
	if (readErr != nil && readErr != io.EOF) || (len(names) != 2 && len(names) != 3) {
		_ = root.Close()
		return nil, errContentAuditStore
	}
	// A retained legacy probes directory is tolerated without reading, writing,
	// or deleting its contents. New stores have no probes directory.
	for _, entry := range names {
		if entry.Name() != contentAuditMarker && entry.Name() != "attempts" && entry.Name() != "probes" {
			_ = root.Close()
			return nil, errContentAuditStore
		}
	}
	return root, nil
}

func (s *contentAuditStore) space(capacity int64) (uint64, uint64, error) {
	readUsage := s.usage
	if readUsage == nil {
		readUsage = disk.Usage
	}
	usage, err := readUsage(s.directory)
	if err != nil || usage == nil {
		return 0, 0, errContentAuditStore
	}
	if usage.Free < uint64(max(int64(64<<20), capacity/20)) || (usage.InodesTotal > 0 && usage.InodesFree < 1024) {
		return usage.Free, usage.InodesFree, errContentAuditStore
	}
	return usage.Free, usage.InodesFree, nil
}

// Check actual disk headroom before each bounded physical write.
func (s *contentAuditStore) checkWriteSpace(ctx context.Context, amount int64) error {
	state, err := model.GetContentAuditState(ctx)
	if err != nil || amount < 0 {
		return errContentAuditStore
	}
	free, _, err := s.space(state.CapacityBytes)
	if err != nil {
		return err
	}
	floor := uint64(max(int64(64<<20), state.CapacityBytes/20))
	if uint64(amount) > free-floor {
		return errContentAuditStore
	}
	return nil
}

func readContentAuditFile(root *os.Root, name string, limit int64) ([]byte, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > limit {
		return nil, errContentAuditFile
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errContentAuditFile
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errContentAuditFile
	}
	return data, nil
}

func syncContentAuditDirectory(root *os.Root) error {
	file, err := root.Open(".")
	if err != nil {
		return errContentAuditStore
	}
	defer file.Close()
	if file.Sync() != nil {
		return errContentAuditStore
	}
	return nil
}

func contentAuditAttemptDirectory(auditID, attempt string) (string, error) {
	if !model.ValidContentAuditID(auditID) || !model.ValidContentAuditID(attempt) {
		return "", errContentAuditFile
	}
	return auditID + "-" + attempt, nil
}

func openContentAuditDirectory(root *os.Root, name string) (*os.Root, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errContentAuditFile
	}
	return root.OpenRoot(name)
}

func (s *contentAuditStore) envelope(storageID, auditID, attempt, fileID, kind string, plain []byte, compressed bool) ([]byte, error) {
	if len(plain) > contentAuditMaxFile {
		return nil, errContentAuditFile
	}
	header := make([]byte, contentAuditHeaderSize)
	copy(header, "NACA0001")
	binary.BigEndian.PutUint64(header[12:20], uint64(len(plain)))
	body := plain
	if compressed {
		header[9] = 1
		var buffer bytes.Buffer
		writer, err := gzip.NewWriterLevel(&buffer, gzip.BestSpeed)
		if err != nil {
			return nil, errContentAuditFile
		}
		if _, err := writer.Write(plain); err != nil {
			_ = writer.Close()
			return nil, errContentAuditFile
		}
		if writer.Close() != nil {
			return nil, errContentAuditFile
		}
		body = buffer.Bytes()
	}
	identity := []byte(storageID + "/" + auditID + "/" + attempt + "/" + fileID + "/" + kind + "/1")
	if s.aead != nil {
		header[8] = 1
		_, _ = rand.Read(header[20:32])
		aad := append(bytes.Clone(header), identity...)
		body = s.aead.Seal(nil, header[20:32], body, aad)
	} else {
		// Integrity is not authentication in explicitly acknowledged plaintext
		// mode; filesystem operators are inside that mode's trust boundary.
		hash := sha256.New()
		_, _ = hash.Write(identity)
		_, _ = hash.Write(header[:32])
		_, _ = hash.Write(body)
		copy(header[32:], hash.Sum(nil))
	}
	return append(header, body...), nil
}

func (s *contentAuditStore) decode(storageID, auditID, attempt, fileID, kind string, encoded []byte, limit int) ([]byte, error) {
	if len(encoded) < contentAuditHeaderSize || string(encoded[:8]) != "NACA0001" || encoded[9] > 1 || limit > contentAuditMaxFile {
		return nil, errContentAuditFile
	}
	header, body := encoded[:contentAuditHeaderSize], encoded[contentAuditHeaderSize:]
	length := binary.BigEndian.Uint64(header[12:20])
	if length > uint64(limit) {
		return nil, errContentAuditFile
	}
	identity := []byte(storageID + "/" + auditID + "/" + attempt + "/" + fileID + "/" + kind + "/1")
	if header[8] == 1 && s.aead != nil {
		aad := append(bytes.Clone(header), identity...)
		var err error
		body, err = s.aead.Open(nil, header[20:32], body, aad)
		if err != nil {
			return nil, errContentAuditFile
		}
	} else if header[8] == 0 && s.aead == nil {
		hash := sha256.New()
		_, _ = hash.Write(identity)
		_, _ = hash.Write(header[:32])
		_, _ = hash.Write(body)
		if !bytes.Equal(hash.Sum(nil), header[32:]) {
			return nil, errContentAuditFile
		}
	} else {
		return nil, errContentAuditFile
	}
	if header[9] == 1 {
		reader, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, errContentAuditFile
		}
		decoded, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
		closeErr := reader.Close()
		if err != nil || closeErr != nil || len(decoded) > limit || uint64(len(decoded)) != length {
			return nil, errContentAuditFile
		}
		return decoded, nil
	}
	if uint64(len(body)) != length {
		return nil, errContentAuditFile
	}
	return body, nil
}

// All files are independently randomized (except the immutable closed marker),
// exclusive, encrypted BEFORE any write, and atomically renamed on the same
// filesystem. No raw image or plaintext spool file is ever created.
func (s *contentAuditStore) write(ctx context.Context, root *os.Root, storageID, auditID, attempt, fileID, kind string, data []byte, compressed bool, remaining *int64) (int64, error) {
	if fileID != "closed" && !model.ValidContentAuditID(fileID) {
		return 0, errContentAuditFile
	}
	encoded, err := s.envelope(storageID, auditID, attempt, fileID, kind, data, compressed)
	if err != nil || int64(len(encoded)) > *remaining {
		return 0, errContentAuditFile
	}
	// Charge before issuing I/O, including a partial write on error. A failed
	// attempt retains its ENTIRE database reservation until confirmed deletion.
	s.physicalMu.Lock()
	defer s.physicalMu.Unlock()
	if err := s.checkWriteSpace(ctx, int64(len(encoded))); err != nil {
		return 0, err
	}
	*remaining -= int64(len(encoded))
	file, err := root.OpenFile(fileID+".tmp", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return 0, errContentAuditStore
	}
	_, writeErr := file.Write(encoded)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return 0, errContentAuditStore
	}
	if _, err := root.Lstat(fileID + ".bin"); !errors.Is(err, os.ErrNotExist) {
		return 0, errContentAuditFile
	}
	if root.Rename(fileID+".tmp", fileID+".bin") != nil || syncContentAuditDirectory(root) != nil {
		return 0, errContentAuditStore
	}
	return int64(len(encoded)), nil
}

func (s *contentAuditStore) beginAttempt(state *model.ContentAuditStorageState, record *model.ContentAudit) (*os.Root, error) {
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
	if attempts.Mkdir(name, 0700) != nil || syncContentAuditDirectory(attempts) != nil {
		return nil, errContentAuditStore
	}
	return openContentAuditDirectory(attempts, name)
}

func (s *contentAuditStore) read(state *model.ContentAuditStorageState, record *model.ContentAudit, file model.ContentAuditFile) ([]byte, error) {
	if !model.ValidContentAuditID(file.ID) || file.PlainBytes < 0 || file.PlainBytes > contentAuditMaxFile || file.Bytes > contentAuditMaxFile+65536 {
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
	encoded, err := readContentAuditFile(directory, file.ID+".bin", file.Bytes)
	if err != nil || int64(len(encoded)) != file.Bytes {
		return nil, errContentAuditFile
	}
	return s.decode(record.StorageID, record.AuditID, record.Attempt, file.ID, file.Kind, encoded, file.PlainBytes)
}

func (s *contentAuditStore) closedAttempt(state *model.ContentAuditStorageState, auditID, attempt string) (*contentAuditClosedAttempt, error) {
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
	name, err := contentAuditAttemptDirectory(auditID, attempt)
	if err != nil {
		return nil, err
	}
	directory, err := openContentAuditDirectory(attempts, name)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	encoded, err := readContentAuditFile(directory, "closed.bin", 16384)
	if err != nil {
		return nil, err
	}
	data, err := s.decode(state.StorageID, auditID, attempt, "closed", "closed", encoded, 8192)
	if err != nil {
		return nil, err
	}
	var closed contentAuditClosedAttempt
	if common.Unmarshal(data, &closed) != nil || closed.AuditID != auditID || closed.Attempt != attempt || !model.ValidContentAuditID(closed.Owner) || len(closed.Files) > 5 {
		return nil, errContentAuditFile
	}
	return &closed, nil
}

func (s *contentAuditStore) deleteAttempt(ctx context.Context, state *model.ContentAuditStorageState, auditID, attempt string) error {
	root, err := s.open(state)
	if err != nil {
		return err
	}
	defer root.Close()
	attempts, err := openContentAuditDirectory(root, "attempts")
	if err != nil {
		return errContentAuditStore
	}
	defer attempts.Close()
	name, err := contentAuditAttemptDirectory(auditID, attempt)
	if err != nil {
		return err
	}
	directory, err := openContentAuditDirectory(attempts, name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errContentAuditStore
	}
	defer directory.Close()
	// A ready/closed v2 namespace is disposable only after its authenticated
	// manifest accounts for every boundedly inspected file, not by ID shape.
	var record model.ContentAudit
	lookup := model.DB.WithContext(ctx).Where("audit_id = ? AND attempt = ?", auditID, attempt).Limit(1).Find(&record)
	if lookup.Error != nil {
		return lookup.Error
	}
	closed, closedErr := s.closedAttempt(state, auditID, attempt)
	strict := record.DeletionAuthorization != "" || (record.FormatVersion == 2 && record.ReservedBytes == 0) || (closedErr == nil && closed.Version == 2)
	if strict {
		if lookup.RowsAffected == 0 {
			// A v2 orphan has no durable owner for deletion authorization.
			return errContentAuditFile
		}
		authorization, err := s.prepareAttemptDeletion(ctx, state, &record, directory)
		if err != nil {
			return err
		}
		if err := s.deleteAuthorizedAttemptContents(ctx, state, &record, directory, authorization); err != nil {
			return err
		}
		if err := attempts.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			return errContentAuditStore
		}
		return syncContentAuditDirectory(attempts)
	}
	// Confirmed stopped incomplete attempts cannot have a complete manifest.
	// Their existing reservation remains conservative until this whole deletion
	// succeeds; only the caller may then remove their row/release the charge.
	entries, err := directory.Open(".")
	if err != nil {
		return errContentAuditStore
	}
	// Validate the complete namespace before removing anything, then repeat in
	// bounded batches. Every entry is rechecked during the deletion pass.
	for pass := range 2 {
		for {
			files, readErr := entries.ReadDir(100)
			if readErr != nil && readErr != io.EOF {
				_ = entries.Close()
				return errContentAuditStore
			}
			for _, file := range files {
				base, extension, ok := strings.Cut(file.Name(), ".")
				if !ok || (!model.ValidContentAuditID(base) && base != "closed") || (extension != "bin" && extension != "tmp") || !file.Type().IsRegular() {
					_ = entries.Close()
					return errContentAuditFile
				}
				if pass == 1 {
					if err := directory.Remove(file.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
						_ = entries.Close()
						return errContentAuditStore
					}
				}
			}
			if readErr == io.EOF {
				break
			}
		}
		_ = entries.Close()
		if pass == 0 {
			entries, err = directory.Open(".")
			if err != nil {
				return errContentAuditStore
			}
		}
	}
	if syncContentAuditDirectory(directory) != nil {
		return errContentAuditStore
	}
	if err := attempts.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errContentAuditStore
	}
	return syncContentAuditDirectory(attempts)
}

// The envelope authenticates a bounded digest of immutable SQL references and
// the deletion fence. "metadata" additionally proves all image bodies were
// removed and the directory synced before any descriptor could disappear.
type contentAuditDeletionAuthorization struct {
	Version int                    `json:"version"`
	Fence   int64                  `json:"fence"`
	Digest  string                 `json:"digest"`
	Stage   string                 `json:"stage"`
	Payload model.ContentAuditFile `json:"payload"`
}

func contentAuditDeletionDigest(ctx context.Context, record *model.ContentAudit) (string, error) {
	if record.Status != model.ContentAuditDeleting || !record.WriterStopped || len(record.FilesJSON) > 8192 {
		return "", errContentAuditFile
	}
	digest := sha256.New()
	identity, err := common.Marshal([]any{record.StorageID, record.AuditID, record.Attempt, record.Owner, record.Fence, record.FormatVersion, record.FileBytes, record.ReservedBytes, record.FilesJSON})
	if err != nil {
		return "", err
	}
	_, _ = digest.Write(identity)
	after := -1
	for {
		rows, err := model.ListContentAuditImages(ctx, record, after, 100)
		if err != nil {
			return "", err
		}
		for _, row := range rows {
			data, err := common.Marshal(row)
			if err != nil {
				return "", err
			}
			_, _ = digest.Write(data)
			after = row.ImageIndex
		}
		if len(rows) < 100 {
			break
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func (s *contentAuditStore) saveDeletionAuthorization(ctx context.Context, record *model.ContentAudit, authorization *contentAuditDeletionAuthorization) error {
	data, err := common.Marshal(authorization)
	if err != nil || len(data) > 1024 {
		return errContentAuditFile
	}
	encoded, err := s.envelope(record.StorageID, record.AuditID, record.Attempt, record.AuditID, "delete_authorization", data, false)
	if err != nil {
		return err
	}
	return model.AuthorizeContentAuditDeletion(ctx, record, base64.StdEncoding.EncodeToString(encoded))
}

func (s *contentAuditStore) prepareAttemptDeletion(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, directory *os.Root) (*contentAuditDeletionAuthorization, error) {
	if record.StorageID != state.StorageID || record.Mode != state.Mode || record.KeyID != state.KeyID {
		return nil, errContentAuditFile
	}
	digest, err := contentAuditDeletionDigest(ctx, record)
	if err != nil {
		return nil, err
	}
	authorization := &contentAuditDeletionAuthorization{Version: 1, Fence: record.Fence, Digest: digest, Stage: "images"}
	if record.DeletionAuthorization == "" {
		closed, err := s.closedAttempt(state, record.AuditID, record.Attempt)
		if err != nil || closed.Version != 2 {
			return nil, errContentAuditFile
		}
		actual, count, err := inspectContentAuditAttempt(directory, ".")
		if err != nil {
			return nil, err
		}
		manifestRecord := *record
		manifestRecord.FormatVersion = 2
		if err := s.verifyAttemptManifest(ctx, state, &manifestRecord, directory, closed, actual, count); err != nil {
			return nil, err
		}
		authorization.Payload = closed.Files[0]
		// Persist only after the intact manifest AND exact namespace match.
		if err := s.verifyDeletionSubset(ctx, state, record, directory, authorization); err != nil {
			return nil, err
		}
		if err := s.saveDeletionAuthorization(ctx, record, authorization); err != nil {
			return nil, err
		}
	} else {
		if len(record.DeletionAuthorization) > 2048 {
			return nil, errContentAuditFile
		}
		encoded, err := base64.StdEncoding.DecodeString(record.DeletionAuthorization)
		if err != nil {
			return nil, errContentAuditFile
		}
		data, err := s.decode(record.StorageID, record.AuditID, record.Attempt, record.AuditID, "delete_authorization", encoded, 1024)
		if err != nil || common.Unmarshal(data, authorization) != nil || authorization.Version != 1 || authorization.Fence != record.Fence || authorization.Digest != digest || (authorization.Stage != "images" && authorization.Stage != "metadata") {
			return nil, errContentAuditFile
		}
	}
	if err := s.verifyDeletionSubset(ctx, state, record, directory, authorization); err != nil {
		return nil, err
	}
	return authorization, nil
}

func contentAuditDeletionLookup(record *model.ContentAudit, id string) string {
	if id == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(record.StorageID + "/" + record.AuditID + "/" + record.Attempt + "/" + id))
	return hex.EncodeToString(digest[:])
}

// Old rows may have NULL/empty hints. Rebuild from authenticated descriptors in
// one bounded pass; a failed/partial rebuild grants no deletion permission and
// the hints do not change the existing immutable authorization digest.
func (s *contentAuditStore) rebuildDeletionLookups(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit) error {
	after := -1
	for {
		rows, err := model.ListContentAuditImages(ctx, record, after, 100)
		if err != nil {
			return err
		}
		for _, row := range rows {
			descriptor, _, err := s.imageDescriptor(ctx, state, record, row)
			if err != nil {
				return err
			}
			original, thumbnail := "", ""
			if descriptor.Original != nil {
				original = contentAuditDeletionLookup(record, descriptor.Original.ID)
			}
			if descriptor.Thumbnail != nil {
				thumbnail = contentAuditDeletionLookup(record, descriptor.Thumbnail.ID)
			}
			if row.OriginalLookup != original || row.ThumbnailLookup != thumbnail {
				result := model.DB.WithContext(ctx).Model(&model.ContentAuditImage{}).
					Where("id = ? AND audit_id = ? AND attempt = ? AND descriptor_id = ?", row.ID, record.AuditID, record.Attempt, row.DescriptorID).
					Updates(map[string]any{"original_lookup": original, "thumbnail_lookup": thumbnail})
				if result.Error != nil {
					return result.Error
				}
				if result.RowsAffected != 1 {
					return model.ErrContentAuditOwnership
				}
			}
			after = row.ImageIndex
		}
		if len(rows) < 100 {
			return nil
		}
	}
}

// Exact membership with at most 100 names and 100 candidate rows in memory.
// Each index page is rebuilt once; each directory batch uses three independent
// indexed lookups, not a full-row rescan or an OR that can bypass the indexes.
// Hints only locate candidates: authenticated descriptors still decide names.
func (s *contentAuditStore) verifyDeletionSubset(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, directory *os.Root, authorization *contentAuditDeletionAuthorization) error {
	if authorization.Payload.Kind != "payload" || !model.ValidContentAuditID(authorization.Payload.ID) {
		return errContentAuditFile
	}
	if authorization.Stage == "images" {
		if err := s.rebuildDeletionLookups(ctx, state, record); err != nil {
			return err
		}
	}
	entries, err := directory.Open(".")
	if err != nil {
		return err
	}
	defer entries.Close()
	for {
		batch, readErr := entries.ReadDir(100)
		if readErr != nil && readErr != io.EOF {
			return readErr
		}
		unrecognized := make(map[string]bool, len(batch))
		ids := make([]string, 0, len(batch))
		lookups := make([]string, 0, len(batch))
		for _, entry := range batch {
			info, err := directory.Lstat(entry.Name())
			if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
				return errContentAuditFile
			}
			if entry.Name() == "closed.bin" || entry.Name() == authorization.Payload.ID+".bin" {
				continue
			}
			id, ok := strings.CutSuffix(entry.Name(), ".bin")
			if !ok || !model.ValidContentAuditID(id) {
				return errContentAuditFile
			}
			unrecognized[entry.Name()] = true
			ids = append(ids, id)
			lookups = append(lookups, contentAuditDeletionLookup(record, id))
		}
		columns := []string{"descriptor_id"}
		if authorization.Stage == "images" {
			columns = append(columns, "original_lookup", "thumbnail_lookup")
		}
		for _, column := range columns {
			values := lookups
			if column == "descriptor_id" {
				values = ids
			}
			if len(values) == 0 {
				continue
			}
			var afterID int64
			for {
				var rows []model.ContentAuditImage
				if err := model.DB.WithContext(ctx).
					Where("audit_id = ? AND attempt = ? AND committed = ? AND id > ?", record.AuditID, record.Attempt, true, afterID).
					Where(column+" IN ?", values).Order("id").Limit(100).Find(&rows).Error; err != nil {
					return err
				}
				for _, row := range rows {
					if !model.ValidContentAuditID(row.DescriptorID) {
						return errContentAuditFile
					}
					delete(unrecognized, row.DescriptorID+".bin")
					if authorization.Stage == "images" {
						descriptor, _, err := s.imageDescriptor(ctx, state, record, row)
						if err != nil {
							return err
						}
						if descriptor.Original != nil {
							delete(unrecognized, descriptor.Original.ID+".bin")
						}
						if descriptor.Thumbnail != nil {
							delete(unrecognized, descriptor.Thumbnail.ID+".bin")
						}
					}
					afterID = row.ID
				}
				if len(rows) < 100 {
					break
				}
			}
		}
		if len(unrecognized) != 0 {
			return errContentAuditFile
		}
		if readErr == io.EOF {
			return nil
		}
	}
}

// Image bodies must disappear while their authenticated descriptor remains.
// This is a production deletion unit, also the actual interruption boundary.
func (s *contentAuditStore) deleteAuthorizedImage(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, directory *os.Root, row model.ContentAuditImage) error {
	descriptor, _, err := s.imageDescriptor(ctx, state, record, row)
	if err != nil {
		return err
	}
	var ids []string
	if descriptor.Original != nil {
		ids = append(ids, descriptor.Original.ID)
	}
	if descriptor.Thumbnail != nil {
		ids = append(ids, descriptor.Thumbnail.ID)
	}
	for _, id := range ids {
		if err := directory.Remove(id + ".bin"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *contentAuditStore) deleteAuthorizedAttemptContents(ctx context.Context, state *model.ContentAuditStorageState, record *model.ContentAudit, directory *os.Root, authorization *contentAuditDeletionAuthorization) error {
	if authorization.Stage == "images" {
		after := -1
		for {
			rows, err := model.ListContentAuditImages(ctx, record, after, 100)
			if err != nil {
				return err
			}
			for _, row := range rows {
				if err := s.deleteAuthorizedImage(ctx, state, record, directory, row); err != nil {
					return err
				}
				after = row.ImageIndex
			}
			if len(rows) < 100 {
				break
			}
		}
		if err := syncContentAuditDirectory(directory); err != nil {
			return err
		}
		next := *authorization
		next.Stage = "metadata"
		// Confirm there is no image body/unknown name left before committing
		// the phase that permits its identifying descriptor to disappear.
		if err := s.verifyDeletionSubset(ctx, state, record, directory, &next); err != nil {
			return err
		}
		if err := s.saveDeletionAuthorization(ctx, record, &next); err != nil {
			return err
		}
		*authorization = next
	}
	// Each retry has already authenticated metadata-only membership. No
	// descriptor bytes are needed now; their immutable child rows stay in SQL.
	after := -1
	for {
		rows, err := model.ListContentAuditImages(ctx, record, after, 100)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if err := directory.Remove(row.DescriptorID + ".bin"); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			after = row.ImageIndex
		}
		if len(rows) < 100 {
			break
		}
	}
	for _, name := range []string{authorization.Payload.ID + ".bin", "closed.bin"} {
		if err := directory.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return syncContentAuditDirectory(directory)
}

package service

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"filippo.io/age"
	"filippo.io/age/armor"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	backupFileName           = "new-api-backup.age"
	backupDefaultDescription = "New-API Auto Backup"
	backupCipherPrefix       = "v1."
	backupManifestVersion    = 1
	backupMaxDumpSize        = 128 * 1024 * 1024
)

var backupRunMu sync.Mutex

type BackupSettingsView struct {
	Enabled                bool   `json:"enabled"`
	IntervalHours          int    `json:"interval_hours"`
	GistID                 string `json:"gist_id"`
	GistDescription        string `json:"gist_description"`
	GitHubTokenConfigured  bool   `json:"github_token_configured"`
	AgeIdentityConfigured  bool   `json:"age_identity_configured"`
	AgeRecipient           string `json:"age_recipient"`
	CryptoSecretConfigured bool   `json:"crypto_secret_configured"`
	DatabaseType           string `json:"database_type"`
	Supported              bool   `json:"supported"`
	LastBackupHash         string `json:"last_backup_hash"`
	LastBackupRevision     string `json:"last_backup_revision"`
	LastBackupAt           int64  `json:"last_backup_at"`
	LastBackupSize         int64  `json:"last_backup_size"`
	LastBackupStatus       string `json:"last_backup_status"`
	LastBackupError        string `json:"last_backup_error"`
	LastCheckedAt          int64  `json:"last_checked_at"`
}

type UpdateBackupSettingsRequest struct {
	Enabled          *bool   `json:"enabled"`
	IntervalHours    *int    `json:"interval_hours"`
	GistID           *string `json:"gist_id"`
	GistDescription  *string `json:"gist_description"`
	GitHubToken      string  `json:"github_token"`
	AgeIdentity      string  `json:"age_identity"`
	ClearGitHubToken bool    `json:"clear_github_token"`
	ClearAgeIdentity bool    `json:"clear_age_identity"`
}

type BackupRevision struct {
	Version     string `json:"version"`
	CommittedAt string `json:"committed_at"`
	URL         string `json:"url,omitempty"`
}

type BackupTaskState struct {
	Stage    string `json:"stage"`
	Progress int    `json:"progress"`
}

type BackupTaskResult struct {
	Status   string `json:"status"`
	Hash     string `json:"hash,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Revision string `json:"revision,omitempty"`
}

type BackupRestorePayload struct {
	Revision string `json:"revision"`
}

type BackupManifest struct {
	Version       int    `json:"version"`
	CreatedAt     int64  `json:"created_at"`
	DatabaseType  string `json:"database_type"`
	DumpFile      string `json:"dump_file"`
	DumpSHA256    string `json:"dump_sha256"`
	ContentSHA256 string `json:"content_sha256,omitempty"`
	DumpSize      int64  `json:"dump_size"`
}

type gistFile struct {
	Filename  string `json:"filename"`
	RawURL    string `json:"raw_url"`
	Size      int    `json:"size"`
	Truncated bool   `json:"truncated"`
	Content   string `json:"content"`
}

type gistHistory struct {
	Version     string `json:"version"`
	CommittedAt string `json:"committed_at"`
	URL         string `json:"url"`
}

type gistResponse struct {
	ID          string              `json:"id"`
	Description string              `json:"description"`
	Public      bool                `json:"public"`
	Files       map[string]gistFile `json:"files"`
	History     []gistHistory       `json:"history"`
}

type gistClient struct {
	token  string
	client *http.Client
}

func newGistClient(token string) *gistClient {
	return &gistClient{
		token:  strings.TrimSpace(token),
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (g *gistClient) request(ctx context.Context, method, path string, body any, result any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := common.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.github.com"+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Authorization", "Bearer "+g.token)
	req.Header.Set("User-Agent", "New-API-backup")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var payload struct {
			Message string `json:"message"`
		}
		_ = common.Unmarshal(responseBody, &payload)
		if payload.Message == "" {
			payload.Message = strings.TrimSpace(string(responseBody))
		}
		return fmt.Errorf("GitHub API returned HTTP %d: %s", resp.StatusCode, payload.Message)
	}
	if result == nil || len(responseBody) == 0 {
		return nil
	}
	if err := common.Unmarshal(responseBody, result); err != nil {
		return fmt.Errorf("invalid GitHub API response: %w", err)
	}
	return nil
}

func (g *gistClient) getGist(ctx context.Context, id string, revision string) (*gistResponse, error) {
	path := "/gists/" + url.PathEscape(id)
	if revision != "" {
		path += "/" + url.PathEscape(revision)
	}
	var gist gistResponse
	if err := g.request(ctx, http.MethodGet, path, nil, &gist); err != nil {
		return nil, err
	}
	return &gist, nil
}

func (g *gistClient) locateGist(ctx context.Context, settings *model.BackupSettings) (*gistResponse, error) {
	if settings.GistID != "" {
		gist, err := g.getGist(ctx, settings.GistID, "")
		if err != nil {
			return nil, err
		}
		if gist.Public {
			return nil, errors.New("configured Gist is public; create or select a private Gist")
		}
		return gist, nil
	}
	var gists []gistResponse
	if err := g.request(ctx, http.MethodGet, "/gists?per_page=100&page=1", nil, &gists); err != nil {
		return nil, err
	}
	for i := range gists {
		if gists[i].Description == settings.GistDescription {
			gist, err := g.getGist(ctx, gists[i].ID, "")
			if err != nil {
				return nil, err
			}
			if gist.Public {
				return nil, errors.New("configured Gist is public; create or select a private Gist")
			}
			return gist, nil
		}
	}
	return nil, nil
}

func (g *gistClient) downloadFile(ctx context.Context, gist *gistResponse, _ string) (string, error) {
	file, ok := gist.Files[backupFileName]
	if !ok {
		return "", errors.New("backup file not found in Gist")
	}
	if !file.Truncated && file.Content != "" {
		return file.Content, nil
	}
	if file.RawURL == "" {
		return "", errors.New("Gist backup file has no raw URL")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, file.RawURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+g.token)
	request.Header.Set("User-Agent", "New-API-backup")
	response, err := g.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("failed to download Gist file: HTTP %d", response.StatusCode)
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, 256*1024*1024))
	return string(content), err
}

func (g *gistClient) upload(ctx context.Context, settings *model.BackupSettings, content string) (*gistResponse, error) {
	files := map[string]map[string]string{
		backupFileName: {"content": content},
	}
	gist, err := g.locateGist(ctx, settings)
	if err != nil {
		return nil, err
	}
	if gist == nil {
		var created gistResponse
		err = g.request(ctx, http.MethodPost, "/gists", map[string]any{
			"description": settings.GistDescription,
			"public":      false,
			"files":       files,
		}, &created)
		if err != nil {
			return nil, err
		}
		return &created, nil
	}
	var updated gistResponse
	err = g.request(ctx, http.MethodPatch, "/gists/"+url.PathEscape(gist.ID), map[string]any{
		"files": files,
	}, &updated)
	if err != nil {
		return nil, err
	}
	return &updated, nil
}

func stableCryptoSecretConfigured() bool {
	return strings.TrimSpace(os.Getenv("CRYPTO_SECRET")) != "" || strings.TrimSpace(os.Getenv("SESSION_SECRET")) != ""
}

func backupSecretKey() [32]byte {
	return sha256.Sum256([]byte("new-api-backup-settings-v1:" + common.CryptoSecret))
}

func encryptBackupSetting(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	key := backupSecretKey()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(value), []byte("new-api-backup-settings-v1"))
	return backupCipherPrefix + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decryptBackupSetting(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if !strings.HasPrefix(value, backupCipherPrefix) {
		return "", errors.New("invalid backup secret ciphertext")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, backupCipherPrefix))
	if err != nil {
		return "", err
	}
	key := backupSecretKey()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", errors.New("invalid backup secret ciphertext")
	}
	plaintext, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], []byte("new-api-backup-settings-v1"))
	if err != nil {
		return "", errors.New("unable to decrypt backup secret; verify CRYPTO_SECRET")
	}
	return string(plaintext), nil
}

func backupSettingsView(settings *model.BackupSettings) BackupSettingsView {
	return BackupSettingsView{
		Enabled:                settings.Enabled,
		IntervalHours:          settings.IntervalHours,
		GistID:                 settings.GistID,
		GistDescription:        settings.GistDescription,
		GitHubTokenConfigured:  settings.GitHubTokenCiphertext != "",
		AgeIdentityConfigured:  settings.AgeIdentityCiphertext != "",
		AgeRecipient:           settings.AgeRecipient,
		CryptoSecretConfigured: stableCryptoSecretConfigured(),
		DatabaseType:           string(common.MainDatabaseType()),
		Supported:              common.UsingMainDatabase(common.DatabaseTypePostgreSQL),
		LastBackupHash:         settings.LastBackupHash,
		LastBackupRevision:     settings.LastBackupRevision,
		LastBackupAt:           settings.LastBackupAt,
		LastBackupSize:         settings.LastBackupSize,
		LastBackupStatus:       settings.LastBackupStatus,
		LastBackupError:        settings.LastBackupError,
		LastCheckedAt:          settings.LastCheckedAt,
	}
}

func GetBackupSettingsView() (BackupSettingsView, error) {
	settings, err := model.GetBackupSettings()
	if err != nil {
		return BackupSettingsView{}, err
	}
	return backupSettingsView(settings), nil
}

func UpdateBackupSettings(request UpdateBackupSettingsRequest) (BackupSettingsView, error) {
	settings, err := model.GetBackupSettings()
	if err != nil {
		return BackupSettingsView{}, err
	}
	if request.Enabled != nil {
		settings.Enabled = *request.Enabled
	}
	if request.IntervalHours != nil {
		if *request.IntervalHours < 1 || *request.IntervalHours > 8760 {
			return BackupSettingsView{}, errors.New("backup interval must be between 1 and 8760 hours")
		}
		settings.IntervalHours = *request.IntervalHours
	}
	if request.GistID != nil {
		settings.GistID = strings.TrimSpace(*request.GistID)
	}
	if request.GistDescription != nil {
		description := strings.TrimSpace(*request.GistDescription)
		if description == "" || len(description) > 255 {
			return BackupSettingsView{}, errors.New("Gist description must be between 1 and 255 characters")
		}
		settings.GistDescription = description
	}
	if strings.TrimSpace(request.GitHubToken) != "" {
		if !stableCryptoSecretConfigured() {
			return BackupSettingsView{}, errors.New("set a stable CRYPTO_SECRET or SESSION_SECRET before storing backup credentials")
		}
		settings.GitHubTokenCiphertext, err = encryptBackupSetting(strings.TrimSpace(request.GitHubToken))
		if err != nil {
			return BackupSettingsView{}, err
		}
	}
	if request.ClearGitHubToken {
		settings.GitHubTokenCiphertext = ""
	}
	if strings.TrimSpace(request.AgeIdentity) != "" {
		if !stableCryptoSecretConfigured() {
			return BackupSettingsView{}, errors.New("set a stable CRYPTO_SECRET or SESSION_SECRET before storing backup credentials")
		}
		identity, err := age.ParseX25519Identity(strings.TrimSpace(request.AgeIdentity))
		if err != nil {
			return BackupSettingsView{}, errors.New("invalid age X25519 identity")
		}
		settings.AgeRecipient = identity.Recipient().String()
		settings.AgeIdentityCiphertext, err = encryptBackupSetting(identity.String())
		if err != nil {
			return BackupSettingsView{}, err
		}
	}
	if request.ClearAgeIdentity {
		settings.AgeIdentityCiphertext = ""
		settings.AgeRecipient = ""
	}
	if err := model.DB.Save(settings).Error; err != nil {
		return BackupSettingsView{}, err
	}
	return backupSettingsView(settings), nil
}

func sanitizePostgresDSN(dsn string) (string, string, error) {
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return "", "", errors.New("SQL_DSN is not a PostgreSQL URL")
	}
	password := ""
	if parsed.User != nil {
		username := parsed.User.Username()
		if parsedPassword, hasPassword := parsed.User.Password(); hasPassword {
			password = parsedPassword
		}
		parsed.User = url.User(username)
	}
	return parsed.String(), password, nil
}

func fingerprintPostgresDump(ctx context.Context, dumpPath string) (string, error) {
	if _, err := exec.LookPath("pg_restore"); err != nil {
		return "", errors.New("pg_restore is not installed in the New-API runtime image")
	}
	command := exec.CommandContext(ctx, "pg_restore", "--no-owner", "--no-privileges", "--file=-", dumpPath)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return "", err
	}

	hash := sha256.New()
	reader := bufio.NewReader(stdout)
	seenRestrict := false
	startedDump := false
	var readErr error
	for {
		var line []byte
		line, readErr = reader.ReadBytes('\n')
		if len(line) > 0 {
			if !startedDump && bytes.HasPrefix(line, []byte("\\restrict ")) {
				seenRestrict = true
			} else if seenRestrict && bytes.HasPrefix(line, []byte("\\unrestrict ")) {
				continue
			} else {
				_, _ = hash.Write(line)
				if !startedDump {
					trimmed := bytes.TrimSpace(line)
					startedDump = len(trimmed) > 0 && !bytes.HasPrefix(trimmed, []byte("--"))
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			readErr = nil
			break
		}
		if readErr != nil {
			break
		}
	}
	waitErr := command.Wait()
	if readErr != nil {
		return "", readErr
	}
	if waitErr != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = waitErr.Error()
		}
		return "", fmt.Errorf("pg_restore fingerprint failed: %s", message)
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func dumpPostgres(ctx context.Context) (string, string, string, int64, error) {
	if !common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		return "", "", "", 0, errors.New("database backup currently supports PostgreSQL only")
	}
	dsn := strings.TrimSpace(os.Getenv("SQL_DSN"))
	if dsn == "" {
		return "", "", "", 0, errors.New("SQL_DSN is not configured")
	}
	safeDSN, password, err := sanitizePostgresDSN(dsn)
	if err != nil {
		return "", "", "", 0, err
	}
	if _, err := exec.LookPath("pg_dump"); err != nil {
		return "", "", "", 0, errors.New("pg_dump is not installed in the New-API runtime image")
	}
	if _, err := exec.LookPath("pg_restore"); err != nil {
		return "", "", "", 0, errors.New("pg_restore is not installed in the New-API runtime image")
	}
	file, err := os.CreateTemp("", "new-api-postgres-*.dump")
	if err != nil {
		return "", "", "", 0, err
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		os.Remove(path)
		return "", "", "", 0, err
	}
	defer func() { _ = os.Remove(path) }()
	command := exec.CommandContext(ctx, "pg_dump", "--dbname="+safeDSN, "--format=custom", "--no-owner", "--no-privileges", "--file="+path)
	command.Env = os.Environ()
	if password != "" {
		command.Env = append(command.Env, "PGPASSWORD="+password)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", "", "", 0, fmt.Errorf("pg_dump failed: %s", message)
	}
	stat, err := os.Stat(path)
	if err != nil {
		return "", "", "", 0, err
	}
	if stat.Size() <= 0 || stat.Size() > backupMaxDumpSize {
		return "", "", "", 0, fmt.Errorf("database dump size %d is outside the supported range", stat.Size())
	}
	dump, err := os.Open(path)
	if err != nil {
		return "", "", "", 0, err
	}
	rawHash := sha256.New()
	_, copyErr := io.Copy(rawHash, dump)
	closeErr := dump.Close()
	if copyErr != nil {
		return "", "", "", 0, copyErr
	}
	if closeErr != nil {
		return "", "", "", 0, closeErr
	}
	contentHash, err := fingerprintPostgresDump(ctx, path)
	if err != nil {
		return "", "", "", 0, err
	}
	return path, fmt.Sprintf("%x", rawHash.Sum(nil)), contentHash, stat.Size(), nil
}

func buildBackupPayload(dumpPath, dumpHash, contentHash string, dumpSize int64) ([]byte, error) {
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	tarWriter := tar.NewWriter(gzipWriter)
	manifest := BackupManifest{
		Version:       backupManifestVersion,
		CreatedAt:     time.Now().Unix(),
		DatabaseType:  string(common.MainDatabaseType()),
		DumpFile:      "database.dump",
		DumpSHA256:    dumpHash,
		ContentSHA256: contentHash,
		DumpSize:      dumpSize,
	}
	manifestBytes, err := common.Marshal(manifest)
	if err != nil {
		return nil, err
	}
	if err := tarWriter.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0600, Size: int64(len(manifestBytes)), ModTime: time.Unix(0, 0)}); err != nil {
		return nil, err
	}
	if _, err := tarWriter.Write(manifestBytes); err != nil {
		return nil, err
	}
	dump, err := os.Open(dumpPath)
	if err != nil {
		return nil, err
	}
	if err := tarWriter.WriteHeader(&tar.Header{Name: manifest.DumpFile, Mode: 0600, Size: dumpSize, ModTime: time.Unix(0, 0)}); err != nil {
		_ = dump.Close()
		return nil, err
	}
	if _, err := io.Copy(tarWriter, dump); err != nil {
		_ = dump.Close()
		return nil, err
	}
	if err := dump.Close(); err != nil {
		return nil, err
	}
	if err := tarWriter.Close(); err != nil {
		return nil, err
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func encryptAgePayload(payload []byte, recipient string) (string, error) {
	parsedRecipient, err := age.ParseX25519Recipient(recipient)
	if err != nil {
		return "", errors.New("invalid age recipient")
	}
	var output bytes.Buffer
	armorWriter := armor.NewWriter(&output)
	encrypter, err := age.Encrypt(armorWriter, parsedRecipient)
	if err != nil {
		_ = armorWriter.Close()
		return "", err
	}
	if _, err := encrypter.Write(payload); err != nil {
		_ = encrypter.Close()
		_ = armorWriter.Close()
		return "", err
	}
	if err := encrypter.Close(); err != nil {
		_ = armorWriter.Close()
		return "", err
	}
	if err := armorWriter.Close(); err != nil {
		return "", err
	}
	return output.String(), nil
}

func decryptAgePayload(content, identity string) ([]byte, error) {
	parsedIdentity, err := age.ParseX25519Identity(identity)
	if err != nil {
		return nil, errors.New("invalid age identity")
	}
	reader, err := age.Decrypt(armor.NewReader(strings.NewReader(content)), parsedIdentity)
	if err != nil {
		return nil, errors.New("unable to decrypt backup; verify the age identity")
	}
	payload, err := io.ReadAll(io.LimitReader(reader, backupMaxDumpSize+16*1024*1024))
	if err != nil {
		return nil, err
	}
	return payload, nil
}

func readManifest(payload []byte) (BackupManifest, error) {
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return BackupManifest{}, errors.New("backup archive is not valid gzip data")
	}
	defer reader.Close()
	tarReader := tar.NewReader(reader)
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return BackupManifest{}, errors.New("backup archive is not valid tar data")
		}
		if header.Name != "manifest.json" {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(tarReader, 64*1024))
		if err != nil {
			return BackupManifest{}, err
		}
		var manifest BackupManifest
		if err := common.Unmarshal(data, &manifest); err != nil {
			return BackupManifest{}, errors.New("backup manifest is invalid")
		}
		if manifest.Version != backupManifestVersion ||
			manifest.DatabaseType != string(common.DatabaseTypePostgreSQL) ||
			manifest.DumpSHA256 == "" || manifest.DumpFile != "database.dump" ||
			manifest.DumpSize <= 0 || manifest.DumpSize > backupMaxDumpSize {
			return BackupManifest{}, errors.New("backup manifest is unsupported")
		}
		return manifest, nil
	}
	return BackupManifest{}, errors.New("backup manifest is missing")
}

func extractBackupDump(payload []byte) (string, BackupManifest, error) {
	manifest, err := readManifest(payload)
	if err != nil {
		return "", BackupManifest{}, err
	}
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return "", BackupManifest{}, err
	}
	tarReader := tar.NewReader(reader)
	file, err := os.CreateTemp("", "new-api-restore-*.dump")
	if err != nil {
		_ = reader.Close()
		return "", BackupManifest{}, err
	}
	path := file.Name()
	cleanup := func() {
		_ = file.Close()
		_ = reader.Close()
		_ = os.Remove(path)
	}
	found := false
	for {
		header, nextErr := tarReader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			cleanup()
			return "", BackupManifest{}, nextErr
		}
		if header.Name != manifest.DumpFile {
			continue
		}
		if header.Size <= 0 || header.Size > backupMaxDumpSize {
			cleanup()
			return "", BackupManifest{}, errors.New("backup dump size is invalid")
		}
		if _, err := io.CopyN(file, tarReader, header.Size); err != nil {
			cleanup()
			return "", BackupManifest{}, err
		}
		found = true
		break
	}
	if err := file.Close(); err != nil {
		cleanup()
		return "", BackupManifest{}, err
	}
	if err := reader.Close(); err != nil {
		_ = os.Remove(path)
		return "", BackupManifest{}, err
	}
	if !found {
		_ = os.Remove(path)
		return "", BackupManifest{}, errors.New("backup dump is missing")
	}
	dump, err := os.Open(path)
	if err != nil {
		_ = os.Remove(path)
		return "", BackupManifest{}, err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, dump)
	closeErr := dump.Close()
	if copyErr != nil {
		_ = os.Remove(path)
		return "", BackupManifest{}, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return "", BackupManifest{}, closeErr
	}
	if fmt.Sprintf("%x", hash.Sum(nil)) != manifest.DumpSHA256 {
		_ = os.Remove(path)
		return "", BackupManifest{}, errors.New("backup dump checksum does not match manifest")
	}
	return path, manifest, nil
}

func latestRevision(gist *gistResponse) string {
	if len(gist.History) == 0 {
		return ""
	}
	return gist.History[0].Version
}

func loadBackupCredentials(settings *model.BackupSettings) (string, string, error) {
	if settings.GitHubTokenCiphertext == "" {
		return "", "", errors.New("GitHub Token is not configured")
	}
	if settings.AgeIdentityCiphertext == "" {
		return "", "", errors.New("age identity is not configured")
	}
	token, err := decryptBackupSetting(settings.GitHubTokenCiphertext)
	if err != nil {
		return "", "", err
	}
	identity, err := decryptBackupSetting(settings.AgeIdentityCiphertext)
	if err != nil {
		return "", "", err
	}
	return token, identity, nil
}

func saveBackupState(settings *model.BackupSettings) error {
	return model.DB.Save(settings).Error
}

func PerformBackup(ctx context.Context, report func(stage string, progress int)) (BackupTaskResult, error) {
	backupRunMu.Lock()
	defer backupRunMu.Unlock()
	settings, err := model.GetBackupSettings()
	if err != nil {
		return BackupTaskResult{}, err
	}
	if report != nil {
		report("dumping", 10)
	}
	dumpPath, dumpHash, contentHash, dumpSize, err := dumpPostgres(ctx)
	if err != nil {
		settings.LastBackupStatus = "failed"
		settings.LastBackupError = err.Error()
		_ = saveBackupState(settings)
		return BackupTaskResult{}, err
	}
	credentialsToken, identity, err := loadBackupCredentials(settings)
	if err != nil {
		settings.LastBackupStatus = "failed"
		settings.LastBackupError = err.Error()
		_ = saveBackupState(settings)
		return BackupTaskResult{}, err
	}
	if report != nil {
		report("packaging", 35)
	}
	plainPayload, err := buildBackupPayload(dumpPath, dumpHash, contentHash, dumpSize)
	if err != nil {
		return BackupTaskResult{}, err
	}
	client := newGistClient(credentialsToken)
	gist, err := client.locateGist(ctx, settings)
	if err != nil {
		return BackupTaskResult{}, err
	}
	if gist != nil {
		remoteContent, remoteErr := client.downloadFile(ctx, gist, "")
		if remoteErr == nil {
			remotePayload, decryptErr := decryptAgePayload(remoteContent, identity)
			if decryptErr == nil {
				remoteManifest, manifestErr := readManifest(remotePayload)
				if manifestErr == nil && remoteManifest.ContentSHA256 != "" && remoteManifest.ContentSHA256 == contentHash {
					settings.GistID = gist.ID
					settings.LastCheckedAt = time.Now().Unix()
					settings.LastBackupStatus = "unchanged"
					settings.LastBackupError = ""
					if err := saveBackupState(settings); err != nil {
						return BackupTaskResult{}, err
					}
					if report != nil {
						report("unchanged", 100)
					}
					return BackupTaskResult{Status: "unchanged", Hash: dumpHash, Size: dumpSize, Revision: latestRevision(gist)}, nil
				}
			}
		}
	}
	if report != nil {
		report("encrypting", 60)
	}
	encrypted, err := encryptAgePayload(plainPayload, settings.AgeRecipient)
	if err != nil {
		return BackupTaskResult{}, err
	}
	if report != nil {
		report("uploading", 80)
	}
	uploaded, err := client.upload(ctx, settings, encrypted)
	if err != nil {
		settings.LastBackupStatus = "failed"
		settings.LastBackupError = err.Error()
		_ = saveBackupState(settings)
		return BackupTaskResult{}, err
	}
	settings.GistID = uploaded.ID
	settings.LastBackupHash = dumpHash
	settings.LastBackupRevision = latestRevision(uploaded)
	settings.LastBackupAt = time.Now().Unix()
	settings.LastBackupSize = dumpSize
	settings.LastCheckedAt = settings.LastBackupAt
	settings.LastBackupStatus = "succeeded"
	settings.LastBackupError = ""
	if err := saveBackupState(settings); err != nil {
		return BackupTaskResult{}, err
	}
	if report != nil {
		report("completed", 100)
	}
	return BackupTaskResult{Status: "succeeded", Hash: dumpHash, Size: dumpSize, Revision: settings.LastBackupRevision}, nil
}

func TestBackupConnection(ctx context.Context) (map[string]any, error) {
	settings, err := model.GetBackupSettings()
	if err != nil {
		return nil, err
	}
	token, identity, err := loadBackupCredentials(settings)
	if err != nil {
		return nil, err
	}
	if _, err := exec.LookPath("pg_dump"); err != nil {
		return nil, errors.New("pg_dump is not installed in the New-API runtime image")
	}
	if _, err := exec.LookPath("pg_restore"); err != nil {
		return nil, errors.New("pg_restore is not installed in the New-API runtime image")
	}
	parsedIdentity, err := age.ParseX25519Identity(identity)
	if err != nil || parsedIdentity.Recipient().String() != settings.AgeRecipient {
		return nil, errors.New("stored age identity does not match the configured recipient")
	}
	client := newGistClient(token)
	gist, err := client.locateGist(ctx, settings)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"gist_found": gist != nil, "gist_id": "", "database_type": common.MainDatabaseType()}
	if gist != nil {
		result["gist_id"] = gist.ID
		if gist.Public {
			return nil, errors.New("configured Gist is public; create or select a private Gist")
		}
	}
	return result, nil
}

func ListBackupRevisions(ctx context.Context) ([]BackupRevision, error) {
	settings, err := model.GetBackupSettings()
	if err != nil {
		return nil, err
	}
	token, _, err := loadBackupCredentials(settings)
	if err != nil {
		return nil, err
	}
	gist, err := newGistClient(token).locateGist(ctx, settings)
	if err != nil {
		return nil, err
	}
	if gist == nil {
		return []BackupRevision{}, nil
	}
	revisions := make([]BackupRevision, 0, len(gist.History))
	for _, item := range gist.History {
		revisions = append(revisions, BackupRevision{Version: item.Version, CommittedAt: item.CommittedAt, URL: item.URL})
	}
	return revisions, nil
}

func downloadBackupRevisionWithCredentials(ctx context.Context, settings *model.BackupSettings, token, identity, revision string) (string, []byte, BackupManifest, error) {
	client := newGistClient(token)
	gist, err := client.locateGist(ctx, settings)
	if err != nil {
		return "", nil, BackupManifest{}, err
	}
	if gist == nil {
		return "", nil, BackupManifest{}, errors.New("backup Gist has not been created")
	}
	if revision != "" {
		gist, err = client.getGist(ctx, gist.ID, revision)
		if err != nil {
			return "", nil, BackupManifest{}, err
		}
		if gist.Public {
			return "", nil, BackupManifest{}, errors.New("configured Gist is public; create or select a private Gist")
		}
	}
	content, err := client.downloadFile(ctx, gist, revision)
	if err != nil {
		return "", nil, BackupManifest{}, err
	}
	payload, err := decryptAgePayload(content, identity)
	if err != nil {
		return "", nil, BackupManifest{}, err
	}
	manifest, err := readManifest(payload)
	if err != nil {
		return "", nil, BackupManifest{}, err
	}
	return content, payload, manifest, nil
}

func downloadBackupRevision(ctx context.Context, revision string) (string, BackupManifest, error) {
	settings, err := model.GetBackupSettings()
	if err != nil {
		return "", BackupManifest{}, err
	}
	token, identity, err := loadBackupCredentials(settings)
	if err != nil {
		return "", BackupManifest{}, err
	}
	content, _, manifest, err := downloadBackupRevisionWithCredentials(ctx, settings, token, identity, revision)
	if err != nil {
		return "", BackupManifest{}, err
	}
	return content, manifest, nil
}

func VerifyBackup(ctx context.Context, revision string) (BackupManifest, error) {
	settings, err := model.GetBackupSettings()
	if err != nil {
		return BackupManifest{}, err
	}
	token, identity, err := loadBackupCredentials(settings)
	if err != nil {
		return BackupManifest{}, err
	}
	client := newGistClient(token)
	gist, err := client.locateGist(ctx, settings)
	if err != nil {
		return BackupManifest{}, err
	}
	if gist == nil {
		return BackupManifest{}, errors.New("backup Gist has not been created")
	}
	if revision != "" {
		gist, err = client.getGist(ctx, gist.ID, revision)
		if err != nil {
			return BackupManifest{}, err
		}
		if gist.Public {
			return BackupManifest{}, errors.New("configured Gist is public; create or select a private Gist")
		}
	}
	content, err := client.downloadFile(ctx, gist, revision)
	if err != nil {
		return BackupManifest{}, err
	}
	payload, err := decryptAgePayload(content, identity)
	if err != nil {
		return BackupManifest{}, err
	}
	dumpPath, manifest, err := extractBackupDump(payload)
	if err != nil {
		return BackupManifest{}, err
	}
	defer os.Remove(dumpPath)
	if _, err := exec.LookPath("pg_restore"); err != nil {
		return BackupManifest{}, errors.New("pg_restore is not installed in the New-API runtime image")
	}
	command := exec.CommandContext(ctx, "pg_restore", "--list", dumpPath)
	if output, err := command.CombinedOutput(); err != nil {
		return BackupManifest{}, fmt.Errorf("pg_restore validation failed: %s", strings.TrimSpace(string(output)))
	}
	settings.LastCheckedAt = time.Now().Unix()
	settings.LastBackupStatus = "verified"
	settings.LastBackupError = ""
	_ = saveBackupState(settings)
	return manifest, nil
}

func DownloadBackup(ctx context.Context, revision string) ([]byte, BackupManifest, error) {
	content, manifest, err := downloadBackupRevision(ctx, revision)
	if err != nil {
		return nil, BackupManifest{}, err
	}
	return []byte(content), manifest, nil
}

func EnqueueBackupTask() (*model.SystemTask, bool, error) {
	return EnqueueSystemTask(model.SystemTaskTypeBackup, nil)
}

func EnqueueBackupRestoreTask(revision string) (*model.SystemTask, bool, error) {
	revision = strings.TrimSpace(revision)
	if revision == "" {
		return nil, false, errors.New("backup revision is required")
	}
	return EnqueueSystemTask(model.SystemTaskTypeBackupRestore, BackupRestorePayload{Revision: revision})
}

func PerformBackupRestore(ctx context.Context, revision string, report func(stage string, progress int)) (BackupTaskResult, error) {
	backupRunMu.Lock()
	defer backupRunMu.Unlock()
	if !common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		return BackupTaskResult{}, errors.New("database restore currently supports PostgreSQL only")
	}
	settings, err := model.GetBackupSettings()
	if err != nil {
		return BackupTaskResult{}, err
	}
	token, identity, err := loadBackupCredentials(settings)
	if err != nil {
		return BackupTaskResult{}, err
	}
	if report != nil {
		report("downloading", 10)
	}
	_, payload, manifest, err := downloadBackupRevisionWithCredentials(ctx, settings, token, identity, revision)
	if err != nil {
		return BackupTaskResult{}, err
	}
	dumpPath, extractedManifest, err := extractBackupDump(payload)
	if err != nil {
		return BackupTaskResult{}, err
	}
	defer os.Remove(dumpPath)
	if extractedManifest.DumpSHA256 != manifest.DumpSHA256 {
		return BackupTaskResult{}, errors.New("selected backup revision changed while downloading")
	}
	if _, err := exec.LookPath("pg_restore"); err != nil {
		return BackupTaskResult{}, errors.New("pg_restore is not installed in the New-API runtime image")
	}
	dsn := strings.TrimSpace(os.Getenv("SQL_DSN"))
	safeDSN, password, err := sanitizePostgresDSN(dsn)
	if err != nil {
		return BackupTaskResult{}, err
	}
	if report != nil {
		report("restoring", 60)
	}
	args := []string{
		"--dbname=" + safeDSN,
		"--clean",
		"--if-exists",
		"--single-transaction",
		"--no-owner",
		"--no-privileges",
		"--exit-on-error",
		"--exclude-table=system_tasks",
		"--exclude-table=system_task_locks",
		"--exclude-table=backup_settings",
		dumpPath,
	}
	command := exec.CommandContext(ctx, "pg_restore", args...)
	command.Env = os.Environ()
	if password != "" {
		command.Env = append(command.Env, "PGPASSWORD="+password)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return BackupTaskResult{}, fmt.Errorf("pg_restore failed: %s", message)
	}
	if report != nil {
		report("completed", 100)
	}
	return BackupTaskResult{
		Status:   "restored",
		Hash:     manifest.DumpSHA256,
		Size:     manifest.DumpSize,
		Revision: revision,
	}, nil
}

type backupTaskHandler struct{}

func (backupTaskHandler) Type() string { return model.SystemTaskTypeBackup }

func (backupTaskHandler) Enabled() bool {
	settings, err := model.GetBackupSettings()
	return err == nil && settings.Enabled
}

func (backupTaskHandler) Interval() time.Duration {
	settings, err := model.GetBackupSettings()
	if err != nil || settings.IntervalHours <= 0 {
		return 24 * time.Hour
	}
	return time.Duration(settings.IntervalHours) * time.Hour
}

func (backupTaskHandler) NewPayload() any { return nil }

func (backupTaskHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	report := func(stage string, progress int) {
		_ = model.UpdateSystemTaskState(task.TaskID, runnerID, BackupTaskState{Stage: stage, Progress: progress})
	}
	report("starting", 0)
	result, err := PerformBackup(ctx, report)
	status := model.SystemTaskStatusSucceeded
	errorMessage := ""
	if err != nil {
		status = model.SystemTaskStatusFailed
		errorMessage = err.Error()
	}
	if finishErr := model.FinishSystemTask(task.TaskID, runnerID, status, result, errorMessage); finishErr != nil {
		common.SysLog(fmt.Sprintf("database backup task failed to persist result: %v", finishErr))
	}
}

type backupRestoreTaskHandler struct{}

func (backupRestoreTaskHandler) Type() string { return model.SystemTaskTypeBackupRestore }

func (backupRestoreTaskHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	payload := BackupRestorePayload{}
	if err := task.DecodePayload(&payload); err != nil {
		_ = model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusFailed, nil, err.Error())
		return
	}
	report := func(stage string, progress int) {
		_ = model.UpdateSystemTaskState(task.TaskID, runnerID, BackupTaskState{Stage: stage, Progress: progress})
	}
	report("starting", 0)
	result, err := PerformBackupRestore(ctx, payload.Revision, report)
	status := model.SystemTaskStatusSucceeded
	errorMessage := ""
	if err != nil {
		status = model.SystemTaskStatusFailed
		errorMessage = err.Error()
	}
	if finishErr := model.FinishSystemTask(task.TaskID, runnerID, status, result, errorMessage); finishErr != nil {
		common.SysLog(fmt.Sprintf("database restore task failed to persist result: %v", finishErr))
	}
}

func RegisterBackupSystemTaskHandler() {
	RegisterSystemTaskHandler(backupTaskHandler{})
	RegisterSystemTaskHandler(backupRestoreTaskHandler{})
}

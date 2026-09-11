package service

import (
	"context"
	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
	"net/http"
	"os"
	"time"
)

// DownloadGalleryOriginal is transient, owner-authenticated acquisition for a
// local draft. It never creates a GalleryImage or consumes cloud retention quota.
func DownloadGalleryOriginal(ctx context.Context, user int, raw string) (*os.File, string, func(), error) {
	client := newContentAuditImageClient()
	defer client.CloseIdleConnections()
	return downloadGalleryOriginal(ctx, user, raw, client)
}

func downloadGalleryOriginal(ctx context.Context, user int, raw string, client *http.Client) (*os.File, string, func(), error) {
	if user < 1 {
		return nil, "", nil, model.ErrGalleryInvalid
	}
	if _, err := contentAuditImageURL(raw); err != nil {
		return nil, "", nil, model.ErrGalleryInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	root, err := galleryRoot()
	if err != nil {
		return nil, "", nil, err
	}
	// A private request directory prevents cleanup/retention from seeing a draft
	// as a published original. Remove only this invocation's generated paths.
	temporary, err := os.MkdirTemp(root, ".original-")
	if err != nil {
		return nil, "", nil, model.ErrGalleryUnavailable
	}
	id := uuid.NewString()
	path, _ := galleryFilePath(temporary, id, "original")
	cleanup := func() { _ = os.Remove(path); _ = os.Remove(temporary) }
	writer, err := newGalleryWriter(ctx, temporary, id, "original", 1<<40)
	if err != nil {
		cleanup()
		return nil, "", nil, err
	}
	declared := ""
	err = streamContentAuditImage(ctx, client, raw, writer, &declared)
	closeErr := writer.Close()
	if err != nil || closeErr != nil || ctx.Err() != nil {
		cleanup()
		return nil, "", nil, model.ErrGalleryInvalid
	}
	actual, _, _, err := validateGalleryOriginal(temporary, id, writer.written)
	if err != nil || actual != declared || ctx.Err() != nil {
		cleanup()
		return nil, "", nil, model.ErrGalleryInvalid
	}
	file, err := openGalleryFile(temporary, id, "original")
	if err != nil {
		cleanup()
		return nil, "", nil, err
	}
	return file, actual, func() { _ = file.Close(); cleanup() }, nil
}

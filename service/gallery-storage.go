package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
	"github.com/shirou/gopsutil/disk"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"gorm.io/gorm"
)

// A thumbnail is a JPEG, or a PNG when its original has transparency, which
// JPEG cannot hold. PNG files start with this signature.
var galleryPNGSignature = []byte("\x89PNG\r\n\x1a\n")

// galleryTransparentThumbnailsMarker marks, inside the storage directory it
// describes, that every thumbnail there keeps its original's transparency.
// Builds before it wrote every thumbnail as JPEG, painting transparency black;
// until it exists, originals stand in for JPEG thumbnails of PNG and WebP ones.
const galleryTransparentThumbnailsMarker = ".transparent-thumbnails"

func galleryThumbnailsChecked(root string) bool {
	_, err := os.Lstat(filepath.Join(root, galleryTransparentThumbnailsMarker))
	return err == nil
}

func isPNGGalleryThumbnail(r io.Reader) bool {
	signature := make([]byte, len(galleryPNGSignature))
	_, err := io.ReadFull(r, signature)
	return err == nil && bytes.Equal(signature, galleryPNGSignature)
}

func galleryRoot() (string, error) {
	root := os.Getenv("GALLERY_STORAGE_DIR")
	if root == "" {
		root = "./data/gallery"
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", model.ErrGalleryUnavailable
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return "", model.ErrGalleryUnavailable
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", model.ErrGalleryUnavailable
	}
	if err = os.Chmod(root, 0700); err != nil {
		return "", model.ErrGalleryUnavailable
	}
	return root, nil
}

func galleryFreeBytes(root string) (int64, error) {
	usage, err := disk.Usage(root)
	if err != nil {
		return 0, model.ErrGalleryUnavailable
	}
	if usage.Free <= 512<<20 {
		return 0, model.ErrGalleryCapacity
	}
	return int64(min(usage.Free-(512<<20), uint64(1<<40))), nil
}

func galleryFilePath(root, id, kind string) (string, error) {
	parsed, err := uuid.Parse(id)
	if err != nil || parsed.String() != id || (kind != "original" && kind != "thumbnail" && kind != "metadata") {
		return "", model.ErrGalleryUnavailable
	}
	return filepath.Join(root, "gallery-"+id+"."+kind), nil
}

type galleryWriter struct {
	file      *os.File
	ctx       context.Context
	root      string
	remaining int64
	written   int64
	failure   error
}

func newGalleryWriter(ctx context.Context, root, id, kind string, budget int64) (*galleryWriter, error) {
	path, err := galleryFilePath(root, id, kind)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, model.ErrGallerySave
	}
	return &galleryWriter{file: f, ctx: ctx, root: root, remaining: budget}, nil
}

func (w *galleryWriter) Write(data []byte) (int, error) {
	if w.failure != nil {
		return 0, w.failure
	}
	if w.ctx.Err() != nil {
		w.failure = model.ErrGallerySave
		return 0, w.failure
	}
	if int64(len(data)) > w.remaining {
		w.failure = model.ErrGalleryCapacity
		return 0, w.failure
	}
	free, err := galleryFreeBytes(w.root)
	if err != nil {
		w.failure = err
		return 0, w.failure
	}
	if free < int64(len(data)) {
		w.failure = model.ErrGalleryCapacity
		return 0, w.failure
	}
	n, err := w.file.Write(data)
	w.remaining -= int64(n)
	w.written += int64(n)
	if err != nil {
		w.failure = model.ErrGallerySave
		return n, w.failure
	}
	return n, nil
}

func (w *galleryWriter) Close() error {
	syncErr := w.file.Sync()
	closeErr := w.file.Close()
	if syncErr != nil || closeErr != nil {
		return model.ErrGallerySave
	}
	return nil
}

// galleryOriginalLost reports whether a record's original file is gone, as after
// a restore from a snapshot that carries the database but not the images. Such
// a record no longer counts as an original; the browser that still holds the
// picture uploads it again.
func galleryOriginalLost(root, id string) (bool, error) {
	path, err := galleryFilePath(root, id, "original")
	if err != nil {
		return false, err
	}
	_, err = os.Lstat(path)
	if os.IsNotExist(err) {
		return true, nil
	}
	if err != nil {
		return false, model.ErrGalleryUnavailable
	}
	return false, nil
}

func openGalleryFile(root, id, kind string) (*os.File, error) {
	path, err := galleryFilePath(root, id, kind)
	if err != nil {
		return nil, err
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() {
		return nil, model.ErrGalleryUnavailable
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, model.ErrGalleryUnavailable
	}
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) || !after.Mode().IsRegular() {
		f.Close()
		return nil, model.ErrGalleryUnavailable
	}
	return f, nil
}

func removeGalleryRecord(ctx context.Context, root string, record *model.GalleryImage) error {
	updates := map[string]any{"state": "deleting"}
	if record.CanvasID != "" {
		updates["prompt"], updates["negative_prompt"], updates["parameters_json"], updates["model"] = "", "", "", ""
	}
	if err := model.DB.WithContext(ctx).Model(record).Updates(updates).Error; err != nil {
		return model.ErrGalleryUnavailable
	}
	for _, kind := range []string{"original", "thumbnail", "metadata"} {
		path, err := galleryFilePath(root, record.ID, kind)
		if err != nil {
			return err
		}
		info, statErr := os.Lstat(path)
		if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
			return model.ErrGalleryUnavailable
		}
		if record.CanvasID != "" {
			updates := map[string]any{}
			if statErr == nil && info.Mode().IsRegular() {
				record.StorageBytes = max(0, record.StorageBytes-info.Size())
				updates["storage_bytes"] = record.StorageBytes
			}
			if kind == "original" {
				record.Bytes = 0
				updates["bytes"] = 0
			}
			if kind == "thumbnail" {
				record.HasThumbnail = false
				updates["has_thumbnail"] = false
			}
			if len(updates) > 0 {
				if err := model.DB.WithContext(ctx).Model(record).Updates(updates).Error; err != nil {
					return model.ErrGalleryUnavailable
				}
			}
		}
	}
	if err := model.DB.WithContext(ctx).Delete(record).Error; err != nil {
		return model.ErrGalleryUnavailable
	}
	return nil
}

// Validate the full original container without allocating its decoded pixels.
// Large valid originals remain available even when thumbnail decoding is unsafe.
// The picture must be whole, but bytes past its end are kept: phone galleries
// and photo editors append their own data there, which every decoder ignores.
func validateGalleryOriginal(root, id string, size int64) (string, int, int, error) {
	f, err := openGalleryFile(root, id, "original")
	if err != nil {
		return "", 0, 0, err
	}
	defer f.Close()
	config, format, err := image.DecodeConfig(f)
	if err != nil || config.Width < 1 || config.Height < 1 || (format != "png" && format != "jpeg" && format != "webp") {
		return "", 0, 0, model.ErrGalleryInvalid
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return "", 0, 0, model.ErrGalleryInvalid
	}
	r := bufio.NewReaderSize(f, 32<<10)
	buffer := make([]byte, 32<<10)
	invalid := func() (string, int, int, error) { return "", 0, 0, model.ErrGalleryInvalid }
	switch format {
	case "png":
		if _, err = r.Discard(8); err != nil {
			return invalid()
		}
		first, pixels, done := true, false, false
		for !done {
			var chunk [8]byte
			if _, err = io.ReadFull(r, chunk[:]); err != nil {
				return invalid()
			}
			n := int64(binary.BigEndian.Uint32(chunk[:4]))
			kind := string(chunk[4:])
			if n > size || (first && (kind != "IHDR" || n != 13)) || (!first && kind == "IHDR") || (kind == "IEND" && (n != 0 || !pixels)) {
				return invalid()
			}
			crc := crc32.NewIEEE()
			_, _ = crc.Write(chunk[4:])
			copied, e := io.CopyBuffer(crc, io.LimitReader(r, n), buffer)
			if e != nil || copied != n {
				return invalid()
			}
			var expected [4]byte
			if _, err = io.ReadFull(r, expected[:]); err != nil || binary.BigEndian.Uint32(expected[:]) != crc.Sum32() {
				return invalid()
			}
			pixels = pixels || kind == "IDAT"
			done, first = kind == "IEND", false
		}
	case "webp":
		var header [12]byte
		if _, err = io.ReadFull(r, header[:]); err != nil {
			return invalid()
		}
		remaining := int64(binary.LittleEndian.Uint32(header[4:8])) - 4
		if remaining < 0 || remaining+12 > size {
			return invalid()
		}
		pixels := false
		for remaining > 0 {
			var chunk [8]byte
			if remaining < 8 {
				return invalid()
			}
			if _, err = io.ReadFull(r, chunk[:]); err != nil {
				return invalid()
			}
			n := int64(binary.LittleEndian.Uint32(chunk[4:]))
			padded := n + n%2
			if padded > remaining-8 {
				return invalid()
			}
			kind := string(chunk[:4])
			pixels = pixels || n > 0 && (kind == "VP8 " || kind == "VP8L" || kind == "ANMF")
			copied, e := io.CopyBuffer(io.Discard, io.LimitReader(r, padded), buffer)
			if e != nil || copied != padded {
				return invalid()
			}
			remaining -= 8 + padded
		}
		if !pixels {
			return invalid()
		}
	case "jpeg":
		if _, err = r.Discard(2); err != nil {
			return invalid()
		}
		scan, pixels, done := false, false, false
		for !done {
			ch, e := r.ReadByte()
			if e != nil {
				return invalid()
			}
			if ch != 0xff {
				if scan {
					continue
				}
				return invalid()
			}
			marker, e := r.ReadByte()
			if e != nil {
				return invalid()
			}
			for marker == 0xff {
				marker, e = r.ReadByte()
				if e != nil {
					return invalid()
				}
			}
			if scan && (marker == 0 || marker >= 0xd0 && marker <= 0xd7) {
				continue
			}
			if marker == 0xd9 {
				if !pixels {
					return invalid()
				}
				done = true
				continue
			}
			if marker == 0 || marker == 0xd8 || marker >= 0xd0 && marker <= 0xd7 {
				return invalid()
			}
			var length [2]byte
			if _, err = io.ReadFull(r, length[:]); err != nil {
				return invalid()
			}
			n := int64(binary.BigEndian.Uint16(length[:])) - 2
			if n < 0 {
				return invalid()
			}
			copied, e := io.CopyBuffer(io.Discard, io.LimitReader(r, n), buffer)
			if e != nil || copied != n {
				return invalid()
			}
			scan = marker == 0xda
			pixels = pixels || scan
		}
	}
	return "image/" + format, config.Width, config.Height, nil
}

type galleryThumbnailBuffer struct{ bytes.Buffer }

func (b *galleryThumbnailBuffer) Write(data []byte) (int, error) {
	if b.Len()+len(data) > 1<<20 {
		return 0, model.ErrGalleryCapacity
	}
	return b.Buffer.Write(data)
}

// makeGalleryThumbnail makes an original's thumbnail: a JPEG, or a PNG when the
// picture has transparency, which JPEG would paint black, and reports whether it
// found any. An original too large to decode safely gets none, and so does a
// transparent one whose PNG would be no smaller than itself, as one within the
// thumbnail size is: the original stands in for those.
func makeGalleryThumbnail(ctx context.Context, root string, record *model.GalleryImage) ([]byte, bool, error) {
	if ctx.Err() != nil {
		return nil, false, model.ErrGallerySave
	}
	if record.Bytes > 16<<20 || record.Width > 8192 || record.Height > 8192 || int64(record.Width)*int64(record.Height) > 16777216 {
		return nil, false, nil
	}
	f, err := openGalleryFile(root, record.ID, "original")
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	decoded, _, err := image.Decode(f)
	if err != nil {
		return nil, false, model.ErrGalleryInvalid
	}
	if ctx.Err() != nil {
		return nil, false, model.ErrGallerySave
	}
	width, height := record.Width, record.Height
	if max(width, height) > 512 {
		width, height = max(1, width*512/max(record.Width, record.Height)), max(1, height*512/max(record.Width, record.Height))
	}
	scaled := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.ApproxBiLinear.Scale(scaled, scaled.Bounds(), decoded, decoded.Bounds(), draw.Src, nil)
	transparent := !scaled.Opaque()
	var encoded galleryThumbnailBuffer
	if transparent {
		err = png.Encode(&encoded, scaled)
	} else {
		err = jpeg.Encode(&encoded, scaled, &jpeg.Options{Quality: 80})
	}
	if err != nil || (transparent && int64(encoded.Len()) >= record.Bytes) {
		return nil, transparent, nil
	}
	return encoded.Bytes(), transparent, nil
}

// RemakeTransparentGalleryThumbnails checks, once per storage directory, every
// JPEG thumbnail of a PNG or WebP original. A transparent picture's is replaced
// by a PNG, or dropped when that would be no smaller than the original or would
// not fit its owner's limit, and the original stands in. It is safe to repeat:
// a failed run leaves what it did not reach to the next.
func RemakeTransparentGalleryThumbnails(ctx context.Context) error {
	root, err := galleryRoot()
	if err != nil {
		return err
	}
	if galleryThumbnailsChecked(root) {
		return nil
	}
	checked, changed := 0, 0
	after := ""
	for {
		var ids []string
		err = model.DB.WithContext(ctx).Model(&model.GalleryImage{}).
			Where("state = ? AND has_thumbnail = ? AND mime_type IN ? AND id > ?", "ready", true, []string{"image/png", "image/webp"}, after).
			Order("id").Limit(100).Pluck("id", &ids).Error
		if err != nil {
			return model.ErrGalleryUnavailable
		}
		if len(ids) == 0 {
			break
		}
		for _, id := range ids {
			remade, err := remakeTransparentGalleryThumbnail(ctx, root, id)
			if err != nil {
				return err
			}
			checked++
			if remade {
				changed++
			}
		}
		after = ids[len(ids)-1]
	}
	if err = os.WriteFile(filepath.Join(root, galleryTransparentThumbnailsMarker), nil, 0600); err != nil {
		return model.ErrGallerySave
	}
	common.SysLog(fmt.Sprintf("Gallery thumbnails keep transparency now: %d checked, %d remade or dropped.", checked, changed))
	return nil
}

// remakeTransparentGalleryThumbnail treats one image as
// RemakeTransparentGalleryThumbnails describes, and reports whether its
// thumbnail changed.
func remakeTransparentGalleryThumbnail(ctx context.Context, root, id string) (bool, error) {
	galleryMu.Lock()
	defer galleryMu.Unlock()
	var record model.GalleryImage
	err := model.DB.WithContext(ctx).Where("id = ? AND state = ? AND has_thumbnail = ?", id, "ready", true).First(&record).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, model.ErrGalleryUnavailable
	}
	path, err := galleryFilePath(root, id, "thumbnail")
	if err != nil {
		return false, err
	}
	if _, err = os.Lstat(path); os.IsNotExist(err) {
		// A thumbnail lost with a restore is not this pass's to make.
		return false, nil
	}
	file, err := openGalleryFile(root, id, "thumbnail")
	if err != nil {
		return false, err
	}
	info, statErr := file.Stat()
	isPNG := isPNGGalleryThumbnail(file)
	file.Close()
	if statErr != nil {
		return false, model.ErrGalleryUnavailable
	}
	if isPNG {
		// A PNG thumbnail keeps transparency already.
		return false, nil
	}
	remade, transparent, err := makeGalleryThumbnail(ctx, root, &record)
	if errors.Is(err, model.ErrGalleryUnavailable) {
		if lost, lostErr := galleryOriginalLost(root, id); lostErr == nil && lost {
			// An original lost with a restore cannot tell whether it had
			// transparency, and its thumbnail is all that is left of it.
			return false, nil
		}
		return false, model.ErrGalleryUnavailable
	}
	if errors.Is(err, model.ErrGallerySave) {
		return false, err
	}
	if err != nil || !transparent {
		// An original that no longer decodes keeps its thumbnail, and so does an
		// opaque one, whose JPEG is right.
		return false, nil
	}
	settings, err := GetGallerySettings(ctx)
	if err != nil {
		return false, err
	}
	_, used, total, err := model.GalleryTotals(ctx, record.UserID)
	if err != nil {
		return false, model.ErrGalleryUnavailable
	}
	room := min(settings.UserMaxBytes-used, settings.TotalMaxBytes-total)
	// Drop the black thumbnail first, so stopping part way leaves the original
	// standing in for it rather than a record naming a missing file.
	storageBytes := max(0, record.StorageBytes-info.Size())
	if err = model.DB.WithContext(ctx).Model(&record).Updates(map[string]any{"has_thumbnail": false, "storage_bytes": storageBytes}).Error; err != nil {
		return false, model.ErrGalleryUnavailable
	}
	if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
		return true, model.ErrGalleryUnavailable
	}
	if remade == nil || int64(len(remade))-info.Size() > max(room, 0) {
		return true, nil
	}
	writer, err := newGalleryWriter(ctx, root, id, "thumbnail", int64(len(remade)))
	if err != nil {
		return true, err
	}
	_, writeErr := writer.Write(remade)
	closeErr := writer.Close()
	if writeErr != nil || closeErr != nil {
		// Out of disk, say: the original keeps standing in.
		if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
			return true, model.ErrGalleryUnavailable
		}
		return true, nil
	}
	if err = model.DB.WithContext(ctx).Model(&record).Updates(map[string]any{"has_thumbnail": true, "storage_bytes": storageBytes + writer.written}).Error; err != nil {
		return true, model.ErrGalleryUnavailable
	}
	return true, nil
}

package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"

	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
	"github.com/shirou/gopsutil/disk"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

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
	if err != nil || usage.Free <= 512<<20 {
		return 0, model.ErrGalleryUnavailable
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
	if err != nil || free < int64(len(data)) {
		w.failure = model.ErrGalleryUnavailable
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
		if remaining < 0 || remaining+12 != size {
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
	if _, err = r.ReadByte(); err != io.EOF {
		return invalid()
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

func makeGalleryThumbnail(ctx context.Context, root string, record *model.GalleryImage) ([]byte, error) {
	if ctx.Err() != nil {
		return nil, model.ErrGallerySave
	}
	if record.Bytes > 16<<20 || record.Width > 8192 || record.Height > 8192 || int64(record.Width)*int64(record.Height) > 16777216 {
		return nil, nil
	}
	f, err := openGalleryFile(root, record.ID, "original")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	decoded, _, err := image.Decode(f)
	if err != nil {
		return nil, model.ErrGalleryInvalid
	}
	if ctx.Err() != nil {
		return nil, model.ErrGallerySave
	}
	width, height := record.Width, record.Height
	if max(width, height) > 512 {
		width, height = max(1, width*512/max(record.Width, record.Height)), max(1, height*512/max(record.Width, record.Height))
	}
	scaled := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.ApproxBiLinear.Scale(scaled, scaled.Bounds(), decoded, decoded.Bounds(), draw.Src, nil)
	var encoded galleryThumbnailBuffer
	if jpeg.Encode(&encoded, scaled, &jpeg.Options{Quality: 80}) != nil {
		return nil, nil
	}
	return encoded.Bytes(), nil
}

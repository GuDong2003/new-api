package service

import (
	"bufio"
	"encoding/binary"
	"io"

	"github.com/QuantumNous/new-api/model"
)

// validateGIFContainer checks every frame's container and the final trailer
// without decoding or re-encoding pixels. Originals retain their timing,
// disposal, loop extensions, and complete compressed frames.
func validateGIFContainer(r *bufio.Reader) error {
	var header [13]byte
	if _, err := io.ReadFull(r, header[:]); err != nil || (string(header[:6]) != "GIF87a" && string(header[:6]) != "GIF89a") {
		return model.ErrGalleryInvalid
	}
	width, height := int(binary.LittleEndian.Uint16(header[6:8])), int(binary.LittleEndian.Uint16(header[8:10]))
	if width == 0 || height == 0 {
		return model.ErrGalleryInvalid
	}
	if header[10]&0x80 != 0 {
		if _, err := r.Discard(3 * (1 << ((header[10] & 7) + 1))); err != nil {
			return model.ErrGalleryInvalid
		}
	}
	frames := 0
	for {
		block, err := r.ReadByte()
		if err != nil {
			return model.ErrGalleryInvalid
		}
		switch block {
		case 0x3b: // Trailer, after at least one image descriptor.
			if frames == 0 {
				return model.ErrGalleryInvalid
			}
			return nil
		case 0x21: // Extensions, including frame delays and the loop count.
			if _, err := r.ReadByte(); err != nil {
				return model.ErrGalleryInvalid
			}
		case 0x2c: // Image descriptor, optional palette, then LZW sub-blocks.
			var descriptor [9]byte
			if _, err := io.ReadFull(r, descriptor[:]); err != nil {
				return model.ErrGalleryInvalid
			}
			x, y := int(binary.LittleEndian.Uint16(descriptor[:2])), int(binary.LittleEndian.Uint16(descriptor[2:4]))
			w, h := int(binary.LittleEndian.Uint16(descriptor[4:6])), int(binary.LittleEndian.Uint16(descriptor[6:8]))
			if w == 0 || h == 0 || x+w > width || y+h > height {
				return model.ErrGalleryInvalid
			}
			if descriptor[8]&0x80 != 0 {
				if _, err := r.Discard(3 * (1 << ((descriptor[8] & 7) + 1))); err != nil {
					return model.ErrGalleryInvalid
				}
			}
			codeSize, err := r.ReadByte()
			if err != nil || codeSize < 2 || codeSize > 8 {
				return model.ErrGalleryInvalid
			}
			frames++
		default:
			return model.ErrGalleryInvalid
		}
		for {
			length, err := r.ReadByte()
			if err != nil {
				return model.ErrGalleryInvalid
			}
			if length == 0 {
				break
			}
			if _, err := r.Discard(int(length)); err != nil {
				return model.ErrGalleryInvalid
			}
		}
	}
}

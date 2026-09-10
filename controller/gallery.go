package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func galleryAPIError(c *gin.Context, err error) {
	status, message := http.StatusServiceUnavailable, model.ErrGalleryUnavailable.Error()
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		status, message = http.StatusNotFound, "The gallery image was not found."
	case errors.Is(err, model.ErrGalleryInvalid):
		status, message = http.StatusBadRequest, model.ErrGalleryInvalid.Error()
	case errors.Is(err, model.ErrGallerySettings):
		status, message = http.StatusBadRequest, model.ErrGallerySettings.Error()
	case errors.Is(err, model.ErrGalleryDisabled):
		status, message = http.StatusConflict, model.ErrGalleryDisabled.Error()
	case errors.Is(err, model.ErrGalleryCapacity):
		status, message = http.StatusConflict, model.ErrGalleryCapacity.Error()
	case errors.Is(err, model.ErrGallerySave):
		message = model.ErrGallerySave.Error()
	}
	c.JSON(status, gin.H{"success": false, "message": message})
}

func GetGalleryUsage(c *gin.Context) {
	usage, err := service.GetGalleryUsage(c.Request.Context(), c.GetInt("id"))
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, usage)
}

func GetGallerySettings(c *gin.Context) {
	settings, err := service.GetGallerySettings(c.Request.Context())
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, settings)
}

func UpdateGallerySettings(c *gin.Context) {
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, 4097))
	if err != nil || len(raw) > 4096 {
		galleryAPIError(c, model.ErrGallerySettings)
		return
	}
	// Full replacement: in particular, omitted enabled must not silently disable storage.
	var fields map[string]any
	if common.Unmarshal(raw, &fields) != nil || len(fields) != 5 {
		galleryAPIError(c, model.ErrGallerySettings)
		return
	}
	for _, key := range []string{"enabled", "retention_days", "user_max_images", "user_max_bytes", "total_max_bytes"} {
		if fields[key] == nil {
			galleryAPIError(c, model.ErrGallerySettings)
			return
		}
	}
	var input model.GallerySettings
	if common.Unmarshal(raw, &input) != nil {
		galleryAPIError(c, model.ErrGallerySettings)
		return
	}
	settings, err := service.UpdateGallerySettings(c.Request.Context(), input)
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, settings)
}

func ListGalleryImages(c *gin.Context) {
	page, e1 := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, e2 := strconv.Atoi(c.DefaultQuery("page_size", "24"))
	if e1 != nil || e2 != nil {
		galleryAPIError(c, model.ErrGalleryInvalid)
		return
	}
	result, err := service.ListGalleryImages(c.Request.Context(), c.GetInt("id"), page, size, c.Query("source"))
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func SaveGalleryImage(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, (1<<40)+(128<<10))
	reader, err := c.Request.MultipartReader()
	if err != nil {
		galleryAPIError(c, model.ErrGalleryInvalid)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), time.Minute)
	defer cancel()
	// Bound slow clients as well as URL downloads. Unsupported deadline control
	// (for example in a test recorder) is harmless; the context remains bounded.
	responseController := http.NewResponseController(c.Writer)
	_ = responseController.SetReadDeadline(time.Now().Add(time.Minute))
	defer responseController.SetReadDeadline(time.Time{})
	result, err := service.SaveGalleryImage(ctx, c.GetInt("id"), reader)
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func GetGalleryFile(c *gin.Context) {
	thumbnail := c.Query("thumbnail") == "true"
	f, record, err := service.OpenGalleryImage(c.Request.Context(), c.GetInt("id"), c.Param("id"), thumbnail)
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		galleryAPIError(c, model.ErrGalleryUnavailable)
		return
	}
	mime := record.MIMEType
	if thumbnail && record.HasThumbnail {
		mime = "image/jpeg"
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", `inline; filename="gallery-image"`)
	c.DataFromReader(http.StatusOK, info.Size(), mime, f, nil)
}

func DeleteGalleryImage(c *gin.Context) {
	if err := service.DeleteGalleryImage(c.Request.Context(), c.GetInt("id"), c.Param("id")); err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

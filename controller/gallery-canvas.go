package controller

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func ListGalleryCanvases(c *gin.Context) {
	page, e1 := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, e2 := strconv.Atoi(c.DefaultQuery("page_size", "24"))
	if e1 != nil || e2 != nil {
		galleryAPIError(c, model.ErrGalleryInvalid)
		return
	}
	result, err := service.ListGalleryCanvases(c.Request.Context(), c.GetInt("id"), page, size, c.Query("source"), c.Query("search"), c.DefaultQuery("sort", "updated_desc"))
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func GetGalleryCanvas(c *gin.Context) {
	result, err := service.GetGalleryCanvas(c.Request.Context(), c.GetInt("id"), c.Param("id"))
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func SaveGalleryCanvas(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, (1<<40)+(128<<20))
	reader, err := c.Request.MultipartReader()
	if err != nil {
		galleryAPIError(c, model.ErrGalleryInvalid)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), time.Minute)
	defer cancel()
	responseController := http.NewResponseController(c.Writer)
	_ = responseController.SetReadDeadline(time.Now().Add(time.Minute))
	defer responseController.SetReadDeadline(time.Time{})
	result, err := service.SaveGalleryCanvas(ctx, c.GetInt("id"), reader)
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func DeleteGalleryCanvas(c *gin.Context) {
	revision, err := strconv.ParseInt(c.Query("revision"), 10, 64)
	if err != nil || revision < 0 {
		galleryAPIError(c, model.ErrGalleryInvalid)
		return
	}
	if err := service.DeleteGalleryCanvas(c.Request.Context(), c.GetInt("id"), c.Param("id"), revision); err != nil {
		galleryAPIError(c, err)
		return
	}
	GetGalleryCanvas(c)
}

func DeleteGalleryCanvasAsset(c *gin.Context) {
	revision, err := strconv.ParseInt(c.Query("revision"), 10, 64)
	if err != nil || revision < 0 {
		galleryAPIError(c, model.ErrGalleryInvalid)
		return
	}
	result, err := service.DeleteGalleryCanvasAsset(c.Request.Context(), c.GetInt("id"), c.Param("id"), c.Param("assetId"), revision)
	if err != nil {
		galleryAPIError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

package controller

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

type avatarURLRequest struct {
	URL string `json:"url"`
}

func GetAvatar(c *gin.Context) {
	filename := c.Param("filename")
	filePath, ok := service.AvatarFilePath(filename)
	if !ok {
		c.Status(http.StatusNotFound)
		return
	}
	file, err := os.Open(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.Status(http.StatusNotFound)
			return
		}
		c.Status(http.StatusInternalServerError)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		c.Status(http.StatusNotFound)
		return
	}

	c.Header("Content-Type", service.AvatarMIMEType(filename))
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.Header("Content-Disposition", fmt.Sprintf("inline; filename=%q", filename))
	if strings.HasSuffix(filename, ".svg") {
		c.Header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
	}
	http.ServeContent(c.Writer, c.Request, filename, info.ModTime(), file)
}

func UpdateSelfAvatar(c *gin.Context) {
	updateAvatar(c, c.GetInt("id"), false)
}

func DeleteSelfAvatar(c *gin.Context) {
	deleteAvatar(c, c.GetInt("id"), false)
}

func AdminUpdateUserAvatar(c *gin.Context) {
	userID, ok := managedAvatarTarget(c)
	if !ok {
		return
	}
	updateAvatar(c, userID, true)
}

func AdminDeleteUserAvatar(c *gin.Context) {
	userID, ok := managedAvatarTarget(c)
	if !ok {
		return
	}
	deleteAvatar(c, userID, true)
}

func managedAvatarTarget(c *gin.Context) (int, bool) {
	userID, err := strconv.Atoi(c.Param("id"))
	if err != nil || userID <= 0 {
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
		return 0, false
	}
	targetUser, err := model.GetUserById(userID, false)
	if err != nil {
		common.ApiError(c, err)
		return 0, false
	}
	if !canManageTargetRole(c.GetInt("role"), targetUser.Role) {
		common.ApiErrorI18n(c, i18n.MsgUserNoPermissionSameLevel)
		return 0, false
	}
	return userID, true
}

func updateAvatar(c *gin.Context, userID int, adminAction bool) {
	data, err := avatarRequestData(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	preparedAvatar, err := service.PrepareAvatar(data)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	newAvatarURL, err := service.StoreAvatar(preparedAvatar)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	previousAvatarURL, err := model.ReplaceUserAvatar(userID, newAvatarURL)
	if err != nil {
		_ = service.DeleteManagedAvatar(newAvatarURL)
		common.ApiError(c, err)
		return
	}
	if err := service.DeleteManagedAvatar(previousAvatarURL); err != nil {
		common.SysError(fmt.Sprintf("failed to remove previous avatar for user %d: %v", userID, err))
	}
	if adminAction {
		recordManageAuditFor(c, userID, "user.avatar_update", map[string]interface{}{"id": userID})
	}
	common.ApiSuccess(c, gin.H{"avatar_url": newAvatarURL})
}

func deleteAvatar(c *gin.Context, userID int, adminAction bool) {
	previousAvatarURL, err := model.ReplaceUserAvatar(userID, "")
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := service.DeleteManagedAvatar(previousAvatarURL); err != nil {
		common.SysError(fmt.Sprintf("failed to remove avatar for user %d: %v", userID, err))
	}
	if adminAction {
		recordManageAuditFor(c, userID, "user.avatar_delete", map[string]interface{}{"id": userID})
	}
	common.ApiSuccess(c, gin.H{"avatar_url": ""})
}

func avatarRequestData(c *gin.Context) ([]byte, error) {
	contentType := strings.ToLower(c.GetHeader("Content-Type"))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, service.MaxAvatarBytes+512*1024)
		fileHeader, err := c.FormFile("file")
		if err != nil {
			return nil, errors.New("avatar file is required")
		}
		if fileHeader.Size > service.MaxAvatarBytes {
			return nil, fmt.Errorf("avatar must not exceed %d MiB", service.MaxAvatarBytes>>20)
		}
		file, err := fileHeader.Open()
		if err != nil {
			return nil, err
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, service.MaxAvatarBytes+1))
		if err != nil {
			return nil, err
		}
		if len(data) > service.MaxAvatarBytes {
			return nil, fmt.Errorf("avatar must not exceed %d MiB", service.MaxAvatarBytes>>20)
		}
		return data, nil
	}

	var request avatarURLRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil || strings.TrimSpace(request.URL) == "" {
		return nil, errors.New("image URL is required")
	}
	return service.FetchAvatarURL(c.Request.Context(), request.URL)
}

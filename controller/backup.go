package controller

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

func GetBackupSettings(c *gin.Context) {
	settings, err := service.GetBackupSettingsView()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, settings)
}

func UpdateBackupSettings(c *gin.Context) {
	var request service.UpdateBackupSettingsRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorMsg(c, "invalid backup settings")
		return
	}
	settings, err := service.UpdateBackupSettings(request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, settings)
}

func TestBackupConnection(c *gin.Context) {
	result, err := service.TestBackupConnection(c.Request.Context())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func StartBackup(c *gin.Context) {
	task, created, err := service.EnqueueBackupTask()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"task":    task.ToResponse(),
		"created": created,
	})
}

func StartBackupRestore(c *gin.Context) {
	var request struct {
		Revision     string `json:"revision"`
		Confirmation string `json:"confirmation"`
	}
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorMsg(c, "invalid restore request")
		return
	}
	if strings.TrimSpace(request.Confirmation) != "RESTORE" {
		common.ApiErrorMsg(c, "restore confirmation is required")
		return
	}
	task, created, err := service.EnqueueBackupRestoreTask(request.Revision)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"task":    task.ToResponse(),
		"created": created,
	})
}

func ListBackupRevisions(c *gin.Context) {
	revisions, err := service.ListBackupRevisions(c.Request.Context())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, revisions)
}

func VerifyBackup(c *gin.Context) {
	revision := strings.TrimSpace(c.Query("revision"))
	manifest, err := service.VerifyBackup(c.Request.Context(), revision)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, manifest)
}

func DownloadBackup(c *gin.Context) {
	revision := strings.TrimSpace(c.Query("revision"))
	content, manifest, err := service.DownloadBackup(c.Request.Context(), revision)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	version := revision
	if version == "" {
		version = strconv.FormatInt(manifest.CreatedAt, 10)
	}
	filename := fmt.Sprintf("new-api-backup-%s.age", version)
	c.Header("Content-Type", "text/plain; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	c.Data(http.StatusOK, "text/plain; charset=utf-8", content)
}

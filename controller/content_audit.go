package controller

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func contentAuditAPIError(c *gin.Context, err error) {
	status, code := http.StatusServiceUnavailable, "CONTENT_AUDIT_UNAVAILABLE"
	switch {
	case errors.Is(err, model.ErrContentAuditInvalid), errors.Is(err, service.ErrVerificationContextInvalid):
		status, code = http.StatusBadRequest, "CONTENT_AUDIT_INVALID"
	case errors.Is(err, model.ErrContentAuditConflict):
		status, code = http.StatusConflict, "CONTENT_AUDIT_CONFLICT"
	case errors.Is(err, gorm.ErrRecordNotFound):
		status, code = http.StatusNotFound, "CONTENT_AUDIT_NOT_FOUND"
	case errors.Is(err, model.ErrContentAuditExpired):
		status, code = http.StatusGone, "CONTENT_AUDIT_EXPIRED"
	case errors.Is(err, model.ErrContentAuditOwnership):
		status, code = http.StatusConflict, "CONTENT_AUDIT_WRITER_ACTIVE"
	}
	c.JSON(status, gin.H{"success": false, "code": code, "message": code})
}

func GetContentAuditSettings(c *gin.Context) {
	status, err := service.GetContentAuditStatus(c.Request.Context())
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	common.ApiSuccess(c, status)
}

func GetContentAuditStatus(c *gin.Context) { GetContentAuditSettings(c) }

func contentAuditOperationBody(c *gin.Context, scope string, target any) bool {
	data, err := io.ReadAll(io.LimitReader(c.Request.Body, 16385))
	if err != nil || len(data) > 16384 || common.Unmarshal(data, target) != nil {
		contentAuditAPIError(c, model.ErrContentAuditInvalid)
		return false
	}
	operation := service.VerificationOperation{Scope: scope, Context: data}
	if _, err := service.BindVerificationOperation(operation); err != nil {
		contentAuditAPIError(c, err)
		return false
	}
	return middleware.RequireSecurityProof(c, operation) != nil
}

// Only fixed action/result codes and server-normalized record/operation IDs
// enter the security log. No request body, settings values, URL or proof is copied.
func recordContentAuditAccess(c *gin.Context, operationID, action, phase string, ids []string, success bool) error {
	common.SetContextKey(c, constant.ContextKeyAuditLogged, true)
	return model.RecordAuditLogDurable(c, model.AuditLog{
		UserId: c.GetInt("id"), Username: c.GetString("username"), ActorRole: common.RoleRootUser,
		Category: model.AuditCategorySecurity, Action: action, Success: success, Content: "Content audit " + phase,
		Other: model.AuditOther{RootInfo: model.AuditFields{"operation_id": operationID, "record_ids": ids, "phase": phase}},
	})
}

func InitializeContentAudit(c *gin.Context) {
	var input service.ContentAuditInitializeRequest
	if !contentAuditOperationBody(c, service.VerificationScopeContentAuditInitialize, &input) {
		return
	}
	operationID := common.NewRequestId()
	c.Header("X-Content-Audit-Operation", operationID)
	if err := recordContentAuditAccess(c, operationID, "content_audit.initialize", "authorized", nil, true); err != nil {
		contentAuditAPIError(c, err)
		return
	}
	err := service.InitializeContentAudit(c.Request.Context(), input)
	if logErr := recordContentAuditAccess(c, operationID, "content_audit.initialize", "result", nil, err == nil); logErr != nil {
		contentAuditAPIError(c, logErr)
		return
	}
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	GetContentAuditSettings(c)
}

func UpdateContentAuditSettings(c *gin.Context) {
	var input service.ContentAuditSettingsUpdate
	if !contentAuditOperationBody(c, service.VerificationScopeContentAuditSettings, &input) {
		return
	}
	operationID := common.NewRequestId()
	c.Header("X-Content-Audit-Operation", operationID)
	if err := recordContentAuditAccess(c, operationID, "content_audit.settings.update", "authorized", nil, true); err != nil {
		contentAuditAPIError(c, err)
		return
	}
	err := service.UpdateContentAudit(c.Request.Context(), input)
	if logErr := recordContentAuditAccess(c, operationID, "content_audit.settings.update", "result", nil, err == nil); logErr != nil {
		contentAuditAPIError(c, logErr)
		return
	}
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	GetContentAuditSettings(c)
}

func ListContentAudits(c *gin.Context) {
	now := time.Now().Unix()
	filter := model.ContentAuditFilter{Start: now - 7*86400, End: now, Page: 1, PageSize: 25, Model: c.Query("model"), RequestID: c.Query("request_id"), Kind: c.Query("kind"), Integrity: c.Query("integrity")}
	for key, target := range map[string]*int64{"start": &filter.Start, "end": &filter.End} {
		if value := c.Query(key); value != "" {
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				contentAuditAPIError(c, model.ErrContentAuditInvalid)
				return
			}
			*target = parsed
		}
	}
	for key, target := range map[string]*int{"user_id": &filter.UserID, "channel_id": &filter.ChannelID, "http_status": &filter.HTTPStatus, "page": &filter.Page, "page_size": &filter.PageSize} {
		if value := c.Query(key); value != "" {
			parsed, err := strconv.Atoi(value)
			if err != nil || parsed < 0 {
				contentAuditAPIError(c, model.ErrContentAuditInvalid)
				return
			}
			*target = parsed
		}
	}
	if (filter.Kind != "" && filter.Kind != "text" && filter.Kind != "image") || (filter.Integrity != "" && filter.Integrity != "complete" && filter.Integrity != "partial") || (filter.HTTPStatus != 0 && (filter.HTTPStatus < 100 || filter.HTTPStatus > 599)) {
		contentAuditAPIError(c, model.ErrContentAuditInvalid)
		return
	}
	records, total, err := model.ListContentAudits(c.Request.Context(), filter)
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": records, "total": total, "page": filter.Page, "page_size": filter.PageSize})
}

func contentAuditSessionStillRoot(c *gin.Context) bool {
	identity, ok := middleware.GetSessionAuthIdentity(c)
	if ok {
		ok = model.ValidateContentAuditSession(c.Request.Context(), identity) == nil
	}
	if !ok {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "code": "CONTENT_AUDIT_SESSION_REQUIRED", "message": "A live root dashboard session is required."})
	}
	return ok
}

func GetContentAuditDetail(c *gin.Context) {
	id := c.Param("id")
	if !model.ValidContentAuditID(id) {
		contentAuditAPIError(c, model.ErrContentAuditInvalid)
		return
	}
	operationID := common.NewRequestId()
	if err := recordContentAuditAccess(c, operationID, "content_audit.read", "authorized", []string{id}, true); err != nil {
		contentAuditAPIError(c, err)
		return
	}
	record, payload, err := service.ReadContentAuditPayload(c.Request.Context(), id)
	if logErr := recordContentAuditAccess(c, operationID, "content_audit.read", "result", []string{id}, err == nil); logErr != nil {
		contentAuditAPIError(c, logErr)
		return
	}
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	if !contentAuditSessionStillRoot(c) {
		return
	}
	common.ApiSuccess(c, gin.H{"record": record, "payload": payload})
}

func GetContentAuditImagePage(c *gin.Context) {
	id := c.Param("id")
	after, afterErr := strconv.Atoi(c.DefaultQuery("after", "-1"))
	limit, limitErr := strconv.Atoi(c.DefaultQuery("limit", "20"))
	if !model.ValidContentAuditID(id) || afterErr != nil || limitErr != nil || after < -1 || limit < 1 || limit > 100 {
		contentAuditAPIError(c, model.ErrContentAuditInvalid)
		return
	}
	operationID := common.NewRequestId()
	if err := recordContentAuditAccess(c, operationID, "content_audit.images.read", "authorized", []string{id}, true); err != nil {
		contentAuditAPIError(c, err)
		return
	}
	page, err := service.ReadContentAuditImagePage(c.Request.Context(), id, after, limit)
	if logErr := recordContentAuditAccess(c, operationID, "content_audit.images.read", "result", []string{id}, err == nil); logErr != nil {
		contentAuditAPIError(c, logErr)
		return
	}
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	if !contentAuditSessionStillRoot(c) {
		return
	}
	record, err := model.GetContentAudit(c.Request.Context(), id)
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	if record.ExpiresAt <= time.Now().Unix() {
		contentAuditAPIError(c, model.ErrContentAuditExpired)
		return
	}
	if record.Status != model.ContentAuditReady {
		contentAuditAPIError(c, model.ErrContentAuditUnavailable)
		return
	}
	common.ApiSuccess(c, page)
}

func GetContentAuditOriginal(c *gin.Context) {
	id := c.Param("id")
	index, err := strconv.Atoi(c.Param("index"))
	if !model.ValidContentAuditID(id) || err != nil || index < 0 {
		contentAuditAPIError(c, model.ErrContentAuditInvalid)
		return
	}
	operationID := common.NewRequestId()
	if err := recordContentAuditAccess(c, operationID, "content_audit.original.read", "authorized", []string{id}, true); err != nil {
		contentAuditAPIError(c, err)
		return
	}
	original, err := service.OpenContentAuditOriginal(c.Request.Context(), id, index)
	if original != nil {
		defer original.Reader.Close()
	}
	if logErr := recordContentAuditAccess(c, operationID, "content_audit.original.read", "result", []string{id}, err == nil); logErr != nil {
		contentAuditAPIError(c, logErr)
		return
	}
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	if !contentAuditSessionStillRoot(c) {
		return
	}
	record, err := model.GetContentAudit(c.Request.Context(), id)
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	if record.ExpiresAt <= time.Now().Unix() {
		contentAuditAPIError(c, model.ErrContentAuditExpired)
		return
	}
	if record.Status != model.ContentAuditReady {
		contentAuditAPIError(c, model.ErrContentAuditUnavailable)
		return
	}
	extension := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[original.MIME]
	if extension == "" {
		contentAuditAPIError(c, model.ErrContentAuditUnavailable)
		return
	}
	c.Header("Content-Type", original.MIME)
	c.Header("Content-Length", strconv.FormatInt(original.Bytes, 10))
	c.Header("Content-Disposition", "attachment; filename=\"audit-"+id+"-"+strconv.Itoa(index)+extension+"\"")
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Status(http.StatusOK)
	identity, _ := middleware.GetSessionAuthIdentity(c)
	buffer := make([]byte, 128<<10)
	var sent int64
	for {
		// Do not call JSON-writing error helpers after binary output begins.
		current, lookupErr := model.GetContentAudit(c.Request.Context(), id)
		if lookupErr != nil || current.ExpiresAt <= time.Now().Unix() || current.Status != model.ContentAuditReady || model.ValidateContentAuditSession(c.Request.Context(), identity) != nil {
			err = model.ErrContentAuditUnavailable
			break
		}
		n, readErr := original.Reader.Read(buffer)
		if n > 0 {
			written, writeErr := c.Writer.Write(buffer[:n])
			sent += int64(written)
			if writeErr != nil || written != n {
				err = io.ErrUnexpectedEOF
				break
			}
		}
		if readErr != nil {
			if readErr != io.EOF || sent != original.Bytes {
				err = io.ErrUnexpectedEOF
			}
			break
		}
	}
	if err != nil {
		_ = recordContentAuditAccess(c, operationID, "content_audit.original.read", "interrupted", []string{id}, false)
		c.Abort()
	}
}

func GetContentAuditThumbnail(c *gin.Context) {
	id := c.Param("id")
	index, err := strconv.Atoi(c.Param("index"))
	if !model.ValidContentAuditID(id) || err != nil || index < 0 {
		contentAuditAPIError(c, model.ErrContentAuditInvalid)
		return
	}
	operationID := common.NewRequestId()
	if err := recordContentAuditAccess(c, operationID, "content_audit.thumbnail.read", "authorized", []string{id}, true); err != nil {
		contentAuditAPIError(c, err)
		return
	}
	data, err := service.ReadContentAuditThumbnail(c.Request.Context(), id, index)
	if logErr := recordContentAuditAccess(c, operationID, "content_audit.thumbnail.read", "result", []string{id}, err == nil); logErr != nil {
		contentAuditAPIError(c, logErr)
		return
	}
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	if !contentAuditSessionStillRoot(c) {
		return
	}
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, "image/jpeg", data)
}

func DeleteContentAudits(c *gin.Context) {
	var input service.ContentAuditDeleteRequest
	if id := c.Param("id"); id != "" {
		input.IDs = []string{id}
		raw, err := common.Marshal(input)
		if err != nil || !model.ValidContentAuditID(id) {
			contentAuditAPIError(c, model.ErrContentAuditInvalid)
			return
		}
		if middleware.RequireSecurityProof(c, service.VerificationOperation{Scope: service.VerificationScopeContentAuditDelete, Context: raw}) == nil {
			return
		}
	} else if !contentAuditOperationBody(c, service.VerificationScopeContentAuditDelete, &input) {
		return
	}
	operationID := common.NewRequestId()
	c.Header("X-Content-Audit-Operation", operationID)
	if err := recordContentAuditAccess(c, operationID, "content_audit.delete", "authorized", input.IDs, true); err != nil {
		contentAuditAPIError(c, err)
		return
	}
	err := service.RequestContentAuditDeletion(c.Request.Context(), input)
	if logErr := recordContentAuditAccess(c, operationID, "content_audit.delete", "deletion_requested", input.IDs, err == nil); logErr != nil {
		contentAuditAPIError(c, logErr)
		return
	}
	if err != nil {
		contentAuditAPIError(c, err)
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"success": true, "message": "", "data": gin.H{"operation_id": operationID, "ids": input.IDs, "status": "deleting"}})
}

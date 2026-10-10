package controller

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const (
	maxInviteCodeBatchSize = 100
	maxInviteCodeUses      = 100000
	maxInviteCodeNameRunes = 64
)

type createInviteCodesRequest struct {
	Name        string `json:"name"`
	Code        string `json:"code"`
	Count       int    `json:"count"`
	MaxUses     int    `json:"max_uses"`
	ExpiredTime int64  `json:"expired_time"`
}

type updateInviteCodeRequest struct {
	Id          int    `json:"id"`
	Name        string `json:"name"`
	Status      int    `json:"status"`
	MaxUses     int    `json:"max_uses"`
	ExpiredTime int64  `json:"expired_time"`
}

type validateInviteCodeRequest struct {
	InviteCode string `json:"invite_code"`
}

func ValidateInviteCode(c *gin.Context) {
	var request validateInviteCodeRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	codeHash, err := model.HashInviteCode(request.InviteCode)
	if err == nil {
		err = model.ValidateInviteCodeHash(codeHash)
	}
	if err != nil {
		if !respondInviteCodeError(c, err) {
			common.ApiError(c, err)
		}
		return
	}
	common.ApiSuccess(c, nil)
}

func GetInviteCodes(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	inviteCodes, total, err := model.GetInviteCodesWithOptions(model.InviteCodeQueryOptions{
		Keyword:    c.Query("keyword"),
		Status:     c.Query("status"),
		Usage:      c.Query("usage"),
		Expiration: c.Query("expiration"),
		Sort:       c.Query("sort"),
	}, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		if errors.Is(err, model.ErrInviteCodeInvalid) {
			common.ApiErrorT(c, "Invalid parameters")
			return
		}
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(inviteCodes)
	common.ApiSuccess(c, pageInfo)
}

func GetInviteCodeUsages(c *gin.Context) {
	inviteCodeId, err := strconv.Atoi(c.Param("id"))
	if err != nil || inviteCodeId <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	pageInfo := common.GetPageQuery(c)
	usages, total, err := model.GetInviteCodeUsages(inviteCodeId, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(usages)
	common.ApiSuccess(c, pageInfo)
}

func CreateInviteCodes(c *gin.Context) {
	var request createInviteCodesRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	request.Code = strings.TrimSpace(request.Code)
	if request.Count == 0 {
		request.Count = 1
	}
	if request.MaxUses == 0 {
		request.MaxUses = 1
	}
	if utf8.RuneCountInString(request.Name) > maxInviteCodeNameRunes {
		common.ApiErrorT(c, "Invitation code name must not exceed 64 characters")
		return
	}
	if request.Count < 1 || request.Count > maxInviteCodeBatchSize {
		common.ApiErrorT(c, "Invitation code quantity must be between 1 and 100")
		return
	}
	if request.Code != "" && request.Count != 1 {
		common.ApiErrorT(c, "A custom invitation code can only create one code at a time")
		return
	}
	if request.MaxUses < 1 || request.MaxUses > maxInviteCodeUses {
		common.ApiErrorT(c, "Maximum uses must be between 1 and 100000")
		return
	}
	if request.ExpiredTime != 0 && request.ExpiredTime <= common.GetTimestamp() {
		common.ApiErrorT(c, "Expiration time must be in the future")
		return
	}
	generated, err := model.CreateInviteCodesWithCustomCode(c.GetInt("id"), request.Name, request.Count, request.MaxUses, request.ExpiredTime, request.Code)
	if err != nil {
		if errors.Is(err, model.ErrInviteCodeInvalid) {
			common.ApiErrorT(c, "Invitation code must be 8-64 characters using letters, numbers, hyphens, or underscores")
			return
		}
		if errors.Is(err, model.ErrInviteCodeExists) {
			common.ApiErrorT(c, "This invitation code already exists")
			return
		}
		common.SysError(common.LogText("failed to create invitation codes: %v", err))
		common.ApiErrorT(c, "Failed to create invitation code, please try again later")
		return
	}
	recordManageAudit(c, "invite_code.create", map[string]any{
		"count":    request.Count,
		"max_uses": request.MaxUses,
	})
	common.ApiSuccess(c, generated)
}

func UpdateInviteCode(c *gin.Context) {
	var request updateInviteCodeRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if utf8.RuneCountInString(request.Name) > maxInviteCodeNameRunes {
		common.ApiErrorT(c, "Invitation code name must not exceed 64 characters")
		return
	}
	if request.MaxUses < 1 || request.MaxUses > maxInviteCodeUses {
		common.ApiErrorT(c, "Maximum uses must be between 1 and 100000")
		return
	}
	inviteCode, err := model.UpdateInviteCode(request.Id, request.Name, request.Status, request.MaxUses, request.ExpiredTime)
	if err != nil {
		if errors.Is(err, model.ErrInviteCodeInvalid) {
			common.ApiErrorT(c, "Invalid invitation code settings; maximum uses cannot be lower than the used count")
			return
		}
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "invite_code.update", map[string]any{
		"id":       inviteCode.Id,
		"status":   inviteCode.Status,
		"max_uses": inviteCode.MaxUses,
	})
	common.ApiSuccess(c, inviteCode)
}

func DeleteInviteCode(c *gin.Context) {
	inviteCodeId, err := strconv.Atoi(c.Param("id"))
	if err != nil || inviteCodeId <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	if err := model.DeleteUnusedInviteCode(inviteCodeId); err != nil {
		if errors.Is(err, model.ErrInviteCodeUsed) {
			common.ApiErrorT(c, "Invitation codes with usage records cannot be deleted; disable them instead")
			return
		}
		common.SysError(common.LogText("failed to delete invitation code: %v", err))
		common.ApiErrorT(c, "Failed to delete invitation code, please try again later")
		return
	}
	recordManageAudit(c, "invite_code.delete", map[string]any{
		"id": inviteCodeId,
	})
	common.ApiSuccess(c, nil)
}

func respondInviteCodeError(c *gin.Context, err error) bool {
	switch {
	case errors.Is(err, model.ErrInviteCodeRequired):
		common.ApiErrorT(c, "An invitation code is required to create a new account")
		return true
	case errors.Is(err, model.ErrInviteCodeInvalid), errors.Is(err, model.ErrInviteCodeUnavailable):
		common.ApiErrorT(c, "The invitation code is invalid, expired, disabled, or has no remaining uses")
		return true
	default:
		return false
	}
}

package controller

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
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
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
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
			common.ApiErrorI18n(c, i18n.MsgInvalidParams)
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
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
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
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Count == 0 {
		request.Count = 1
	}
	if request.MaxUses == 0 {
		request.MaxUses = 1
	}
	if utf8.RuneCountInString(request.Name) > maxInviteCodeNameRunes {
		common.ApiErrorI18n(c, i18n.MsgInviteCodeNameTooLong)
		return
	}
	if request.Count < 1 || request.Count > maxInviteCodeBatchSize {
		common.ApiErrorI18n(c, i18n.MsgInviteCodeCountInvalid)
		return
	}
	if request.MaxUses < 1 || request.MaxUses > maxInviteCodeUses {
		common.ApiErrorI18n(c, i18n.MsgInviteCodeMaxUsesInvalid)
		return
	}
	if request.ExpiredTime != 0 && request.ExpiredTime <= common.GetTimestamp() {
		common.ApiErrorI18n(c, i18n.MsgInviteCodeExpireTimeInvalid)
		return
	}
	generated, err := model.CreateInviteCodes(c.GetInt("id"), request.Name, request.Count, request.MaxUses, request.ExpiredTime)
	if err != nil {
		common.SysError("failed to create invitation codes: " + err.Error())
		common.ApiErrorI18n(c, i18n.MsgInviteCodeCreateFailed)
		return
	}
	recordManageAudit(c, "invite_code.create", map[string]interface{}{
		"count":    request.Count,
		"max_uses": request.MaxUses,
	})
	common.ApiSuccess(c, generated)
}

func UpdateInviteCode(c *gin.Context) {
	var request updateInviteCodeRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if utf8.RuneCountInString(request.Name) > maxInviteCodeNameRunes {
		common.ApiErrorI18n(c, i18n.MsgInviteCodeNameTooLong)
		return
	}
	if request.MaxUses < 1 || request.MaxUses > maxInviteCodeUses {
		common.ApiErrorI18n(c, i18n.MsgInviteCodeMaxUsesInvalid)
		return
	}
	inviteCode, err := model.UpdateInviteCode(request.Id, request.Name, request.Status, request.MaxUses, request.ExpiredTime)
	if err != nil {
		if errors.Is(err, model.ErrInviteCodeInvalid) {
			common.ApiErrorI18n(c, i18n.MsgInviteCodeUpdateInvalid)
			return
		}
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "invite_code.update", map[string]interface{}{
		"id":       inviteCode.Id,
		"status":   inviteCode.Status,
		"max_uses": inviteCode.MaxUses,
	})
	common.ApiSuccess(c, inviteCode)
}

func DeleteInviteCode(c *gin.Context) {
	inviteCodeId, err := strconv.Atoi(c.Param("id"))
	if err != nil || inviteCodeId <= 0 {
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
		return
	}
	if err := model.DeleteUnusedInviteCode(inviteCodeId); err != nil {
		if errors.Is(err, model.ErrInviteCodeUsed) {
			common.ApiErrorI18n(c, i18n.MsgInviteCodeDeleteUsed)
			return
		}
		common.SysError("failed to delete invitation code: " + err.Error())
		common.ApiErrorI18n(c, i18n.MsgInviteCodeDeleteFailed)
		return
	}
	recordManageAudit(c, "invite_code.delete", map[string]interface{}{
		"id": inviteCodeId,
	})
	common.ApiSuccess(c, nil)
}

func respondInviteCodeError(c *gin.Context, err error) bool {
	switch {
	case errors.Is(err, model.ErrInviteCodeRequired):
		common.ApiErrorI18n(c, i18n.MsgInviteCodeRequired)
		return true
	case errors.Is(err, model.ErrInviteCodeInvalid), errors.Is(err, model.ErrInviteCodeUnavailable):
		common.ApiErrorI18n(c, i18n.MsgInviteCodeUnavailable)
		return true
	default:
		return false
	}
}

package controller

import (
	"errors"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
)

func GetAllRedemptions(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	redemptions, total, err := model.GetAllRedemptions(pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(redemptions)
	common.ApiSuccess(c, pageInfo)
	return
}

func SearchRedemptions(c *gin.Context) {
	keyword := c.Query("keyword")
	status := c.Query("status")
	pageInfo := common.GetPageQuery(c)
	redemptions, total, err := model.SearchRedemptions(keyword, status, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(redemptions)
	common.ApiSuccess(c, pageInfo)
	return
}

func GetRedemption(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	redemption, err := model.GetRedemptionById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if redemption.BatchId != "" {
		redemption.BatchSize, err = model.CountRedemptionBatch(redemption.BatchId)
		if err != nil {
			common.ApiError(c, err)
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    redemption,
	})
	return
}

func AddRedemption(c *gin.Context) {
	if !operation_setting.IsPaymentComplianceConfirmed() {
		common.ApiErrorI18n(c, i18n.MsgPaymentComplianceRequired)
		return
	}

	redemption := model.Redemption{}
	err := c.ShouldBindJSON(&redemption)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if utf8.RuneCountInString(redemption.Name) == 0 || utf8.RuneCountInString(redemption.Name) > 20 {
		common.ApiErrorI18n(c, i18n.MsgRedemptionNameLength)
		return
	}
	if redemption.Count <= 0 {
		common.ApiErrorI18n(c, i18n.MsgRedemptionCountPositive)
		return
	}
	if redemption.Count > 100 {
		common.ApiErrorI18n(c, i18n.MsgRedemptionCountMax)
		return
	}
	if redemption.Quota <= 0 {
		common.ApiError(c, errors.New("redemption quota must be positive"))
		return
	}
	if err := common.ValidateWalletQuota(redemption.Quota); err != nil {
		common.ApiError(c, err)
		return
	}
	if valid, msg := validateExpiredTime(c, redemption.ExpiredTime); !valid {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": msg})
		return
	}
	// A request without max_uses makes one-time codes, as before shared codes.
	if redemption.MaxUses == 0 {
		redemption.MaxUses = 1
	}
	if redemption.MaxUses < 1 || redemption.MaxUses > model.RedemptionMaxUsesLimit {
		common.ApiErrorI18n(c, i18n.MsgRedemptionMaxUsesInvalid)
		return
	}
	// A shared code is one code that many accounts redeem once each; the
	// one-code-per-account rule is for batches of one-time codes.
	if redemption.MaxUses > 1 && (redemption.Count != 1 || redemption.BatchOnePerUser) {
		common.ApiErrorI18n(c, i18n.MsgRedemptionSharedCodeInvalid)
		return
	}
	batchId := common.GetUUID()
	var keys []string
	for i := 0; i < redemption.Count; i++ {
		key := common.GetUUID()
		cleanRedemption := model.Redemption{
			UserId:          c.GetInt("id"),
			Name:            redemption.Name,
			Key:             key,
			CreatedTime:     common.GetTimestamp(),
			Quota:           redemption.Quota,
			ExpiredTime:     redemption.ExpiredTime,
			BatchId:         batchId,
			BatchOnePerUser: redemption.BatchOnePerUser,
			MaxUses:         redemption.MaxUses,
		}
		err = cleanRedemption.Insert()
		if err != nil {
			common.SysError("failed to insert redemption: " + err.Error())
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": i18n.T(c, i18n.MsgRedemptionCreateFailed),
				"data":    keys,
			})
			return
		}
		keys = append(keys, key)
	}
	recordManageAudit(c, "redemption.create", map[string]any{
		"name":               redemption.Name,
		"count":              redemption.Count,
		"quota":              logger.LogQuota(redemption.Quota),
		"max_uses":           redemption.MaxUses,
		"batch_one_per_user": redemption.BatchOnePerUser,
		"batch_id":           batchId,
	})
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    keys,
	})
	return
}

func DeleteRedemption(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	err := model.DeleteRedemptionById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
	return
}

type updateRedemptionRequest struct {
	Id          int    `json:"id"`
	Name        string `json:"name"`
	Quota       int    `json:"quota"`
	ExpiredTime int64  `json:"expired_time"`
	Status      int    `json:"status"`
	// Absent settings stay as they are, so an older editor keeps them.
	MaxUses         *int  `json:"max_uses"`
	BatchOnePerUser *bool `json:"batch_one_per_user"`
}

func UpdateRedemption(c *gin.Context) {
	statusOnly := c.Query("status_only")
	request := updateRedemptionRequest{}
	err := c.ShouldBindJSON(&request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if statusOnly != "" {
		cleanRedemption, err := model.GetRedemptionById(request.Id)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		// Enabling a used-up code would let it be redeemed once more.
		if request.Status == common.RedemptionCodeStatusEnabled && cleanRedemption.UsedCount >= max(cleanRedemption.MaxUses, 1) {
			common.ApiErrorI18n(c, i18n.MsgRedemptionUsedUp)
			return
		}
		cleanRedemption.Status = request.Status
		if err := cleanRedemption.Update(); err != nil {
			common.ApiError(c, err)
			return
		}
		recordManageAudit(c, "redemption.update", map[string]any{
			"id":       cleanRedemption.Id,
			"batch_id": cleanRedemption.BatchId,
			"status":   request.Status,
		})
		common.ApiSuccess(c, cleanRedemption)
		return
	}
	if request.Quota <= 0 {
		common.ApiError(c, errors.New("redemption quota must be positive"))
		return
	}
	if err := common.ValidateWalletQuota(request.Quota); err != nil {
		common.ApiError(c, err)
		return
	}
	if valid, msg := validateExpiredTime(c, request.ExpiredTime); !valid {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": msg})
		return
	}
	cleanRedemption, err := model.UpdateRedemptionDetails(request.Id, model.RedemptionEdit{
		Name:            request.Name,
		Quota:           request.Quota,
		ExpiredTime:     request.ExpiredTime,
		MaxUses:         request.MaxUses,
		BatchOnePerUser: request.BatchOnePerUser,
	})
	if errors.Is(err, model.ErrRedemptionMaxUsesInvalid) {
		common.ApiErrorI18n(c, i18n.MsgRedemptionSharedMaxUsesInvalid)
		return
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	audit := map[string]any{
		"id":       cleanRedemption.Id,
		"batch_id": cleanRedemption.BatchId,
		"name":     cleanRedemption.Name,
		"quota":    logger.LogQuota(cleanRedemption.Quota),
	}
	if request.MaxUses != nil {
		audit["max_uses"] = cleanRedemption.MaxUses
	}
	if request.BatchOnePerUser != nil {
		audit["batch_one_per_user"] = *request.BatchOnePerUser
	}
	recordManageAudit(c, "redemption.update", audit)
	common.ApiSuccess(c, cleanRedemption)
}

func DeleteInvalidRedemption(c *gin.Context) {
	rows, err := model.DeleteInvalidRedemptions()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    rows,
	})
	return
}

func validateExpiredTime(c *gin.Context, expired int64) (bool, string) {
	if expired != 0 && expired < common.GetTimestamp() {
		return false, i18n.T(c, i18n.MsgRedemptionExpireTimeInvalid)
	}
	return true, ""
}

func DeleteRedemptionBatch(c *gin.Context) {
	var request struct {
		Ids []int `json:"ids" binding:"required,min=1,max=1000,dive,gt=0"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
		return
	}
	count, err := model.BatchDeleteRedemptions(request.Ids)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "redemption.delete_batch", map[string]any{
		"count":                    count,
		"total":                    len(request.Ids),
		"requested_redemption_ids": request.Ids,
	})
	common.ApiSuccess(c, count)
}

func GetRedemptionRecords(c *gin.Context) {
	redemptionId, err := strconv.Atoi(c.Param("id"))
	if err != nil || redemptionId <= 0 {
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
		return
	}
	pageInfo := common.GetPageQuery(c)
	records, total, err := model.GetRedemptionRecords(redemptionId, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(records)
	common.ApiSuccess(c, pageInfo)
}

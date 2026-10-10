package controller

import (
	"errors"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
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
		common.ApiErrorT(c, "Payment, redemption, subscription, and invitation reward features are disabled. The administrator must confirm compliance terms before enabling them.")
		return
	}

	redemption := model.Redemption{}
	err := c.ShouldBindJSON(&redemption)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if utf8.RuneCountInString(redemption.Name) == 0 || utf8.RuneCountInString(redemption.Name) > 20 {
		common.ApiErrorT(c, "Redemption code name length must be between 1-20")
		return
	}
	if redemption.Count <= 0 {
		common.ApiErrorT(c, "Redemption code count must be greater than 0")
		return
	}
	if redemption.Count > 100 {
		common.ApiErrorT(c, "Maximum 100 redemption codes can be generated at once")
		return
	}
	if redemption.Quota <= 0 {
		common.ApiErrorT(c, "Redemption quota must be positive")
		return
	}
	if err := common.ValidateWalletQuota(redemption.Quota); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := validateExpiredTime(redemption.ExpiredTime); err != nil {
		common.ApiError(c, err)
		return
	}
	// A request without max_uses makes one-time codes, as before shared codes.
	if redemption.MaxUses == 0 {
		redemption.MaxUses = 1
	}
	if redemption.MaxUses < 1 || redemption.MaxUses > model.RedemptionMaxUsesLimit {
		common.ApiErrorT(c, "A code can be redeemed 1 to 100000 times")
		return
	}
	// A shared code is one code that many accounts redeem once each; the
	// one-code-per-account rule is for batches of one-time codes.
	if redemption.MaxUses > 1 && (redemption.Count != 1 || redemption.BatchOnePerUser) {
		common.ApiErrorT(c, "A shared code is created on its own and has no one-per-account batch rule")
		return
	}
	batchId := common.GetUUID()
	var keys []string
	for range redemption.Count {
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
			common.SysError(common.LogText("failed to insert redemption: %s", err.Error()))
			common.ApiErrorStatus(c, http.StatusOK, common.NewMessage("Failed to create redemption code, please try again later"), gin.H{"data": keys})
			return
		}
		keys = append(keys, key)
	}
	recordManageAudit(c, "redemption.create", map[string]any{
		"name":               redemption.Name,
		"count":              redemption.Count,
		"quota":              logger.FormatQuota(redemption.Quota),
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
			common.ApiErrorT(c, "This code is used up and cannot be enabled again")
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
		common.ApiErrorT(c, "Redemption quota must be positive")
		return
	}
	if err := common.ValidateWalletQuota(request.Quota); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := validateExpiredTime(request.ExpiredTime); err != nil {
		common.ApiError(c, err)
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
		common.ApiErrorT(c, "A shared code serves 2 to 100000 accounts, and no fewer than have already redeemed it")
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
		"quota":    logger.FormatQuota(cleanRedemption.Quota),
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

func validateExpiredTime(expired int64) error {
	if expired != 0 && expired < common.GetTimestamp() {
		return common.NewMessage("Expiration time cannot be earlier than current time")
	}
	return nil
}

func DeleteRedemptionBatch(c *gin.Context) {
	var request struct {
		Ids []int `json:"ids" binding:"required,min=1,max=1000,dive,gt=0"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
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
		common.ApiErrorT(c, "Invalid parameters")
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

package controller

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type upstreamAccountChannelsRequest struct {
	ChannelIds []int `json:"channel_ids"`
}

type channelBalanceSourceRequest struct {
	Source string `json:"source"`
}

func ListUpstreamAccounts(c *gin.Context) {
	accounts, err := model.ListUpstreamAccounts()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, accounts)
}

func ListUpstreamSiteTypes(c *gin.Context) {
	common.ApiSuccess(c, model.GetUpstreamSiteTypeOptions())
}

func ListUpstreamAccountChannels(c *gin.Context) {
	channels := make([]*model.Channel, 0)
	if err := model.DB.Select("id", "name", "base_url", "status", "balance_source").Order("id desc").Find(&channels).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.HydrateChannelUpstreamBalances(channels); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, channels)
}

func CreateUpstreamAccount(c *gin.Context) {
	account := &model.UpstreamAccount{}
	if err := c.ShouldBindJSON(account); err != nil {
		common.ApiError(c, err)
		return
	}
	channelIds := account.ChannelIds
	if err := model.CreateUpstreamAccount(account); err != nil {
		common.ApiError(c, err)
		return
	}
	if len(channelIds) > 0 {
		if err := model.ReplaceUpstreamAccountChannels(account.Id, channelIds); err != nil {
			_ = model.DeleteUpstreamAccount(account.Id)
			common.ApiError(c, err)
			return
		}
		model.InitChannelCache()
	}
	created, err := model.GetUpstreamAccountById(account.Id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	created.ChannelIds = append([]int{}, channelIds...)
	common.ApiSuccess(c, created)
}

func UpdateUpstreamAccount(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	account := &model.UpstreamAccount{}
	if err := c.ShouldBindJSON(account); err != nil {
		common.ApiError(c, err)
		return
	}
	account.Id = id
	if err := model.UpdateUpstreamAccount(account); err != nil {
		common.ApiError(c, err)
		return
	}
	updated, err := model.GetUpstreamAccountById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, updated)
}

func DeleteUpstreamAccount(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.DeleteUpstreamAccount(id); err != nil {
		common.ApiError(c, err)
		return
	}
	model.InitChannelCache()
	common.ApiSuccess(c, nil)
}

func ReplaceUpstreamAccountChannels(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	request := upstreamAccountChannelsRequest{}
	if err := c.ShouldBindJSON(&request); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.ReplaceUpstreamAccountChannels(id, request.ChannelIds); err != nil {
		common.ApiError(c, err)
		return
	}
	model.InitChannelCache()
	common.ApiSuccess(c, nil)
}

func UpdateChannelBalanceSource(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	request := channelBalanceSourceRequest{}
	if err := c.ShouldBindJSON(&request); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.UpdateChannelBalanceSource(id, request.Source); err != nil {
		common.ApiError(c, err)
		return
	}
	model.InitChannelCache()
	common.ApiSuccess(c, nil)
}

func ListUpstreamAccountLogs(c *gin.Context) {
	accountId, _ := strconv.Atoi(c.Query("account_id"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	logs, err := model.ListUpstreamAccountLogs(accountId, limit)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, logs)
}

func loadUpstreamAccountParam(c *gin.Context) (*model.UpstreamAccount, bool) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return nil, false
	}
	account, err := model.GetUpstreamAccountById(id)
	if err != nil {
		common.ApiError(c, err)
		return nil, false
	}
	return account, true
}

func CheckinUpstreamAccount(c *gin.Context) {
	account, ok := loadUpstreamAccountParam(c)
	if !ok {
		return
	}
	result, err := service.CheckinUpstreamAccount(c.Request.Context(), account, model.UpstreamTriggerManual)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error(), "data": result})
		return
	}
	common.ApiSuccess(c, result)
}

func RefreshUpstreamAccountBalance(c *gin.Context) {
	account, ok := loadUpstreamAccountParam(c)
	if !ok {
		return
	}
	result, err := service.RefreshUpstreamAccountBalance(c.Request.Context(), account, model.UpstreamTriggerManual)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error(), "data": result})
		return
	}
	common.ApiSuccess(c, result)
}

func HealthCheckUpstreamAccount(c *gin.Context) {
	account, ok := loadUpstreamAccountParam(c)
	if !ok {
		return
	}
	result, err := service.HealthCheckUpstreamAccount(c.Request.Context(), account, model.UpstreamTriggerManual)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error(), "data": result})
		return
	}
	common.ApiSuccess(c, result)
}

type upstreamAccountTaskPayload struct {
	AccountIds []int `json:"account_ids"`
}

type upstreamAccountTaskResult struct {
	Accounts  int `json:"accounts"`
	Checkins  int `json:"checkins"`
	Balances  int `json:"balances"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

func buildDueUpstreamAccountTask(now int64) (*model.SystemTask, bool, error) {
	accountIds, err := model.GetDueUpstreamAccountIds(now)
	if err != nil || len(accountIds) == 0 {
		return nil, false, err
	}
	if active, err := model.GetActiveSystemTask(model.SystemTaskTypeUpstreamAccount); err != nil {
		return nil, false, err
	} else if active != nil {
		return active, false, nil
	}
	task, err := model.CreateSystemTask(model.SystemTaskTypeUpstreamAccount, upstreamAccountTaskPayload{AccountIds: accountIds}, nil)
	if err != nil {
		active, activeErr := model.GetActiveSystemTask(model.SystemTaskTypeUpstreamAccount)
		if activeErr == nil && active != nil {
			return active, false, nil
		}
		return nil, false, err
	}
	return task, true, nil
}

func runUpstreamAccountTask(ctx context.Context, payload upstreamAccountTaskPayload, progress func(int, int)) (*upstreamAccountTaskResult, error) {
	result := &upstreamAccountTaskResult{Accounts: len(payload.AccountIds)}
	now := common.GetTimestamp()
	for index, accountId := range payload.AccountIds {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		account, err := model.GetUpstreamAccountById(accountId)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			result.Failed++
			continue
		}
		if account.AutoCheckin && account.NextCheckinTime > 0 && account.NextCheckinTime <= now {
			result.Checkins++
			if _, err := service.CheckinUpstreamAccount(ctx, account, model.UpstreamTriggerScheduled); err != nil {
				result.Failed++
			} else {
				result.Succeeded++
			}
			if refreshed, reloadErr := model.GetUpstreamAccountById(accountId); reloadErr == nil {
				account = refreshed
			}
		}
		if account.AutoBalance && account.NextBalanceTime > 0 && account.NextBalanceTime <= now {
			result.Balances++
			if _, err := service.RefreshUpstreamAccountBalance(ctx, account, model.UpstreamTriggerScheduled); err != nil {
				result.Failed++
			} else {
				result.Succeeded++
			}
		}
		if progress != nil {
			progress(index+1, len(payload.AccountIds))
		}
	}
	return result, nil
}

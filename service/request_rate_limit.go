package service

import (
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting"
)

// RequestRateLimitFor returns the request limit a user is held to: the one an
// administrator set for them, else that of the first of the given groups with
// a limit, else the default.
func RequestRateLimitFor(userSetting dto.UserSetting, groups ...string) setting.RequestRateLimit {
	if personal := userSetting.RateLimit; personal != nil {
		return setting.RequestRateLimit{Count: personal.Count, SuccessCount: personal.SuccessCount}
	}
	for _, group := range groups {
		if count, successCount, found := setting.GetGroupRateLimit(group); found {
			return setting.RequestRateLimit{Count: count, SuccessCount: successCount}
		}
	}
	return setting.RequestRateLimit{
		Count:        setting.ModelRequestRateLimitCount,
		SuccessCount: setting.ModelRequestRateLimitSuccessCount,
	}
}

// UserRPM returns how many requests a user may make each minute on their own
// group, failures included; 0 is no limit. The rate limit period is a minute.
func UserRPM(user *model.User) int {
	return RequestRateLimitFor(user.GetSetting(), user.Group).PerPeriod()
}

package service

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting"
)

// Where a user's request limit comes from before subscriptions raise it.
const (
	RequestRateLimitSourceUser    = "user"
	RequestRateLimitSourceGroup   = "group"
	RequestRateLimitSourceDefault = "default"
)

// UserRequestRateLimit is the request limit a user is held to in each rate
// limit period, as shown to administrators and to the user.
type UserRequestRateLimit struct {
	// Count caps every request, failures included; 0 is no cap.
	Count int `json:"count"`
	// SuccessCount caps successful requests; 0 is no cap.
	SuccessCount    int `json:"success_count"`
	DurationMinutes int `json:"duration_minutes"`
	// Source is where the limit comes from before subscriptions raise it.
	Source string `json:"source"`
	// Raised reports that an active subscription raised the limit.
	Raised bool `json:"raised"`
}

// BaseRequestRateLimit returns the request limit a user is held to before
// subscriptions raise it: the one an administrator set for them, else that of
// the first of the given groups with a limit, else the default.
func BaseRequestRateLimit(userSetting dto.UserSetting, groups ...string) (setting.RequestRateLimit, string) {
	if personal := userSetting.RateLimit; personal != nil {
		return setting.RequestRateLimit{Count: personal.Count, SuccessCount: personal.SuccessCount}, RequestRateLimitSourceUser
	}
	for _, group := range groups {
		if count, successCount, found := setting.GetGroupRateLimit(group); found {
			return setting.RequestRateLimit{Count: count, SuccessCount: successCount}, RequestRateLimitSourceGroup
		}
	}
	return setting.RequestRateLimit{
		Count:        setting.ModelRequestRateLimitCount,
		SuccessCount: setting.ModelRequestRateLimitSuccessCount,
	}, RequestRateLimitSourceDefault
}

// RequestRateLimitFor returns the request limit a user is held to: their base
// limit over the given groups, raised by what their active subscriptions grant.
// The subscriptions are read through a cache that can lag an expiry by up to a
// minute. When they cannot be read, it returns the base limit along with the
// error.
func RequestRateLimitFor(userId int, userSetting dto.UserSetting, groups ...string) (setting.RequestRateLimit, error) {
	base, _ := BaseRequestRateLimit(userSetting, groups...)
	raise, raised, err := model.UserSubscriptionRequestRateLimit(userId)
	if err != nil || !raised {
		return base, err
	}
	return base.Raise(raise), nil
}

// DescribeRequestRateLimits returns the request limit each given user is held to
// on their own group, read straight from their subscriptions. When those cannot
// be read, it describes the limits as they are before subscriptions raise them.
func DescribeRequestRateLimits(users []*model.User) map[int]UserRequestRateLimit {
	userIds := make([]int, 0, len(users))
	for _, user := range users {
		userIds = append(userIds, user.Id)
	}
	raises, err := model.SubscriptionRequestRateLimits(userIds)
	if err != nil {
		common.SysError("failed to read the subscriptions raising users' request limits: " + err.Error())
	}
	limits := make(map[int]UserRequestRateLimit, len(users))
	for _, user := range users {
		base, source := BaseRequestRateLimit(user.GetSetting(), user.Group)
		limit := base
		if raise, ok := raises[user.Id]; ok {
			limit = base.Raise(raise)
		}
		limits[user.Id] = UserRequestRateLimit{
			Count:           limit.Count,
			SuccessCount:    limit.SuccessCount,
			DurationMinutes: setting.ModelRequestRateLimitDurationMinutes,
			Source:          source,
			Raised:          limit != base,
		}
	}
	return limits
}

package setting

import (
	"fmt"
	"math"
	"sync"

	"github.com/QuantumNous/new-api/common"
)

// maxRateLimitDurationSeconds is the largest window the count cap is computed
// against (24h). Token-bucket capacity is count*duration; this keeps that
// product inside int64 when the window is at most a day.
const maxRateLimitDurationSeconds = 24 * 60 * 60

// maxModelRequestRateLimitCount is math.MaxInt64 / maxRateLimitDurationSeconds.
// It is the largest count that cannot overflow int64(count)*duration for a
// window of at most 24 hours.
const maxModelRequestRateLimitCount int64 = math.MaxInt64 / maxRateLimitDurationSeconds

// ModelRequestRateLimitEnabled turns on the cap all users' requests share. Each
// user's own limit applies whether or not it is on.
var ModelRequestRateLimitEnabled = false
var ModelRequestRateLimitDurationMinutes = 1

// ModelRequestRateLimitCount and ModelRequestRateLimitSuccessCount are the
// limit of a user whose group has none of its own.
var ModelRequestRateLimitCount = 0
var ModelRequestRateLimitSuccessCount = 1000
var ModelRequestRateLimitGroup = map[string][2]int{}
var ModelRequestRateLimitMutex sync.RWMutex

// ModelRequestRateLimitGlobalCount and ModelRequestRateLimitGlobalSuccessCount
// cap all users' requests together while ModelRequestRateLimitEnabled is on.
var ModelRequestRateLimitGlobalCount = 0
var ModelRequestRateLimitGlobalSuccessCount = 0

// RequestRateLimit caps the requests one counter admits in each rate limit
// period: Count counts every request, failures included, and SuccessCount only
// successful ones. A cap of 0 is off.
type RequestRateLimit struct {
	Count        int
	SuccessCount int
}

// PerPeriod returns how many requests the limit admits in each period: the
// stricter of its caps, or 0 when it caps neither.
func (l RequestRateLimit) PerPeriod() int {
	switch {
	case l.Count == 0:
		return l.SuccessCount
	case l.SuccessCount == 0:
		return l.Count
	default:
		return min(l.Count, l.SuccessCount)
	}
}

// CheckRequestRateLimit reports whether a limit a group or a user sets is in
// range: a request cap of 0 or more, where 0 is off, and a success cap of at
// least 1.
func CheckRequestRateLimit(count, successCount int) error {
	if count < 0 || successCount < 1 {
		return fmt.Errorf("rate limit [%d, %d] needs a request cap of at least 0 and a success cap of at least 1", count, successCount)
	}
	if int64(count) > maxModelRequestRateLimitCount || int64(successCount) > maxModelRequestRateLimitCount {
		return fmt.Errorf("rate limit [%d, %d] exceeds max rate limit %d", count, successCount, maxModelRequestRateLimitCount)
	}
	return nil
}

// CheckGlobalRequestRateLimitCap reports whether a cap all users share is in
// range. 0 turns it off.
func CheckGlobalRequestRateLimitCap(value int) error {
	if value < 0 || int64(value) > maxModelRequestRateLimitCount {
		return fmt.Errorf("global rate limit %d must be between 0 and %d", value, maxModelRequestRateLimitCount)
	}
	return nil
}

func ModelRequestRateLimitGroup2JSONString() string {
	ModelRequestRateLimitMutex.RLock()
	defer ModelRequestRateLimitMutex.RUnlock()

	jsonBytes, err := common.Marshal(ModelRequestRateLimitGroup)
	if err != nil {
		common.SysLog("error marshalling model ratio: " + err.Error())
	}
	return string(jsonBytes)
}

func UpdateModelRequestRateLimitGroupByJSONString(jsonStr string) error {
	ModelRequestRateLimitMutex.RLock()
	defer ModelRequestRateLimitMutex.RUnlock()

	ModelRequestRateLimitGroup = make(map[string][2]int)
	return common.Unmarshal([]byte(jsonStr), &ModelRequestRateLimitGroup)
}

func GetGroupRateLimit(group string) (totalCount, successCount int, found bool) {
	ModelRequestRateLimitMutex.RLock()
	defer ModelRequestRateLimitMutex.RUnlock()

	if ModelRequestRateLimitGroup == nil {
		return 0, 0, false
	}

	limits, found := ModelRequestRateLimitGroup[group]
	if !found {
		return 0, 0, false
	}
	return limits[0], limits[1], true
}

func CheckModelRequestRateLimitGroup(jsonStr string) error {
	checkModelRequestRateLimitGroup := make(map[string][2]int)
	err := common.Unmarshal([]byte(jsonStr), &checkModelRequestRateLimitGroup)
	if err != nil {
		return err
	}
	for group, limits := range checkModelRequestRateLimitGroup {
		if err := CheckRequestRateLimit(limits[0], limits[1]); err != nil {
			return fmt.Errorf("group %s: %w", group, err)
		}
	}

	return nil
}

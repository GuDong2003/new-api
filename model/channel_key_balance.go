package model

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// channelKeyBalanceBatch bounds the rows one statement writes or deletes, so
// a channel with thousands of keys stays within every database's limit on
// the parameters of a statement.
const channelKeyBalanceBatch = 500

// channelKeyBalanceLocks holds a lock per channel. Saves of one channel's key
// balances run one at a time, so two refreshes finishing together cannot
// deadlock on its rows.
var channelKeyBalanceLocks sync.Map

// ChannelKeyBalance is the balance one key of a multi-key channel last read.
// It is kept by a fingerprint of the key rather than its position, so adding,
// removing or reordering keys never moves a balance onto another key, and in
// a table of its own, so no save of the channel overwrites it. UpdatedTime
// stays 0 until a refresh reads the key.
type ChannelKeyBalance struct {
	Id          int
	ChannelId   int    `gorm:"uniqueIndex:idx_channel_key_balance_key"`
	KeyHash     string `gorm:"type:varchar(32);uniqueIndex:idx_channel_key_balance_key"`
	Balance     float64
	UpdatedTime int64  `gorm:"bigint"`
	Status      string `gorm:"type:varchar(32)"`
}

// ChannelKeyBalanceDetail is the balance of the key at Index, as the channel
// API lists it: by position, never by the key itself. KeyStatus is the key's
// own status, enabled or manually or automatically disabled.
type ChannelKeyBalanceDetail struct {
	Index       int     `json:"index"`
	Balance     float64 `json:"balance"`
	UpdatedTime int64   `json:"updated_time"`
	Status      string  `json:"status"`
	KeyStatus   int     `json:"key_status"`
}

// ChannelKeyBalanceRead is how reading the balance of one key went.
type ChannelKeyBalanceRead struct {
	Key     string
	Balance float64
	Failed  bool
}

// ChannelKeyBalanceSummary is a multi-key channel's balance after a refresh:
// the total and when it was last read, and the balance of each key.
type ChannelKeyBalanceSummary struct {
	Balance     float64
	UpdatedTime int64
	Keys        []ChannelKeyBalanceDetail
}

// channelKeyFingerprint names a key without revealing it.
func channelKeyFingerprint(key string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(key)))
	return hex.EncodeToString(sum[:8])
}

// channelKeyBalanceDetails lists, in the order of keys, the balance each key
// last read.
func channelKeyBalanceDetails(keys []string, keyStatuses map[int]int, balances map[string]ChannelKeyBalance) []ChannelKeyBalanceDetail {
	details := make([]ChannelKeyBalanceDetail, 0, len(keys))
	for index, key := range keys {
		detail := ChannelKeyBalanceDetail{Index: index, Status: UpstreamStatusUnknown, KeyStatus: common.ChannelStatusEnabled}
		if status, ok := keyStatuses[index]; ok {
			detail.KeyStatus = status
		}
		if balance, ok := balances[channelKeyFingerprint(key)]; ok {
			detail.Balance = balance.Balance
			detail.UpdatedTime = balance.UpdatedTime
			detail.Status = balance.Status
		}
		details = append(details, detail)
	}
	return details
}

// ChannelKeyReadOrder is the order to read the keys of a multi-key channel
// in: keys never read first, then those read longest ago, so a refresh cut
// short by its deadline reaches the keys it left out first next time. It is
// the keys' own order when their balances cannot be loaded.
func ChannelKeyReadOrder(channelId int, keys []string) []int {
	order := make([]int, len(keys))
	for index := range order {
		order[index] = index
	}
	var stored []ChannelKeyBalance
	if err := DB.Select("key_hash", "updated_time").Where("channel_id = ?", channelId).Find(&stored).Error; err != nil {
		return order
	}
	readAt := make(map[string]int64, len(stored))
	for _, balance := range stored {
		readAt[balance.KeyHash] = balance.UpdatedTime
	}
	times := make([]int64, len(keys))
	for index, key := range keys {
		times[index] = readAt[channelKeyFingerprint(key)]
	}
	slices.SortStableFunc(order, func(a, b int) int {
		return cmp.Compare(times[a], times[b])
	})
	return order
}

// SaveChannelKeyBalances records the balances just read for the keys of a
// multi-key channel and forgets those of keys it no longer has. A key that
// could not be read keeps the balance it read last, a key not read at all is
// left as it was, and the channel balance becomes the total of every key read
// so far, counting a key listed twice once.
func SaveChannelKeyBalances(channelId int, reads []ChannelKeyBalanceRead) (*ChannelKeyBalanceSummary, error) {
	value, _ := channelKeyBalanceLocks.LoadOrStore(channelId, &sync.Mutex{})
	lock := value.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	channel, err := GetChannelById(channelId, true)
	if err != nil {
		return nil, err
	}
	var stored []ChannelKeyBalance
	if err := DB.Where("channel_id = ?", channelId).Find(&stored).Error; err != nil {
		return nil, err
	}
	previous := make(map[string]ChannelKeyBalance, len(stored))
	for _, balance := range stored {
		previous[balance.KeyHash] = balance
	}
	readByKey := make(map[string]ChannelKeyBalanceRead, len(reads))
	for _, read := range reads {
		readByKey[channelKeyFingerprint(read.Key)] = read
	}
	now := common.GetTimestamp()
	summary := &ChannelKeyBalanceSummary{Balance: channel.Balance, UpdatedTime: channel.BalanceUpdatedTime}
	balances := make(map[string]ChannelKeyBalance)
	kept := make([]ChannelKeyBalance, 0, len(stored))
	total := 0.0
	anyRead := false
	for _, key := range channel.GetKeys() {
		hash := channelKeyFingerprint(key)
		if _, counted := balances[hash]; counted {
			continue
		}
		balance, known := previous[hash]
		read, wasRead := readByKey[hash]
		switch {
		case wasRead && !read.Failed:
			balance.Balance = read.Balance
			balance.UpdatedTime = now
			balance.Status = UpstreamStatusHealthy
			anyRead = true
		case wasRead:
			balance.Status = UpstreamStatusFailed
		case !known:
			// A key added while the others were being read waits for the
			// next refresh.
			continue
		}
		// Rows are matched on the channel and key, not on their own id.
		balance.Id = 0
		balance.ChannelId = channelId
		balance.KeyHash = hash
		balances[hash] = balance
		kept = append(kept, balance)
		if balance.UpdatedTime > 0 {
			total += balance.Balance
		}
	}
	forgotten := make([]string, 0)
	for hash := range previous {
		if _, ok := balances[hash]; !ok {
			forgotten = append(forgotten, hash)
		}
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		for hashes := range slices.Chunk(forgotten, channelKeyBalanceBatch) {
			if err := tx.Where("channel_id = ? AND key_hash IN ?", channelId, hashes).Delete(&ChannelKeyBalance{}).Error; err != nil {
				return err
			}
		}
		if len(kept) > 0 {
			err := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "channel_id"}, {Name: "key_hash"}},
				DoUpdates: clause.AssignmentColumns([]string{"balance", "updated_time", "status"}),
			}).CreateInBatches(&kept, channelKeyBalanceBatch).Error
			if err != nil {
				return err
			}
		}
		if !anyRead {
			return nil
		}
		return tx.Model(&Channel{}).Where("id = ?", channelId).
			Updates(map[string]any{"balance": total, "balance_updated_time": now}).Error
	})
	if err != nil {
		return nil, err
	}
	if anyRead {
		summary.Balance = total
		summary.UpdatedTime = now
	}
	summary.Keys = channelKeyBalanceDetails(channel.GetKeys(), channel.ChannelInfo.MultiKeyStatusList, balances)
	return summary, nil
}

// HydrateChannelKeyBalances lists, key by key, the balances of the multi-key
// channels among channels that take their balance from their own keys. The
// channel list loads channels without their keys, so only the keys of
// channels with balances to list are loaded.
func HydrateChannelKeyBalances(channels []*Channel) error {
	ids := make([]int, 0, len(channels))
	for _, channel := range channels {
		if channel == nil || !channel.ChannelInfo.IsMultiKey {
			continue
		}
		if channel.BalanceSource == ChannelBalanceSourceUpstream || channel.BalanceSource == ChannelBalanceSourceNone {
			continue
		}
		ids = append(ids, channel.Id)
	}
	if len(ids) == 0 {
		return nil
	}
	var stored []ChannelKeyBalance
	if err := DB.Where("channel_id IN ?", ids).Find(&stored).Error; err != nil {
		return err
	}
	if len(stored) == 0 {
		return nil
	}
	byChannel := make(map[int]map[string]ChannelKeyBalance)
	for _, balance := range stored {
		if byChannel[balance.ChannelId] == nil {
			byChannel[balance.ChannelId] = make(map[string]ChannelKeyBalance)
		}
		byChannel[balance.ChannelId][balance.KeyHash] = balance
	}
	withBalances := make([]int, 0, len(byChannel))
	for id := range byChannel {
		withBalances = append(withBalances, id)
	}
	var keyed []*Channel
	if err := DB.Select("id", "key").Where("id IN ?", withBalances).Find(&keyed).Error; err != nil {
		return err
	}
	keysById := make(map[int][]string, len(keyed))
	for _, channel := range keyed {
		keysById[channel.Id] = channel.GetKeys()
	}
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		balances, keys := byChannel[channel.Id], keysById[channel.Id]
		if len(balances) == 0 || len(keys) == 0 {
			continue
		}
		channel.KeyBalanceDetails = channelKeyBalanceDetails(keys, channel.ChannelInfo.MultiKeyStatusList, balances)
	}
	return nil
}

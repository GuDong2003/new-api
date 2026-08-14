package operation_setting

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/setting/config"
)

type MonitorSetting struct {
	AutoTestChannelEnabled bool    `json:"auto_test_channel_enabled"`
	AutoTestChannelMinutes float64 `json:"auto_test_channel_minutes"`
	ChannelTestMode        string  `json:"channel_test_mode"`
	ChannelTestMessage     string  `json:"channel_test_message"`
}

const (
	ChannelTestModeScheduledAll    = "scheduled_all"
	ChannelTestModeAutoBanOnly     = "auto_ban_only"
	ChannelTestModePassiveRecovery = "passive_recovery"
	ChannelTestMessageOptionKey    = "monitor_setting.channel_test_message"
	DefaultChannelTestMessage      = "你好，请简单介绍一下你自己。"
	ChannelTestMessageMaxRunes     = 4096
)

// 默认配置
var monitorSetting = MonitorSetting{
	AutoTestChannelEnabled: false,
	AutoTestChannelMinutes: 10,
	ChannelTestMode:        ChannelTestModeScheduledAll,
	ChannelTestMessage:     DefaultChannelTestMessage,
}

func init() {
	// 注册到全局配置管理器
	config.GlobalConfig.Register("monitor_setting", &monitorSetting)
}

func GetMonitorSetting() *MonitorSetting {
	if os.Getenv("CHANNEL_TEST_FREQUENCY") != "" {
		frequency, err := strconv.Atoi(os.Getenv("CHANNEL_TEST_FREQUENCY"))
		if err == nil && frequency > 0 {
			monitorSetting.AutoTestChannelEnabled = true
			monitorSetting.AutoTestChannelMinutes = float64(frequency)
			monitorSetting.ChannelTestMode = ChannelTestModeScheduledAll
		}
	}
	if enabled, ok := os.LookupEnv("CHANNEL_TEST_ENABLED"); ok {
		parsed, err := strconv.ParseBool(enabled)
		if err == nil {
			monitorSetting.AutoTestChannelEnabled = parsed
		}
	}
	switch monitorSetting.ChannelTestMode {
	case ChannelTestModeAutoBanOnly, ChannelTestModePassiveRecovery:
	default:
		monitorSetting.ChannelTestMode = ChannelTestModeScheduledAll
	}
	return &monitorSetting
}

// NormalizeChannelTestMessage trims and validates a test prompt supplied by
// an administrator or a one-off channel test request. Empty values are
// allowed and resolve to the configured global default at request time.
func NormalizeChannelTestMessage(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) {
		return "", fmt.Errorf("channel test message must be valid UTF-8")
	}
	if utf8.RuneCountInString(value) > ChannelTestMessageMaxRunes {
		return "", fmt.Errorf("channel test message must be at most %d characters", ChannelTestMessageMaxRunes)
	}
	return value, nil
}

// ResolveChannelTestMessage returns the one-off prompt when provided, or the
// persisted global prompt for scheduled/default tests.
func ResolveChannelTestMessage(value string) (string, error) {
	normalized, err := NormalizeChannelTestMessage(value)
	if err != nil {
		return "", err
	}
	if normalized != "" {
		return normalized, nil
	}

	global, err := NormalizeChannelTestMessage(monitorSetting.ChannelTestMessage)
	if err != nil || global == "" {
		return DefaultChannelTestMessage, nil
	}
	return global, nil
}

func ValidateChannelTestMessage(value string) error {
	_, err := NormalizeChannelTestMessage(value)
	return err
}

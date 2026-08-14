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
	AutoTestChannelEnabled         bool    `json:"auto_test_channel_enabled"`
	AutoTestChannelMinutes         float64 `json:"auto_test_channel_minutes"`
	ChannelTestMode                string  `json:"channel_test_mode"`
	ChannelTestMessage             string  `json:"channel_test_message"`
	ChannelTestUseChannelStyle     bool    `json:"channel_test_use_channel_style"`
	ChannelTestShowResponsePreview bool    `json:"channel_test_show_response_preview"`
}

const (
	ChannelTestModeScheduledAll    = "scheduled_all"
	ChannelTestModeAutoBanOnly     = "auto_ban_only"
	ChannelTestModePassiveRecovery = "passive_recovery"
	DefaultChannelTestMessage      = "你好，请简单介绍一下你自己。"
	ChannelTestMessageMaxRunes     = 4096

	ChannelTestMessageOptionKey             = "monitor_setting.channel_test_message"
	ChannelTestUseChannelStyleOptionKey     = "monitor_setting.channel_test_use_channel_style"
	ChannelTestShowResponsePreviewOptionKey = "monitor_setting.channel_test_show_response_preview"
)

// 默认配置
func defaultMonitorSetting() MonitorSetting {
	return MonitorSetting{
		AutoTestChannelEnabled:         false,
		AutoTestChannelMinutes:         10,
		ChannelTestMode:                ChannelTestModeScheduledAll,
		ChannelTestMessage:             DefaultChannelTestMessage,
		ChannelTestUseChannelStyle:     true,
		ChannelTestShowResponsePreview: false,
	}
}

var monitorSetting = defaultMonitorSetting()

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
	message, err := NormalizeChannelTestMessage(monitorSetting.ChannelTestMessage)
	if err != nil || message == "" {
		monitorSetting.ChannelTestMessage = DefaultChannelTestMessage
	} else {
		monitorSetting.ChannelTestMessage = message
	}
	return &monitorSetting
}

// NormalizeChannelTestMessage trims and validates the administrator-configured
// global channel-test message. Empty values resolve to the built-in default at
// request time.
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

// ResolveChannelTestMessage returns an explicitly supplied internal test
// message when provided, or the persisted global message for default tests.
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

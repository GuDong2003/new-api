package model

import (
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChannelValidateSettingsRejectsInvalidHTTPTransport(t *testing.T) {
	tests := []struct {
		name    string
		setting dto.ChannelSettings
		wantErr string
	}{
		{
			name:    "auto with shards is valid",
			setting: dto.ChannelSettings{HTTPProtocol: "auto", HTTP2ConnectionShards: 4},
		},
		{
			name:    "http1 with shards greater than one rejected",
			setting: dto.ChannelSettings{HTTPProtocol: "http1", HTTP2ConnectionShards: 2},
			wantErr: "http2_connection_shards",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			channel := &Channel{}
			channel.SetSetting(tt.setting)
			err := channel.ValidateSettings()
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestChannelValidateSettingsSupportsStandardClientIdentityTemplates(t *testing.T) {
	tests := []struct {
		name        string
		channelType int
		config      *dto.ClientIdentityConfig
		wantErr     string
	}{
		{
			name:        "standard OpenAI",
			channelType: constant.ChannelTypeOpenAI,
			config: &dto.ClientIdentityConfig{
				ClientType: dto.ClientIdentityClientTypeCodex,
				Profile:    dto.ClientIdentityProfileCodexCLI,
				Version:    "0.147.0",
				Platform:   dto.ClientIdentityPlatformWindowsX64,
			},
		},
		{
			name:        "standard Anthropic",
			channelType: constant.ChannelTypeAnthropic,
			config: &dto.ClientIdentityConfig{
				ClientType: dto.ClientIdentityClientTypeClaude,
				Profile:    dto.ClientIdentityProfileClaudeCLI,
				Version:    "2.1.224",
				Platform:   dto.ClientIdentityPlatformMacOSX64,
			},
		},
		{
			name:        "profile belongs to another template",
			channelType: constant.ChannelTypeOpenAI,
			config: &dto.ClientIdentityConfig{
				ClientType: dto.ClientIdentityClientTypeClaudeCode,
				Profile:    dto.ClientIdentityProfileClaudeCode,
			},
			wantErr: "not supported",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			channel := &Channel{Type: tt.channelType}
			channel.SetOtherSettings(dto.ChannelOtherSettings{ClientIdentity: tt.config})

			err := channel.ValidateSettings()
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestChannelValidateSettingsKeepsLegacyEmptyOtherSettingsValid(t *testing.T) {
	for _, channelType := range []int{constant.ChannelTypeOpenAI, constant.ChannelTypeAnthropic} {
		t.Run(fmt.Sprintf("channel-%d", channelType), func(t *testing.T) {
			channel := &Channel{Type: channelType}
			channel.SetOtherSettings(dto.ChannelOtherSettings{})

			require.NoError(t, channel.ValidateSettings())
		})
	}
}

func TestAdvancedCustomChannelRequiresModelListRouteOnlyWhenUpdateChecksEnabled(t *testing.T) {
	inferenceRoute := dto.AdvancedCustomRoute{
		IncomingPath: "/v1/chat/completions",
		UpstreamPath: "/v1/chat/completions",
		Converter:    "none",
	}

	tests := []struct {
		name          string
		checksEnabled bool
		routes        []dto.AdvancedCustomRoute
		wantErr       string
	}{
		{
			name:   "legacy channel without discovery route remains valid",
			routes: []dto.AdvancedCustomRoute{inferenceRoute},
		},
		{
			name:          "enabled checks require discovery route",
			checksEnabled: true,
			routes:        []dto.AdvancedCustomRoute{inferenceRoute},
			wantErr:       dto.AdvancedCustomModelListPath,
		},
		{
			name:          "enabled checks accept discovery route",
			checksEnabled: true,
			routes: []dto.AdvancedCustomRoute{
				inferenceRoute,
				{
					IncomingPath: dto.AdvancedCustomModelListPath,
					UpstreamPath: dto.AdvancedCustomModelListPath,
					Converter:    "none",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			channel := &Channel{Type: constant.ChannelTypeAdvancedCustom}
			channel.SetOtherSettings(dto.ChannelOtherSettings{
				UpstreamModelUpdateCheckEnabled: tt.checksEnabled,
				AdvancedCustom: &dto.AdvancedCustomConfig{
					Routes: tt.routes,
				},
			})

			err := channel.ValidateSettings()
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

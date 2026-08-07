package controller

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

type clientIdentityVersionRequest struct {
	Profile  string `json:"profile"`
	Platform string `json:"platform,omitempty"`
}

func validateClientIdentityQuery(c *gin.Context) error {
	allowed := map[string]struct{}{
		"profile":  {},
		"platform": {},
	}
	for key := range c.Request.URL.Query() {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("unsupported client identity query parameter: %s", key)
		}
	}
	return nil
}

func normalizeClientIdentityVersionRequest(request clientIdentityVersionRequest) (string, string, error) {
	profile, err := dto.NormalizeClientIdentityProfile(request.Profile)
	if err != nil {
		return "", "", err
	}
	platform, err := dto.NormalizeClientIdentityPlatform(request.Platform)
	if err != nil {
		return "", "", err
	}
	config := dto.ClientIdentityConfig{Profile: profile, Platform: platform}
	if err := config.Validate(dto.ClientIdentityChannelTypeForProfile(profile)); err != nil {
		return "", "", err
	}
	return profile, platform, nil
}

func GetClientIdentityVersions(c *gin.Context) {
	if err := validateClientIdentityQuery(c); err != nil {
		common.ApiError(c, err)
		return
	}
	profile := strings.TrimSpace(c.Query("profile"))
	if profile == "" {
		common.ApiErrorMsg(c, "profile is required and must be one of the supported client profiles")
		return
	}
	profile, platform, err := normalizeClientIdentityVersionRequest(clientIdentityVersionRequest{
		Profile:  profile,
		Platform: c.Query("platform"),
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	lookup, err := service.GetClientIdentityVersions(c.Request.Context(), profile, platform)
	if err != nil {
		common.SysError("failed to load client identity versions: " + err.Error())
		common.ApiErrorMsg(c, "official client identity versions are unavailable and no cached version exists")
		return
	}
	common.ApiSuccess(c, lookup)
}

func RefreshClientIdentityVersions(c *gin.Context) {
	var request clientIdentityVersionRequest
	rawBody, err := c.GetRawData()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	var rawFields map[string]any
	if err := common.Unmarshal(rawBody, &rawFields); err != nil {
		common.ApiError(c, fmt.Errorf("invalid client identity refresh request: %w", err))
		return
	}
	for key := range rawFields {
		if key != "profile" && key != "platform" {
			common.ApiError(c, fmt.Errorf("unsupported client identity refresh field: %s", key))
			return
		}
	}
	if err := common.Unmarshal(rawBody, &request); err != nil {
		common.ApiError(c, fmt.Errorf("invalid client identity refresh request: %w", err))
		return
	}
	profile, platform, err := normalizeClientIdentityVersionRequest(request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	lookup, err := service.RefreshClientIdentityVersions(c.Request.Context(), profile, platform)
	if err != nil {
		common.SysError("failed to refresh client identity versions: " + err.Error())
		common.ApiErrorMsg(c, "official client identity versions are unavailable and no cached version exists")
		return
	}
	common.ApiSuccess(c, lookup)
}

func GetChannelClientIdentity(c *gin.Context) {
	channelID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, fmt.Errorf("invalid channel id: %w", err))
		return
	}
	channel, err := model.GetChannelById(channelID, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if channel == nil {
		common.ApiErrorMsg(c, "channel not found")
		return
	}
	if !dto.SupportsClientIdentityChannelType(channel.Type) {
		common.ApiSuccess(c, gin.H{
			"channel_id":   channel.Id,
			"channel_type": channel.Type,
			"supported":    false,
		})
		return
	}

	config := dto.DefaultClientIdentityConfig(channel.Type)
	persisted := false
	settings := channel.GetOtherSettings()
	if settings.ClientIdentity != nil {
		config = *settings.ClientIdentity
		if settings.ClientIdentity.Source != nil {
			sourceCopy := *settings.ClientIdentity.Source
			config.Source = &sourceCopy
		}
		if err := config.Normalize(channel.Type); err != nil {
			common.ApiError(c, fmt.Errorf("invalid client identity settings: %w", err))
			return
		}
		persisted = !config.IsZero()
	}
	common.ApiSuccess(c, gin.H{
		"channel_id":   channel.Id,
		"channel_type": channel.Type,
		"supported":    true,
		"persisted":    persisted,
		"config":       config,
	})
}

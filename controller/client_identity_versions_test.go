package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetChannelClientIdentityReturnsStandardTemplateDefaults(t *testing.T) {
	db := setupModelListControllerTestDB(t)

	channel := &model.Channel{
		Type: constant.ChannelTypeOpenAI,
		Name: "standard OpenAI",
		Key:  "test-key",
	}
	channel.SetOtherSettings(dto.ChannelOtherSettings{
		ClientIdentity: &dto.ClientIdentityConfig{},
	})
	require.NoError(t, db.Create(channel).Error)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: "1"}}
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/channel/1/client-identity", nil)

	GetChannelClientIdentity(ctx)

	var response struct {
		Success bool `json:"success"`
		Data    struct {
			Supported bool                     `json:"supported"`
			Persisted bool                     `json:"persisted"`
			Config    dto.ClientIdentityConfig `json:"config"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.True(t, response.Success)
	assert.True(t, response.Data.Supported)
	assert.False(t, response.Data.Persisted)
	assert.Equal(t, dto.ClientIdentityClientTypeNone, response.Data.Config.ClientType)
	assert.Equal(t, dto.ClientIdentityProfileNone, response.Data.Config.Profile)
	assert.Empty(t, response.Data.Config.Version)
	assert.Empty(t, response.Data.Config.Platform)
}

func TestNormalizeClientIdentityVersionRequestRejectsInvalidProfile(t *testing.T) {
	_, _, err := normalizeClientIdentityVersionRequest(clientIdentityVersionRequest{
		Profile:  "not-a-profile",
		Platform: dto.ClientIdentityPlatformLinuxX64,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid client identity profile")
}

package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	canvasDefaultModelsOption       = "canvas_setting.default_models"
	canvasDisabledResolutionsOption = "canvas_setting.disabled_resolutions"
)

// keepCanvasSetting puts the canvas setting back once the test is done.
func keepCanvasSetting(t *testing.T) {
	t.Helper()
	canvas := config.GlobalConfig.Get("canvas_setting").(*operation_setting.CanvasSetting)
	previous := *canvas
	t.Cleanup(func() { *canvas = previous })
}

// saveCanvasOption saves one option the way the Canvas management table does.
func saveCanvasOption(t *testing.T, key, value string) (bool, string) {
	t.Helper()
	body, err := common.Marshal(OptionUpdateRequest{Key: key, Value: value})
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPut, "/api/option/", strings.NewReader(string(body)))
	UpdateOption(c)
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	return response.Success, response.Message
}

// Every group keeps at least one tier, and only named groups, named models
// and known tiers are stored; the canvas relies on all three.
func TestUpdateOptionValidatesCanvasSettings(t *testing.T) {
	modelManagementDB(t, "sqlite", "")
	keepCanvasSetting(t)
	tests := []struct {
		name     string
		key      string
		value    string
		accepted bool
	}{
		{name: "a model for each group", key: canvasDefaultModelsOption, value: `{"default":"gpt-image-2","vip":"nano-banana-pro"}`, accepted: true},
		{name: "no default models", key: canvasDefaultModelsOption, value: `{}`, accepted: true},
		{name: "default models that are not a JSON object", key: canvasDefaultModelsOption, value: `["gpt-image-2"]`},
		{name: "a default model for an unnamed group", key: canvasDefaultModelsOption, value: `{" ":"gpt-image-2"}`},
		{name: "a blank default model", key: canvasDefaultModelsOption, value: `{"vip":" "}`},
		{name: "some tiers withheld", key: canvasDisabledResolutionsOption, value: `{"default":["4K"],"vip":["1K","2K"]}`, accepted: true},
		{name: "no tiers withheld", key: canvasDisabledResolutionsOption, value: `{}`, accepted: true},
		{name: "a repeated tier that still leaves one", key: canvasDisabledResolutionsOption, value: `{"default":["4K","4K","2K"]}`, accepted: true},
		{name: "every tier withheld", key: canvasDisabledResolutionsOption, value: `{"default":["1K","2K","4K"]}`},
		{name: "an unknown tier", key: canvasDisabledResolutionsOption, value: `{"default":["8K"]}`},
		{name: "tiers for an unnamed group", key: canvasDisabledResolutionsOption, value: `{"":["4K"]}`},
		{name: "tiers that are not a JSON object", key: canvasDisabledResolutionsOption, value: `"4K"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			success, message := saveCanvasOption(t, tt.key, tt.value)
			assert.Equal(t, tt.accepted, success, message)
			if !tt.accepted {
				assert.NotEmpty(t, message)
			}
		})
	}
}

// The canvas asks only for its own user's group. A group nobody set up gets
// no default model and every tier, as an empty list rather than null.
func TestCanvasSettingSavedAsOptionsReachesTheUsersGroup(t *testing.T) {
	modelManagementDB(t, "sqlite", "")
	keepCanvasSetting(t)
	success, message := saveCanvasOption(t, canvasDefaultModelsOption, `{"vip":"gpt-image-2","default":"nano-banana-pro"}`)
	require.True(t, success, message)
	success, message = saveCanvasOption(t, canvasDisabledResolutionsOption, `{"vip":["4K"],"default":["2K","4K"]}`)
	require.True(t, success, message)

	tests := []struct {
		group string
		want  string
	}{
		{group: "vip", want: `{"default_model":"gpt-image-2","disabled_resolutions":["4K"]}`},
		{group: "free", want: `{"default_model":"","disabled_resolutions":[]}`},
	}
	for _, tt := range tests {
		t.Run(tt.group, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/user/canvas_setting", nil)
			common.SetContextKey(c, constant.ContextKeyUserGroup, tt.group)

			GetCanvasSetting(c)

			require.Equal(t, http.StatusOK, recorder.Code)
			assert.JSONEq(t, `{"success":true,"message":"","data":`+tt.want+`}`, recorder.Body.String())
		})
	}
}

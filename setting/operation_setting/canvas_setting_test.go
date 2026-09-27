package operation_setting

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestValidateCanvasDefaultModels(t *testing.T) {
	tests := []struct {
		name  string
		value string
		valid bool
	}{
		{name: "a model for each group", value: `{"default":"gpt-image-2","vip":"nano-banana-pro"}`, valid: true},
		{name: "no defaults", value: `{}`, valid: true},
		{name: "not a JSON object", value: `["gpt-image-2"]`},
		{name: "a group without a name", value: `{" ":"gpt-image-2"}`},
		{name: "a group without a model", value: `{"vip":" "}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateCanvasDefaultModels(tt.value)
			if tt.valid {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

func TestValidateCanvasDisabledResolutions(t *testing.T) {
	tests := []struct {
		name  string
		value string
		valid bool
	}{
		{name: "some tiers withheld", value: `{"default":["4K"],"vip":["1K","2K"]}`, valid: true},
		{name: "nothing withheld", value: `{}`, valid: true},
		{name: "a repeated tier still leaves one", value: `{"default":["4K","4K","2K"]}`, valid: true},
		{name: "every tier withheld", value: `{"default":["1K","2K","4K"]}`},
		{name: "an unknown tier", value: `{"default":["8K"]}`},
		{name: "a group without a name", value: `{"":["4K"]}`},
		{name: "not a JSON object", value: `"4K"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateCanvasDisabledResolutions(tt.value)
			if tt.valid {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

// A group nobody set up offers every tier and leaves the model to the canvas,
// answered as an empty list rather than null.
func TestCanvasGroupSettingForAGroupLeftOut(t *testing.T) {
	assert.Equal(t, CanvasGroupSetting{DisabledResolutions: []string{}}, GetCanvasGroupSetting("never-configured"))
}

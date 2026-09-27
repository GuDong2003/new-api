package operation_setting

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
)

// CanvasResolutions are the resolution tiers the canvas offers for models that
// size their output by tier.
var CanvasResolutions = []string{"1K", "2K", "4K"}

// CanvasSetting holds what the canvas starts from for each user group.
type CanvasSetting struct {
	// DefaultModels names the model the canvas picks for a user of the group
	// whenever it has to choose one itself.
	DefaultModels map[string]string `json:"default_models"`
	// DisabledResolutions lists the resolution tiers the canvas withholds from
	// a user of the group. A group left out offers every tier.
	DisabledResolutions map[string][]string `json:"disabled_resolutions"`
}

var canvasSetting = CanvasSetting{
	DefaultModels:       map[string]string{},
	DisabledResolutions: map[string][]string{},
}

func init() {
	config.GlobalConfig.Register("canvas_setting", &canvasSetting)
}

// CanvasGroupSetting is what the canvas of one user group starts from.
type CanvasGroupSetting struct {
	DefaultModel        string   `json:"default_model"`
	DisabledResolutions []string `json:"disabled_resolutions"`
}

// GetCanvasGroupSetting reads the canvas setting of one user group. Option
// updates replace the maps under the option lock, so this reads under it too.
func GetCanvasGroupSetting(group string) CanvasGroupSetting {
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	disabled := slices.Clone(canvasSetting.DisabledResolutions[group])
	if disabled == nil {
		disabled = []string{}
	}
	return CanvasGroupSetting{
		DefaultModel:        canvasSetting.DefaultModels[group],
		DisabledResolutions: disabled,
	}
}

// ValidateCanvasDefaultModels checks a JSON object of user group names to the
// model name the canvas defaults to for that group.
func ValidateCanvasDefaultModels(value string) error {
	models := map[string]string{}
	if err := common.UnmarshalJsonStr(value, &models); err != nil {
		return errors.New("canvas default models must be a JSON object of group names to model names")
	}
	for group, model := range models {
		if strings.TrimSpace(group) == "" || strings.TrimSpace(model) == "" {
			return errors.New("each canvas default model needs a group name and a model name")
		}
	}
	return nil
}

// ValidateCanvasDisabledResolutions checks a JSON object of user group names
// to the resolution tiers withheld from that group. A group keeps at least one.
func ValidateCanvasDisabledResolutions(value string) error {
	disabled := map[string][]string{}
	if err := common.UnmarshalJsonStr(value, &disabled); err != nil {
		return errors.New("canvas disabled resolutions must be a JSON object of group names to resolution lists")
	}
	for group, tiers := range disabled {
		if strings.TrimSpace(group) == "" {
			return errors.New("each canvas resolution setting needs a group name")
		}
		withheld := map[string]bool{}
		for _, tier := range tiers {
			if !slices.Contains(CanvasResolutions, tier) {
				return fmt.Errorf("unknown canvas resolution %q", tier)
			}
			withheld[tier] = true
		}
		if len(withheld) == len(CanvasResolutions) {
			return fmt.Errorf("group %q must keep at least one canvas resolution", group)
		}
	}
	return nil
}

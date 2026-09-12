package common_test

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/stretchr/testify/assert"
)

func TestIsImageGenerationModelRecognizesSupportedFamilies(t *testing.T) {
	tests := []struct {
		name  string
		model string
		want  bool
	}{
		{name: "dall-e", model: "dall-e-3", want: true},
		{name: "gpt image", model: "gpt-image-2", want: true},
		{name: "chatgpt image", model: "chatgpt-image-latest", want: true},
		{name: "imagen", model: "imagen-4.0-generate-001", want: true},
		{name: "flux", model: "black-forest-labs/flux-1.1-pro", want: true},
		{name: "seedream", model: "doubao-seedream-4-0-250828", want: true},
		{name: "qwen image", model: "qwen-image-plus", want: true},
		{name: "novelai", model: "nai-diffusion-4-5-full", want: false},
		{name: "text", model: "gpt-5.6", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, common.IsImageGenerationModel(tt.model))
		})
	}
}

func TestWanEndpointsDistinguishImagesFromVideos(t *testing.T) {
	for _, name := range []string{
		"wan2.7-image-pro", "wan2.7-image", "wan2.6-image", "wan2.6-t2i",
		"wan2.5-t2i-preview", "wan2.2-t2i-flash", "wan2.2-t2i-plus",
		"wanx2.1-t2i-turbo", "wanx2.1-t2i-plus", "wanx2.0-t2i-turbo",
	} {
		t.Run(name, func(t *testing.T) {
			assert.Contains(t, common.GetEndpointTypesByChannelType(constant.ChannelTypeAli, name), constant.EndpointTypeImageGeneration)
		})
	}
	for _, name := range []string{
		"wanx2.1-t2v-plus", "wanx2.1-t2v-turbo", "wanx2.1-i2v-plus", "wanx2.1-i2v-turbo",
	} {
		t.Run(name, func(t *testing.T) {
			assert.NotContains(t, common.GetEndpointTypesByChannelType(constant.ChannelTypeAli, name), constant.EndpointTypeImageGeneration)
		})
	}
}

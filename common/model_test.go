package common

import "testing"

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
		{name: "novelai", model: "nai-diffusion-4-5-full", want: false},
		{name: "text", model: "gpt-5.6", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsImageGenerationModel(tt.model); got != tt.want {
				t.Fatalf("IsImageGenerationModel(%q) = %v, want %v", tt.model, got, tt.want)
			}
		})
	}
}

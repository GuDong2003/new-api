package service

import (
	"crypto/sha256"
	"encoding/hex"
	"maps"
	"math"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/google/uuid"
)

type GalleryCanvasAssetRef struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MIMEType string `json:"mimeType"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

type GalleryCanvasDocumentInfo struct {
	Document    map[string]any
	Assets      []GalleryCanvasAssetRef
	ContentHash string
	Bytes       int64
}

// canvasDocumentField mirrors the scalar bounds/defaults of the existing
// Drawing and NAI version 1 schemas. Unknown fields are never copied.
type canvasDocumentField struct {
	name     string
	typeName string
	min      float64
	max      float64
	values   []string
	fallback any
	optional bool
	nullable bool
	trim     bool
}

func normalizeCanvasFields(input map[string]any, fields []canvasDocumentField) (map[string]any, error) {
	if input == nil {
		return nil, model.ErrGalleryInvalid
	}
	output := make(map[string]any, len(fields))
	for _, field := range fields {
		value, exists := input[field.name]
		if !exists {
			if field.optional {
				continue
			}
			value = field.fallback
		}
		if value == nil && field.nullable {
			output[field.name] = nil
			continue
		}
		switch field.typeName {
		case "string":
			text, ok := value.(string)
			if !ok || !utf8.ValidString(text) {
				return nil, model.ErrGalleryInvalid
			}
			if field.trim {
				text = strings.TrimSpace(text)
			}
			// Zod measures JavaScript UTF-16 code units, including surrogate pairs.
			length := 0
			for _, char := range text {
				length += utf16.RuneLen(char)
			}
			if float64(length) < field.min || (field.max > 0 && float64(length) > field.max) || (len(field.values) > 0 && !slices.Contains(field.values, text)) {
				return nil, model.ErrGalleryInvalid
			}
			value = text
		case "number", "integer":
			number, ok := value.(float64)
			if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number < field.min || number > field.max || (field.typeName == "integer" && math.Trunc(number) != number) {
				return nil, model.ErrGalleryInvalid
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				return nil, model.ErrGalleryInvalid
			}
		}
		output[field.name] = value
	}
	return output, nil
}

func normalizeCanvasSettings(kind string, input map[string]any) (map[string]any, error) {
	fields := []canvasDocumentField{
		{name: "group", typeName: "string", trim: true, fallback: "default"},
		{name: "model", typeName: "string", trim: true, fallback: ""},
		{name: "prompt", typeName: "string", max: 32000, fallback: ""},
	}
	if kind == "drawing" {
		fields = append(fields,
			canvasDocumentField{name: "mode", typeName: "string", values: []string{"generate", "edit"}, fallback: "generate"},
			canvasDocumentField{name: "size", typeName: "string", fallback: "1024x1024"},
			canvasDocumentField{name: "quality", typeName: "string", values: []string{"auto", "low", "medium", "high", "standard", "hd"}, fallback: "auto"},
			canvasDocumentField{name: "n", typeName: "integer", min: 1, max: 10, fallback: float64(1)},
			canvasDocumentField{name: "background", typeName: "string", values: []string{"auto", "transparent", "opaque"}, fallback: "auto"},
			canvasDocumentField{name: "outputFormat", typeName: "string", values: []string{"png", "jpeg", "webp"}, fallback: "png"},
			canvasDocumentField{name: "outputCompression", typeName: "integer", max: 100, fallback: float64(100)},
			canvasDocumentField{name: "moderation", typeName: "string", values: []string{"auto", "low"}, fallback: "auto"},
			canvasDocumentField{name: "responseFormat", typeName: "string", values: []string{"b64_json", "url"}, fallback: "b64_json"},
			canvasDocumentField{name: "style", typeName: "string", values: []string{"vivid", "natural"}, fallback: "vivid"},
			canvasDocumentField{name: "inputFidelity", typeName: "string", values: []string{"default", "high", "low"}, fallback: "default"},
			canvasDocumentField{name: "stream", typeName: "boolean", fallback: false},
			canvasDocumentField{name: "partialImages", typeName: "integer", max: 3, fallback: float64(1)},
			canvasDocumentField{name: "user", typeName: "string", max: 512, fallback: ""},
		)
	} else {
		fields = append(fields,
			canvasDocumentField{name: "negativePrompt", typeName: "string", max: 32000, fallback: ""},
			canvasDocumentField{name: "width", typeName: "integer", min: 64, max: 2048, fallback: float64(832)},
			canvasDocumentField{name: "height", typeName: "integer", min: 64, max: 2048, fallback: float64(1216)},
			canvasDocumentField{name: "steps", typeName: "integer", min: 1, max: 50, fallback: float64(28)},
			canvasDocumentField{name: "scale", typeName: "number", max: 30, fallback: float64(5)},
			canvasDocumentField{name: "sampler", typeName: "string", values: []string{"k_euler_ancestral", "k_euler", "k_dpmpp_2s_ancestral", "k_dpmpp_2m", "k_dpmpp_sde", "ddim_v3"}, fallback: "k_euler_ancestral"},
			canvasDocumentField{name: "noiseSchedule", typeName: "string", values: []string{"native", "karras", "exponential", "polyexponential"}, fallback: "karras"},
			canvasDocumentField{name: "cfgRescale", typeName: "number", max: 1, fallback: float64(0)},
			canvasDocumentField{name: "seed", typeName: "integer", max: 4294967295, nullable: true},
			canvasDocumentField{name: "n", typeName: "integer", min: 1, max: 8, fallback: float64(1)},
			canvasDocumentField{name: "qualityToggle", typeName: "boolean", fallback: false},
			canvasDocumentField{name: "qualityTier", typeName: "string", values: []string{"standard", "light"}, fallback: "standard"},
			canvasDocumentField{name: "ucPreset", typeName: "string", values: []string{"heavy", "light", "humanFocus", "none"}, fallback: "none"},
			canvasDocumentField{name: "smea", typeName: "boolean", fallback: false},
			canvasDocumentField{name: "smeaDyn", typeName: "boolean", fallback: false},
			canvasDocumentField{name: "decrisp", typeName: "boolean", fallback: false},
		)
	}
	return normalizeCanvasFields(input, fields)
}

func normalizeCanvasAsset(input any, assets *[]GalleryCanvasAssetRef, seen map[string]GalleryCanvasAssetRef) (map[string]any, error) {
	descriptor, ok := input.(map[string]any)
	if !ok {
		return nil, model.ErrGalleryInvalid
	}
	if _, embedded := descriptor["src"]; embedded {
		return nil, model.ErrGalleryInvalid
	}
	asset, err := normalizeCanvasFields(descriptor, []canvasDocumentField{
		{name: "id", typeName: "string", min: 36, max: 36},
		{name: "name", typeName: "string", max: 512},
		{name: "width", typeName: "integer", min: 1, max: 32768},
		{name: "height", typeName: "integer", min: 1, max: 32768},
		{name: "mimeType", typeName: "string", values: []string{"image/png", "image/jpeg", "image/webp"}},
	})
	if err != nil {
		return nil, err
	}
	id := asset["id"].(string)
	parsed, err := uuid.Parse(id)
	if err != nil || parsed == uuid.Nil || parsed.String() != id {
		return nil, model.ErrGalleryInvalid
	}
	ref := GalleryCanvasAssetRef{ID: id, Name: asset["name"].(string), Width: int(asset["width"].(float64)), Height: int(asset["height"].(float64)), MIMEType: asset["mimeType"].(string)}
	if previous, exists := seen[id]; exists {
		if previous != ref {
			return nil, model.ErrGalleryInvalid
		}
	} else {
		seen[id] = ref
		*assets = append(*assets, ref)
	}
	return asset, nil
}

func normalizeCanvasReferences(input any, nodes map[string]map[string]any) ([]any, error) {
	refs, ok := input.([]any)
	if !ok || len(refs) > 16 {
		return nil, model.ErrGalleryInvalid
	}
	output := make([]any, 0, len(refs))
	for _, value := range refs {
		id, ok := value.(string)
		data := nodes[id]
		if !ok || data == nil || data["status"] != "complete" || data["asset"] == nil {
			return nil, model.ErrGalleryInvalid
		}
		output = append(output, id)
	}
	return output, nil
}

func validCanvasMask(mask map[string]any, references []any, nodes map[string]map[string]any) bool {
	if len(references) == 0 || mask["mimeType"] != "image/png" {
		return false
	}
	reference := nodes[references[0].(string)]["asset"].(map[string]any)
	return mask["width"] == reference["width"] && mask["height"] == reference["height"]
}

// Usage is untrusted upstream metadata, not an arbitrary nested JSON payload.
func normalizeCanvasUsage(input any) (map[string]any, error) {
	usage, ok := input.(map[string]any)
	if !ok {
		return nil, model.ErrGalleryInvalid
	}
	var fields []canvasDocumentField
	for _, key := range []string{"input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens"} {
		fields = append(fields, canvasDocumentField{name: key, typeName: "integer", max: 9007199254740991, optional: true})
	}
	output, err := normalizeCanvasFields(usage, fields)
	if err != nil {
		return nil, err
	}
	var detailFields []canvasDocumentField
	for _, key := range []string{"text_tokens", "image_tokens", "audio_tokens", "cached_tokens", "reasoning_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"} {
		detailFields = append(detailFields, canvasDocumentField{name: key, typeName: "integer", max: 9007199254740991, optional: true})
	}
	for _, key := range []string{"input_tokens_details", "output_tokens_details", "prompt_tokens_details", "completion_tokens_details"} {
		if value, exists := usage[key]; exists {
			detail, _ := value.(map[string]any)
			output[key], err = normalizeCanvasFields(detail, detailFields)
			if err != nil {
				return nil, err
			}
		}
	}
	return output, nil
}

// NormalizeGalleryCanvasDocument returns a detached, allowlisted editor v1
// document containing canonical asset UUID descriptors, never image sources.
// Bytes counts the complete normalized JSON; ContentHash omits only viewport
// (jobId/progress and unknown properties are stripped from the document itself).
func NormalizeGalleryCanvasDocument(kind string, document map[string]any) (*GalleryCanvasDocumentInfo, error) {
	if kind != "drawing" && kind != "nai" {
		return nil, model.ErrGalleryInvalid
	}
	// Use the shared codec to detach input and normalize Go numeric/slice types
	// to their JSON representation. Non-finite numbers cannot reach storage.
	raw, err := common.Marshal(document)
	if err != nil {
		return nil, model.ErrGalleryInvalid
	}
	var input map[string]any
	if common.Unmarshal(raw, &input) != nil || input == nil || input["version"] != float64(1) {
		return nil, model.ErrGalleryInvalid
	}
	settings, _ := input["settings"].(map[string]any)
	normalizedSettings, err := normalizeCanvasSettings(kind, settings)
	if err != nil {
		return nil, err
	}
	positionFields := []canvasDocumentField{
		{name: "x", typeName: "number", min: -math.MaxFloat64, max: math.MaxFloat64},
		{name: "y", typeName: "number", min: -math.MaxFloat64, max: math.MaxFloat64},
	}
	viewport, _ := input["viewport"].(map[string]any)
	normalizedViewport, err := normalizeCanvasFields(viewport, append(slices.Clone(positionFields), canvasDocumentField{name: "zoom", typeName: "number", min: 0.1, max: 4}))
	if err != nil {
		return nil, err
	}
	nodes, ok := input["nodes"].([]any)
	if !ok || len(nodes) > 500 {
		return nil, model.ErrGalleryInvalid
	}
	info := &GalleryCanvasDocumentInfo{Assets: []GalleryCanvasAssetRef{}}
	seenAssets := map[string]GalleryCanvasAssetRef{}
	nodeData := map[string]map[string]any{}
	normalizedNodes := make([]any, 0, len(nodes))
	nodeType := "image"
	if kind == "nai" {
		nodeType = "nai-image"
	}
	for _, value := range nodes {
		node, _ := value.(map[string]any)
		normalized, err := normalizeCanvasFields(node, []canvasDocumentField{
			{name: "id", typeName: "string", min: 1, max: 128},
			{name: "type", typeName: "string", values: []string{nodeType}},
			{name: "width", typeName: "number", min: math.SmallestNonzeroFloat64, max: 10000, optional: true},
			{name: "height", typeName: "number", min: math.SmallestNonzeroFloat64, max: 10000, optional: true},
		})
		if err != nil {
			return nil, err
		}
		id := normalized["id"].(string)
		if _, duplicate := nodeData[id]; duplicate {
			return nil, model.ErrGalleryInvalid
		}
		position, _ := node["position"].(map[string]any)
		normalized["position"], err = normalizeCanvasFields(position, positionFields)
		if err != nil {
			return nil, err
		}
		data, _ := node["data"].(map[string]any)
		dataFields := []canvasDocumentField{
			{name: "prompt", typeName: "string", max: 32000},
			{name: "status", typeName: "string", values: []string{"pending", "complete", "error", "cancelled"}},
			{name: "error", typeName: "string", max: 10000, optional: true},
			{name: "createdAt", typeName: "number", min: -math.MaxFloat64, max: math.MaxFloat64},
		}
		if kind == "drawing" {
			dataFields = append(dataFields, canvasDocumentField{name: "revisedPrompt", typeName: "string", max: 64000, optional: true})
		}
		normalizedData, err := normalizeCanvasFields(data, dataFields)
		if err != nil {
			return nil, err
		}
		nodeSettings, _ := data["settings"].(map[string]any)
		normalizedData["settings"], err = normalizeCanvasSettings(kind, nodeSettings)
		if err != nil {
			return nil, err
		}
		for _, key := range []string{"asset", "mask"} {
			if key == "mask" && kind != "drawing" {
				continue
			}
			if value, exists := data[key]; exists {
				normalizedData[key], err = normalizeCanvasAsset(value, &info.Assets, seenAssets)
				if err != nil {
					return nil, err
				}
			}
		}
		if value, exists := data["usage"]; exists {
			normalizedData["usage"], err = normalizeCanvasUsage(value)
			if err != nil {
				return nil, err
			}
		}
		normalized["data"] = normalizedData
		nodeData[id] = normalizedData
		normalizedNodes = append(normalizedNodes, normalized)
	}
	info.Document = map[string]any{"version": float64(1), "nodes": normalizedNodes, "settings": normalizedSettings, "viewport": normalizedViewport}
	if kind == "drawing" {
		for i, value := range nodes {
			originalData := value.(map[string]any)["data"].(map[string]any)
			data := normalizedNodes[i].(map[string]any)["data"].(map[string]any)
			refs := []any{}
			if value, exists := originalData["referenceIds"]; exists {
				refs, err = normalizeCanvasReferences(value, nodeData)
				if err != nil {
					return nil, err
				}
				data["referenceIds"] = refs
			}
			if mask, exists := data["mask"]; exists && !validCanvasMask(mask.(map[string]any), refs, nodeData) {
				return nil, model.ErrGalleryInvalid
			}
		}
		edges, ok := input["edges"].([]any)
		if !ok || len(edges) > 8000 {
			return nil, model.ErrGalleryInvalid
		}
		normalizedEdges := make([]any, 0, len(edges))
		for _, value := range edges {
			edge, _ := value.(map[string]any)
			normalized, err := normalizeCanvasFields(edge, []canvasDocumentField{
				{name: "id", typeName: "string"}, {name: "source", typeName: "string"}, {name: "target", typeName: "string"},
			})
			if err != nil || nodeData[normalized["source"].(string)] == nil || nodeData[normalized["target"].(string)] == nil {
				return nil, model.ErrGalleryInvalid
			}
			normalizedEdges = append(normalizedEdges, normalized)
		}
		info.Document["edges"] = normalizedEdges
		references, exists := input["referenceIds"]
		if !exists {
			references = []any{}
		}
		refs, err := normalizeCanvasReferences(references, nodeData)
		if err != nil {
			return nil, err
		}
		info.Document["referenceIds"] = refs
		info.Document["mask"] = nil
		if value := input["mask"]; value != nil {
			mask, ok := value.(map[string]any)
			if !ok || len(refs) == 0 || mask["referenceId"] != refs[0] {
				return nil, model.ErrGalleryInvalid
			}
			asset, err := normalizeCanvasAsset(mask["asset"], &info.Assets, seenAssets)
			if err != nil || !validCanvasMask(asset, refs, nodeData) {
				return nil, model.ErrGalleryInvalid
			}
			info.Document["mask"] = map[string]any{"referenceId": refs[0], "asset": asset}
		}
	}
	raw, err = common.Marshal(info.Document)
	if err != nil {
		return nil, model.ErrGalleryInvalid
	}
	info.Bytes = int64(len(raw))
	content := maps.Clone(info.Document)
	delete(content, "viewport")
	raw, err = common.Marshal(content)
	if err != nil {
		return nil, model.ErrGalleryInvalid
	}
	sum := sha256.Sum256(raw)
	info.ContentHash = hex.EncodeToString(sum[:])
	return info, nil
}

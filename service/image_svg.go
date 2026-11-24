package service

import (
	"bufio"
	"encoding/xml"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/QuantumNous/new-api/model"
)

const (
	gallerySVGMIMEType = "image/svg+xml"
	maxGallerySVGSize  = 16 << 20
	svgNamespace       = "http://www.w3.org/2000/svg"
	xmlNamespace       = "http://www.w3.org/XML/1998/namespace"
)

var (
	svgFragment    = regexp.MustCompile(`^#[\w:.-]+$`)
	svgLocalPaint  = regexp.MustCompile(`(?i)url\(\s*(?:#[\w:.-]+|"#[\w:.-]+"|'#[\w:.-]+')\s*\)`)
	svgCSSResource = regexp.MustCompile(`(?i)(?:url|image|(?:-webkit-)?image-set|src)\s*\(`)
	svgCSSAtRule   = regexp.MustCompile(`(?i)@(?:import|font-face|namespace|keyframes)\b`)
)

// staticSVGDimensions validates the vector original before the gallery
// publishes its unmodified bytes, then reports the image's intrinsic size.
func staticSVGDimensions(reader io.Reader) (int, int, error) {
	source := bufio.NewReader(reader)
	if prefix, _ := source.Peek(3); string(prefix) == "\xef\xbb\xbf" {
		_, _ = source.Discard(3)
	}
	decoder := xml.NewDecoder(source)
	depth, width, height := 0, 0, 0
	rootSeen, declarationSeen := false, false
	var style strings.Builder
	insideStyle := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, 0, model.ErrGalleryInvalid
		}
		switch element := token.(type) {
		case xml.Directive:
			return 0, 0, model.ErrGalleryInvalid
		case xml.ProcInst:
			if rootSeen || declarationSeen || element.Target != "xml" {
				return 0, 0, model.ErrGalleryInvalid
			}
			declarationSeen = true
		case xml.StartElement:
			if element.Name.Space != svgNamespace || insideStyle || depth >= 256 {
				return 0, 0, model.ErrGalleryInvalid
			}
			if depth == 0 {
				if rootSeen || element.Name.Local != "svg" {
					return 0, 0, model.ErrGalleryInvalid
				}
				rootSeen = true
				width, height = svgDimensions(element.Attr)
			}
			if !staticSVGElement(element) {
				return 0, 0, model.ErrGalleryInvalid
			}
			depth++
			insideStyle = element.Name.Local == "style"
		case xml.EndElement:
			if insideStyle {
				if !localSVGStyle(style.String()) {
					return 0, 0, model.ErrGalleryInvalid
				}
				style.Reset()
				insideStyle = false
			}
			depth--
		case xml.CharData:
			if depth == 0 && strings.TrimSpace(string(element)) != "" {
				return 0, 0, model.ErrGalleryInvalid
			}
			if insideStyle {
				style.Write(element)
			}
		}
	}
	if !rootSeen || depth != 0 || width < 1 || height < 1 {
		return 0, 0, model.ErrGalleryInvalid
	}
	return width, height, nil
}

func staticSVGElement(element xml.StartElement) bool {
	switch element.Name.Local {
	case "svg", "g", "defs", "symbol", "title", "desc", "metadata", "path", "rect",
		"circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath",
		"use", "clipPath", "mask", "pattern", "marker", "linearGradient",
		"radialGradient", "stop", "style", "filter", "feBlend", "feColorMatrix",
		"feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
		"feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA",
		"feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode",
		"feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight",
		"feTile", "feTurbulence":
	default:
		return false
	}
	seen := make(map[xml.Name]struct{}, len(element.Attr))
	for _, attribute := range element.Attr {
		if _, duplicate := seen[attribute.Name]; duplicate {
			return false
		}
		seen[attribute.Name] = struct{}{}
		name := attribute.Name.Local
		if attribute.Name.Space == "xmlns" || (attribute.Name.Space == "" && name == "xmlns") {
			continue
		}
		if (attribute.Name.Space == xmlNamespace && name != "lang" && name != "space") ||
			strings.HasPrefix(strings.ToLower(name), "on") ||
			(name == "href" && !svgFragment.MatchString(strings.TrimSpace(attribute.Value))) ||
			!localSVGStyle(attribute.Value) {
			return false
		}
	}
	return true
}

func localSVGStyle(value string) bool {
	return !strings.Contains(value, "\\") && !svgCSSAtRule.MatchString(value) &&
		!svgCSSResource.MatchString(svgLocalPaint.ReplaceAllString(value, ""))
}

func svgDimensions(attributes []xml.Attr) (int, int) {
	var width, height float64
	var viewBox string
	for _, attribute := range attributes {
		if attribute.Name.Space != "" {
			continue
		}
		switch attribute.Name.Local {
		case "width":
			width, _ = strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(attribute.Value), "px"), 64)
		case "height":
			height, _ = strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(attribute.Value), "px"), 64)
		case "viewBox":
			viewBox = attribute.Value
		}
	}
	if !(width > 0 && height > 0) {
		values := strings.FieldsFunc(viewBox, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
		if len(values) != 4 {
			return 0, 0
		}
		var box [4]float64
		for index, value := range values {
			dimension, err := strconv.ParseFloat(value, 64)
			if err != nil || math.IsNaN(dimension) || math.IsInf(dimension, 0) {
				return 0, 0
			}
			box[index] = dimension
		}
		if box[2] <= 0 || box[3] <= 0 {
			return 0, 0
		}
		ratio := box[2] / box[3]
		switch {
		case width > 0:
			height = width / ratio
		case height > 0:
			width = height * ratio
		default:
			width, height = box[2], box[3]
		}
	}
	width, height = math.Round(width), math.Round(height)
	if !(width >= 1 && width <= 32768 && height >= 1 && height <= 32768) {
		return 0, 0
	}
	return int(width), int(height)
}

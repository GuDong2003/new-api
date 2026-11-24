export const SVG_IMAGE_MIME_TYPE = 'image/svg+xml'
export const SVG_FORMAT_MISMATCH =
  'The upstream provider did not return an SVG image.'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const SVG_MAX_BYTES = 16 * 1024 * 1024
const SVG_ELEMENTS = new Set(
  (
    'svg g defs symbol title desc metadata path rect circle ellipse line polyline polygon ' +
    'text tspan textPath use clipPath mask pattern marker linearGradient radialGradient stop style ' +
    'filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix ' +
    'feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA ' +
    'feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset ' +
    'fePointLight feSpecularLighting feSpotLight feTile feTurbulence'
  ).split(' ')
)

export function isSVGImageType(contentType: string): boolean {
  const [type] = contentType.split(';', 1)
  return type.trim().toLowerCase() === SVG_IMAGE_MIME_TYPE
}

function isLocalSVGStyle(value: string): boolean {
  if (
    /@(?:import|font-face|namespace|keyframes)\b/i.test(value) ||
    value.includes('\\')
  ) {
    return false
  }
  const localPaint = /url\(\s*(?:#[\w:.-]+|"#[\w:.-]+"|'#[\w:.-]+')\s*\)/gi
  return !/(?:url|image|(?:-webkit-)?image-set|src)\s*\(/i.test(
    value.replace(localPaint, '')
  )
}

/** Validate the static vector original and read its layout without mounting XML. */
export async function readSVGImage(
  blob: Blob
): Promise<{ width: number; height: number }> {
  if (!isSVGImageType(blob.type)) throw new Error(SVG_FORMAT_MISMATCH)
  const invalid = () => new Error('The image response is invalid.')
  if (blob.size > SVG_MAX_BYTES) throw invalid()
  const bytes = await blob.arrayBuffer()
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid()
  }
  if (/<!DOCTYPE\b/i.test(source)) throw invalid()
  const document = new DOMParser().parseFromString(source, SVG_IMAGE_MIME_TYPE)
  const root = document.documentElement
  if (
    root.localName !== 'svg' ||
    document.doctype ||
    document
      .createTreeWalker(document, NodeFilter.SHOW_PROCESSING_INSTRUCTION)
      .nextNode()
  ) {
    throw invalid()
  }
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (
      element.namespaceURI !== SVG_NAMESPACE ||
      !SVG_ELEMENTS.has(element.localName)
    ) {
      throw invalid()
    }
    for (const attribute of element.attributes) {
      if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue
      const name = attribute.localName
      if (
        (attribute.namespaceURI === 'http://www.w3.org/XML/1998/namespace' &&
          name !== 'lang' &&
          name !== 'space') ||
        name.toLowerCase().startsWith('on') ||
        (name === 'href' && !/^#[\w:.-]+$/.test(attribute.value.trim())) ||
        !isLocalSVGStyle(attribute.value)
      ) {
        throw invalid()
      }
    }
    if (
      element.localName === 'style' &&
      (element.childElementCount > 0 ||
        !isLocalSVGStyle(element.textContent ?? ''))
    ) {
      throw invalid()
    }
  }

  let width = Number(root.getAttribute('width')?.trim().replace(/px$/, ''))
  let height = Number(root.getAttribute('height')?.trim().replace(/px$/, ''))
  if (!(width > 0 && height > 0)) {
    const viewBox = root
      .getAttribute('viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map(Number)
    if (
      viewBox?.length !== 4 ||
      !viewBox.every(Number.isFinite) ||
      viewBox[2] <= 0 ||
      viewBox[3] <= 0
    ) {
      throw invalid()
    }
    const ratio = viewBox[2] / viewBox[3]
    if (width > 0) height = width / ratio
    else if (height > 0) width = height * ratio
    else [width, height] = viewBox.slice(2)
  }
  width = Math.round(width)
  height = Math.round(height)
  if (!(width >= 1 && width <= 32768 && height >= 1 && height <= 32768)) {
    throw invalid()
  }
  return { width, height }
}

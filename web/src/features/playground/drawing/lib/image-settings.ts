/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { z } from 'zod'

import {
  getAlibabaImageModel,
  getImageGenerationMode,
  getImageModelFamily as classifyImageModelFamily,
  type ImageModelFamily,
} from './image-models'
import { mentionsOnlySentReferences } from './reference-mentions'

export type { ImageModelFamily } from './image-models'

// Keep the historical GPT-compatible fallback for saved documents that were
// created before the drawing model filter existed. New model selection uses
// filterImageModels, so unsupported names never enter the selector.
export function getImageModelFamily(model: string): ImageModelFamily {
  return classifyImageModelFamily(model) ?? 'gpt-image'
}

export const imageSettingsSchema = z.object({
  mode: z.enum(['generate', 'edit']).default('generate'),
  group: z.string().trim().default('default'),
  model: z.string().trim().default(''),
  prompt: z.string().max(32000).default(''),
  size: z.string().default('1024x1024'),
  quality: z
    .enum([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'standard',
      'hd',
      // This gateway reads quality as the billed tier (doc §2.2).
      '1k',
      '2k',
      '4k',
    ])
    .default('auto'),
  n: z.number().int().min(1).max(10).default(1),
  background: z.enum(['auto', 'transparent', 'opaque']).default('opaque'),
  outputFormat: z.enum(['png', 'jpeg', 'webp', 'gif']).default('png'),
  frameCount: z.number().int().min(2).max(16).default(9),
  frameDurationMs: z.number().int().min(20).max(2000).default(200),
  outputCompression: z.number().int().min(0).max(100).default(100),
  moderation: z.enum(['auto', 'low']).default('auto'),
  responseFormat: z.enum(['b64_json', 'url']).default('b64_json'),
  style: z.enum(['vivid', 'natural']).default('vivid'),
  inputFidelity: z.enum(['default', 'high', 'low']).default('default'),
  nsfw: z.boolean().default(false),
  // Tag prompting: NovelAI and Alibaba's image models.
  generationMode: z.enum(['description', 'tags']).default('description'),
  negativePrompt: z.string().max(32000).default(''),
  width: z.number().int().min(64).max(2048).default(832),
  height: z.number().int().min(64).max(2048).default(1216),
  steps: z.number().int().min(1).max(50).default(28),
  scale: z.number().min(0).max(30).default(5),
  sampler: z
    .enum([
      'k_euler_ancestral',
      'k_euler',
      'k_dpmpp_2s_ancestral',
      'k_dpmpp_2m',
      'k_dpmpp_sde',
      'ddim_v3',
    ])
    .default('k_euler_ancestral'),
  noiseSchedule: z
    .enum(['native', 'karras', 'exponential', 'polyexponential'])
    .default('karras'),
  cfgRescale: z.number().min(0).max(1).default(0),
  seed: z.number().int().min(0).max(4294967295).nullable().default(null),
  qualityToggle: z.boolean().default(false),
  qualityTier: z.enum(['standard', 'light']).default('standard'),
  ucPreset: z.enum(['heavy', 'light', 'humanFocus', 'none']).default('none'),
  smea: z.boolean().default(false),
  smeaDyn: z.boolean().default(false),
  decrisp: z.boolean().default(false),
  promptExtend: z.boolean().default(true),
})

export const DEFAULT_IMAGE_SETTINGS = imageSettingsSchema.parse({})

// Settings only a tag-prompted model reads. A description-prompted image does
// not store them, so its saved settings stay exactly what they always were.
const TAG_SETTING_FIELDS = [
  'generationMode',
  'negativePrompt',
  'width',
  'height',
  'steps',
  'scale',
  'sampler',
  'noiseSchedule',
  'cfgRescale',
  'seed',
  'qualityToggle',
  'qualityTier',
  'ucPreset',
  'smea',
  'smeaDyn',
  'decrisp',
  'promptExtend',
] as const

export function normalizeStoredImageSettings(
  settings: z.infer<typeof imageSettingsSchema>
): z.infer<typeof imageSettingsSchema> {
  const normalized: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(imageSettingsSchema.shape)) {
    const field = key as keyof typeof settings
    const result = schema.safeParse(settings[field])
    normalized[key] = result.success
      ? result.data
      : DEFAULT_IMAGE_SETTINGS[field]
  }
  const parsed = imageSettingsSchema.parse(normalized)
  // Per-field parsing cannot see the model, so a document saved before a family
  // changed its supported values would restore into a state that fails
  // validation. Re-apply the model's own constraints here.
  const stored: Record<string, unknown> = settingsForImageModel(
    parsed,
    parsed.model
  )
  if (stored.generationMode !== 'tags') {
    for (const field of TAG_SETTING_FIELDS) delete stored[field]
  }
  // Parsing a stored document restores the defaults of the omitted fields.
  return stored as z.infer<typeof imageSettingsSchema>
}

export function getImageSizes(model: string): string[] {
  const family = getImageModelFamily(model)
  // NovelAI takes its size as a width and height of its own.
  if (family === 'novelai') return []
  if (family === 'alibaba') {
    return [...(getAlibabaImageModel(model)?.sizes ?? [])]
  }
  if (family === 'dall-e-2') return ['256x256', '512x512', '1024x1024']
  if (family === 'dall-e-3') return ['1024x1024', '1792x1024', '1024x1792']
  if (family === 'imagen') {
    return ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792']
  }
  if (
    family === 'seedream' &&
    /(^|[/:-])seedream-(?:4-5|5-0(?:-lite)?)(?:-\d{6})?$/.test(
      model.trim().toLowerCase().replaceAll(/[._]/g, '-')
    )
  ) {
    // These models require at least 3,686,400 pixels. Keep saved canvases
    // within the same per-model limits as the Doubao Images decoder.
    return ['2048x2048', '2560x1440', '1440x2560', '2304x1728', '1728x2304']
  }
  if (family === 'flux' || family === 'seedream') {
    return ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792']
  }
  return ['auto', '1024x1024', '1536x1024', '1024x1536']
}

/**
 * GPT Image 1 and the ChatGPT alias are the official OpenAI models: fixed sizes
 * and the low/medium/high ladder. Names may carry a vendor prefix such as
 * `openai/`, which must not promote a legacy model.
 */
function isLegacyGptImageModel(model: string): boolean {
  return /(^|[/.:_-])(?:gpt-image-1(?:[.-]|$)|chatgpt-image-latest$)/.test(
    model.trim().toLowerCase()
  )
}

export function supportsImageAnimation(model: string): boolean {
  return /(^|[/.:_-])gpt-image-2\.6(?:[/.:_-]|$)/i.test(model.trim())
}

/**
 * GPT Image 2 and later accept any ratio and tier from the preset table, while
 * gpt-image-1 and the ChatGPT alias are limited to the official fixed sizes.
 */
export function supportsImageSizePresetTable(model: string): boolean {
  return (
    getImageModelFamily(model) === 'gpt-image' && !isLegacyGptImageModel(model)
  )
}

/**
 * Models that express output as an aspect ratio crossed with a resolution tier
 * rather than a fixed list of pixel sizes. Exact pixels are never honoured by
 * these providers, so the presets are the only sizes offered.
 */
export function supportsImageSizePresets(model: string): boolean {
  return (
    supportsImageSizePresetTable(model) || supportsAutomaticImageSize(model)
  )
}

/**
 * Only Nano Banana can take its output ratio from the reference image. GPT
 * Image silently falls back to 1:1 instead, so offering `auto` there would
 * promise something the provider does not do.
 */
export function supportsAutomaticImageSize(model: string): boolean {
  return getImageModelFamily(model) === 'nano-banana'
}

/**
 * The prompt length the preset-table provider keeps. It truncates anything
 * longer without saying so, which silently drops the end of a long prompt.
 */
export const MAX_PRESET_PROMPT_CHARACTERS = 4000

/**
 * How many images one request can come back with. The provider that serves the
 * preset tables renders a single image and ignores a larger `n`, and DALL·E 3
 * and the video-style models only ever return one, so a batch would leave the
 * extra canvas nodes waiting for images that never arrive.
 */
export function getMaxImagesPerRequest(model: string): number {
  const family = getImageModelFamily(model)
  if (family === 'dall-e-3' || family === 'imagen' || family === 'seedream') {
    return 1
  }
  if (family === 'novelai') return 8
  if (family === 'alibaba') return getAlibabaImageModel(model)?.maxImages ?? 1
  return supportsImageSizePresets(model) ? 1 : 10
}

/**
 * How many reference images a model can edit from. Zero means it only
 * generates from text; DALL·E 2 edits exactly one image.
 */
export function getMaxReferenceImages(model: string): number {
  const family = getImageModelFamily(model)
  if (
    family === 'dall-e-3' ||
    family === 'imagen' ||
    family === 'seedream' ||
    family === 'novelai'
  ) {
    return 0
  }
  if (family === 'dall-e-2') return 1
  if (family === 'alibaba') {
    return getAlibabaImageModel(model)?.maxReferences ?? 0
  }
  return 16
}

/** Some Alibaba models only edit, so they cannot start from text alone. */
export function requiresReferenceImages(model: string): boolean {
  return (getAlibabaImageModel(model)?.minReferences ?? 0) > 0
}

/** Among Alibaba's models only the Wanx image editor repaints under a mask. */
export function supportsImageMask(model: string, format = 'png'): boolean {
  if (format === 'gif') return false
  if (getImageModelFamily(model) !== 'alibaba') return true
  return getAlibabaImageModel(model)?.mask ?? false
}

/**
 * The seed range a tag-prompted model accepts. NovelAI takes any unsigned
 * 32-bit value; Alibaba stops at the signed 32-bit maximum.
 */
export function getMaxImageSeed(model: string): number {
  return getImageModelFamily(model) === 'alibaba' ? 2147483647 : 4294967295
}

/**
 * Nano Banana v2 is the only model that renders the extreme panoramas. It ships
 * both under its own alias and as the Gemini 3.1 Flash image model.
 */
function isNanoBananaV2(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    /nano-banana[-_.]?(?:v2|2)(?:[/.:_-]|$)/.test(normalized) ||
    /gemini-3\.1-flash[\w.-]*image/.test(normalized)
  )
}

export function getImageAspectRatios(
  model: string
): readonly ImageAspectRatio[] {
  if (supportsImageSizePresetTable(model)) return GPT_IMAGE_ASPECT_RATIOS
  if (isNanoBananaV2(model)) return IMAGE_ASPECT_RATIOS
  return IMAGE_ASPECT_RATIOS.filter(
    (ratio) => !PANORAMIC_IMAGE_ASPECT_RATIOS.includes(ratio)
  )
}

export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
  // Only Nano Banana v2 renders these panoramas; every other model rejects them.
  '1:4',
  '4:1',
  '1:8',
  '8:1',
] as const
const PANORAMIC_IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  '1:4',
  '4:1',
  '1:8',
  '8:1',
]
export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number] | '9:21'
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number]

export const IMAGE_RESOLUTION_MAX_DIMENSIONS: Record<ImageResolution, number> =
  {
    '1K': 1536,
    '2K': 2800,
    '4K': 3840,
  }

const GPT_IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  '1:1',
  '2:3',
  '3:2',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '21:9',
  '9:21',
]

/**
 * A tier may omit ratios the model cannot render, but 1:1 is mandatory: it is
 * the size every model falls back to when it lacks the requested ratio.
 */
type ImagePresetSizes = Record<
  ImageResolution,
  Partial<Record<ImageAspectRatio, string>> & Record<'1:1', string>
>

const GPT_IMAGE_PRESET_SIZES: ImagePresetSizes = {
  '1K': {
    '1:1': '1024x1024',
    '2:3': '1024x1536',
    '3:2': '1536x1024',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '16:9': '1536x864',
    '9:16': '864x1536',
    // These panorama sizes were verified against upstream 1K billing.
    '21:9': '1456x624',
    '9:21': '624x1456',
  },
  '2K': {
    '1:1': '2048x2048',
    '2:3': '1360x2048',
    '3:2': '2048x1360',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '16:9': '2048x1152',
    '9:16': '1152x2048',
    '21:9': '2688x1152',
    '9:21': '1152x2688',
  },
  '4K': {
    '1:1': '2880x2880',
    '2:3': '2336x3520',
    '3:2': '3520x2336',
    '4:3': '3312x2480',
    '3:4': '2480x3312',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
    '21:9': '3840x1648',
    '9:21': '1648x3840',
    // Saved legacy ratios still need sizes in the requested tier.
    '5:4': '3200x2560',
    '4:5': '2560x3200',
  },
}

// Saved canvases retain their previous tier and ratio, including 4:5 and 5:4.
const LEGACY_GPT_IMAGE_PRESET_SIZES: ImagePresetSizes = {
  '1K': {
    '1:1': '1024x1024',
    '2:3': '1024x1536',
    '3:2': '1536x1024',
    '3:4': '864x1152',
    '4:3': '1152x864',
    '4:5': '896x1120',
    '5:4': '1120x896',
    '9:16': '720x1280',
    '16:9': '1280x720',
    '21:9': '1456x624',
  },
  '2K': {
    '1:1': '2048x2048',
    '2:3': '1664x2496',
    '3:2': '2496x1664',
    '3:4': '1728x2304',
    '4:3': '2304x1728',
    '4:5': '1792x2240',
    '5:4': '2240x1792',
    '9:16': '1440x2560',
    '16:9': '2560x1440',
    '21:9': '3024x1296',
  },
  '4K': {
    '1:1': '2480x2480',
    '2:3': '2032x3056',
    '3:2': '3056x2032',
    '3:4': '2160x2880',
    '4:3': '2880x2160',
    '4:5': '2224x2784',
    '5:4': '2784x2224',
    '9:16': '1872x3328',
    '16:9': '3328x1872',
    '21:9': '3808x1632',
  },
}

/**
 * Nano Banana runs a different upstream path and rejects the GPT Image sizes,
 * so it carries its own table. Each tier is roughly N²·1024² pixels.
 */
const NANO_BANANA_PRESET_SIZES: ImagePresetSizes = {
  '1K': {
    '1:1': '1024x1024',
    '2:3': '848x1264',
    '3:2': '1264x848',
    '3:4': '864x1152',
    '4:3': '1152x864',
    '4:5': '832x1024',
    '5:4': '1024x832',
    '9:16': '768x1360',
    '16:9': '1360x768',
    '21:9': '1584x672',
    '1:4': '512x2048',
    '4:1': '2048x512',
    '1:8': '368x2944',
    '8:1': '2944x368',
  },
  '2K': {
    '1:1': '2048x2048',
    '2:3': '1696x2528',
    '3:2': '2528x1696',
    '3:4': '1536x2048',
    '4:3': '2048x1536',
    '4:5': '1856x2304',
    '5:4': '2304x1856',
    '9:16': '1536x2752',
    '16:9': '2752x1536',
    '21:9': '3168x1344',
    '1:4': '1024x4096',
    '4:1': '4096x1024',
    '1:8': '736x5888',
    '8:1': '5888x736',
  },
  '4K': {
    '1:1': '4096x4096',
    '2:3': '3392x5056',
    '3:2': '5056x3392',
    '3:4': '3584x4784',
    '4:3': '4784x3584',
    '4:5': '3712x4608',
    '5:4': '4608x3712',
    '9:16': '3072x5504',
    '16:9': '5504x3072',
    '21:9': '6336x2688',
    '1:4': '2048x8192',
    '4:1': '8192x2048',
    '1:8': '1472x11776',
    '8:1': '11776x1472',
  },
}

function imagePresetTable(model: string) {
  return getImageModelFamily(model) === 'nano-banana'
    ? NANO_BANANA_PRESET_SIZES
    : GPT_IMAGE_PRESET_SIZES
}

export function getImagePresetSize(
  aspectRatio: ImageAspectRatio,
  resolution: ImageResolution,
  model: string
): string {
  const sizes = imagePresetTable(model)[resolution]
  const size = sizes[aspectRatio]
  if (size) return size
  if (getImageModelFamily(model) !== 'nano-banana') {
    return (
      LEGACY_GPT_IMAGE_PRESET_SIZES[resolution][aspectRatio] ?? sizes['1:1']
    )
  }
  return sizes['1:1']
}

/** A bare ratio remembers automatic resolution without losing the ratio. */
export function getAutomaticImageAspectRatio(
  size: string,
  model: string
): ImageAspectRatio | undefined {
  if (!supportsImageSizePresets(model)) return undefined
  // Saved GPT ratios stay usable when switching to automatic resolution.
  if (
    getImageModelFamily(model) === 'gpt-image' &&
    (size === '4:5' || size === '5:4')
  ) {
    return size
  }
  return getImageAspectRatios(model).find((ratio) => ratio === size)
}

// Saved canvases and retries can still carry the retired 1K panorama sizes.
export function normalizeGptImagePanoramaSize(
  size: string,
  model: string,
  withheld: readonly string[]
): string {
  if (
    !supportsImageSizePresetTable(model) ||
    !withheld.includes('2K') ||
    withheld.includes('1K')
  ) {
    return size
  }
  if (size === '2016x864' || size === '1904x816') {
    return getImagePresetSize('21:9', '1K', model)
  }
  if (size === '864x2016' || size === '816x1904') {
    return getImagePresetSize('9:21', '1K', model)
  }
  return size
}

/** Automatic resolution uses the model's 1K preset at the request boundary. */
export function resolveImageRequestSize(size: string, model: string): string {
  const ratio = getAutomaticImageAspectRatio(size, model)
  return ratio ? getImagePresetSize(ratio, '1K', model) : size
}

/** Classify custom pixel sizes by their longest side; presets use their table. */
export function getImageResolutionTier(
  size: string,
  model: string
): ImageResolution {
  const longest = Math.max(...size.split('x').map(Number))
  const max1K = supportsImageSizePresetTable(model)
    ? IMAGE_RESOLUTION_MAX_DIMENSIONS['1K']
    : 1600
  if (!Number.isFinite(longest) || longest <= max1K) {
    return '1K'
  }
  if (longest <= IMAGE_RESOLUTION_MAX_DIMENSIONS['2K']) return '2K'
  return '4K'
}

export function getImageSizePreset(
  size: string,
  model: string
): { aspectRatio: ImageAspectRatio; resolution: ImageResolution } | null {
  for (const resolution of IMAGE_RESOLUTIONS) {
    for (const aspectRatio of getImageAspectRatios(model)) {
      if (getImagePresetSize(aspectRatio, resolution, model) === size) {
        return { aspectRatio, resolution }
      }
    }
  }
  if (getImageModelFamily(model) === 'gpt-image') {
    if (size === '2016x864' || size === '1904x816') {
      return { aspectRatio: '21:9', resolution: '2K' }
    }
    if (size === '864x2016' || size === '816x1904') {
      return { aspectRatio: '9:21', resolution: '2K' }
    }
    for (const resolution of IMAGE_RESOLUTIONS) {
      for (const [aspectRatio, pixels] of Object.entries(
        LEGACY_GPT_IMAGE_PRESET_SIZES[resolution]
      )) {
        const ratio = aspectRatio as ImageAspectRatio
        if (
          pixels === size ||
          getImagePresetSize(ratio, resolution, model) === size
        ) {
          return {
            aspectRatio: ratio,
            resolution: getImageResolutionTier(size, model),
          }
        }
      }
    }
  }
  return null
}

/**
 * The offered tier closest to the one asked for, the lower on a tie. The
 * server keeps at least one tier offered to every group.
 */
export function nearestOfferedResolution(
  resolution: ImageResolution,
  withheld: readonly string[]
): ImageResolution {
  const index = IMAGE_RESOLUTIONS.indexOf(resolution)
  let nearest = resolution
  let nearestDistance = Infinity
  IMAGE_RESOLUTIONS.forEach((candidate, candidateIndex) => {
    const distance = Math.abs(candidateIndex - index)
    if (withheld.includes(candidate) || distance >= nearestDistance) return
    nearest = candidate
    nearestDistance = distance
  })
  return nearest
}

/** Canvas-only tier restrictions; public image requests keep their semantics. */
export function getAllowedImageSize(
  size: string,
  model: string,
  withheld: readonly string[]
): string {
  if (!withheld.length || !supportsImageSizePresets(model)) return size
  const automaticRatio = getAutomaticImageAspectRatio(size, model)
  if (size === 'auto' || automaticRatio) {
    return getImagePresetSize(
      automaticRatio ?? '1:1',
      nearestOfferedResolution('1K', withheld),
      model
    )
  }
  const preset = getImageSizePreset(size, model)
  const tier = preset?.resolution ?? getImageResolutionTier(size, model)
  const offered = nearestOfferedResolution(tier, withheld)
  if (offered === tier) return size
  return getImagePresetSize(preset?.aspectRatio ?? '1:1', offered, model)
}

export function getImageQualities(model: string): string[] {
  const family = getImageModelFamily(model)
  if (family === 'dall-e-2') return ['standard']
  if (family === 'dall-e-3') return ['standard', 'hd']
  if (family === 'imagen' || family === 'flux') return ['standard', 'hd']
  if (family === 'seedream') return ['standard']
  // Gemini defines no quality: its output is described entirely by the size,
  // so there is nothing to offer and nothing to send. Tag-prompted models have
  // sampling controls instead.
  if (
    supportsAutomaticImageSize(model) ||
    family === 'novelai' ||
    family === 'alibaba'
  ) {
    return []
  }
  // Listed best first, after `auto`, which stays the default for every family.
  // GPT Image 2 added the two rungs above `high`; gpt-image-1 stops there.
  if (supportsImageSizePresetTable(model)) {
    return ['auto', 'max', 'xhigh', 'high', 'medium', 'low']
  }
  return ['auto', 'high', 'medium', 'low']
}

export function settingsForImageModel(
  settings: Partial<z.infer<typeof imageSettingsSchema>>,
  model: string
): z.infer<typeof imageSettingsSchema> {
  const next = { ...DEFAULT_IMAGE_SETTINGS, ...settings, model }
  // Old runtime settings can outlive the schema that originally parsed them.
  for (const field of ['stream', 'partialImages', 'user']) {
    Reflect.deleteProperty(next, field)
  }
  const family = getImageModelFamily(model)
  const classified = classifyImageModelFamily(model)
  if (classified) next.generationMode = getImageGenerationMode(classified)
  if (next.outputFormat === 'gif' && !supportsImageAnimation(model)) {
    next.outputFormat = 'png'
  }
  if (family === 'gpt-image') {
    if (next.background === 'auto') next.background = 'opaque'
    if (next.background === 'transparent' && next.outputFormat === 'jpeg') {
      next.outputFormat = 'png'
    }
  }
  next.n = Math.min(next.n, getMaxImagesPerRequest(model))
  if (family === 'novelai') {
    // NovelAI sizes the image from its width and height and only generates.
    next.size = `${next.width}x${next.height}`
    next.mode = 'generate'
    return next
  }
  if (family === 'alibaba') {
    const profile = getAlibabaImageModel(model)
    const sizes = getImageSizes(model)
    if (sizes.length && !sizes.includes(next.size)) next.size = sizes[0]
    if (!profile?.maxReferences) next.mode = 'generate'
    else if (profile.minReferences) next.mode = 'edit'
    if (next.seed !== null) {
      next.seed = Math.min(next.seed, getMaxImageSeed(model))
    }
    if (profile && settings.model !== model) {
      next.promptExtend = profile.promptExtendByDefault
    }
    return next
  }
  const qualities = getImageQualities(model)
  if (qualities.length && !qualities.includes(next.quality)) {
    next.quality = qualities[0] as typeof next.quality
  }
  const sizes = getImageSizes(model)
  if (!sizes.includes(next.size) && !supportsImageSizePresets(model)) {
    next.size = sizes.includes('1024x1024') ? '1024x1024' : sizes[0]
  }
  // Automatic resolution can retain a ratio only when the new model supports it.
  if (
    supportsImageSizePresets(model) &&
    next.size.includes(':') &&
    !getAutomaticImageAspectRatio(next.size, model)
  ) {
    next.size = getImagePresetSize('1:1', '1K', model)
  }
  // Preset-only families have no free-form pixel entry, so a size carried over
  // from a custom-size model must land back on a preset the toggles can show.
  if (
    family === 'nano-banana' &&
    next.size !== 'auto' &&
    !getAutomaticImageAspectRatio(next.size, model) &&
    !getImageSizePreset(next.size, model)
  ) {
    next.size = getImagePresetSize('1:1', '1K', model)
  }
  if (family === 'dall-e-3' || family === 'imagen' || family === 'seedream') {
    next.mode = 'generate'
  }
  return next
}

// Cross-field constraints live at the request boundary as well as in the form.
export function validateImageSettings(
  settings: z.infer<typeof imageSettingsSchema>,
  referenceCount: number
): string | null {
  if (!imageSettingsSchema.safeParse(settings).success) {
    return 'Check the image generation parameters.'
  }
  if (!settings.prompt.trim()) return 'Enter a prompt to generate an image.'
  if (!settings.model.trim()) return 'Select an image model.'
  if (!settings.group) return 'Select a group.'
  // Text to image sends none of the selected references.
  if (
    !mentionsOnlySentReferences(
      settings.prompt,
      settings.mode === 'edit' ? referenceCount : 0
    )
  ) {
    return "The prompt mentions a reference image that this request does not send. Remove the mention or insert the image again; to change a canvas image's prompt, use Reuse prompt and settings."
  }
  const family = getImageModelFamily(settings.model)
  if (
    settings.outputFormat === 'gif' &&
    !supportsImageAnimation(settings.model)
  ) {
    return 'This model does not support GIF output.'
  }
  if (family === 'novelai') {
    return validateNovelAIImageSettings(settings)
  }
  if (family === 'alibaba') {
    return validateAlibabaImageSettings(settings, referenceCount)
  }
  if (family === 'dall-e-3' && settings.n !== 1) {
    return 'DALL·E 3 supports one image per request.'
  }
  if (settings.n > getMaxImagesPerRequest(settings.model)) {
    return 'This model supports one image per request.'
  }
  // Runes, not UTF-16 units: a surrogate pair counts once upstream.
  if (
    supportsImageSizePresets(settings.model) &&
    [...settings.prompt].length > MAX_PRESET_PROMPT_CHARACTERS
  ) {
    return 'Prompts for this model must be 4,000 characters or fewer.'
  }
  if (settings.mode === 'edit') {
    if (family === 'dall-e-3') return 'DALL·E 3 does not support image editing.'
    if (family === 'imagen' || family === 'seedream') {
      return 'This image model does not support image editing.'
    }
    if (referenceCount === 0) return 'Add a reference image before editing.'
    if (
      referenceCount > 16 ||
      (family === 'dall-e-2' && referenceCount !== 1)
    ) {
      return 'Use one reference for DALL·E 2 or up to 16 for GPT Image.'
    }
  }
  const qualities = getImageQualities(settings.model)
  if (qualities.length && !qualities.includes(settings.quality)) {
    return 'Choose a quality supported by this model.'
  }
  const size = resolveImageRequestSize(settings.size, settings.model)
  if (
    !supportsImageSizePresets(settings.model) &&
    !getImageSizes(settings.model).includes(size)
  ) {
    return 'Choose a size supported by this model.'
  }
  if (size !== 'auto' && !/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(size)) {
    return 'Enter a valid width and height.'
  }
  if (family === 'gpt-image' && !getImageSizes(settings.model).includes(size)) {
    if (isLegacyGptImageModel(settings.model)) {
      return 'Choose a size supported by this model.'
    }
    const [width, height] = size.split('x').map(Number)
    if (
      width % 16 ||
      height % 16 ||
      width / height < 1 / 3 ||
      width / height > 3 ||
      Math.max(width, height) > 3840
    ) {
      return 'Custom dimensions must be multiples of 16, at most 3840 pixels per side, with a 1:3 to 3:1 aspect ratio.'
    }
  }
  if (
    family === 'gpt-image' &&
    settings.background === 'transparent' &&
    settings.outputFormat === 'jpeg'
  ) {
    return 'JPEG does not support transparent backgrounds.'
  }
  if (family === 'dall-e-2' && settings.prompt.length > 1000) {
    return 'DALL·E 2 prompts must be 1,000 characters or fewer.'
  }
  if (family === 'dall-e-3' && settings.prompt.length > 4000) {
    return 'DALL·E 3 prompts must be 4,000 characters or fewer.'
  }
  return null
}

function validateNovelAIImageSettings(
  settings: z.infer<typeof imageSettingsSchema>
): string | null {
  if (settings.mode === 'edit') {
    return 'This image model does not support image editing.'
  }
  if (settings.n > getMaxImagesPerRequest(settings.model)) {
    return 'NovelAI generates up to 8 images per request.'
  }
  if (settings.width % 64 || settings.height % 64) {
    return 'Image dimensions must be multiples of 64.'
  }
  if (settings.width * settings.height > 3145728) {
    return 'The image resolution exceeds the NovelAI limit.'
  }
  return null
}

function validateAlibabaImageSettings(
  settings: z.infer<typeof imageSettingsSchema>,
  referenceCount: number
): string | null {
  const profile = getAlibabaImageModel(settings.model)
  if (!profile) return 'Select an image model.'
  if (settings.n > profile.maxImages) {
    return profile.maxImages === 1
      ? 'This model supports one image per request.'
      : 'Reduce the image count for this model.'
  }
  const references = settings.mode === 'edit' ? referenceCount : 0
  if (settings.mode === 'edit') {
    if (!profile.maxReferences) {
      return 'This image model does not support image editing.'
    }
    if (referenceCount === 0) return 'Add a reference image before editing.'
    if (referenceCount > profile.maxReferences) {
      return 'Too many reference images for this model.'
    }
  }
  if (references < profile.minReferences) {
    return 'This model edits images. Add a reference image first.'
  }
  if (profile.sizes.length && !profile.sizes.includes(settings.size)) {
    return 'Choose a size supported by this model.'
  }
  if (settings.size === '4K' && references > 0) {
    return '4K is only available when generating from text.'
  }
  if (
    settings.seed !== null &&
    settings.seed > getMaxImageSeed(settings.model)
  ) {
    return 'Enter a seed between 0 and 2147483647.'
  }
  return null
}

/** Whether the gateway answers with the images themselves rather than links. */
export function returnsInlineImages(
  settings: z.infer<typeof imageSettingsSchema>
): boolean {
  // GPT Image has no link form; it always answers with base64.
  if (getImageModelFamily(settings.model) === 'gpt-image') return true
  return buildImagePayload(settings).response_format === 'b64_json'
}

/**
 * The most gallery room one generated image may take: its pixels stored
 * uncompressed with alpha, which a PNG only exceeds by its framing, plus a
 * megabyte for the thumbnail and metadata. An automatic size is taken to stay
 * within 2048 × 2048.
 */
export function getMaxImageGalleryBytes(
  settings: z.infer<typeof imageSettingsSchema>
): number {
  const size = /^(\d+)[x*](\d+)$/.exec(
    String(buildImagePayload(settings).size ?? '')
  )
  const pixels = size ? Number(size[1]) * Number(size[2]) : 2048 * 2048
  return pixels * 4 + (1 << 20)
}

export type ImagePayload = Record<
  string,
  string | number | boolean | Record<string, unknown>
>

export function buildImagePayload(
  settings: z.infer<typeof imageSettingsSchema>
): ImagePayload {
  const family = getImageModelFamily(settings.model)
  if (family === 'novelai') return buildNovelAIImagePayload(settings)
  if (family === 'alibaba') return buildAlibabaImagePayload(settings)
  const payload: Record<string, string | number | boolean> = {
    model: settings.model,
    prompt: settings.prompt.trim(),
    group: settings.group,
    n: settings.n,
    size: resolveImageRequestSize(settings.size, settings.model),
  }
  // Gemini describes its output entirely through the size, so a model with no
  // quality of its own sends none rather than an invented one.
  if (getImageQualities(settings.model).length) {
    payload.quality = settings.quality
  }
  // Only Grok reads nsfw; other providers reject or ignore the unknown field.
  if (family === 'grok-imagine') payload.nsfw = settings.nsfw
  if (family === 'gpt-image') {
    payload.background =
      settings.background === 'auto' ? 'opaque' : settings.background
    payload.output_format = settings.outputFormat
    payload.moderation = settings.moderation
    if (settings.outputFormat === 'jpeg' || settings.outputFormat === 'webp') {
      payload.output_compression = settings.outputCompression
    }
    if (settings.outputFormat === 'gif') {
      payload.frame_count = settings.frameCount
      payload.frame_duration_ms = settings.frameDurationMs
    }
    if (settings.mode === 'edit' && settings.inputFidelity !== 'default') {
      payload.input_fidelity = settings.inputFidelity
    }
  } else {
    payload.response_format = settings.responseFormat
    if (family === 'dall-e-3') payload.style = settings.style
  }
  return payload
}

// NovelAI reads its sampling controls from the native `nai.parameters` object.
function buildNovelAIImagePayload(
  settings: z.infer<typeof imageSettingsSchema>
): ImagePayload {
  let qualityTagHint = 0
  if (settings.qualityToggle) {
    qualityTagHint = settings.qualityTier === 'light' ? 3 : 1
  }
  const parameters: Record<string, unknown> = {
    params_version: 4,
    width: settings.width,
    height: settings.height,
    steps: settings.steps,
    scale: settings.scale,
    sampler: settings.sampler,
    noise_schedule: settings.noiseSchedule,
    cfg_rescale: settings.cfgRescale,
    n_samples: settings.n,
    negative_prompt: settings.negativePrompt.trim(),
    ucPresetId: settings.ucPreset,
    qualityPresetId: settings.qualityToggle ? settings.qualityTier : 'none',
    tag_hint_qt: qualityTagHint,
    legacy: false,
    dynamic_thresholding: settings.decrisp,
    add_original_image: false,
    sm: settings.smea,
    sm_dyn: settings.smeaDyn,
    image_format: 'png',
  }
  if (settings.seed !== null) parameters.seed = settings.seed
  return {
    model: settings.model,
    prompt: settings.prompt.trim(),
    size: `${settings.width}x${settings.height}`,
    n: settings.n,
    response_format: 'b64_json',
    group: settings.group,
    nai: { action: 'generate', parameters },
  }
}

// The alibaba task plugin reads these OpenAI Images fields for every Alibaba
// image model, in JSON and in multipart edits alike.
function buildAlibabaImagePayload(
  settings: z.infer<typeof imageSettingsSchema>
): ImagePayload {
  const profile = getAlibabaImageModel(settings.model)
  const payload: ImagePayload = {
    model: settings.model,
    prompt: settings.prompt.trim(),
    group: settings.group,
    n: settings.n,
    response_format: 'b64_json',
  }
  if (profile?.sizes.length) payload.size = settings.size
  if (profile?.negativePrompt && settings.negativePrompt.trim()) {
    payload.negative_prompt = settings.negativePrompt.trim()
  }
  if (profile?.promptExtend) payload.prompt_extend = settings.promptExtend
  if (settings.seed !== null) payload.seed = settings.seed
  return payload
}

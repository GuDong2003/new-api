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
  getImageModelFamily as classifyImageModelFamily,
  type ImageModelFamily,
} from './image-models'

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
  background: z.enum(['auto', 'transparent', 'opaque']).default('auto'),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).default('png'),
  outputCompression: z.number().int().min(0).max(100).default(100),
  moderation: z.enum(['auto', 'low']).default('auto'),
  responseFormat: z.enum(['b64_json', 'url']).default('b64_json'),
  style: z.enum(['vivid', 'natural']).default('vivid'),
  inputFidelity: z.enum(['default', 'high', 'low']).default('default'),
  stream: z.boolean().default(false),
  partialImages: z.number().int().min(0).max(3).default(1),
  user: z.string().max(512).default(''),
  nsfw: z.boolean().default(false),
})

export const DEFAULT_IMAGE_SETTINGS = imageSettingsSchema.parse({})

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
  return settingsForImageModel(parsed, parsed.model)
}

export function getImageSizes(model: string): string[] {
  const family = getImageModelFamily(model)
  if (family === 'dall-e-2') return ['256x256', '512x512', '1024x1024']
  if (family === 'dall-e-3') return ['1024x1024', '1792x1024', '1024x1792']
  if (family === 'imagen') {
    return ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792']
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
  return supportsImageSizePresetTable(model) || supportsAutomaticImageSize(model)
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

/**
 * The request value for a tier. `1k` is documented but rejected upstream, so
 * its documented synonym `standard` carries the 1K tier instead.
 */
export function imageTierQuality(resolution: ImageResolution): string {
  if (resolution === '1K') return 'standard'
  return resolution.toLowerCase()
}

export function getImageAspectRatios(
  model: string
): readonly ImageAspectRatio[] {
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

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number]
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number]

/**
 * The provider's recommended size for each ratio and tier. Exact pixels are not
 * honoured anyway — a request is rendered at the model's own size for the tier,
 * keeping only the ratio — so these are the values the provider itself
 * publishes rather than anything derived from a formula.
 */
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
    '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024',
    '3:4': '864x1152', '4:3': '1152x864', '4:5': '896x1120',
    '5:4': '1120x896', '9:16': '720x1280', '16:9': '1280x720',
    '21:9': '1456x624',
  },
  '2K': {
    '1:1': '2048x2048', '2:3': '1664x2496', '3:2': '2496x1664',
    '3:4': '1728x2304', '4:3': '2304x1728', '4:5': '1792x2240',
    '5:4': '2240x1792', '9:16': '1440x2560', '16:9': '2560x1440',
    '21:9': '3024x1296',
  },
  '4K': {
    '1:1': '2480x2480', '2:3': '2032x3056', '3:2': '3056x2032',
    '3:4': '2160x2880', '4:3': '2880x2160', '4:5': '2224x2784',
    '5:4': '2784x2224', '9:16': '1872x3328', '16:9': '3328x1872',
    '21:9': '3808x1632',
  },
}

/**
 * Nano Banana runs a different upstream path and rejects the GPT Image sizes,
 * so it carries its own table. Each tier is roughly N²·1024² pixels.
 */
const NANO_BANANA_PRESET_SIZES: ImagePresetSizes = {
  '1K': {
    '1:1': '1024x1024', '2:3': '848x1264', '3:2': '1264x848',
    '3:4': '864x1152', '4:3': '1152x864', '4:5': '832x1024',
    '5:4': '1024x832', '9:16': '768x1360', '16:9': '1360x768',
    '21:9': '1584x672',
    '1:4': '512x2048', '4:1': '2048x512', '1:8': '368x2944', '8:1': '2944x368',
  },
  '2K': {
    '1:1': '2048x2048', '2:3': '1696x2528', '3:2': '2528x1696',
    '3:4': '1536x2048', '4:3': '2048x1536', '4:5': '1856x2304',
    '5:4': '2304x1856', '9:16': '1536x2752', '16:9': '2752x1536',
    '21:9': '3168x1344',
    '1:4': '1024x4096', '4:1': '4096x1024', '1:8': '736x5888', '8:1': '5888x736',
  },
  '4K': {
    '1:1': '4096x4096', '2:3': '3392x5056', '3:2': '5056x3392',
    '3:4': '3584x4784', '4:3': '4784x3584', '4:5': '3712x4608',
    '5:4': '4608x3712', '9:16': '3072x5504', '16:9': '5504x3072',
    '21:9': '6336x2688',
    '1:4': '2048x8192', '4:1': '8192x2048', '1:8': '1472x11776',
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
  return (
    imagePresetTable(model)[resolution][aspectRatio] ??
    GPT_IMAGE_PRESET_SIZES[resolution]['1:1']
  )
}

/**
 * Read the billed tier a pixel size falls into. Fixed-size models have no
 * preset to look up, so the thresholds mirror how the provider infers a tier
 * from the longest side.
 */
export function getImageResolutionTier(size: string): ImageResolution {
  const longest = Math.max(...size.split('x').map(Number))
  if (!Number.isFinite(longest) || longest <= 1600) return '1K'
  if (longest <= 2800) return '2K'
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
  return null
}

export function getImageQualities(model: string): string[] {
  const family = getImageModelFamily(model)
  if (family === 'dall-e-2') return ['standard']
  if (family === 'dall-e-3') return ['standard', 'hd']
  if (family === 'imagen' || family === 'flux') return ['standard', 'hd']
  if (family === 'seedream') return ['standard']
  // Preset models do not expose quality at all: this gateway reads it as the
  // billed tier, which buildImagePayload derives from the chosen size.
  if (supportsImageSizePresets(model)) return ['standard', '2k', '4k']
  // Listed best first, after `auto`, which stays the default for every family.
  return ['auto', 'high', 'medium', 'low']
}

export function settingsForImageModel(
  settings: Partial<z.infer<typeof imageSettingsSchema>>,
  model: string
): z.infer<typeof imageSettingsSchema> {
  const next = { ...DEFAULT_IMAGE_SETTINGS, ...settings, model }
  const family = getImageModelFamily(model)
  const qualities = getImageQualities(model)
  if (!qualities.includes(next.quality)) {
    next.quality = qualities[0] as typeof next.quality
  }
  if (
    !getImageSizes(model).includes(next.size) &&
    !supportsImageSizePresets(model)
  ) {
    next.size = '1024x1024'
  }
  // Preset-only families have no free-form pixel entry, so a size carried over
  // from a custom-size model must land back on a preset the toggles can show.
  if (
    family === 'nano-banana' &&
    next.size !== 'auto' &&
    !getImageSizePreset(next.size, model)
  ) {
    next.size = getImagePresetSize('1:1', '1K', model)
  }
  if (family === 'dall-e-3' || family === 'imagen' || family === 'seedream') {
    next.n = 1
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
  const family = getImageModelFamily(settings.model)
  if (family === 'dall-e-3' && settings.n !== 1) {
    return 'DALL·E 3 supports one image per request.'
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
  if (!getImageQualities(settings.model).includes(settings.quality)) {
    return 'Choose a quality supported by this model.'
  }
  if (
    !supportsImageSizePresets(settings.model) &&
    !getImageSizes(settings.model).includes(settings.size)
  ) {
    return 'Choose a size supported by this model.'
  }
  if (
    settings.size !== 'auto' &&
    !/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(settings.size)
  ) {
    return 'Enter a valid width and height.'
  }
  if (
    family === 'gpt-image' &&
    !getImageSizes(settings.model).includes(settings.size)
  ) {
    if (isLegacyGptImageModel(settings.model)) {
      return 'Choose a size supported by this model.'
    }
    const [width, height] = settings.size.split('x').map(Number)
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
    return 'Transparent backgrounds require PNG or WebP.'
  }
  if (family === 'dall-e-2' && settings.prompt.length > 1000) {
    return 'DALL·E 2 prompts must be 1,000 characters or fewer.'
  }
  if (family === 'dall-e-3' && settings.prompt.length > 4000) {
    return 'DALL·E 3 prompts must be 4,000 characters or fewer.'
  }
  return null
}

// A streamed request is watched on its open connection and keeps returning
// partial previews. Everything else is submitted as a durable gateway task, and
// one task carries exactly one image.
export function usesImageTask(
  settings: z.infer<typeof imageSettingsSchema>
): boolean {
  return buildImagePayload(settings).stream !== true
}

export function buildImagePayload(
  settings: z.infer<typeof imageSettingsSchema>
): Record<string, string | number | boolean> {
  const family = getImageModelFamily(settings.model)
  const payload: Record<string, string | number | boolean> = {
    model: settings.model,
    prompt: settings.prompt.trim(),
    group: settings.group,
    n: settings.n,
    size: settings.size,
    quality: settings.quality,
  }
  if (settings.user.trim()) payload.user = settings.user.trim()
  // This gateway bills by the tier named in quality, so it must agree with the
  // pixels in size or the request pays for one tier and renders another.
  if (supportsImageSizePresets(settings.model)) {
    payload.quality = imageTierQuality(
      getImageSizePreset(settings.size, settings.model)?.resolution ?? '1K'
    )
  }
  // Only Grok reads nsfw; other providers reject or ignore the unknown field.
  if (family === 'grok-imagine') payload.nsfw = settings.nsfw
  if (family === 'gpt-image') {
    payload.background = settings.background
    payload.output_format = settings.outputFormat
    payload.moderation = settings.moderation
    payload.stream = settings.stream
    if (settings.outputFormat !== 'png') {
      payload.output_compression = settings.outputCompression
    }
    if (settings.stream) payload.partial_images = settings.partialImages
    if (settings.mode === 'edit' && settings.inputFidelity !== 'default') {
      payload.input_fidelity = settings.inputFidelity
    }
  } else {
    payload.response_format = settings.responseFormat
    if (family === 'dall-e-3') payload.style = settings.style
  }
  return payload
}

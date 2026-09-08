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

export const imageSettingsSchema = z.object({
  mode: z.enum(['generate', 'edit']).default('generate'),
  group: z.string().trim().default('default'),
  model: z.string().trim().default(''),
  prompt: z.string().max(32000).default(''),
  size: z.string().default('1024x1024'),
  quality: z
    .enum(['auto', 'low', 'medium', 'high', 'standard', 'hd'])
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
  return imageSettingsSchema.parse(normalized)
}

export function getImageModelFamily(
  model: string
): 'dall-e-2' | 'dall-e-3' | 'gpt-image' {
  if (model === 'dall-e-2' || model === 'dall-e') return 'dall-e-2'
  if (model === 'dall-e-3') return 'dall-e-3'
  return 'gpt-image'
}

export function getImageSizes(model: string): string[] {
  const family = getImageModelFamily(model)
  if (family === 'dall-e-2') return ['256x256', '512x512', '1024x1024']
  if (family === 'dall-e-3') return ['1024x1024', '1792x1024', '1024x1792']
  return ['auto', '1024x1024', '1536x1024', '1024x1536']
}

export function getImageQualities(model: string): string[] {
  const family = getImageModelFamily(model)
  if (family === 'dall-e-2') return ['standard']
  if (family === 'dall-e-3') return ['standard', 'hd']
  return ['auto', 'low', 'medium', 'high']
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
    (family !== 'gpt-image' ||
      /^(gpt-image-1(?:[.-]|$)|chatgpt-image-latest$)/.test(model))
  ) {
    next.size = '1024x1024'
  }
  if (family === 'dall-e-3') {
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
    family !== 'gpt-image' &&
    !getImageSizes(settings.model).includes(settings.size)
  ) {
    return 'Choose a size supported by this model.'
  }
  if (
    settings.size !== 'auto' &&
    !/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(settings.size)
  ) {
    return 'Enter a size in WIDTHxHEIGHT format.'
  }
  if (
    family === 'gpt-image' &&
    !getImageSizes(settings.model).includes(settings.size)
  ) {
    if (/^(gpt-image-1(?:[.-]|$)|chatgpt-image-latest$)/.test(settings.model)) {
      return 'Choose a size supported by this model.'
    }
    const [width, height] = settings.size.split('x').map(Number)
    if (
      width % 16 ||
      height % 16 ||
      width / height < 1 / 3 ||
      width / height > 3 ||
      width * height > 3840 * 2160 ||
      Math.max(width, height) > 3840
    ) {
      return 'Custom dimensions must be multiples of 16, within 3840 × 2160 pixels and a 1:3 to 3:1 aspect ratio.'
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

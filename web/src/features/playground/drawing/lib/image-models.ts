/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { SUPPORTED_NOVELAI_MODELS } from '@/lib/novelai-models'

import type { ModelOption } from '../../types'

export type ImageModelFamily =
  | 'dall-e-2'
  | 'dall-e-3'
  | 'gpt-image'
  | 'grok-imagine'
  | 'nano-banana'
  | 'imagen'
  | 'flux'
  | 'seedream'
  | 'recraft'
  | 'kolors'
  | 'janus'
  | 'novelai'
  | 'alibaba'

/**
 * How the drawing page asks for an image. A description is one paragraph the
 * model interprets; tags are short positive and negative phrases with explicit
 * sampling controls such as the seed.
 */
export type ImageGenerationMode = 'description' | 'tags'

/**
 * What an Alibaba image model accepts, as the alibaba task plugin validates it.
 * `sizes` lists the output sizes offered; an empty list means the model takes
 * no size and follows its reference image.
 */
export type AlibabaImageModel = {
  maxImages: number
  minReferences: number
  maxReferences: number
  sizes: readonly string[]
  negativePrompt: boolean
  promptExtend: boolean
  // Z-Image bills a rewritten prompt as a second image, so rewriting starts off.
  promptExtendByDefault: boolean
  mask: boolean
}

// Qwen-Image 1.0 renders only these five sizes.
const QWEN_IMAGE_SIZES = [
  '1328*1328',
  '1664*928',
  '928*1664',
  '1472*1140',
  '1140*1472',
]
// Later Qwen-Image and Z-Image models take any size between 512² and 2048²
// pixels; these are the common ratios within that range.
const QWEN_IMAGE_2_SIZES = [
  '1024*1024',
  '1328*1328',
  '1664*928',
  '928*1664',
  '1472*1140',
  '1140*1472',
  '2048*2048',
]
// Wan image models also accept the 1K and 2K tiers, sized from the reference.
const WAN_IMAGE_SIZES = [
  '1K',
  '2K',
  '1024*1024',
  '1664*928',
  '928*1664',
  '1472*1104',
  '1104*1472',
]
// Wan text-to-image models render up to 1440 pixels per side.
const WAN_T2I_SIZES = [
  '1024*1024',
  '1280*720',
  '720*1280',
  '1152*864',
  '864*1152',
  '1440*1440',
]

const wanTextToImage: AlibabaImageModel = {
  maxImages: 4,
  minReferences: 0,
  maxReferences: 0,
  sizes: WAN_T2I_SIZES,
  negativePrompt: true,
  promptExtend: true,
  promptExtendByDefault: true,
  mask: false,
}
const qwenTextToImage: AlibabaImageModel = {
  maxImages: 1,
  minReferences: 0,
  maxReferences: 0,
  sizes: QWEN_IMAGE_SIZES,
  negativePrompt: true,
  promptExtend: true,
  promptExtendByDefault: true,
  mask: false,
}
const qwenImage2: AlibabaImageModel = {
  ...qwenTextToImage,
  maxImages: 6,
  maxReferences: 3,
  sizes: QWEN_IMAGE_2_SIZES,
}
const qwenImageEdit: AlibabaImageModel = {
  maxImages: 1,
  minReferences: 1,
  maxReferences: 3,
  sizes: [],
  negativePrompt: true,
  promptExtend: false,
  promptExtendByDefault: false,
  mask: false,
}

const ALIBABA_IMAGE_MODELS: Record<string, AlibabaImageModel> = {
  'wan2.7-image-pro': {
    ...wanTextToImage,
    maxReferences: 9,
    sizes: [...WAN_IMAGE_SIZES.slice(0, 2), '4K', ...WAN_IMAGE_SIZES.slice(2)],
  },
  'wan2.7-image': {
    ...wanTextToImage,
    maxReferences: 9,
    sizes: WAN_IMAGE_SIZES,
  },
  'wan2.6-image': {
    ...wanTextToImage,
    minReferences: 1,
    maxReferences: 4,
    sizes: WAN_IMAGE_SIZES,
  },
  'wan2.6-t2i': wanTextToImage,
  'wan2.5-t2i-preview': wanTextToImage,
  'wan2.2-t2i-flash': wanTextToImage,
  'wan2.2-t2i-plus': wanTextToImage,
  'wanx2.1-t2i-turbo': wanTextToImage,
  'wanx2.1-t2i-plus': wanTextToImage,
  'wanx2.0-t2i-turbo': wanTextToImage,
  'wan2.5-i2i-preview': {
    ...wanTextToImage,
    minReferences: 1,
    maxReferences: 3,
    sizes: ['1024*1024', '1280*720', '720*1280', '1280*1280'],
    promptExtend: false,
  },
  // One base image selects its operation; a mask repaints only part of it.
  'wanx2.1-imageedit': {
    ...wanTextToImage,
    minReferences: 1,
    maxReferences: 1,
    sizes: [],
    negativePrompt: false,
    promptExtend: false,
    mask: true,
  },
  'qwen-image': qwenTextToImage,
  'qwen-image-plus': qwenTextToImage,
  'qwen-image-max': qwenTextToImage,
  'qwen-image-2.0': qwenImage2,
  'qwen-image-2.0-pro': qwenImage2,
  'qwen-image-3.0': qwenImage2,
  'qwen-image-3.0-pro': qwenImage2,
  'qwen-image-edit': qwenImageEdit,
  'qwen-image-edit-plus': { ...qwenImageEdit, maxImages: 6 },
  'qwen-image-edit-max': { ...qwenImageEdit, maxImages: 6 },
  'z-image-turbo': {
    ...qwenTextToImage,
    sizes: QWEN_IMAGE_2_SIZES,
    promptExtendByDefault: false,
  },
}

/**
 * Dated snapshots such as `qwen-image-2.0-pro-2026-03-03` share the profile of
 * the undated model, and `wan2.1-` is the newer spelling of `wanx2.1-`.
 */
export function getAlibabaImageModel(model: string): AlibabaImageModel | null {
  const key = model
    .trim()
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/^wan2\.1-/, 'wanx2.1-')
  return ALIBABA_IMAGE_MODELS[key] ?? null
}

/**
 * Classify models that can be sent through the generic image-generation
 * playground.
 */
export function getImageModelFamily(model: string): ImageModelFamily | null {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return null

  if ((SUPPORTED_NOVELAI_MODELS as readonly string[]).includes(normalized)) {
    return 'novelai'
  }
  if (getAlibabaImageModel(normalized)) return 'alibaba'
  if (
    normalized === 'dall-e' ||
    /(^|[/.:_-])dall-e-2(?:[/.:_-]|$)/.test(normalized)
  ) {
    return 'dall-e-2'
  }
  if (/(^|[/.:_-])dall-e-3(?:[/.:_-]|$)/.test(normalized)) {
    return 'dall-e-3'
  }
  if (/(^|[/.:_-])(?:gpt-image|chatgpt-image)(?:[/.:_-]|$)/.test(normalized)) {
    return 'gpt-image'
  }
  if (
    !/video/i.test(normalized) &&
    /(^|[/.:_-])grok-imagine(?:[/.:_-]|$)/.test(normalized)
  ) {
    return 'grok-imagine'
  }
  // Nano Banana ships under its own name and as the Gemini image models it is
  // built on. Gemini text and embedding names must not be swept in, so an
  // `image` segment is required, and video variants stay out.
  if (
    /nano-banana/.test(normalized) ||
    (!/video/.test(normalized) &&
      /(^|[/.:_-])gemini[\w.-]*[/.:_-]image(?:[/.:_-]|$)/.test(normalized))
  ) {
    return 'nano-banana'
  }
  if (/(^|[/.:_-])imagen(?:[/.:_-]|$)/.test(normalized)) return 'imagen'
  if (/(^|[/._-])flux(?:[/._-]|$)/.test(normalized)) return 'flux'
  if (/(^|[/._-])seedream(?:[/._-]|$)/.test(normalized)) {
    return 'seedream'
  }
  if (/(^|[/._-])recraft(?:[/._-]|$)/.test(normalized)) return 'recraft'
  if (/(^|[/._-])kolors(?:[/._-]|$)/.test(normalized)) return 'kolors'
  if (/(^|[/._-])janus(?:[/._-]|$)/.test(normalized)) return 'janus'

  return null
}

/** NovelAI and Alibaba's image models are prompted with tags. */
export function getImageGenerationMode(
  family: ImageModelFamily
): ImageGenerationMode {
  return family === 'novelai' || family === 'alibaba' ? 'tags' : 'description'
}

export function filterImageModels(
  models: readonly ModelOption[],
  mode: ImageGenerationMode
): ModelOption[] {
  return models.filter((model) => {
    const family = getImageModelFamily(model.value)
    return family !== null && getImageGenerationMode(family) === mode
  })
}

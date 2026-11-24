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
import { CANVAS_ASSET_ID } from '@/features/gallery/lib/canvas-document'

import type { ImageResponse, ImageResult } from '../types'
import { IMAGE_MIME_TYPES, isSafeImageSource } from './image-assets'
import {
  isSVGImageType,
  SVG_FORMAT_MISMATCH,
  SVG_IMAGE_MIME_TYPE,
} from './svg-image'

export function parseImageResult(
  item: {
    b64_json?: string
    url?: string
    revised_prompt?: string
    mime_type?: string
    gallery_image_id?: string
  },
  format = 'png'
): ImageResult {
  let mimeType = format === 'svg' ? SVG_IMAGE_MIME_TYPE : 'image/png'
  if (['jpeg', 'webp', 'gif'].includes(format)) mimeType = `image/${format}`
  const declaredType = item.mime_type
  if (declaredType && isSVGImageType(declaredType)) {
    mimeType = SVG_IMAGE_MIME_TYPE
  } else if (declaredType && IMAGE_MIME_TYPES.includes(declaredType)) {
    mimeType = declaredType
  }
  if (item.b64_json) {
    // Probe only the signature; decoding the full image would duplicate a
    // potentially large animation in memory. Actual bytes win over a requested
    // GIF when an upstream falls back to a still image.
    let prefix: string
    try {
      prefix = atob(
        item.b64_json.slice(0, 64).replaceAll(/\s/g, '').slice(0, 32)
      )
    } catch {
      throw new Error('The image response is invalid.')
    }
    if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) {
      mimeType = 'image/gif'
    } else if (prefix.startsWith('\x89PNG\r\n\x1a\n')) {
      mimeType = 'image/png'
    } else if (prefix.startsWith('\xff\xd8\xff')) {
      mimeType = 'image/jpeg'
    } else if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') {
      mimeType = 'image/webp'
    }
  }
  const src = item.b64_json
    ? `data:${mimeType};base64,${item.b64_json}`
    : item.url
  if (!src || !isSafeImageSource(src)) {
    throw new Error('The image response is invalid.')
  }
  if (format === 'svg' && mimeType !== SVG_IMAGE_MIME_TYPE) {
    throw new Error(SVG_FORMAT_MISMATCH)
  }
  return {
    src,
    mimeType,
    revisedPrompt: item.revised_prompt,
    galleryImageId: CANVAS_ASSET_ID.test(item.gallery_image_id ?? '')
      ? item.gallery_image_id
      : undefined,
  }
}

export function parseImageResponse(
  response: ImageResponse,
  format: string
): ImageResult[] {
  if (response.error) {
    throw new Error(response.error.message || 'Image generation failed.')
  }
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error('The server returned no images.')
  }
  return response.data.map((item) =>
    parseImageResult(
      item,
      format === 'svg' ? format : response.output_format || format
    )
  )
}

type StreamImageEvent = {
  type?: string
  b64_json?: string
  url?: string
  revised_prompt?: string
  output_format?: string
  image_index?: number
  output_index?: number
  error?: { message?: string }
  message?: string
  usage?: Record<string, unknown>
}

export async function readImageStream(
  stream: ReadableStream<Uint8Array>,
  format: string,
  onPartial: (result: ImageResult, index: number) => void,
  signal?: AbortSignal
): Promise<{ images: ImageResult[]; usage?: Record<string, unknown> }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const completed = new Map<number, ImageResult>()
  let usage: Record<string, unknown> | undefined
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    let done = false
    while (!done) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      done = chunk.done
      buffer += decoder.decode(chunk.value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      if (done && buffer.trim()) blocks.push(buffer)
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data || data === '[DONE]') continue
        const event = JSON.parse(data) as StreamImageEvent
        if (event.error || event.type === 'error') {
          throw new Error(
            event.error?.message || event.message || 'Image generation failed.'
          )
        }
        if (
          !event.type?.endsWith('.partial_image') &&
          !event.type?.endsWith('.completed')
        ) {
          continue
        }
        const image = parseImageResult(
          event,
          format === 'svg' ? format : event.output_format || format
        )
        const index = event.image_index ?? event.output_index ?? completed.size
        if (!Number.isInteger(index) || index < 0 || index > 9) {
          throw new Error('The image response is invalid.')
        }
        if (event.type.endsWith('.completed')) {
          completed.set(index, image)
          usage = event.usage ?? usage
        } else {
          onPartial(image, index)
        }
      }
    }
    signal?.throwIfAborted()
    if (completed.size === 0) {
      throw new Error('The image stream ended before generation completed.')
    }
    return {
      images: [...completed.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value),
      usage,
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

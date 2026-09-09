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
import { isAxiosError } from 'axios'

import { api } from '@/lib/api'

import { buildNaiImagePayload, validateNaiSettings } from './lib/nai-settings'
import type { NaiImageAsset, NaiSettings } from './types'

type NaiImageResponse = {
  data?: Array<{ b64_json?: string; url?: string }>
  usage?: Record<string, unknown>
  error?: { message?: string }
}

export async function generateNaiImages(options: {
  settings: NaiSettings
  signal: AbortSignal
}): Promise<{ images: NaiImageAsset[]; usage?: Record<string, unknown> }> {
  const error = validateNaiSettings(options.settings)
  if (error) throw new Error(error)
  const response = await api.post<NaiImageResponse>(
    '/pg/images/generations',
    buildNaiImagePayload(options.settings),
    {
      signal: options.signal,
      skipErrorHandler: true,
      skipBusinessError: true,
    }
  )
  const data = response.data
  if (data.error?.message) throw new Error(data.error.message)
  const images = (data.data || [])
    .map((item): NaiImageAsset | null => {
      if (item.b64_json) {
        return {
          id: crypto.randomUUID(),
          name: options.settings.prompt.slice(0, 512),
          src: `data:image/png;base64,${item.b64_json}`,
          width: options.settings.width,
          height: options.settings.height,
          mimeType: 'image/png',
        }
      }
      return null
    })
    .filter((image): image is NaiImageAsset => image !== null)
  if (!images.length) throw new Error('NovelAI returned no images.')
  return { images, usage: data.usage }
}

export function getNaiGenerationError(error: unknown): string {
  if (isAxiosError<NaiImageResponse>(error)) {
    return (
      error.response?.data?.error?.message ||
      error.message ||
      'NovelAI image generation failed.'
    )
  }
  return error instanceof Error
    ? error.message
    : 'NovelAI image generation failed.'
}

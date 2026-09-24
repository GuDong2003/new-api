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
import { isAxiosError } from 'axios'

import { api } from '@/lib/api'

import {
  imageAssetToFile,
  MAX_IMAGE_BYTES,
  MAX_REFERENCE_IMAGE_BYTES,
} from './lib/image-assets'
import {
  buildImagePayload,
  getImageModelFamily,
  supportsImageMask,
  supportsImageSizePresets,
  usesImageTask,
  validateImageSettings,
  type ImagePayload,
} from './lib/image-settings'
import { parseImageResponse, readImageStream } from './lib/image-stream'
import type {
  ImageAsset,
  ImageResponse,
  ImageResult,
  ImageSettings,
  ImageTaskResponse,
} from './types'

export type GenerateImagesOptions = {
  settings: ImageSettings
  references: ImageAsset[]
  mask?: ImageAsset
  /**
   * Reads a picture in full. A canvas opened from the gallery shows previews
   * while its originals arrive, and a preview must never be what gets sent
   * upstream as the reference for a generation.
   */
  readImage?: (asset: ImageAsset, signal?: AbortSignal) => Promise<File>
  signal: AbortSignal
  onPartial: (result: ImageResult, index: number) => void
  // Reports the accepted task so the canvas can resume it after a reload.
  onTask?: (taskId: string) => void
  // Resumes an already accepted task instead of submitting a new request.
  taskId?: string
  // Answers on this request even without streaming, for images a task could
  // not keep.
  direct?: boolean
}

export type ImageGenerationResult = {
  images: ImageResult[]
  usage?: Record<string, unknown>
}

// Async tasks are read back from the gateway, never from a provider URL, and
// the edit endpoint shares the generation task namespace.
const IMAGE_TASK_ENDPOINT = '/pg/images/generations'
// The provider decides how long a queue takes, so polling backs off instead of
// hammering the gateway for slow models.
const IMAGE_TASK_POLL_DELAYS = [800, 1500, 2500, 4000]

export async function generateImages(
  options: GenerateImagesOptions
): Promise<ImageGenerationResult> {
  const outputFormat =
    getImageModelFamily(options.settings.model) === 'gpt-image'
      ? options.settings.outputFormat
      : 'png'
  if (options.taskId) {
    return await pollImageTask(options.taskId, outputFormat, options.signal)
  }
  const validation = validateImageSettings(
    options.settings,
    options.references.length
  )
  if (validation) throw new Error(validation)
  const payload = buildImagePayload(options.settings)
  let body: ImagePayload | FormData = payload
  if (options.settings.mode === 'edit') {
    // Among Alibaba's models only the Wanx image editor reads a mask.
    const mask = supportsImageMask(options.settings.model)
      ? options.mask
      : undefined
    if (
      mask &&
      (mask.mimeType !== 'image/png' ||
        mask.width !== options.references[0].width ||
        mask.height !== options.references[0].height)
    ) {
      throw new Error(
        'The mask must be a PNG with the same dimensions as the first reference image.'
      )
    }
    const readImage = options.readImage ?? imageAssetToFile
    const files = await Promise.all(
      options.references.map((asset) => readImage(asset, options.signal))
    )
    if (
      getImageModelFamily(options.settings.model) === 'dall-e-2' &&
      (files[0].type !== 'image/png' ||
        files[0].size >= 4 * 1024 * 1024 ||
        options.references[0].width !== options.references[0].height)
    ) {
      throw new Error('DALL·E 2 requires a square PNG smaller than 4 MB.')
    }
    // A single reference is capped well below the body limit, and enough of
    // them can clear that cap individually and still overrun the body.
    if (supportsImageSizePresets(options.settings.model)) {
      if (files.some((file) => file.size > MAX_REFERENCE_IMAGE_BYTES)) {
        throw new Error('Each reference image must be smaller than 20 MB.')
      }
      const total = files.reduce((bytes, file) => bytes + file.size, 0)
      if (total >= MAX_IMAGE_BYTES) {
        throw new Error('The reference images must total less than 50 MB.')
      }
    }
    // Alibaba reads each reference inline, up to its 10 MB input limit.
    if (
      getImageModelFamily(options.settings.model) === 'alibaba' &&
      files.some((file) => file.size > 10 * 1024 * 1024)
    ) {
      throw new Error('Each reference image must be smaller than 10 MB.')
    }
    const form = new FormData()
    for (const [key, value] of Object.entries(payload)) {
      form.append(
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      )
    }
    for (const file of files) {
      form.append(files.length === 1 ? 'image' : 'image[]', file)
    }
    if (mask) {
      const file = await readImage(mask, options.signal)
      if (file.size >= 4 * 1024 * 1024) {
        throw new Error('The mask must be smaller than 4 MB.')
      }
      form.append('mask', file)
    }
    body = form
  }
  options.signal.throwIfAborted()
  const endpoint =
    options.settings.mode === 'edit' ? '/pg/images/edits' : IMAGE_TASK_ENDPOINT
  if (usesImageTask(options.settings) && !options.direct) {
    // Without live previews there is nothing to watch on the connection, so the
    // request becomes a durable task: it survives reloads, proxy idle timeouts
    // and long provider queues.
    return await runImageTask(endpoint, body, outputFormat, options)
  }
  try {
    // The shared client supplies account authentication, rotation and credentials.
    const response = await api.post<ReadableStream<Uint8Array>>(
      endpoint,
      body,
      {
        adapter: 'fetch',
        responseType: 'stream',
        signal: options.signal,
        skipErrorHandler: true,
        skipBusinessError: true,
      }
    )
    if (
      String(response.headers['content-type']).includes('text/event-stream')
    ) {
      return await readImageStream(
        response.data,
        outputFormat,
        options.onPartial,
        options.signal
      )
    }
    const data = (await new Response(response.data).json()) as ImageResponse
    options.signal.throwIfAborted()
    return { images: parseImageResponse(data, outputFormat), usage: data.usage }
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason
    if (
      isAxiosError<ReadableStream<Uint8Array>>(error) &&
      error.response?.data
    ) {
      const data = (await new Response(error.response.data)
        .json()
        .catch(() => null)) as ImageResponse | null
      throw new Error(data?.error?.message || 'Image generation failed.')
    }
    throw error
  }
}

async function runImageTask(
  endpoint: string,
  body: ImagePayload | FormData,
  outputFormat: string,
  options: GenerateImagesOptions
): Promise<ImageGenerationResult> {
  let accepted: ImageTaskResponse
  try {
    // The shared client supplies account authentication, rotation and credentials.
    const response = await api.post<ReadableStream<Uint8Array>>(
      endpoint,
      body,
      {
        params: { async: 'true' },
        adapter: 'fetch',
        responseType: 'stream',
        signal: options.signal,
        skipErrorHandler: true,
        skipBusinessError: true,
      }
    )
    accepted = (await new Response(response.data).json()) as ImageTaskResponse
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason
    if (
      isAxiosError<ReadableStream<Uint8Array>>(error) &&
      error.response?.data
    ) {
      const data = (await new Response(error.response.data)
        .json()
        .catch(() => null)) as ImageResponse | null
      throw new Error(data?.error?.message || 'Image generation failed.')
    }
    throw error
  }
  if (!accepted.task_id) {
    // A gateway without async image support answers with the image itself.
    options.signal.throwIfAborted()
    return {
      images: parseImageResponse(accepted, outputFormat),
      usage: accepted.usage,
    }
  }
  options.onTask?.(accepted.task_id)
  return await pollImageTask(accepted.task_id, outputFormat, options.signal)
}

async function pollImageTask(
  taskId: string,
  outputFormat: string,
  signal: AbortSignal
): Promise<ImageGenerationResult> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let task: ImageTaskResponse
    try {
      // The task is addressed by id on our own endpoint; a status URL returned
      // by the gateway is never used as the request target.
      const response = await api.get<ImageTaskResponse>(
        `${IMAGE_TASK_ENDPOINT}/${encodeURIComponent(taskId)}`,
        { signal, skipErrorHandler: true, skipBusinessError: true }
      )
      task = response.data
    } catch (error) {
      throw imageTaskError(error, signal)
    }
    if (task.status === 'completed') {
      return {
        images: parseImageResponse(task, outputFormat),
        usage: task.usage,
      }
    }
    if (task.status === 'failed') {
      throw new Error(task.error?.message || 'Image generation failed.')
    }
    await waitBeforeNextPoll(
      IMAGE_TASK_POLL_DELAYS[
        Math.min(attempt, IMAGE_TASK_POLL_DELAYS.length - 1)
      ],
      signal
    )
  }
}

function waitBeforeNextPoll(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function imageTaskError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason
  if (isAxiosError<ImageTaskResponse>(error)) {
    const message = error.response?.data?.error?.message
    if (message) return new Error(message)
  }
  return error
}

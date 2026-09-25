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
import { t } from 'i18next'

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
  ImageTaskFailureReason,
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
// The canvas names each task it submits. A submission whose reply is lost, to a
// proxy error page or a dropped connection, can then still be found and watched
// instead of reported as failed while the gateway generates and bills it anyway.
const IMAGE_TASK_ID_HEADER = 'X-Image-Task-Id'
const IMAGE_TASK_ID_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
// A proxy can give up on an upload before the gateway has all of it, so after a
// lost reply the task may still be on its way. It is looked for this long before
// the submission counts as never having arrived.
const LOST_SUBMISSION_WAIT_MS = 3 * 60 * 1000
// The gateway keeps generating while the connection is down, so polling rides
// out an outage this long before it stops watching.
const UNREACHABLE_GATEWAY_WAIT_MS = 10 * 60 * 1000

// A submission whose reply was lost: what the browser got back instead, and
// when to stop looking for the task it may have created.
type LostSubmission = { reason: string; deadline: number }

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
  const taskId = createImageTaskId()
  let accepted: ImageTaskResponse
  try {
    // The shared client supplies account authentication, rotation and credentials.
    const response = await api.post<ReadableStream<Uint8Array>>(
      endpoint,
      body,
      {
        params: { async: 'true' },
        headers: { [IMAGE_TASK_ID_HEADER]: taskId },
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
    const refusal = await readGatewayRefusal(error)
    if (refusal !== undefined) {
      throw new Error(refusal || 'Image generation failed.')
    }
    // Whether the gateway accepted the task is unknown, but the task was named
    // before it was sent, so it can be looked for under that name.
    options.onTask?.(taskId)
    return await pollImageTask(taskId, outputFormat, options.signal, {
      reason: lostSubmissionReason(error),
      deadline: Date.now() + LOST_SUBMISSION_WAIT_MS,
    })
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
  signal: AbortSignal,
  lostSubmission?: LostSubmission
): Promise<ImageGenerationResult> {
  let unreachableSince: number | undefined
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let task: ImageTaskResponse | undefined
    try {
      // The task is addressed by id on our own endpoint; a status URL returned
      // by the gateway is never used as the request target.
      const response = await api.get<ImageTaskResponse>(
        `${IMAGE_TASK_ENDPOINT}/${encodeURIComponent(taskId)}`,
        { signal, skipErrorHandler: true, skipBusinessError: true }
      )
      task = response.data
      unreachableSince = undefined
    } catch (error) {
      if (signal.aborted || !isAxiosError(error)) {
        throw imageTaskError(error, signal)
      }
      const status = error.response?.status
      if (status === 404 && lostSubmission) {
        // Not accepted yet, or never: only waiting tells which.
        if (Date.now() >= lostSubmission.deadline) {
          throw new Error(lostSubmission.reason)
        }
      } else if (status === undefined || status === 429 || status >= 500) {
        unreachableSince ??= Date.now()
        if (Date.now() - unreachableSince >= UNREACHABLE_GATEWAY_WAIT_MS) {
          throw new Error(
            t(
              'The server could not be reached to check on this image. If it finishes, it will appear in the gallery.'
            )
          )
        }
      } else {
        throw imageTaskError(error, signal)
      }
    }
    if (task?.status === 'completed') {
      return {
        images: parseImageResponse(task, outputFormat),
        usage: task.usage,
      }
    }
    if (task?.status === 'failed') {
      throw new Error(describeImageTaskFailure(task))
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

function createImageTaskId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const name = Array.from(
    bytes,
    (byte) => IMAGE_TASK_ID_ALPHABET[byte % IMAGE_TASK_ID_ALPHABET.length]
  ).join('')
  return `task_${name}`
}

// Reads the gateway's own answer to a failed request. It is undefined when the
// answer did not come from the gateway: no answer at all, or a page a proxy put
// in its place.
async function readGatewayRefusal(error: unknown): Promise<string | undefined> {
  if (
    !isAxiosError<ReadableStream<Uint8Array>>(error) ||
    !error.response?.data
  ) {
    return undefined
  }
  const answer = (await new Response(error.response.data)
    .json()
    .catch(() => null)) as (ImageResponse & { message?: string }) | null
  if (!answer || typeof answer !== 'object') return undefined
  return answer.error?.message || answer.message || ''
}

// Explains a submission that never became a task, with what the browser got
// back in its place.
function lostSubmissionReason(error: unknown): string {
  const status = isAxiosError(error) ? error.response?.status : undefined
  let detail = status ? `HTTP ${status}` : ''
  if (!detail && error instanceof Error) detail = error.message
  if (!detail) {
    return t(
      'The request did not reach the server. Check your network and try again.'
    )
  }
  return t(
    'The request did not reach the server ({{detail}}). Check your network and try again.',
    { detail }
  )
}

// Explains a failed task in terms its owner can act on: each distinct cause its
// attempts met, the first plainly and the rest as what a retry ran into. A task
// that recorded no causes falls back to the gateway's message.
function describeImageTaskFailure(task: ImageTaskResponse): string {
  const causes = [
    ...new Set((task.failure_reasons ?? []).map(describeFailureCause)),
  ]
  if (causes.length === 0) {
    return task.error?.message || 'Image generation failed.'
  }
  return causes
    .map((cause, index) =>
      index === 0 ? cause : t('After a retry: {{reason}}', { reason: cause })
    )
    .join('\n')
}

function describeFailureCause(cause: ImageTaskFailureReason): string {
  switch (cause.kind) {
    case 'content_policy':
      return cause.message || t('The upstream service rejected the prompt.')
    case 'timeout':
      return t('The upstream service timed out.')
    case 'unavailable':
      return t('The upstream service was unavailable.')
    case 'task_lost':
      return t('The upstream service lost the task.')
    case 'queue_timeout':
      return t('The image task timed out while waiting in the queue.')
    case 'interrupted':
      return t('Image generation was interrupted by a service restart.')
    case 'result_too_large':
      return t('The generated image was too large to keep.')
    default:
      return cause.message || t('The upstream service returned an error.')
  }
}

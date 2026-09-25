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
import { AxiosError, type AxiosResponse } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { generateImages } from '../api'
import {
  DEFAULT_IMAGE_SETTINGS,
  settingsForImageModel,
} from '../lib/image-settings'

function streamed(payload: unknown) {
  return {
    headers: { 'content-type': 'application/json' },
    data: new Response(JSON.stringify(payload)).body,
  }
}

// dall-e-3 never streams, so these settings exercise the async task transport.
const DALL_E_SETTINGS = {
  ...DEFAULT_IMAGE_SETTINGS,
  model: 'dall-e-3',
  quality: 'standard' as const,
  prompt: 'A cup',
}

// An answer that is not a success. A proxy that replaces the gateway's reply
// answers with an HTML page; the gateway itself answers with JSON.
function failedAnswer(status: number, data: unknown): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    { status, statusText: '', headers: {}, data } as AxiosResponse
  )
}

const droppedConnection = () => new AxiosError('Network Error', 'ERR_NETWORK')
const taskNotFound = () =>
  failedAnswer(404, {
    error: { message: 'image task not found', code: 'task_not_found' },
  })

function proposedTaskId(config: unknown): string {
  return String(
    (config as { headers?: Record<string, string> } | undefined)?.headers?.[
      'X-Image-Task-Id'
    ]
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Image request transport', () => {
  it('decodes DALL·E base64 as PNG after switching from GPT WebP output', async () => {
    const request = vi.spyOn(api, 'post').mockResolvedValue({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }] })).body,
    })
    const result = await generateImages({
      settings: {
        ...DEFAULT_IMAGE_SETTINGS,
        model: 'dall-e-3',
        quality: 'standard',
        prompt: 'A cup',
        outputFormat: 'webp',
      },
      references: [],
      signal: new AbortController().signal,
      onPartial: vi.fn(),
    })
    expect(request).toHaveBeenCalledWith(
      '/pg/images/generations',
      expect.objectContaining({ model: 'dall-e-3', group: 'default' }),
      expect.objectContaining({ adapter: 'fetch' })
    )
    expect(result.images[0]).toMatchObject({
      mimeType: 'image/png',
      src: 'data:image/png;base64,YWJj',
    })
  })

  // A canvas opened from the gallery shows previews while its originals arrive.
  // A preview must never be what gets sent upstream to build the next image on.
  it('sends the original of a reference rather than the preview on screen', async () => {
    const request = vi.spyOn(api, 'post').mockResolvedValue({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }] })).body,
    })
    const readImage = vi.fn(
      async () =>
        new File(['the original'], 'reference.png', { type: 'image/png' })
    )

    await generateImages({
      settings: {
        ...DEFAULT_IMAGE_SETTINGS,
        model: 'gpt-image-1',
        mode: 'edit',
        prompt: 'A cup',
      },
      references: [
        {
          id: 'asset-1',
          name: 'preview.png',
          src: 'blob:http://localhost/preview',
          width: 1024,
          height: 1024,
          mimeType: 'image/png',
          previewOnly: true,
        },
      ],
      readImage,
      signal: new AbortController().signal,
      onPartial: vi.fn(),
    })

    expect(readImage).toHaveBeenCalledTimes(1)
    const form = request.mock.calls[0][1] as FormData
    expect((form.get('image') as File).name).toBe('reference.png')
  })

  // The gateway rejects a single reference over 20 MB, well under the 50 MB it
  // allows for the whole request, so the per-image cap has to be its own check.
  it('refuses a reference image the gateway would reject as too large', async () => {
    const request = vi.spyOn(api, 'post')
    const oversized = new File(['x'], 'huge.png', { type: 'image/png' })
    Object.defineProperty(oversized, 'size', { value: 21 * 1024 * 1024 })

    await expect(
      generateImages({
        settings: {
          ...settingsForImageModel(DEFAULT_IMAGE_SETTINGS, 'nano-banana-pro'),
          mode: 'edit',
          prompt: 'A cup',
        },
        references: [
          {
            id: 'asset-1',
            name: 'huge.png',
            src: 'blob:http://localhost/huge',
            width: 1024,
            height: 1024,
            mimeType: 'image/png',
          },
        ],
        readImage: vi.fn(async () => oversized),
        signal: new AbortController().signal,
        onPartial: vi.fn(),
      })
    ).rejects.toThrow('Each reference image must be smaller than 20 MB.')

    expect(request).not.toHaveBeenCalled()
  })

  // Each reference can clear the 20 MB per-image cap and still put the request
  // body over the 50 MB the gateway accepts.
  it('refuses references that individually fit but together exceed the body limit', async () => {
    const request = vi.spyOn(api, 'post')
    const readImage = vi.fn(async () => {
      const file = new File(['x'], 'big.png', { type: 'image/png' })
      Object.defineProperty(file, 'size', { value: 18 * 1024 * 1024 })
      return file
    })

    await expect(
      generateImages({
        settings: {
          ...settingsForImageModel(DEFAULT_IMAGE_SETTINGS, 'nano-banana-pro'),
          mode: 'edit',
          prompt: 'A cup',
        },
        references: [1, 2, 3].map((index) => ({
          id: `asset-${index}`,
          name: `big-${index}.png`,
          src: `blob:http://localhost/big-${index}`,
          width: 1024,
          height: 1024,
          mimeType: 'image/png',
        })),
        readImage,
        signal: new AbortController().signal,
        onPartial: vi.fn(),
      })
    ).rejects.toThrow('The reference images must total less than 50 MB.')

    expect(request).not.toHaveBeenCalled()
  })

  it('submits a non-streaming request as a task and polls it to completion', async () => {
    const request = vi
      .spyOn(api, 'post')
      .mockResolvedValue(streamed({ task_id: 'task_abc', status: 'queued' }))
    const poll = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce({
        data: { task_id: 'task_abc', status: 'queued' },
      })
      .mockResolvedValueOnce({
        data: {
          task_id: 'task_abc',
          status: 'completed',
          data: [{ url: 'https://cdn.example/a.png' }],
          usage: { total_tokens: 3 },
        },
      })
    const onTask = vi.fn()

    const result = await generateImages({
      settings: DALL_E_SETTINGS,
      references: [],
      signal: new AbortController().signal,
      onPartial: vi.fn(),
      onTask,
    })

    expect(request).toHaveBeenCalledWith(
      '/pg/images/generations',
      expect.anything(),
      expect.objectContaining({ params: { async: 'true' } })
    )
    expect(onTask).toHaveBeenCalledWith('task_abc')
    expect(poll).toHaveBeenCalledWith(
      '/pg/images/generations/task_abc',
      expect.anything()
    )
    expect(result.images[0].src).toBe('https://cdn.example/a.png')
    expect(result.usage).toEqual({ total_tokens: 3 })
  })

  it('reports the reason a task failed instead of returning images', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(
      streamed({ task_id: 'task_bad', status: 'queued' })
    )
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        task_id: 'task_bad',
        status: 'failed',
        data: [],
        error: { message: 'The prompt was rejected.' },
      },
    })

    await expect(
      generateImages({
        settings: DALL_E_SETTINGS,
        references: [],
        signal: new AbortController().signal,
        onPartial: vi.fn(),
      })
    ).rejects.toThrow('The prompt was rejected.')
  })

  it('names the task it submits and reads that task back', async () => {
    let proposed = ''
    vi.spyOn(api, 'post').mockImplementation(async (_url, _body, config) => {
      proposed = proposedTaskId(config)
      return streamed({ task_id: proposed, status: 'queued' })
    })
    const poll = vi.spyOn(api, 'get').mockImplementation(async () => ({
      data: {
        task_id: proposed,
        status: 'completed',
        data: [{ url: 'https://cdn.example/named.png' }],
      },
    }))

    const result = await generateImages({
      settings: DALL_E_SETTINGS,
      references: [],
      signal: new AbortController().signal,
      onPartial: vi.fn(),
    })

    expect(proposed).toMatch(/^task_[0-9A-Za-z]{32}$/)
    expect(poll).toHaveBeenCalledWith(
      `/pg/images/generations/${proposed}`,
      expect.anything()
    )
    expect(result.images[0].src).toBe('https://cdn.example/named.png')
  })

  it('finds its task after a proxy error page replaced the submission reply', async () => {
    let proposed = ''
    vi.spyOn(api, 'post').mockImplementation(async (_url, _body, config) => {
      proposed = proposedTaskId(config)
      throw failedAnswer(
        524,
        new Response('<!DOCTYPE html><title>A timeout occurred</title>').body
      )
    })
    const poll = vi
      .spyOn(api, 'get')
      .mockRejectedValueOnce(taskNotFound())
      .mockResolvedValueOnce({
        data: {
          task_id: proposed,
          status: 'completed',
          data: [{ url: 'https://cdn.example/recovered.png' }],
        },
      })
    const onTask = vi.fn()

    const result = await generateImages({
      settings: DALL_E_SETTINGS,
      references: [],
      signal: new AbortController().signal,
      onPartial: vi.fn(),
      onTask,
    })

    expect(onTask).toHaveBeenCalledWith(proposed)
    expect(poll).toHaveBeenLastCalledWith(
      `/pg/images/generations/${proposed}`,
      expect.anything()
    )
    expect(result.images[0].src).toBe('https://cdn.example/recovered.png')
  })

  it('says the request never reached the server once its task never appears', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'post').mockRejectedValue(droppedConnection())
    vi.spyOn(api, 'get').mockRejectedValue(taskNotFound())

    const outcome = expect(
      generateImages({
        settings: DALL_E_SETTINGS,
        references: [],
        signal: new AbortController().signal,
        onPartial: vi.fn(),
      })
    ).rejects.toThrow(
      'The request did not reach the server (Network Error). Check your network and try again.'
    )
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    await outcome
  })

  it("shows the gateway's own refusal without looking for a task", async () => {
    vi.spyOn(api, 'post').mockRejectedValue(
      failedAnswer(
        403,
        new Response(
          JSON.stringify({ error: { message: 'Insufficient quota.' } })
        ).body
      )
    )
    const poll = vi.spyOn(api, 'get')

    await expect(
      generateImages({
        settings: DALL_E_SETTINGS,
        references: [],
        signal: new AbortController().signal,
        onPartial: vi.fn(),
      })
    ).rejects.toThrow('Insufficient quota.')
    expect(poll).not.toHaveBeenCalled()
  })

  it('explains each cause a failed task met, in order', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(
      streamed({ task_id: 'task_refused', status: 'queued' })
    )
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        task_id: 'task_refused',
        status: 'failed',
        data: [],
        error: { message: 'upstream returned 524: The origin web server…' },
        failure_reasons: [
          {
            kind: 'content_policy',
            status: 502,
            message: '提示词有安全风险，请调整提示词重试',
          },
          { kind: 'timeout', status: 524 },
        ],
      },
    })

    await expect(
      generateImages({
        settings: DALL_E_SETTINGS,
        references: [],
        signal: new AbortController().signal,
        onPartial: vi.fn(),
      })
    ).rejects.toThrow(
      '提示词有安全风险，请调整提示词重试\nAfter a retry: The upstream service timed out.'
    )
  })

  it('keeps watching its task through a dropped connection', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(
      streamed({ task_id: 'task_flaky', status: 'queued' })
    )
    vi.spyOn(api, 'get')
      .mockRejectedValueOnce(droppedConnection())
      .mockResolvedValueOnce({
        data: {
          task_id: 'task_flaky',
          status: 'completed',
          data: [{ url: 'https://cdn.example/flaky.png' }],
        },
      })

    const result = await generateImages({
      settings: DALL_E_SETTINGS,
      references: [],
      signal: new AbortController().signal,
      onPartial: vi.fn(),
    })

    expect(result.images[0].src).toBe('https://cdn.example/flaky.png')
  })

  it('resumes an accepted task without submitting a new request', async () => {
    const request = vi.spyOn(api, 'post')
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        task_id: 'task_resume',
        status: 'completed',
        data: [{ url: 'https://cdn.example/resumed.png' }],
      },
    })

    const result = await generateImages({
      settings: DALL_E_SETTINGS,
      references: [],
      signal: new AbortController().signal,
      onPartial: vi.fn(),
      taskId: 'task_resume',
    })

    expect(request).not.toHaveBeenCalled()
    expect(result.images[0].src).toBe('https://cdn.example/resumed.png')
  })

  it('stops polling when the caller aborts', async () => {
    const controller = new AbortController()
    vi.spyOn(api, 'post').mockResolvedValue(
      streamed({ task_id: 'task_slow', status: 'queued' })
    )
    vi.spyOn(api, 'get').mockImplementation(async () => {
      controller.abort(new DOMException('Cancelled.', 'AbortError'))
      return { data: { task_id: 'task_slow', status: 'in_progress' } }
    })

    await expect(
      generateImages({
        settings: DALL_E_SETTINGS,
        references: [],
        signal: controller.signal,
        onPartial: vi.fn(),
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps the streaming transport when partial previews are requested', async () => {
    const request = vi.spyOn(api, 'post').mockResolvedValue({
      headers: { 'content-type': 'text/event-stream' },
      data: new Response(
        'data: {"type":"image_generation.completed","b64_json":"YWJj","image_index":0}\n\n'
      ).body,
    })
    const poll = vi.spyOn(api, 'get')

    const result = await generateImages({
      settings: {
        ...DEFAULT_IMAGE_SETTINGS,
        model: 'gpt-image-1',
        prompt: 'A cup',
        stream: true,
        outputFormat: 'png',
      },
      references: [],
      signal: new AbortController().signal,
      onPartial: vi.fn(),
    })

    expect(request).toHaveBeenCalledWith(
      '/pg/images/generations',
      expect.anything(),
      expect.not.objectContaining({ params: expect.anything() })
    )
    expect(poll).not.toHaveBeenCalled()
    expect(result.images[0].src).toBe('data:image/png;base64,YWJj')
  })
})

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

afterEach(() => {
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

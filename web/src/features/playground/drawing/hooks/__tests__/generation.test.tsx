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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  AxiosError,
  type AxiosResponse,
  type GenericAbortSignal,
  type InternalAxiosRequestConfig,
} from 'axios'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { login, response, usage } from '@/features/gallery/__tests__/fixtures'
import type { GalleryUsage } from '@/features/gallery/types'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
} from '../../lib/canvas-geometry'
import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { DrawingNode } from '../../types'
import {
  cancelImageGenerationJobs,
  resumeImageGenerationJobs,
  useImageGeneration,
} from '../use-image-generation'

const decoders: EventTarget[] = []
const adapter = api.defaults.adapter
// What the gallery answers when asked for room, or why it cannot answer.
let galleryUsage: GalleryUsage | AxiosError
const galleryRequests: unknown[] = []
beforeEach(() => {
  login()
  decoders.length = 0
  galleryUsage = usage
  galleryRequests.length = 0
  api.defaults.adapter = async (config) => {
    if (config.url !== '/api/gallery/usage') {
      throw new AxiosError(
        'not found',
        '',
        config,
        {},
        {
          ...response(config, {}),
          status: 404,
        }
      )
    }
    galleryRequests.push(config.params)
    if (galleryUsage instanceof AxiosError) throw galleryUsage
    return response(config, galleryUsage)
  }
  useDrawingStore.getState().initialize(813)
  useDrawingStore.getState().hydrate(null)
  vi.stubGlobal(
    'Image',
    class extends EventTarget {
      naturalWidth = 512
      naturalHeight = 512
      src = ''
      constructor() {
        super()
        decoders.push(this)
      }
      set onload(callback: EventListener) {
        this.addEventListener('load', callback)
      }
      set onerror(callback: EventListener) {
        this.addEventListener('error', callback)
      }
    }
  )
  vi.spyOn(api, 'post').mockResolvedValue({
    headers: { 'content-type': 'application/json' },
    data: new Response(
      JSON.stringify({ data: [{ b64_json: 'YWJj' }, { b64_json: 'ZGVm' }] })
    ).body,
  })
})
afterEach(() => {
  useAuthStore.getState().auth.reset()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
})

function generationReference(
  id: string,
  position: { x: number; y: number }
): DrawingNode {
  return {
    id,
    type: 'image',
    position,
    width: 280,
    height: 330,
    data: {
      prompt: id,
      settings: {
        ...DEFAULT_IMAGE_SETTINGS,
        model: 'gpt-image-1',
        prompt: id,
      },
      status: 'complete',
      createdAt: 1,
      asset: {
        id,
        name: `${id}.png`,
        src: 'data:image/png;base64,YWJj',
        mimeType: 'image/png',
        width: 512,
        height: 512,
      },
    },
  }
}

describe('Image generation jobs', () => {
  it('places a generated image to the right of two selected references', async () => {
    const referenceA = generationReference('reference-a', { x: 100, y: 100 })
    const referenceB = generationReference('reference-b', { x: 100, y: 470 })
    useDrawingStore.getState().addNodes([referenceA, referenceB])
    useDrawingStore.getState().setReferences([referenceA.id, referenceB.id])

    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })

    const decoderStart = decoders.length
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A combined image',
          mode: 'edit',
        },
        { x: 20, y: 30 }
      )
    )

    const generatedNode = useDrawingStore.getState().nodes.at(-1)
    expect(generatedNode?.position).toEqual({
      x: 500,
      y: 285,
    })
    expect(generatedNode).toBeDefined()
    expect(useDrawingStore.getState().edges).toHaveLength(2)
    expect(
      useDrawingStore
        .getState()
        .edges.every((edge) => edge.target === generatedNode?.id)
    ).toBe(true)
    await waitFor(() => expect(decoders.length).toBeGreaterThan(decoderStart))
    await act(async () => {
      for (const decoder of decoders.slice(decoderStart)) {
        decoder.dispatchEvent(new Event('error'))
      }
    })
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    hook.unmount()
    client.clear()
  })

  it('keeps text-to-image batches at the requested anchor even when references are selected', async () => {
    const reference = generationReference('reference-a', { x: 100, y: 100 })
    useDrawingStore.getState().addNodes([reference])
    useDrawingStore.getState().setReferences([reference.id])

    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })

    const decoderStart = decoders.length
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A standalone image',
          mode: 'generate',
        },
        { x: 700, y: 30 }
      )
    )

    expect(useDrawingStore.getState().nodes.at(-1)?.position).toEqual({
      x: 700,
      y: 30,
    })
    await waitFor(() => expect(decoders.length).toBeGreaterThan(decoderStart))
    await act(async () => {
      for (const decoder of decoders.slice(decoderStart)) {
        decoder.dispatchEvent(new Event('error'))
      }
    })
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    hook.unmount()
    client.clear()
  })

  // An uploaded image is dropped at the canvas default size, so a generated
  // one has to take the same size for the two to line up.
  it('gives a generated image the default node size an uploaded image gets', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })

    const decoderStart = decoders.length
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A standalone image',
          mode: 'generate',
        },
        { x: 0, y: 0 }
      )
    )

    expect(useDrawingStore.getState().nodes.at(-1)).toMatchObject({
      width: CANVAS_NODE_WIDTH,
      height: CANVAS_NODE_HEIGHT,
    })
    await waitFor(() => expect(decoders.length).toBeGreaterThan(decoderStart))
    await act(async () => {
      for (const decoder of decoders.slice(decoderStart)) {
        decoder.dispatchEvent(new Event('error'))
      }
    })
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    hook.unmount()
    client.clear()
  })

  it('tracks streamed previews and decoding, then resets progress when retrying the failed attempt', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100000)
    let stream: ReadableStreamDefaultController<Uint8Array>
    vi.mocked(api.post).mockResolvedValueOnce({
      headers: { 'content-type': 'text/event-stream' },
      data: new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
        },
      }),
    })
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A cup',
          stream: true,
        },
        { x: 0, y: 0 }
      )
    )
    const id = useDrawingStore.getState().nodes[0].id
    expect(useDrawingStore.getState().nodes[0].data.progress).toEqual({
      startedAt: 100000,
      phase: 'generating',
      previewCount: 0,
    })
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce())
    await act(async () => {
      stream.enqueue(
        new TextEncoder().encode(
          'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"YWJj"}\n\ndata: {"type":"image_generation.partial_image","partial_image_index":1,"b64_json":"ZGVm"}\n\n'
        )
      )
    })
    await waitFor(() =>
      expect(
        useDrawingStore.getState().nodes[0].data.progress?.previewCount
      ).toBe(2)
    )
    expect(useDrawingStore.getState().nodes[0].data.asset?.src).toBe(
      'data:image/png;base64,ZGVm'
    )
    await act(async () => {
      stream.enqueue(
        new TextEncoder().encode(
          'data: {"type":"image_generation.completed","b64_json":"Z2hp"}\n\n'
        )
      )
      stream.close()
    })
    await waitFor(() => expect(decoders).toHaveLength(1))
    expect(useDrawingStore.getState().nodes[0].data.progress?.phase).toBe(
      'decoding'
    )
    await act(async () => decoders[0].dispatchEvent(new Event('error')))
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    now.mockReturnValue(200000)
    act(() => hook.result.current.retry(id))
    expect(useDrawingStore.getState().nodes[0].data.progress).toEqual({
      startedAt: 200000,
      phase: 'generating',
      previewCount: 0,
    })
    act(() => hook.result.current.cancel())
    hook.unmount()
    client.clear()
  })

  it('continues a generation after the drawing page unmounts', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })

    const decoderIndex = decoders.length
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A cup',
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(decoders.length).toBeGreaterThan(decoderIndex))
    const imageId = useDrawingStore.getState().nodes[0].id

    hook.unmount()
    await act(async () => {
      for (const decoder of decoders.slice(decoderIndex)) {
        decoder.dispatchEvent(new Event('load'))
      }
    })

    await waitFor(() =>
      expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
    )
    expect(useDrawingStore.getState().nodes[0].id).toBe(imageId)
    client.clear()
  })

  it('keeps a final image complete when a lifecycle cancellation arrives during decoding', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })

    const decoderIndex = decoders.length
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A final image',
          n: 1,
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(decoders.length).toBeGreaterThan(decoderIndex))

    cancelImageGenerationJobs(813, 'gallery-session')
    await act(async () =>
      decoders[decoderIndex].dispatchEvent(new Event('load'))
    )

    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
    hook.unmount()
    client.clear()
  })

  it('keeps a pending drawing generation alive while arranging the canvas', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    let signal: GenericAbortSignal | undefined
    vi.mocked(api.post).mockImplementation((_url, _body, config) => {
      signal = config?.signal
      return Promise.resolve({
        headers: { 'content-type': 'application/json' },
        data: new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }] }))
          .body,
      })
    })

    act(() =>
      hook.result.current.generate(
        { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A cup' },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(decoders).toHaveLength(1))
    const node = useDrawingStore.getState().nodes[0]
    const jobId = node.data.jobId

    act(() => useDrawingStore.getState().arrange())

    expect(signal?.aborted).toBe(false)
    expect(useDrawingStore.getState().nodes[0].data).toMatchObject({
      status: 'pending',
      jobId,
    })
    await act(async () => decoders[0].dispatchEvent(new Event('load')))
    await waitFor(() =>
      expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
    )
    hook.unmount()
    client.clear()
  })

  it('does not expose or cancel a different user’s active generation', async () => {
    const client = new QueryClient()
    let signal: GenericAbortSignal | undefined
    let rejectRequest: (reason?: unknown) => void = () => undefined
    const request = new Promise<never>((_resolve, reject) => {
      rejectRequest = reject
    })
    vi.mocked(api.post).mockImplementation((_url, _body, config) => {
      signal = config?.signal
      signal?.addEventListener?.(
        'abort',
        () => rejectRequest(new Error('cancelled')),
        { once: true }
      )
      return request
    })
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    useDrawingStore.getState().initialize(813)
    useDrawingStore.getState().hydrate(null)
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A cup',
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(signal).toBeDefined())

    useDrawingStore.getState().initialize(814)
    useDrawingStore.getState().hydrate(null)
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    act(() => hook.result.current.cancel())
    expect(signal?.aborted).toBe(false)

    cancelImageGenerationJobs(813, 'gallery-session')
    await waitFor(() => expect(signal?.aborted).toBe(true))
    hook.unmount()
    client.clear()
  })

  it('retries only the failed image in place with its original settings and ignores repeated clicks', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    const settings = {
      ...DEFAULT_IMAGE_SETTINGS,
      model: 'gpt-image-1',
      prompt: 'Two cups',
      n: 2,
    }
    act(() => hook.result.current.generate(settings, { x: 120, y: 240 }))
    await waitFor(() => expect(decoders).toHaveLength(2))
    await act(async () => {
      decoders[0].dispatchEvent(new Event('load'))
      decoders[1].dispatchEvent(new Event('error'))
    })
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    const [successful, failed] = useDrawingStore.getState().nodes
    act(() =>
      useDrawingStore.getState().updateSettings({
        model: 'dall-e-3',
        prompt: 'An unrelated landscape',
        n: 1,
      })
    )
    vi.mocked(api.post).mockResolvedValueOnce({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: 'Z2hp' }] })).body,
    })

    act(() => {
      hook.result.current.retry(failed.id)
      hook.result.current.retry(failed.id)
    })

    expect(hook.result.current.pendingCount).toBe(1)
    expect(useDrawingStore.getState().nodes).toHaveLength(2)
    expect(useDrawingStore.getState().nodes[0]).toEqual(successful)
    expect(useDrawingStore.getState().nodes[1]).toMatchObject({
      id: failed.id,
      position: failed.position,
      data: { status: 'pending', prompt: 'Two cups', error: undefined },
    })
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.post).mock.calls[1][1]).toMatchObject({
      model: 'gpt-image-1',
      prompt: 'Two cups',
      n: 1,
    })
    await waitFor(() => expect(decoders).toHaveLength(3))
    await act(async () => decoders[2].dispatchEvent(new Event('load')))
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(useDrawingStore.getState().nodes[1].data.status).toBe('complete')
    expect(useDrawingStore.getState().settings.prompt).toBe(
      'An unrelated landscape'
    )
    hook.unmount()
    client.clear()
  })

  it('keeps successful images when another image in the same request cannot be decoded', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'Two cups',
          n: 2,
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(decoders).toHaveLength(2))
    await act(async () => {
      decoders[0].dispatchEvent(new Event('load'))
      decoders[1].dispatchEvent(new Event('error'))
    })
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(
      useDrawingStore.getState().nodes.map((node) => node.data.status)
    ).toEqual(['complete', 'error'])
    expect(useDrawingStore.getState().nodes[0].data.asset?.width).toBe(512)
    hook.unmount()
    client.clear()
  })

  it('marks pending cards stopped when cancelling while returned images are still decoding', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'Two cups',
          n: 2,
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(decoders).toHaveLength(2))
    await act(async () => {
      hook.result.current.cancel()
      for (const decoder of decoders) decoder.dispatchEvent(new Event('load'))
    })
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(
      useDrawingStore.getState().nodes.map((node) => node.data.status)
    ).toEqual(['cancelled', 'cancelled'])
    hook.unmount()
    client.clear()
  })
  it('reattaches to an accepted image task after the canvas is reopened', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    const poll = vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        task_id: 'task_reopened',
        status: 'completed',
        data: [{ b64_json: 'YWJj' }],
      },
    })
    act(() =>
      useDrawingStore.getState().addNodes([
        {
          ...generationReference('reopened', { x: 0, y: 0 }),
          data: {
            ...generationReference('reopened', { x: 0, y: 0 }).data,
            asset: undefined,
            status: 'pending',
            jobId: undefined,
            taskId: 'task_reopened',
          },
        },
      ])
    )

    const decoderIndex = decoders.length
    act(() => resumeImageGenerationJobs((key: string) => key))

    expect(hook.result.current.pendingCount).toBe(1)
    await waitFor(() => expect(decoders.length).toBeGreaterThan(decoderIndex))
    await act(async () =>
      decoders[decoderIndex].dispatchEvent(new Event('load'))
    )
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))

    expect(poll).toHaveBeenCalledWith(
      '/pg/images/generations/task_reopened',
      expect.anything()
    )
    expect(api.post).not.toHaveBeenCalled()
    const node = useDrawingStore.getState().nodes[0]
    expect(node.data.status).toBe('complete')
    expect(node.data.taskId).toBeUndefined()
    hook.unmount()
    client.clear()
  })
  // A canvas does not persist progress, so a node reopened days later has none.
  // Falling back to when the node was first created counted the whole time the
  // canvas sat closed as generation time.
  it('times a reattached task from the reattach, not from when the node was made', async () => {
    const client = new QueryClient()
    renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { task_id: 'task_stale', status: 'in_progress' },
    })
    const madeLongAgo = Date.now() - 86_400_000
    act(() =>
      useDrawingStore.getState().addNodes([
        {
          ...generationReference('stale', { x: 0, y: 0 }),
          data: {
            ...generationReference('stale', { x: 0, y: 0 }).data,
            asset: undefined,
            status: 'pending',
            jobId: undefined,
            taskId: 'task_stale',
            createdAt: madeLongAgo,
            progress: undefined,
          },
        },
      ])
    )

    act(() => resumeImageGenerationJobs((key: string) => key))

    const startedAt =
      useDrawingStore.getState().nodes[0].data.progress?.startedAt
    expect(startedAt).toBeGreaterThan(madeLongAgo)
    expect(Date.now() - (startedAt ?? 0)).toBeLessThan(5000)
  })

  it('keeps a cancelled generation collectable and returns the paid image', async () => {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    vi.mocked(api.post).mockImplementation(async () => ({
      headers: { 'content-type': 'application/json' },
      data: new Response(
        JSON.stringify({ task_id: 'task_paid', status: 'queued' })
      ).body,
    }))
    const poll = vi.spyOn(api, 'get').mockResolvedValue({
      data: { task_id: 'task_paid', status: 'in_progress' },
    })

    act(() =>
      hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A paid cup',
          n: 1,
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() =>
      expect(useDrawingStore.getState().nodes[0].data.taskId).toBe('task_paid')
    )

    act(() => hook.result.current.cancel())
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))

    const cancelled = useDrawingStore.getState().nodes[0]
    expect(cancelled.data.status).toBe('cancelled')
    expect(cancelled.data.taskId).toBe('task_paid')

    poll.mockResolvedValue({
      data: {
        task_id: 'task_paid',
        status: 'completed',
        data: [{ b64_json: 'YWJj' }],
      },
    })
    const decoderIndex = decoders.length
    act(() => {
      expect(hook.result.current.collect(cancelled.id)).toBe(true)
    })
    await waitFor(() => expect(decoders.length).toBeGreaterThan(decoderIndex))
    await act(async () =>
      decoders[decoderIndex].dispatchEvent(new Event('load'))
    )
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))

    const collected = useDrawingStore.getState().nodes[0]
    expect(collected.data.status).toBe('complete')
    expect(collected.data.taskId).toBeUndefined()
    // Collecting reuses the paid task instead of generating again.
    expect(api.post).toHaveBeenCalledTimes(1)
    hook.unmount()
    client.clear()
  })
})

// A task keeps base64 images only by storing them in the gallery; the gateway
// drops what the gallery cannot take. Those batches are answered on the
// connection instead, so the paid images still reach the canvas.
describe('Image generation while the gallery is short of room', () => {
  function renderGeneration() {
    const client = new QueryClient()
    const hook = renderHook(useImageGeneration, {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    return {
      hook,
      done: () => {
        hook.unmount()
        client.clear()
      },
    }
  }

  it.each([
    [
      'cannot keep them',
      () => {
        galleryUsage = {
          ...usage,
          can_save: false,
          reason: 'Gallery storage limit reached.',
        }
      },
    ],
    [
      'cannot be reached',
      () => {
        galleryUsage = new AxiosError('Network Error', 'ERR_NETWORK')
      },
    ],
  ])(
    'answers base64 images on the connection when the gallery %s',
    async (_, arrange) => {
      arrange()
      const generation = renderGeneration()
      const decoderIndex = decoders.length

      act(() =>
        generation.hook.result.current.generate(
          {
            ...DEFAULT_IMAGE_SETTINGS,
            model: 'gpt-image-1',
            prompt: 'A cup',
            n: 2,
          },
          { x: 0, y: 0 }
        )
      )
      await waitFor(() => expect(decoders.length).toBe(decoderIndex + 2))
      await act(async () => {
        for (const decoder of decoders.slice(decoderIndex)) {
          decoder.dispatchEvent(new Event('load'))
        }
      })
      await waitFor(() =>
        expect(generation.hook.result.current.pendingCount).toBe(0)
      )

      expect(api.post).toHaveBeenCalledWith(
        '/pg/images/generations',
        expect.anything(),
        expect.not.objectContaining({ params: expect.anything() })
      )
      expect(
        useDrawingStore.getState().nodes.map((node) => node.data.status)
      ).toEqual(['complete', 'complete'])
      generation.done()
    }
  )

  it('submits base64 images as a task while the gallery can keep the batch', async () => {
    const generation = renderGeneration()

    act(() =>
      generation.hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-1',
          prompt: 'A cup',
          n: 2,
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(api.post).toHaveBeenCalled())

    expect(galleryRequests).toEqual([
      expect.objectContaining({ required_images: 2 }),
    ])
    expect(api.post).toHaveBeenCalledWith(
      '/pg/images/generations',
      expect.anything(),
      expect.objectContaining({ params: { async: 'true' } })
    )
    act(() => generation.hook.result.current.cancel())
    generation.done()
  })

  it('submits linked images as a task even when the gallery is full', async () => {
    galleryUsage = {
      ...usage,
      can_save: false,
      reason: 'Gallery storage limit reached.',
    }
    const generation = renderGeneration()

    act(() =>
      generation.hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'dall-e-3',
          quality: 'standard',
          prompt: 'A cup',
          responseFormat: 'url',
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(api.post).toHaveBeenCalled())

    expect(api.post).toHaveBeenCalledWith(
      '/pg/images/generations',
      expect.anything(),
      expect.objectContaining({ params: { async: 'true' } })
    )
    expect(galleryRequests).toEqual([])
    act(() => generation.hook.result.current.cancel())
    generation.done()
  })

  it('does not submit a generation when the session changes while the gallery is asked', async () => {
    const answer = api.defaults.adapter as (
      config: InternalAxiosRequestConfig
    ) => Promise<AxiosResponse>
    api.defaults.adapter = async (config) => {
      // Signing in elsewhere lands between the question and the answer.
      login(813, 'replacement')
      return answer(config)
    }
    const generation = renderGeneration()

    act(() =>
      generation.hook.result.current.generate(
        { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A cup' },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(galleryRequests).toHaveLength(1))
    // Everything after the gallery answer runs on promises, which one timer
    // turn drains.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(api.post).not.toHaveBeenCalled()
    generation.done()
  })

  it('asks the gallery for room that fits a 4K image before submitting it as a task', async () => {
    const generation = renderGeneration()

    act(() =>
      generation.hook.result.current.generate(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          model: 'gpt-image-2',
          prompt: 'A cup',
          size: '3840x2160',
          n: 1,
        },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(galleryRequests).toHaveLength(1))
    act(() => generation.hook.result.current.cancel())
    generation.done()

    const room = galleryRequests[0] as {
      required_images: number
      required_bytes: number
    }
    expect(room.required_images).toBe(1)
    // An uncompressed render with alpha is the most its PNG can take.
    expect(room.required_bytes).toBeGreaterThanOrEqual(3840 * 2160 * 4)
  })

  it('asks the gallery for room for images that running tasks will store', async () => {
    vi.mocked(api.post).mockImplementation(async () => ({
      headers: { 'content-type': 'application/json' },
      data: new Response(
        JSON.stringify({ task_id: 'task_running', status: 'queued' })
      ).body,
    }))
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { task_id: 'task_running', status: 'in_progress' },
    })
    const generation = renderGeneration()
    const settings = {
      ...DEFAULT_IMAGE_SETTINGS,
      model: 'gpt-image-1',
      prompt: 'A cup',
    }

    act(() =>
      generation.hook.result.current.generate(
        { ...settings, n: 2 },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() =>
      expect(useDrawingStore.getState().nodes[0].data.taskId).toBe(
        'task_running'
      )
    )
    act(() =>
      generation.hook.result.current.generate(
        { ...settings, n: 1 },
        { x: 400, y: 0 }
      )
    )
    await waitFor(() => expect(galleryRequests).toHaveLength(2))

    expect(galleryRequests[1]).toEqual(
      expect.objectContaining({ required_images: 3 })
    )
    act(() => generation.hook.result.current.cancel())
    generation.done()
  })
})

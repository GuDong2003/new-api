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
import type { GenericAbortSignal } from 'axios'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useDrawingStore } from '@/stores/drawing-store'

import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import {
  cancelImageGenerationJobs,
  useImageGeneration,
} from '../use-image-generation'

const decoders: EventTarget[] = []
beforeEach(() => {
  decoders.length = 0
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
afterEach(() => vi.unstubAllGlobals())

describe('Image generation jobs', () => {
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
    const decoderIndex = decoders.length
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

    cancelImageGenerationJobs(813, null)
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
})

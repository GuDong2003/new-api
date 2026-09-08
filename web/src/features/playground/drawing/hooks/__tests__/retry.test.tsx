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
import {
  act,
  renderHook,
  waitFor,
  type RenderHookResult,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useDrawingStore } from '@/stores/drawing-store'

import {
  parseDrawingDocument,
  serializeDrawingDocument,
} from '../../lib/canvas-document'
import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { DrawingNode, ImageAsset } from '../../types'
import { useImageGeneration } from '../use-image-generation'

const reference = {
  id: 'reference-a',
  type: 'image',
  position: { x: 0, y: 0 },
  data: {
    prompt: 'A cup',
    settings: {
      ...DEFAULT_IMAGE_SETTINGS,
      model: 'gpt-image-1',
      prompt: 'A cup',
    },
    createdAt: 1,
    status: 'complete',
    asset: {
      id: 'reference-asset',
      name: 'cup.png',
      src: 'data:image/png;base64,YWJj',
      mimeType: 'image/png',
      width: 512,
      height: 512,
    },
  },
} satisfies DrawingNode
const mask: ImageAsset = {
  ...reference.data.asset,
  id: 'original-mask',
  name: 'mask.png',
  src: 'data:image/png;base64,bWFzaw==',
}
const failed: DrawingNode = {
  ...reference,
  id: 'failed-image',
  position: { x: 320, y: 40 },
  data: {
    ...reference.data,
    asset: undefined,
    status: 'error',
    error: 'Image generation failed.',
  },
}

const decoders: EventTarget[] = []
let client: QueryClient
let hook: RenderHookResult<ReturnType<typeof useImageGeneration>, unknown>

beforeEach(() => {
  decoders.length = 0
  useDrawingStore.getState().initialize(816)
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
    }
  )
  vi.spyOn(api, 'post').mockResolvedValue({
    headers: { 'content-type': 'application/json' },
    data: new Response(JSON.stringify({ data: [{ b64_json: 'ZGVm' }] })).body,
  })
  client = new QueryClient()
  hook = renderHook(useImageGeneration, {
    wrapper: (props: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    ),
  })
})

afterEach(() => {
  hook.unmount()
  client.clear()
  vi.unstubAllGlobals()
})

describe('Retrying saved image generations', () => {
  it('restores text-to-image settings when undoing a reference connection after a retry fails', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Provider is unavailable'))
    act(() => {
      const state = useDrawingStore.getState()
      state.addNodes([reference, failed])
      state.connectReference({ source: reference.id, target: failed.id })
      hook.result.current.retry(failed.id)
    })
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    act(() => useDrawingStore.getState().undo())
    expect(useDrawingStore.getState().nodes[1].data.settings.mode).toBe(
      'generate'
    )
    act(() => expect(hook.result.current.retry(failed.id)).toBe(true))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.post).mock.calls[1][0]).toBe('/pg/images/generations')
  })

  it('sends a manually connected reference only when the failed image is retried', async () => {
    act(() => {
      const state = useDrawingStore.getState()
      state.addNodes([reference, failed])
      expect(
        state.connectReference({ source: reference.id, target: failed.id })
      ).toBe(true)
    })
    expect(api.post).not.toHaveBeenCalled()
    act(() => hook.result.current.retry(failed.id))
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce())
    const [endpoint, body] = vi.mocked(api.post).mock.calls[0]
    expect(endpoint).toBe('/pg/images/edits')
    expect(body).toBeInstanceOf(FormData)
    expect(await ((body as FormData).get('image') as File).text()).toBe('abc')
    expect((body as FormData).get('n')).toBe('1')
    await waitFor(() => expect(decoders).toHaveLength(1))
    await act(async () => decoders[0].dispatchEvent(new Event('load')))
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(useDrawingStore.getState().nodes[1]).toMatchObject({
      id: failed.id,
      position: failed.position,
      data: { status: 'complete', referenceIds: [reference.id] },
    })
  })

  it('uses the original references and mask after reopening the canvas with different sidebar settings', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Provider is unavailable'))
    act(() => {
      useDrawingStore.getState().addNodes([reference])
      useDrawingStore.getState().setReferences([reference.id])
      hook.result.current.generate(
        { ...reference.data.settings, mode: 'edit' },
        failed.position,
        mask
      )
    })
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(api.post).toHaveBeenCalledTimes(1)
    const originalResult = useDrawingStore.getState().nodes[1]
    expect(originalResult.data.status).toBe('error')
    const edges = useDrawingStore.getState().edges
    const alternate: DrawingNode = {
      ...reference,
      id: 'reference-b',
      data: {
        ...reference.data,
        asset: {
          ...reference.data.asset,
          id: 'alternate-asset',
          src: 'data:image/png;base64,b3RoZXI=',
        },
      },
    }
    act(() => {
      const state = useDrawingStore.getState()
      state.addNodes([alternate])
      state.setReferences([alternate.id])
      state.setMask({
        referenceId: alternate.id,
        asset: {
          ...mask,
          id: 'alternate-mask',
          src: 'data:image/png;base64,b3RoZXI=',
        },
      })
      state.updateSettings({
        mode: 'edit',
        model: 'dall-e-2',
        prompt: 'Another scene',
      })
      const saved = serializeDrawingDocument(useDrawingStore.getState())
      state.initialize(816, parseDrawingDocument(saved))
      hook.result.current.retry(originalResult.id)
    })

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    const [endpoint, body] = vi.mocked(api.post).mock.calls[1]
    expect(endpoint).toBe('/pg/images/edits')
    expect(body).toBeInstanceOf(FormData)
    const request = body as FormData
    expect(request.get('model')).toBe('gpt-image-1')
    expect(request.get('prompt')).toBe('A cup')
    expect(request.get('n')).toBe('1')
    expect(await (request.get('image') as File).text()).toBe('abc')
    expect(await (request.get('mask') as File).text()).toBe('mask')
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(useDrawingStore.getState().edges).toEqual(edges)
    expect(useDrawingStore.getState().nodes[1].position).toEqual(
      failed.position
    )
    expect(useDrawingStore.getState().settings.prompt).toBe('Another scene')
    expect(useDrawingStore.getState().referenceIds).toEqual([alternate.id])
    expect(useDrawingStore.getState().mask?.asset.id).toBe('alternate-mask')
  })

  it('does not submit an edit when one of its original reference images was removed', () => {
    act(() => {
      const state = useDrawingStore.getState()
      state.addNodes([
        reference,
        {
          ...failed,
          data: {
            ...failed.data,
            settings: { ...failed.data.settings, mode: 'edit' },
            referenceIds: [reference.id, 'removed-reference'],
          },
        },
      ])
      state.setReferences([reference.id])
      expect(hook.result.current.retry(failed.id)).toBe(false)
    })
    expect(api.post).not.toHaveBeenCalled()
    expect(hook.result.current.pendingCount).toBe(0)
    expect(useDrawingStore.getState().nodes[1].data.status).toBe('error')
  })

  it('stops a retried image through the existing cancellation control', async () => {
    act(() => {
      useDrawingStore.getState().addNodes([failed])
      hook.result.current.retry(failed.id)
    })
    await waitFor(() => expect(decoders).toHaveLength(1))
    act(() => hook.result.current.cancel())
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('cancelled')
    expect(useDrawingStore.getState().nodes[0].data.error).toBeUndefined()
  })

  it('keeps a newer retry pending when an older cancelled request settles after a canvas import', async () => {
    let rejectOldRequest: (reason: Error) => void
    const oldRequest = new Promise<never>((_resolve, reject) => {
      rejectOldRequest = reject
    })
    vi.mocked(api.post).mockReturnValueOnce(oldRequest)
    act(() => useDrawingStore.getState().addNodes([failed]))
    const saved = serializeDrawingDocument(useDrawingStore.getState())
    act(() => hook.result.current.retry(failed.id))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    act(() => {
      hook.result.current.cancel()
      useDrawingStore.getState().replaceDocument(parseDrawingDocument(saved))
      hook.result.current.retry(failed.id)
    })
    await waitFor(() => expect(decoders).toHaveLength(1))

    await act(async () => rejectOldRequest(new Error('Old request cancelled')))
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(1))

    expect(useDrawingStore.getState().nodes[0].data.status).toBe('pending')
    await act(async () => decoders[0].dispatchEvent(new Event('load')))
    await waitFor(() => expect(hook.result.current.pendingCount).toBe(0))
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  })
})

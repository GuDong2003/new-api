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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReactFlowProvider, useStoreApi, type NodeProps } from '@xyflow/react'
import { AxiosError } from 'axios'
import { useEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ImageCanvasNode } from '@/features/playground/drawing/components/ImageCanvasNode'
import { CANVAS_NODE_WIDTH } from '@/features/playground/drawing/lib/canvas-geometry'
import { DEFAULT_IMAGE_SETTINGS } from '@/features/playground/drawing/lib/image-settings'
import type { DrawingNode } from '@/features/playground/drawing/types'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { login, response } from './fixtures'

const adapter = api.defaults.adapter
let client: QueryClient
let originalReads: number

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:sharp-original')
      static revokeObjectURL = vi.fn()
    }
  )
  login()
  useDrawingStore.getState().initialize(813)
  originalReads = 0
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/file')) {
      originalReads++
      return {
        ...response(config, {}),
        data: new Blob(['original'], { type: 'image/png' }),
      }
    }
    throw new AxiosError(
      'not found',
      '',
      config,
      {},
      { ...response(config, {}), status: 404 }
    )
  }
})

afterEach(() => {
  useAuthStore.getState().auth.reset()
  client.clear()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
})

// A canvas opens from previews so that it opens at all quickly, which leaves
// the pictures softer than their originals once a node is drawn large.
const previewAsset = {
  id: 'asset-1',
  name: 'forest.png',
  src: 'blob:canvas-preview',
  mimeType: 'image/png',
  width: 2048,
  height: 2048,
  previewOnly: true,
}
const previewNode: NodeProps<DrawingNode> = {
  id: 'preview-node',
  type: 'image',
  draggable: true,
  dragging: false,
  selectable: true,
  selected: false,
  deletable: true,
  isConnectable: false,
  zIndex: 0,
  width: CANVAS_NODE_WIDTH,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  data: {
    prompt: 'A quiet forest',
    settings: DEFAULT_IMAGE_SETTINGS,
    createdAt: 1,
    status: 'complete',
    asset: previewAsset,
  },
}

function Zoom(props: { to: number }) {
  const store = useStoreApi()
  useEffect(() => {
    store.setState({ transform: [0, 0, props.to] })
  }, [store, props.to])
  return null
}

const canvasAt = (zoom: number, node = previewNode) => (
  <QueryClientProvider client={client}>
    <ReactFlowProvider>
      <Zoom to={zoom} />
      <ImageCanvasNode {...node} />
    </ReactFlowProvider>
  </QueryClientProvider>
)

const picture = () => screen.getByRole('img', { name: 'A quiet forest' })

it('shows a preview without fetching the original while the node stays small', async () => {
  render(canvasAt(1))

  await waitFor(() =>
    expect(picture()).toHaveAttribute('src', 'blob:canvas-preview')
  )
  expect(originalReads).toBe(0)
})

it('fetches the original once a node is drawn larger than its preview', async () => {
  render(canvasAt(4))

  await waitFor(() =>
    expect(picture()).toHaveAttribute('src', 'blob:sharp-original')
  )
  expect(originalReads).toBe(1)
})

// Saving a picture is the one place a preview is never acceptable, however
// small the node it was saved from.
it('saves the original rather than the preview a node is showing', async () => {
  const saved = vi.fn()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => {
        saved(blob.size)
        return 'blob:download'
      })
      static revokeObjectURL = vi.fn()
    }
  )
  render(canvasAt(1))

  await userEvent.click(screen.getByRole('button', { name: 'Download' }))

  await waitFor(() => expect(originalReads).toBe(1))
  expect(saved).toHaveBeenCalledWith('original'.length)
})

it('keeps a picture the canvas already holds in full at its own source', async () => {
  render(
    canvasAt(4, {
      ...previewNode,
      data: {
        ...previewNode.data,
        asset: { ...previewAsset, previewOnly: undefined },
      },
    })
  )

  await waitFor(() =>
    expect(picture()).toHaveAttribute('src', 'blob:canvas-preview')
  )
  expect(originalReads).toBe(0)
})

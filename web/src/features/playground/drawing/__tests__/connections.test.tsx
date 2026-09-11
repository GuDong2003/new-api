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
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Position, ReactFlowProvider } from '@xyflow/react'
import { AxiosError } from 'axios'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { login, response } from '@/features/gallery/__tests__/fixtures'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { DrawingWorkspace } from '../components/DrawingWorkspace'
import { DrawingPersistence } from '../hooks/use-drawing-persistence'
import { DEFAULT_IMAGE_SETTINGS } from '../lib/image-settings'
import type { DrawingNode } from '../types'

let client: QueryClient
const adapter = api.defaults.adapter
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  api.defaults.adapter = async (config) => {
    // Newly created local projects have no remote revision yet.
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
  cleanup()
  useAuthStore.getState().auth.reset()
  client?.clear()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
})

async function renderReferenceCanvas(userId: number) {
  login(userId)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(
    ['drawing-groups', userId],
    [{ value: 'default', label: 'default', ratio: 1 }]
  )
  client.setQueryData(
    ['drawing-models', userId, 'default'],
    [{ value: 'gpt-image-1', label: 'gpt-image-1' }]
  )
  const route = createRootRoute({
    component: () => (
      <>
        <DrawingPersistence userId={userId} />
        <ReactFlowProvider initialWidth={1000} initialHeight={600}>
          <DrawingWorkspace userId={userId} />
        </ReactFlowProvider>
      </>
    ),
  })
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await waitFor(() =>
    expect(screen.getByText('Room for every idea')).toBeTruthy()
  )
  const nodes: DrawingNode[] = ['A', 'B'].map((id, index) => ({
    id,
    type: 'image',
    position: { x: index * 300, y: 0 },
    width: 280,
    height: 330,
    handles: [
      {
        type: 'source',
        position: Position.Right,
        x: 272,
        y: 157,
        width: 16,
        height: 16,
      },
      {
        type: 'target',
        position: Position.Left,
        x: -8,
        y: 157,
        width: 16,
        height: 16,
      },
    ],
    data: {
      prompt: id,
      createdAt: 1,
      status: 'complete',
      settings: { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1' },
      asset: {
        id,
        name: `${id}.png`,
        src: 'data:image/png;base64,YWJj',
        mimeType: 'image/png',
        width: 64,
        height: 64,
      },
    },
  }))
  act(() => useDrawingStore.getState().addNodes(nodes))
  const outputs = await screen.findAllByRole('button', {
    name: 'Reference output',
  })
  const inputs = screen.getAllByRole('button', { name: 'Reference input' })
  // Happy DOM has no layout; match the explicit coordinates used for the ports.
  vi.spyOn(document, 'elementFromPoint').mockImplementation((x) => {
    if (x === 280) return outputs[0]
    if (x === 300) return inputs[1]
    return null
  })
  return { output: outputs[0], input: inputs[1], user: userEvent.setup() }
}

describe('Cancelling reference connections', () => {
  it('deletes a selected connection through a button and restores its reference on undo', async () => {
    const { output, input, user } = await renderReferenceCanvas(837)
    await user.click(output)
    await user.click(input)
    await user.click(screen.getByRole('group', { name: 'Edge from A to B' }))

    await user.click(
      screen.getByRole('button', { name: 'Delete selected connections' })
    )
    expect(useDrawingStore.getState().edges).toEqual([])
    expect(useDrawingStore.getState().nodes).toHaveLength(2)
    expect(useDrawingStore.getState().nodes[1].data.referenceIds).toEqual([])
    expect(
      screen.queryByRole('button', { name: 'Delete selected connections' })
    ).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(useDrawingStore.getState().edges).toMatchObject([
      { source: 'A', target: 'B' },
    ])
    expect(useDrawingStore.getState().nodes[1].data.referenceIds).toEqual(['A'])
  })

  it('disables removing a selected connection while its target is generating', async () => {
    const { output, input, user } = await renderReferenceCanvas(838)
    await user.click(output)
    await user.click(input)
    act(() =>
      useDrawingStore.getState().updateNodeData('B', { status: 'pending' })
    )
    await user.click(screen.getByRole('group', { name: 'Edge from A to B' }))

    const remove = screen.getByRole('button', {
      name: 'Delete selected connections',
    })
    expect(remove.hasAttribute('disabled')).toBe(true)
    expect(remove.title).toBe(
      'Reference images cannot be changed while generation is running.'
    )
    await user.click(remove)
    expect(useDrawingStore.getState().nodes[1].data.referenceIds).toEqual(['A'])
  })

  it.each(['Escape', 'blank canvas', 'pan tool', 'window blur'] as const)(
    'cancels a clicked endpoint on %s and allows a fresh connection afterward',
    async (method) => {
      const { output, input, user } = await renderReferenceCanvas(
        830 +
          ['Escape', 'blank canvas', 'pan tool', 'window blur'].indexOf(method)
      )
      output.focus()
      await user.keyboard('{Enter}')
      if (method === 'Escape') await user.keyboard('{Escape}')
      if (method === 'blank canvas') {
        await user.click(screen.getByLabelText('Image canvas'))
      }
      if (method === 'pan tool') {
        await user.click(screen.getByRole('button', { name: 'Pan canvas' }))
        await user.click(screen.getByRole('button', { name: 'Select images' }))
      }
      if (method === 'window blur') fireEvent(window, new Event('blur'))

      await user.click(input)
      expect(useDrawingStore.getState().edges).toEqual([])
      expect(
        useDrawingStore.getState().nodes[1].data.referenceIds
      ).toBeUndefined()

      await user.click(output)
      expect(useDrawingStore.getState().edges).toMatchObject([
        { source: 'A', target: 'B' },
      ])
      expect(useDrawingStore.getState().nodes[1].data.referenceIds).toEqual([
        'A',
      ])
    }
  )

  it('does not commit a hovered target when Escape is pressed before releasing a drag', async () => {
    const { output, input } = await renderReferenceCanvas(834)
    fireEvent.mouseDown(output, {
      clientX: 280,
      clientY: 165,
      button: 0,
    })
    fireEvent.mouseMove(input, {
      clientX: 300,
      clientY: 165,
      buttons: 1,
    })
    fireEvent.keyDown(output, { key: 'Escape' })
    fireEvent.mouseUp(input, {
      clientX: 300,
      clientY: 165,
      button: 0,
    })
    expect(useDrawingStore.getState().edges).toEqual([])
  })

  it('creates a reference when a drag reaches a valid target without cancellation', async () => {
    const { output, input } = await renderReferenceCanvas(835)
    fireEvent.mouseDown(output, {
      clientX: 280,
      clientY: 165,
      button: 0,
    })
    fireEvent.mouseMove(input, {
      clientX: 300,
      clientY: 165,
      buttons: 1,
    })
    fireEvent.mouseUp(input, {
      clientX: 300,
      clientY: 165,
      button: 0,
    })
    expect(useDrawingStore.getState().edges).toMatchObject([
      { source: 'A', target: 'B' },
    ])
  })

  it('does not start another connection from the click emitted after dragging back to the starting handle', async () => {
    const { output, input, user } = await renderReferenceCanvas(836)
    fireEvent.mouseDown(output, {
      clientX: 280,
      clientY: 165,
      button: 0,
    })
    fireEvent.mouseMove(input, {
      clientX: 300,
      clientY: 165,
      buttons: 1,
    })
    fireEvent.mouseMove(output, {
      clientX: 280,
      clientY: 165,
      buttons: 1,
    })
    fireEvent.mouseUp(output, {
      clientX: 280,
      clientY: 165,
      button: 0,
    })
    fireEvent.click(output, { clientX: 280, clientY: 165, detail: 1 })
    await user.click(input)
    expect(useDrawingStore.getState().edges).toEqual([])
  })
})

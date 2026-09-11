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
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { AxiosError } from 'axios'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

import { login, response } from '@/features/gallery/__tests__/fixtures'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { DrawingWorkspace } from '../components/DrawingWorkspace'
import { DrawingPersistence } from '../hooks/use-drawing-persistence'
import { DEFAULT_IMAGE_SETTINGS } from '../lib/image-settings'

let client: QueryClient
const adapter = api.defaults.adapter
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  api.defaults.adapter = async (config) => {
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

function renderWorkspace(userId: number) {
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
        <ReactFlowProvider>
          <DrawingWorkspace userId={userId} />
        </ReactFlowProvider>
      </>
    ),
  })
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { client, view }
}

describe('Drawing workspace', () => {
  it('shows the empty canvas and settings when no reference image or mask exists', async () => {
    const { client, view } = renderWorkspace(801)
    await waitFor(() =>
      expect(screen.getByText('Room for every idea')).toBeTruthy()
    )
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: 'Generate images' })
        .hasAttribute('disabled')
    ).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.unmount()
    client.clear()
  })

  it('draws the minimap SVG at the size of its compact container after adding an image', async () => {
    const { client, view } = renderWorkspace(821)
    await waitFor(() =>
      expect(screen.getByText('Room for every idea')).toBeTruthy()
    )
    act(() =>
      useDrawingStore.getState().addNodes([
        {
          id: 'overview-image',
          type: 'image',
          position: { x: 0, y: 0 },
          width: 280,
          height: 330,
          data: {
            prompt: 'Overview image',
            settings: DEFAULT_IMAGE_SETTINGS,
            status: 'error',
            createdAt: 1,
          },
        },
      ])
    )
    const overview = screen.getByTestId('rf__minimap').querySelector('svg')
    expect(overview?.getAttribute('width')).toBe('144')
    expect(overview?.getAttribute('height')).toBe('96')
    expect(overview?.getAttribute('viewBox')).not.toContain('NaN')
    view.unmount()
    client.clear()
  })
})

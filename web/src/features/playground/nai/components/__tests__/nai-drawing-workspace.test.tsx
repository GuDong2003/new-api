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
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { AxiosError } from 'axios'
import { IDBFactory } from 'fake-indexeddb'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { login, response } from '@/features/gallery/__tests__/fixtures'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { NaiDrawingPersistence } from '../../hooks/use-nai-drawing-persistence'
import { NaiDrawing } from '../NaiDrawingWorkspace'

vi.mock('@xyflow/react', () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  )

  return {
    Background: Container,
    BackgroundVariant: { Dots: 'dots' },
    MiniMap: Container,
    Panel: Container,
    ReactFlow: Container,
    ReactFlowProvider: Container,
    useReactFlow: () => ({
      fitView: vi.fn(),
      screenToFlowPosition: vi.fn(),
    }),
  }
})

vi.mock('@/context/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

vi.mock('@/hooks/use-media-query', () => ({
  useMediaQuery: () => false,
}))

vi.mock('../NaiImageCanvasNode', () => ({
  NaiImageCanvasNode: () => null,
}))

vi.mock('../NaiImagePreview', () => ({
  NaiImagePreview: () => null,
}))

vi.mock('../NaiSettings', () => ({
  NaiSettings: () => <div data-testid='nai-settings' />,
}))

describe('NAI drawing workspace', () => {
  let client: QueryClient
  const adapter = api.defaults.adapter
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    login(1, 'nai-workspace-session', 1)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
    client.clear()
    api.defaults.adapter = adapter
    vi.unstubAllGlobals()
  })

  it('shows guidance when the NAI canvas has no image nodes', async () => {
    const route = createRootRoute({
      component: () => (
        <>
          <NaiDrawingPersistence userId={1} />
          <NaiDrawing />
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

    expect(
      await screen.findByText('Start creating NAI images')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Generate images with NovelAI, then arrange and refine them on your canvas.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Scroll to zoom · Space + drag to pan · Shift + drag to select'
      )
    ).toBeInTheDocument()
  })
})

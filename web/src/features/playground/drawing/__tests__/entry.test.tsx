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
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError } from 'axios'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { login, response } from '@/features/gallery/__tests__/fixtures'
import { stopCanvasEditors } from '@/features/gallery/lib/canvas-editor'
import { createCanvasProject } from '@/features/gallery/lib/canvas-projects'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Drawing } from '..'

const identity = { userId: 861, sessionId: 'gallery-session' }
const adapter = api.defaults.adapter
let client: QueryClient
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
  api.defaults.adapter = async (config) => {
    throw new AxiosError(
      'not found',
      '',
      config,
      {},
      { ...response(config, {}), status: 404 }
    )
  }
  login(identity.userId)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
})
afterEach(() => {
  cleanup()
  stopCanvasEditors(identity)
  useAuthStore.getState().auth.reset()
  client.clear()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
})

// A NAI canvas record this build can no longer read, as damaged browser
// storage leaves it.
async function damagedNaiCanvas(): Promise<string> {
  const canvas = await createCanvasProject(identity, 'drawing', 'NAI 画布')
  const damaged = {
    ...canvas,
    kind: 'nai',
    document: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: {},
      nodes: [{ id: 'sketch', type: 'unknown-node', data: { prompt: '狐狸' } }],
    },
  }
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('new-api-gallery-canvases', 1)
    opening.addEventListener('success', () => resolve(opening.result))
    opening.addEventListener('error', () => reject(opening.error))
  })
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('canvases', 'readwrite')
    tx.objectStore('canvases').put(damaged, [identity.userId, canvas.id])
    tx.addEventListener('complete', () => resolve())
    tx.addEventListener('error', () => reject(tx.error))
  })
  database.close()
  return canvas.id
}

it('offers to export a NAI canvas the drawing page cannot convert', async () => {
  const canvasId = await damagedNaiCanvas()
  const downloads: Blob[] = []
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => {
        downloads.push(blob)
        return 'blob:export'
      })
      static revokeObjectURL = vi.fn()
    }
  )
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Drawing canvasId={canvasId} />,
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )

  expect(
    await screen.findByText(
      'This NAI canvas could not be converted. Export it to keep a copy.'
    )
  ).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Export original' }))

  await waitFor(() => expect(downloads).toHaveLength(1))
  expect(JSON.parse(await downloads[0].text()).nodes).toEqual([
    { id: 'sketch', type: 'unknown-node', data: { prompt: '狐狸' } },
  ])
})

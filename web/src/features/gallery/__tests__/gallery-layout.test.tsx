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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { CanvasCard } from '../components/canvas-card'
import { Gallery } from '../index'
import { galleryImage, login, response, usage } from './fixtures'

const adapter = api.defaults.adapter
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}))
let client: QueryClient
beforeEach(() => {
  login()
  vi.stubGlobal('indexedDB', new IDBFactory())
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:private-gallery')
      static revokeObjectURL = vi.fn()
    }
  )
})
afterEach(() => {
  client.clear()
  useAuthStore.getState().auth.reset()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
})

function renderGallery(items: unknown[]) {
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/usage')) return response(config, usage)
    if (config.url?.endsWith('/file')) {
      return { ...response(config, {}), data: new Blob(['private']) }
    }
    return response(config, {
      items,
      total: items.length,
      page: 1,
      page_size: 24,
    })
  }
  return render(
    <QueryClientProvider client={client}>
      <Gallery />
    </QueryClientProvider>
  )
}

it('drops the page title and description the canvas tabs already carry', async () => {
  renderGallery([galleryImage])

  expect(await screen.findByText('2 / 100 images')).toBeVisible()
  expect(
    screen.queryByRole('heading', { name: 'My Gallery' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByText(/Private final images from Drawing and NAI Canvas/)
  ).not.toBeInTheDocument()
})

it('reveals the storage rules only after the usage hint is opened', async () => {
  renderGallery([galleryImage])

  expect(await screen.findByText('2 / 100 images')).toBeVisible()
  expect(screen.queryByText(/New images expire after/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Learn more' }))

  expect(
    await screen.findByText(/New images expire after 7 days/)
  ).toBeVisible()
})

it('lays out image cards on a dense auto-fill track', async () => {
  renderGallery([galleryImage, { ...galleryImage, id: 'image-2' }])

  const cards = await screen.findAllByRole('article')

  expect(cards).toHaveLength(2)
  expect(cards[0].parentElement).toHaveClass(
    'grid-cols-2',
    'sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]'
  )
})

it('renders the canvas cover at the compact card height', () => {
  render(
    <CanvasCard
      identity={{ userId: 813, sessionId: 'gallery-session' }}
      project={{
        id: 'canvas-1',
        kind: 'drawing',
        name: '本地画布',
        revision: 1,
        state: 'ready',
        updatedAt: 1700000000,
        expiresAt: 0,
        coverAssetIds: [],
      }}
      onOpen={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />
  )

  expect(
    screen.getByRole('button', { name: 'Open canvas: 本地画布' })
  ).toHaveClass('h-32')
})

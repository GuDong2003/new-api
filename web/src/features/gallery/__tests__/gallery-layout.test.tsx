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
import { GalleryUsageMeters } from '../components/gallery-usage-meters'
import {
  GALLERY_FALLBACK_PAGE_SIZE,
  calculateGalleryGrid,
} from '../hooks/use-gallery-grid'
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

  expect(
    await screen.findByRole('progressbar', { name: 'Images' })
  ).toHaveAttribute('aria-valuetext', '2 / 100')
  expect(
    screen.queryByRole('heading', { name: 'My Gallery' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByText(/Private final images from Drawing and NAI Canvas/)
  ).not.toBeInTheDocument()
})

it('reveals the storage rules only after the usage hint is opened', async () => {
  renderGallery([galleryImage])

  expect(
    await screen.findByRole('progressbar', { name: 'Images' })
  ).toHaveAttribute('aria-valuetext', '2 / 100')
  expect(screen.queryByText(/New images expire after/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Learn more' }))

  expect(
    await screen.findByText(/New images expire after 7 days/)
  ).toBeVisible()
})

it('fills a desktop window with two rows of large cards', () => {
  const grid = calculateGalleryGrid(1440, 700)

  expect(grid.rows).toBe(2)
  expect(grid.columns).toBe(6)
  expect(grid.pageSize).toBe(12)
})

it('shrinks cards so a short window still fits two rows', () => {
  const roomy = calculateGalleryGrid(1024, 900)
  const short = calculateGalleryGrid(1024, 480)

  expect(short.rows).toBe(2)
  expect(short.columns).toBeGreaterThan(roomy.columns)
})

it('keeps phone captions readable with two columns', () => {
  const phone = calculateGalleryGrid(390, 740)

  expect(phone.columns).toBe(2)
})

it('keeps a single row when not even two fit', () => {
  const landscape = calculateGalleryGrid(844, 300)

  expect(landscape.rows).toBe(1)
})

it('reports the fallback page size before the grid has a size', () => {
  const unmeasured = calculateGalleryGrid(0, 0)

  expect(unmeasured.measured).toBe(false)
  expect(unmeasured.pageSize).toBe(GALLERY_FALLBACK_PAGE_SIZE)
})

it('falls back to an auto-fill track while the grid cannot be measured', async () => {
  renderGallery([galleryImage, { ...galleryImage, id: 'image-2' }])

  const cards = await screen.findAllByRole('article')

  expect(cards).toHaveLength(2)
  expect(cards[0].parentElement).toHaveClass(
    'grid-cols-2',
    'gap-4',
    'sm:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]'
  )
})

it('lets the canvas cover absorb the height a row has to spare', () => {
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
  ).toHaveClass('flex-1', 'min-h-0')
})

it('colors each usage meter by how full that quota is', () => {
  render(
    <GalleryUsageMeters
      usage={{
        used_images: 95,
        max_images: 100,
        used_bytes: 80,
        max_bytes: 100,
        retention_days: 30,
        enabled: true,
        can_save: true,
        reason: '',
      }}
    />
  )

  const fill = (name: string) =>
    screen.getByRole('progressbar', { name }).firstElementChild

  expect(fill('Images')).toHaveClass('bg-destructive')
  expect(fill('Storage')).toHaveClass('bg-warning')
})

it('keeps a quota with room to spare on the calm color', () => {
  render(
    <GalleryUsageMeters
      usage={{
        used_images: 10,
        max_images: 100,
        used_bytes: 10,
        max_bytes: 100,
        retention_days: 30,
        enabled: true,
        can_save: true,
        reason: '',
      }}
    />
  )

  expect(
    screen.getByRole('progressbar', { name: 'Images' }).firstElementChild
  ).toHaveClass('bg-success')
})

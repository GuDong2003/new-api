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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

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

it('shows combined usage, filters sources and paginates server results', async () => {
  const lists: unknown[] = []
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/usage')) return response(config, usage)
    if (config.url?.endsWith('/file')) {
      return { ...response(config, {}), data: new Blob(['private']) }
    }
    lists.push(config.params)
    return response(config, {
      items: Array.from(
        { length: config.params.page === 3 ? 1 : 24 },
        (_, index) => ({
          ...galleryImage,
          id: `image-${(config.params.page - 1) * 24 + index}`,
          source: 'nai',
          prompt: `Picture ${(config.params.page - 1) * 24 + index}`,
        })
      ),
      total: 49,
      page: config.params.page,
      page_size: 24,
    })
  }
  render(
    <QueryClientProvider client={client}>
      <Gallery />
    </QueryClientProvider>
  )
  expect(await screen.findByText('2 / 100 images')).toBeVisible()
  expect(screen.getByText('1.00 / 200.00 MiB')).toBeVisible()
  await userEvent.click(screen.getByRole('combobox', { name: 'Source' }))
  await userEvent.click(screen.getByRole('option', { name: 'NAI Canvas' }))
  await waitFor(() => expect(lists).toContainEqual({ page: 1, page_size: 24 }))
  await userEvent.click(screen.getByRole('button', { name: 'Go to next page' }))
  await waitFor(() => expect(lists).toContainEqual({ page: 2, page_size: 24 }))
  expect(screen.getByText('2 / 3')).toBeVisible()
})

it('fetches private thumbnails with authentication and revokes blob URLs on disposal', async () => {
  const privateRequests: string[] = []
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/usage')) return response(config, usage)
    if (config.url?.endsWith('/file')) {
      privateRequests.push(String(config.headers.Authorization))
      expect(config.params).toEqual({ thumbnail: true })
      return {
        ...response(config, {}),
        data: new Blob(['private'], { type: 'image/png' }),
      }
    }
    return response(config, {
      items: [galleryImage],
      total: 1,
      page: 1,
      page_size: 24,
    })
  }
  const view = render(
    <QueryClientProvider client={client}>
      <Gallery />
    </QueryClientProvider>
  )
  expect(
    await screen.findByRole('img', { name: 'A quiet forest' })
  ).toHaveAttribute('src', 'blob:private-gallery')
  expect(privateRequests).toEqual(['Bearer token-813-gallery-session'])
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-gallery')
})

it('falls back to the private original without a thumbnail, and preview reuses it', async () => {
  const files: unknown[] = []
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/usage')) return response(config, usage)
    if (config.url?.endsWith('/file')) {
      files.push(config.params)
      return {
        ...response(config, {}),
        data: new Blob(['original'], { type: 'image/png' }),
      }
    }
    return response(config, {
      items: [
        {
          ...galleryImage,
          has_thumbnail: false,
          negative_prompt: 'noise',
          parameters: { seed: 42 },
        },
      ],
      total: 1,
      page: 1,
      page_size: 24,
    })
  }
  render(
    <QueryClientProvider client={client}>
      <Gallery />
    </QueryClientProvider>
  )
  expect(
    await screen.findByRole('img', { name: 'A quiet forest' })
  ).toBeVisible()
  expect(files).toEqual([undefined])
  await userEvent.click(
    screen.getByRole('button', { name: 'Preview original' })
  )
  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByRole('img')).toHaveAttribute(
    'src',
    'blob:private-gallery'
  )
  expect(files).toEqual([undefined])
  expect(within(dialog).getByText('noise')).toBeVisible()
  expect(within(dialog).getByText('42')).toBeVisible()
  expect(
    within(dialog).getByRole('link', { name: 'Download original' })
  ).toHaveAttribute('download')
})

it('requires confirmation before deletion and refreshes list and usage after deletion', async () => {
  let deleted = false
  api.defaults.adapter = async (config) => {
    if (config.method === 'delete') {
      deleted = true
      return response(config, null)
    }
    if (config.url?.endsWith('/usage')) {
      return response(config, { ...usage, used_images: deleted ? 0 : 2 })
    }
    if (config.url?.endsWith('/file')) {
      return { ...response(config, {}), data: new Blob(['private']) }
    }
    return response(config, {
      items: deleted ? [] : [galleryImage],
      total: deleted ? 0 : 1,
      page: 1,
      page_size: 24,
    })
  }
  render(
    <QueryClientProvider client={client}>
      <Gallery />
    </QueryClientProvider>
  )
  await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  const confirmation = await screen.findByRole('alertdialog')
  expect(deleted).toBe(false)
  await userEvent.click(
    within(confirmation).getByRole('button', { name: 'Delete' })
  )
  expect(await screen.findByText('0 / 100 images')).toBeVisible()
  expect(await screen.findByText('No saved images')).toBeVisible()
})

it('replaces failed loading with a retry action and keeps thumbnails private after account change', async () => {
  let failed = true
  api.defaults.adapter = async (config) => {
    if (failed) throw new Error('offline')
    if (config.url?.endsWith('/usage')) return response(config, usage)
    return response(config, { items: [], total: 0, page: 1, page_size: 24 })
  }
  render(
    <QueryClientProvider client={client}>
      <Gallery />
    </QueryClientProvider>
  )
  const retry = await screen.findByRole('button', { name: 'Retry' })
  failed = false
  fireEvent.click(retry)
  await waitFor(() => expect(screen.getByText('No saved images')).toBeVisible())
  act(() => useAuthStore.getState().auth.reset())
  expect(screen.queryByText('2 / 100 images')).not.toBeInTheDocument()
})

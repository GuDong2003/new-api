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
import { act, renderHook, waitFor } from '@testing-library/react'
import { AxiosError } from 'axios'
import { IDBFactory } from 'fake-indexeddb'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { useGalleryImage } from '../hooks/use-gallery-image'
import { login, response } from './fixtures'

const identity = { userId: 813, sessionId: 'gallery-session' }
const adapter = api.defaults.adapter
let client: QueryClient
let served: string[]
let holdOriginal: (() => void) | undefined

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(
        (blob: Blob) => `blob:${(blob as Blob & { label?: string }).label}`
      )
      static revokeObjectURL = vi.fn()
    }
  )
  login()
  served = []
  holdOriginal = undefined
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api.defaults.adapter = async (config) => {
    if (!config.url?.endsWith('/file')) {
      throw new AxiosError(
        'not found',
        '',
        config,
        {},
        { ...response(config, {}), status: 404 }
      )
    }
    const thumbnail = (config.params as { thumbnail?: boolean } | undefined)
      ?.thumbnail
    const label = thumbnail ? 'preview' : 'original'
    served.push(label)
    if (!thumbnail && holdOriginal) {
      await new Promise<void>((resolve) => {
        holdOriginal = resolve
      })
    }
    const blob = new Blob([label], { type: 'image/png' })
    Object.assign(blob, { label })
    return { ...response(config, {}), data: blob }
  }
})

afterEach(() => {
  useAuthStore.getState().auth.reset()
  client.clear()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
})

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

// A list shows many pictures at once. Fetching each original behind its preview
// made one page of the gallery pull tens of megabytes for pictures the size of
// a thumbnail, so a preview is the answer here rather than a stand-in.
it('stops at the preview when one exists', async () => {
  const view = renderHook(
    () => useGalleryImage(identity, 'image-1', { preview: true }),
    { wrapper }
  )

  await waitFor(() => expect(view.result.current.url).toBe('blob:preview'))
  expect(view.result.current.isPending).toBe(false)

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(served).toEqual(['preview'])
})

it('goes straight to the original for a picture with no preview', async () => {
  const view = renderHook(
    () => useGalleryImage(identity, 'image-3', { preview: false }),
    { wrapper }
  )

  await waitFor(() => expect(view.result.current.url).toBe('blob:original'))
  expect(served).toEqual(['original'])
})

it('keeps the preview on screen when the original cannot be fetched', async () => {
  api.defaults.adapter = async (config) => {
    const thumbnail = (config.params as { thumbnail?: boolean } | undefined)
      ?.thumbnail
    if (!thumbnail) {
      throw new AxiosError(
        'gone',
        '',
        config,
        {},
        { ...response(config, {}), status: 404 }
      )
    }
    const blob = new Blob(['preview'], { type: 'image/png' })
    Object.assign(blob, { label: 'preview' })
    return { ...response(config, {}), data: blob }
  }
  const view = renderHook(
    () => useGalleryImage(identity, 'image-4', { preview: true }),
    { wrapper }
  )

  await waitFor(() => expect(view.result.current.url).toBe('blob:preview'))
  await waitFor(() => expect(view.result.current.isError).toBe(false))
  expect(view.result.current.url).toBe('blob:preview')
})

// A preview that will not decode — a cache entry whose bytes went bad, or a
// Blob a browser no longer honours — leaves a broken picture on screen with
// nothing to retry it. Discarding what did not work and asking again does.
it('discards a preview that fails to load and fetches it again', async () => {
  const view = renderHook(
    () => useGalleryImage(identity, 'image-4', { preview: true }),
    { wrapper }
  )

  await waitFor(() => expect(view.result.current.url).toBe('blob:preview'))
  expect(served).toEqual(['preview'])

  await act(async () => {
    await view.result.current.retry()
  })

  await waitFor(() => expect(served).toEqual(['preview', 'preview']))
})

// Bytes that will not decode do not start decoding on the second try, and an
// `onError` that asks again every time would hammer the server for as long as
// the card is on screen.
it('asks again only once for a preview that keeps failing', async () => {
  const view = renderHook(
    () => useGalleryImage(identity, 'image-5', { preview: true }),
    { wrapper }
  )

  await waitFor(() => expect(view.result.current.url).toBe('blob:preview'))
  await act(async () => {
    await view.result.current.retry()
  })
  await act(async () => {
    await view.result.current.retry()
  })
  await act(async () => {
    await view.result.current.retry()
  })

  expect(served).toEqual(['preview', 'preview'])
})

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

it('shows the preview first and replaces it with the original', async () => {
  holdOriginal = () => undefined
  const view = renderHook(
    () => useGalleryImage(identity, 'image-1', { preview: true }),
    { wrapper }
  )

  // The preview is up while the original is still in flight, so nothing waits
  // behind the larger download it stands in for.
  await waitFor(() => expect(view.result.current.url).toBe('blob:preview'))
  expect(view.result.current.isPending).toBe(false)
  expect(served).toEqual(['preview', 'original'])

  await act(async () => {
    holdOriginal?.()
  })

  await waitFor(() => expect(view.result.current.url).toBe('blob:original'))
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

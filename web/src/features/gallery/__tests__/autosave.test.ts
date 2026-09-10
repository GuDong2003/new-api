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
import { waitFor } from '@testing-library/react'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { queueGallerySave, cancelGallerySaves } from '../lib/save-queue'
import { galleryImage, login, response, usage } from './fixtures'

const adapter = api.defaults.adapter
const input = {
  userId: 813,
  sessionId: 'gallery-session',
  src: 'https://images.example/final.png',
  metadata: {
    source_id: 'job-1:0',
    source: 'drawing' as const,
    model: 'gpt-image-1',
    prompt: 'A forest',
    negative_prompt: '',
    parameters: {},
  },
}

beforeEach(() => login())
afterEach(() => {
  cancelGallerySaves(813, 'gallery-session')
  useAuthStore.getState().auth.reset()
  api.defaults.adapter = adapter
})

describe('Session-scoped gallery autosave', () => {
  it('posts metadata before the remote URL without fetching the URL in the browser', async () => {
    const posted: FormData[] = []
    const browserFetch = vi.spyOn(globalThis, 'fetch')
    api.defaults.adapter = async (config) => {
      expect(config.headers.Authorization).toBe(
        'Bearer token-813-gallery-session'
      )
      if (config.method === 'post') posted.push(config.data as FormData)
      return response(config, config.method === 'post' ? galleryImage : usage)
    }
    await queueGallerySave(input)
    expect(posted).toHaveLength(1)
    expect([...posted[0].keys()]).toEqual(['metadata', 'url'])
    expect(posted[0].get('url')).toBe(input.src)
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('checks combined quota before decoding data and resolves save failure independently', async () => {
    const warnings = vi.spyOn(toast, 'warning')
    const posted: string[] = []
    api.defaults.adapter = async (config) => {
      posted.push(config.method || '')
      return response(config, {
        ...usage,
        can_save: false,
        reason: 'Gallery storage limit reached.',
      })
    }
    await expect(
      queueGallerySave({ ...input, src: 'data:image/png;base64,invalid' })
    ).resolves.toBeUndefined()
    expect(posted).toEqual(['get'])
    expect(warnings).toHaveBeenCalledWith(
      'Gallery storage is full. This image was not saved to your gallery.',
      expect.anything()
    )
  })

  it('converts only admitted data images into original multipart bytes', async () => {
    let uploaded: File | undefined
    api.defaults.adapter = async (config) => {
      if (config.method === 'post') {
        uploaded = (config.data as FormData).get('file') as File
      }
      return response(config, config.method === 'post' ? galleryImage : usage)
    }
    await queueGallerySave({ ...input, src: 'data:image/png;base64,YWJj' })
    expect(uploaded?.type).toBe('image/png')
    expect(uploaded?.size).toBe(3)
  })

  it('aborts inflight and queued saves synchronously when another account logs in', async () => {
    let pendingConfig: InternalAxiosRequestConfig | undefined
    let finish: (() => void) | undefined
    const posts: string[] = []
    api.defaults.adapter = async (config) => {
      if (config.method === 'post') {
        posts.push(String(config.headers.Authorization))
      }
      pendingConfig = config
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return response(config, usage)
    }
    const first = queueGallerySave(input)
    const second = queueGallerySave({
      ...input,
      metadata: { ...input.metadata, source_id: 'job-2:0' },
    })
    await waitFor(() => expect(pendingConfig).toBeDefined())
    login(814, 'other-session')
    expect(pendingConfig?.signal?.aborted).toBe(true)
    finish?.()
    await Promise.all([first, second])
    expect(posts).toEqual([])
  })

  it('does not replay a 401 under the same user’s replacement session', async () => {
    const urls: string[] = []
    api.defaults.adapter = async (config) => {
      urls.push(config.url || '')
      const rejected = { ...response(config, {}), status: 401 }
      throw new AxiosError(
        'Unauthorized',
        'ERR_BAD_REQUEST',
        config,
        {},
        rejected
      )
    }
    await queueGallerySave(input)
    expect(urls).toEqual(['/api/gallery/usage'])
    expect(useAuthStore.getState().auth.session?.sid).toBe('gallery-session')
  })

  it('does not dispatch when identity changes between scheduling and axios interception', async () => {
    const requests: string[] = []
    api.defaults.adapter = async (config) => {
      requests.push(config.url || '')
      return response(config, usage)
    }
    const saving = queueGallerySave(input)
    login(813, 'replacement-session')
    await saving
    expect(requests).toEqual([])
  })

  it('permanently discards queued jobs on logout even if the old identity is restored before transport settles', async () => {
    let finish: (() => void) | undefined
    const posts: unknown[] = []
    api.defaults.adapter = async (config) => {
      if (config.method === 'post') posts.push(config.data)
      if (!finish) {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      }
      return response(config, config.method === 'post' ? galleryImage : usage)
    }
    const first = queueGallerySave(input)
    const second = queueGallerySave({
      ...input,
      metadata: { ...input.metadata, source_id: 'job-2:0' },
    })
    await waitFor(() => expect(finish).toBeDefined())
    useAuthStore.getState().auth.reset()
    login()
    finish?.()
    await Promise.all([first, second])
    expect(posts).toEqual([])
  })

  it('blocks dispatch if identity changes inside the asynchronous axios interceptor chain', async () => {
    const requests: string[] = []
    api.defaults.adapter = async (config) => {
      requests.push(config.url || '')
      return response(config, usage)
    }
    const interceptor = api.interceptors.request.use((config) => {
      login(814, 'new-account')
      return config
    })
    try {
      await queueGallerySave(input)
      expect(requests).toEqual([])
    } finally {
      api.interceptors.request.eject(interceptor)
    }
  })

  it('silently skips disabled storage without decoding data or uploading', async () => {
    const requests: string[] = []
    const warning = vi.spyOn(toast, 'warning')
    api.defaults.adapter = async (config) => {
      requests.push(config.method || '')
      return response(config, {
        ...usage,
        enabled: false,
        can_save: false,
        reason: 'Gallery storage is disabled.',
      })
    }
    await queueGallerySave({ ...input, src: 'data:image/png;base64,invalid' })
    expect(requests).toEqual(['get'])
    expect(warning).not.toHaveBeenCalled()
  })

  it('bounds pending saves and uploads sequentially while a request is stalled', async () => {
    let finish: (() => void) | undefined
    const posts: FormData[] = []
    let activeRequests = 0
    let peakRequests = 0
    api.defaults.adapter = async (config) => {
      activeRequests++
      peakRequests = Math.max(peakRequests, activeRequests)
      if (!finish) {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      }
      if (config.method === 'post') posts.push(config.data as FormData)
      activeRequests--
      return response(config, config.method === 'post' ? galleryImage : usage)
    }
    const jobs = Array.from({ length: 35 }, (_, index) =>
      queueGallerySave({
        ...input,
        metadata: { ...input.metadata, source_id: `bounded-${index}:0` },
      })
    )
    await waitFor(() => expect(finish).toBeDefined())
    await jobs[34]
    expect(posts).toEqual([])
    finish?.()
    await Promise.all(jobs)
    expect(peakRequests).toBe(1)
    expect(posts).toHaveLength(33)
  })
})

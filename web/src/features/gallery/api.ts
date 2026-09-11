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
import { api, getFreshAuthHeaders, type ApiRequestConfig } from '@/lib/api'

import { assertGalleryIdentity, galleryRequestScope } from './lib/session'
import type {
  GalleryIdentity,
  GalleryImage,
  GalleryPage,
  GallerySettings,
  GallerySource,
  GalleryUsage,
  CanvasRecord,
  CanvasSummary,
  CanvasSaveMetadata,
  CanvasBinary,
} from './types'

async function request<T>(
  identity: GalleryIdentity,
  config: ApiRequestConfig,
  signal?: AbortSignal
): Promise<T> {
  const scope = galleryRequestScope(identity, signal)
  try {
    // Refresh proactively only. Never let a 401 replay old work in a new session.
    await getFreshAuthHeaders()
    assertGalleryIdentity(identity)
    scope.signal.throwIfAborted()
    const result = await api.request({
      ...config,
      signal: scope.signal,
      timeout: 60_000,
      skipAuthRefresh: true,
      skipBusinessError: true,
      skipErrorHandler: true,
      disableDuplicate: true,
    })
    assertGalleryIdentity(identity)
    scope.signal.throwIfAborted()
    if (config.responseType === 'blob') return result.data as T
    if (result.data?.success !== true) {
      throw new Error(result.data?.message || 'Request failed')
    }
    return result.data.data as T
  } finally {
    scope.dispose()
  }
}

export function getGalleryUsage(
  identity: GalleryIdentity,
  signal?: AbortSignal,
  budget?: { required_bytes: number; required_images: number }
) {
  return request<GalleryUsage>(
    identity,
    { method: 'get', url: '/api/gallery/usage', params: budget },
    signal
  )
}

export function getCanvasRecord(
  identity: GalleryIdentity,
  id: string,
  signal?: AbortSignal
) {
  return request<CanvasRecord>(
    identity,
    { method: 'get', url: `/api/gallery/canvases/${encodeURIComponent(id)}` },
    signal
  )
}
export function listCanvasRecords(
  identity: GalleryIdentity,
  params: { page?: number; source?: string; search?: string; sort?: string },
  signal?: AbortSignal
) {
  return request<{
    items: CanvasSummary[]
    total: number
    page: number
    page_size: number
  }>(
    identity,
    {
      method: 'get',
      url: '/api/gallery/canvases',
      params: { page_size: 24, ...params },
    },
    signal
  )
}
export function saveCanvasRecord(
  identity: GalleryIdentity,
  metadata: CanvasSaveMetadata,
  assets: CanvasBinary[],
  signal?: AbortSignal
) {
  const data = new FormData()
  data.append('metadata', JSON.stringify(metadata))
  for (const asset of assets) {
    data.append(`file:${asset.id}`, asset.blob, asset.id)
  }
  return request<CanvasRecord>(
    identity,
    { method: 'post', url: '/api/gallery/canvases', data },
    signal
  )
}
export function deleteCanvasRecord(
  identity: GalleryIdentity,
  id: string,
  revision: number,
  assetId?: string,
  signal?: AbortSignal
) {
  const suffix = assetId ? `/assets/${encodeURIComponent(assetId)}` : ''
  return request<CanvasRecord>(
    identity,
    {
      method: 'delete',
      url: `/api/gallery/canvases/${encodeURIComponent(id)}${suffix}`,
      params: { revision },
    },
    signal
  )
}
export function readRemoteCanvasOriginal(
  identity: GalleryIdentity,
  url: string,
  signal?: AbortSignal
) {
  return request<Blob>(
    identity,
    {
      method: 'post',
      url: '/api/gallery/original',
      data: { url },
      responseType: 'blob',
    },
    signal
  )
}
export function getGalleryImages(
  identity: GalleryIdentity,
  page: number,
  source?: GallerySource,
  signal?: AbortSignal
) {
  return request<GalleryPage>(
    identity,
    {
      method: 'get',
      url: '/api/gallery/images',
      params: { page, page_size: 24, source },
    },
    signal
  )
}
export function saveGalleryImage(
  identity: GalleryIdentity,
  data: FormData,
  signal?: AbortSignal
) {
  return request<GalleryImage>(
    identity,
    { method: 'post', url: '/api/gallery/images', data },
    signal
  )
}
export function getGalleryFile(
  identity: GalleryIdentity,
  id: string,
  thumbnail: boolean,
  signal?: AbortSignal
) {
  return request<Blob>(
    identity,
    {
      method: 'get',
      url: `/api/gallery/images/${encodeURIComponent(id)}/file`,
      params: thumbnail ? { thumbnail: true } : undefined,
      responseType: 'blob',
    },
    signal
  )
}
export function deleteGalleryImage(identity: GalleryIdentity, id: string) {
  return request<unknown>(identity, {
    method: 'delete',
    url: `/api/gallery/images/${encodeURIComponent(id)}`,
  })
}
export function getGallerySettings(
  identity: GalleryIdentity,
  signal?: AbortSignal
) {
  return request<GallerySettings>(
    identity,
    { method: 'get', url: '/api/gallery/settings' },
    signal
  )
}
export function updateGallerySettings(
  identity: GalleryIdentity,
  data: GallerySettings
) {
  return request<GallerySettings>(identity, {
    method: 'put',
    url: '/api/gallery/settings',
    data,
  })
}

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

import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  getLocalThumbnail,
  localThumbnailFingerprint,
} from '../lib/local-thumbnail'
import { readGalleryThumbnail } from '../lib/gallery-thumbnail-cache'

const original = new NodeBlob(['a full sized picture'], {
  type: 'image/png',
}) as unknown as Blob
const preview = new NodeBlob(['small'], {
  type: 'image/jpeg',
}) as unknown as Blob

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('Blob', NodeBlob)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('downscales a local original once and serves the cache after that', async () => {
  const render = vi.fn().mockResolvedValue(preview)

  const first = await getLocalThumbnail(9, 'asset-a', 'sha-1', original, render)
  const second = await getLocalThumbnail(9, 'asset-a', 'sha-1', original, render)

  expect(first).toBe(preview)
  expect(second.size).toBe(preview.size)
  expect(render).toHaveBeenCalledTimes(1)
})

// The cache is the one the gallery reads, so a preview derived for a canvas is
// the same entry the images tab would find.
it('stores the preview in the gallery cache under a content fingerprint', async () => {
  await getLocalThumbnail(9, 'asset-a', 'sha-1', original, async () => preview)

  const cached = await readGalleryThumbnail(
    9,
    'asset-a',
    localThumbnailFingerprint('sha-1')
  )
  expect(cached?.size).toBe(preview.size)
})

it('re-derives when the bytes behind an asset change', async () => {
  const render = vi.fn().mockResolvedValue(preview)
  await getLocalThumbnail(9, 'asset-a', 'sha-1', original, render)

  await getLocalThumbnail(9, 'asset-a', 'sha-2', original, render)

  expect(render).toHaveBeenCalledTimes(2)
})

// A picture already smaller than the preview, or one this browser cannot
// rasterise, must still be shown rather than disappearing.
it('falls back to the original when it cannot be downscaled', async () => {
  const result = await getLocalThumbnail(
    9,
    'asset-b',
    'sha-3',
    original,
    async () => null
  )

  expect(result).toBe(original)
  expect(
    await readGalleryThumbnail(9, 'asset-b', localThumbnailFingerprint('sha-3'))
  ).toBeNull()
})

it('shows the original rather than failing when the content is unidentified', async () => {
  const render = vi.fn().mockResolvedValue(preview)

  const result = await getLocalThumbnail(9, 'asset-b', '', original, render)

  expect(result).toBe(original)
  expect(render).not.toHaveBeenCalled()
})

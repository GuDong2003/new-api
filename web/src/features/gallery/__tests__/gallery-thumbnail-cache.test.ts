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
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  galleryAssetFingerprint,
  readGalleryThumbnail,
  removeGalleryThumbnail,
  writeGalleryThumbnail,
} from '../lib/gallery-thumbnail-cache'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('only reuses a thumbnail when its image fingerprint is unchanged', async () => {
  const fingerprint = galleryAssetFingerprint('image-1')
  const blob = new Blob(['thumbnail'], { type: 'image/jpeg' })
  await writeGalleryThumbnail(813, 'image-1', fingerprint, blob)

  expect(await readGalleryThumbnail(813, 'image-1', fingerprint)).not.toBeNull()
  expect(
    await readGalleryThumbnail(813, 'image-1', `${fingerprint}:changed`)
  ).toBeNull()
})

it('removes a thumbnail from the persistent cache', async () => {
  const blob = new Blob(['thumbnail'], { type: 'image/jpeg' })
  await writeGalleryThumbnail(813, 'image-1', 'fingerprint', blob)
  await removeGalleryThumbnail(813, 'image-1')

  expect(await readGalleryThumbnail(813, 'image-1', 'fingerprint')).toBeNull()
})

it('drops entries whose images outlived the cache retention window', async () => {
  const blob = new Blob(['thumbnail'], { type: 'image/jpeg' })
  const clock = vi.spyOn(Date, 'now')

  clock.mockReturnValue(Date.parse('2026-01-01T00:00:00Z'))
  await writeGalleryThumbnail(813, 'expired-image', 'fingerprint', blob)
  expect(
    await readGalleryThumbnail(813, 'expired-image', 'fingerprint')
  ).not.toBeNull()

  clock.mockReturnValue(Date.parse('2026-02-01T00:00:00Z'))
  await writeGalleryThumbnail(813, 'fresh-image', 'fingerprint', blob)

  expect(
    await readGalleryThumbnail(813, 'expired-image', 'fingerprint')
  ).toBeNull()
  expect(
    await readGalleryThumbnail(813, 'fresh-image', 'fingerprint')
  ).not.toBeNull()
  clock.mockRestore()
})

it('reuses one database connection across cache operations', async () => {
  const factory = new IDBFactory()
  const open = vi.spyOn(factory, 'open')
  vi.stubGlobal('indexedDB', factory)
  const blob = new Blob(['thumbnail'], { type: 'image/jpeg' })

  await writeGalleryThumbnail(813, 'image-1', 'fingerprint', blob)
  await readGalleryThumbnail(813, 'image-1', 'fingerprint')
  await writeGalleryThumbnail(813, 'image-2', 'fingerprint', blob)
  await readGalleryThumbnail(813, 'image-2', 'fingerprint')

  expect(open).toHaveBeenCalledTimes(1)
})

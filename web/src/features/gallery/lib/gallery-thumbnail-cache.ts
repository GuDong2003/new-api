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

const DATABASE_NAME = 'new-api-gallery-thumbnail-cache'
const DATABASE_VERSION = 1
const STORE_NAME = 'thumbnails'

type GalleryThumbnailEntry = {
  fingerprint: string
  blob: Blob
  savedAt: number
}

function cacheKey(userId: number, imageId: string) {
  return `${userId}:${imageId}`
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  request.addEventListener('upgradeneeded', () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME)
    }
  })
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Gallery thumbnail cache unavailable.'))
    )
  })
}

export function galleryThumbnailFingerprint(image: {
  id: string
  bytes: number
  mime_type: string
  created_at: number
  expires_at: number
  has_thumbnail: boolean
}) {
  return [
    image.id,
    image.bytes,
    image.mime_type,
    image.created_at,
    image.expires_at,
    image.has_thumbnail ? 'thumbnail' : 'original',
  ].join(':')
}

export async function readGalleryThumbnail(
  userId: number,
  imageId: string,
  fingerprint: string
): Promise<Blob | null> {
  const database = await openDatabase()
  if (!database) return null
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction
      .objectStore(STORE_NAME)
      .get(cacheKey(userId, imageId))
    request.addEventListener('success', () => {
      const entry = request.result as GalleryThumbnailEntry | undefined
      resolve(entry?.fingerprint === fingerprint ? entry.blob : null)
    })
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Gallery thumbnail cache read failed.'))
    )
    transaction.addEventListener('complete', () => database.close())
    transaction.addEventListener('abort', () => {
      database.close()
      reject(
        transaction.error ?? new Error('Gallery thumbnail cache read aborted.')
      )
    })
  })
}

export async function writeGalleryThumbnail(
  userId: number,
  imageId: string,
  fingerprint: string,
  blob: Blob
): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(
      {
        fingerprint,
        blob,
        savedAt: Date.now(),
      } satisfies GalleryThumbnailEntry,
      cacheKey(userId, imageId)
    )
    transaction.addEventListener('complete', () => {
      database.close()
      resolve()
    })
    transaction.addEventListener('abort', () => {
      database.close()
      reject(
        transaction.error ?? new Error('Gallery thumbnail cache write aborted.')
      )
    })
    transaction.addEventListener('error', () => {
      database.close()
      reject(
        transaction.error ?? new Error('Gallery thumbnail cache write failed.')
      )
    })
  })
}

export async function removeGalleryThumbnail(
  userId: number,
  imageId: string
): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(cacheKey(userId, imageId))
    transaction.addEventListener('complete', () => {
      database.close()
      resolve()
    })
    transaction.addEventListener('abort', () => {
      database.close()
      reject(
        transaction.error ??
          new Error('Gallery thumbnail cache delete aborted.')
      )
    })
    transaction.addEventListener('error', () => {
      database.close()
      reject(
        transaction.error ?? new Error('Gallery thumbnail cache delete failed.')
      )
    })
  })
}

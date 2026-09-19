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
const DATABASE_VERSION = 2
const STORE_NAME = 'thumbnails'
const SAVED_AT_INDEX = 'savedAt'
// Images are deleted server side once their retention expires, and nothing ever
// rewrites their cache entry again. Without this sweep those dead entries grow
// without bound until the origin hits its storage quota and every write starts
// failing silently. Re-fetching an entry that is still alive only costs a miss.
const MAX_ENTRY_AGE_MS = 14 * 24 * 60 * 60 * 1000

type GalleryThumbnailEntry = {
  fingerprint: string
  blob: Blob
  savedAt: number
}

function cacheKey(userId: number, imageId: string) {
  return `${userId}:${imageId}`
}

let openedFrom: IDBFactory | null = null
let connection: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  // The memo belongs to the factory it was opened from, so a replaced global
  // never keeps handing back a connection to a database that no longer exists.
  if (connection && openedFrom === indexedDB) return connection
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  request.addEventListener('upgradeneeded', () => {
    const upgrade = request.transaction
    if (!upgrade) return
    const store = request.result.objectStoreNames.contains(STORE_NAME)
      ? upgrade.objectStore(STORE_NAME)
      : request.result.createObjectStore(STORE_NAME)
    if (!store.indexNames.contains(SAVED_AT_INDEX)) {
      store.createIndex(SAVED_AT_INDEX, SAVED_AT_INDEX)
    }
  })
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener('success', () => {
      request.result.addEventListener('close', () => forget(pending))
      resolve(request.result)
    })
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Gallery thumbnail cache unavailable.'))
    )
  })
  pending.catch(() => forget(pending))
  openedFrom = indexedDB
  connection = pending
  return pending
}

function forget(pending: Promise<IDBDatabase>) {
  if (connection !== pending) return
  connection = null
  openedFrom = null
}

function sweepExpiredEntries(store: IDBObjectStore) {
  const cutoff = Date.now() - MAX_ENTRY_AGE_MS
  const cursor = store
    .index(SAVED_AT_INDEX)
    .openCursor(IDBKeyRange.upperBound(cutoff, true))
  cursor.addEventListener('success', () => {
    const position = cursor.result
    if (!position) return
    position.delete()
    position.continue()
  })
}

/**
 * Every surface showing a gallery picture — the images tab, a canvas cover, a
 * canvas being opened — shares one entry per image, so they must all describe
 * it the same way. Two schemes over the same key meant each surface treated the
 * other's copy as stale and downloaded the picture again.
 *
 * The id alone identifies the bytes: what a gallery image stores never changes
 * after it is written, and its thumbnail is dropped only when the image itself
 * is being removed.
 */
export function galleryAssetFingerprint(imageId: string): string {
  return `asset:${imageId}`
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
    transaction.addEventListener('abort', () =>
      reject(
        transaction.error ?? new Error('Gallery thumbnail cache read aborted.')
      )
    )
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
    const store = transaction.objectStore(STORE_NAME)
    store.put(
      {
        fingerprint,
        blob,
        savedAt: Date.now(),
      } satisfies GalleryThumbnailEntry,
      cacheKey(userId, imageId)
    )
    sweepExpiredEntries(store)
    transaction.addEventListener('complete', () => resolve())
    transaction.addEventListener('abort', () =>
      reject(
        transaction.error ?? new Error('Gallery thumbnail cache write aborted.')
      )
    )
    transaction.addEventListener('error', () =>
      reject(
        transaction.error ?? new Error('Gallery thumbnail cache write failed.')
      )
    )
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
    transaction.addEventListener('complete', () => resolve())
    transaction.addEventListener('abort', () =>
      reject(
        transaction.error ??
          new Error('Gallery thumbnail cache delete aborted.')
      )
    )
    transaction.addEventListener('error', () =>
      reject(
        transaction.error ?? new Error('Gallery thumbnail cache delete failed.')
      )
    )
  })
}

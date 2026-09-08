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
import type { DrawingDocument } from '../types'
import {
  parseDrawingDocument,
  serializeDrawingDocument,
} from './canvas-document'

async function openCanvasDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('new-api-drawing', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('canvases')
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(
        new Error(
          'Canvas storage is unavailable. Export your canvas to keep a copy.'
        )
      )
    request.onsuccess = () => resolve(request.result)
  })
}

export async function loadDrawingDocument(
  userId: number
): Promise<DrawingDocument | null> {
  const database = await openCanvasDatabase()
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction('canvases', 'readonly')
      const request = transaction.objectStore('canvases').get(userId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return value ? parseDrawingDocument(value) : null
  } finally {
    database.close()
  }
}

export async function saveDrawingDocument(
  userId: number,
  document: DrawingDocument
): Promise<void> {
  const database = await openCanvasDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('canvases', 'readwrite')
      transaction
        .objectStore('canvases')
        .put(serializeDrawingDocument(document), userId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

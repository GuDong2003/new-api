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
import { z } from 'zod'

import { isSafeImageSource } from '../../drawing/lib/image-assets'
import type { NaiCanvasDocument } from '../types'
import { naiSettingsSchema } from './nai-settings'

const assetSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(512),
  src: z
    .string()
    .max(72 * 1024 * 1024)
    .refine(isSafeImageSource),
  width: z.number().int().positive().max(32768),
  height: z.number().int().positive().max(32768),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
})

const nodeSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('nai-image'),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  width: z.number().positive().max(10000).optional(),
  height: z.number().positive().max(10000).optional(),
  data: z.object({
    asset: assetSchema.optional(),
    prompt: z.string().max(32000),
    settings: naiSettingsSchema,
    status: z.enum(['pending', 'complete', 'error', 'cancelled']),
    error: z.string().max(10000).optional(),
    jobId: z.string().max(128).optional(),
    createdAt: z.number().finite(),
    usage: z.record(z.string(), z.unknown()).optional(),
  }),
})

const naiCanvasDocumentSchema = z.object({
  version: z.literal(1),
  nodes: z.array(nodeSchema).max(500),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().min(0.1).max(4),
  }),
  settings: naiSettingsSchema,
})

export function parseNaiCanvasDocument(input: unknown): NaiCanvasDocument {
  const result = naiCanvasDocumentSchema.safeParse(input)
  if (!result.success) throw new Error('This file is not a valid NAI canvas.')
  return {
    ...result.data,
    nodes: result.data.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        jobId: undefined,
        status: node.data.status === 'pending' ? 'cancelled' : node.data.status,
      },
    })),
  }
}

export function serializeNaiCanvasDocument(
  document: NaiCanvasDocument
): NaiCanvasDocument {
  return {
    version: 1,
    viewport: document.viewport,
    settings: naiSettingsSchema.parse(document.settings),
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: 'nai-image',
      position: node.position,
      width: node.width,
      height: node.height,
      data: { ...node.data, jobId: undefined },
    })),
  }
}

async function openNaiCanvasDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('new-api-nai-drawing', 1)
    request.addEventListener('upgradeneeded', () =>
      request.result.createObjectStore('canvases')
    )
    request.addEventListener('error', () => reject(request.error))
    request.addEventListener('blocked', () =>
      reject(
        new Error(
          'NAI canvas storage is unavailable. Export your canvas to keep a copy.'
        )
      )
    )
    request.addEventListener('success', () => resolve(request.result))
  })
}

export async function loadNaiCanvasDocument(
  userId: number
): Promise<NaiCanvasDocument | null> {
  const database = await openNaiCanvasDatabase()
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction('canvases', 'readonly')
      const request = transaction.objectStore('canvases').get(userId)
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () => reject(request.error))
    })
    return value ? parseNaiCanvasDocument(value) : null
  } finally {
    database.close()
  }
}

export async function saveNaiCanvasDocument(
  userId: number,
  document: NaiCanvasDocument
): Promise<void> {
  const database = await openNaiCanvasDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('canvases', 'readwrite')
      transaction
        .objectStore('canvases')
        .put(serializeNaiCanvasDocument(document), userId)
      transaction.addEventListener('complete', () => resolve())
      transaction.addEventListener('error', () => reject(transaction.error))
      transaction.addEventListener('abort', () => reject(transaction.error))
    })
  } finally {
    database.close()
  }
}

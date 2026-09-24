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
import { z } from 'zod'

import type { DrawingDocument, ImageSettings } from '../types'
import { isSafeImageSource } from './image-assets'
import { DEFAULT_IMAGE_SETTINGS, settingsForImageModel } from './image-settings'

// The NAI canvas was a separate page before it merged into the drawing page.
// Its documents are still read — from browser storage, from the cloud and from
// exported files — and are converted into drawing documents when opened.

const legacySettingsSchema = z.object({
  group: z.string().trim().default('default'),
  model: z.string().trim().default(''),
  prompt: z.string().max(32000).default(''),
  negativePrompt: z.string().max(32000).default(''),
  width: z.number().int().min(64).max(2048).default(832),
  height: z.number().int().min(64).max(2048).default(1216),
  steps: z.number().int().min(1).max(50).default(28),
  scale: z.number().min(0).max(30).default(5),
  sampler: z
    .enum([
      'k_euler_ancestral',
      'k_euler',
      'k_dpmpp_2s_ancestral',
      'k_dpmpp_2m',
      'k_dpmpp_sde',
      'ddim_v3',
    ])
    .default('k_euler_ancestral'),
  noiseSchedule: z
    .enum(['native', 'karras', 'exponential', 'polyexponential'])
    .default('karras'),
  cfgRescale: z.number().min(0).max(1).default(0),
  seed: z.number().int().min(0).max(4294967295).nullable().default(null),
  n: z.number().int().min(1).max(8).default(1),
  qualityToggle: z.boolean().default(false),
  qualityTier: z.enum(['standard', 'light']).default('standard'),
  ucPreset: z.enum(['heavy', 'light', 'humanFocus', 'none']).default('none'),
  smea: z.boolean().default(false),
  smeaDyn: z.boolean().default(false),
  decrisp: z.boolean().default(false),
})

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
    settings: legacySettingsSchema,
    status: z.enum(['pending', 'complete', 'error', 'cancelled']),
    error: z.string().max(10000).optional(),
    jobId: z.string().max(128).optional(),
    createdAt: z.number().finite(),
    usage: z.record(z.string(), z.unknown()).optional(),
  }),
})

const legacyDocumentSchema = z.object({
  version: z.literal(1),
  nodes: z.array(nodeSchema).max(500),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().min(0.1).max(4),
  }),
  settings: legacySettingsSchema,
})

type LegacyNaiSettings = z.infer<typeof legacySettingsSchema>
export type LegacyNaiDocument = z.infer<typeof legacyDocumentSchema>

export function parseLegacyNaiDocument(input: unknown): LegacyNaiDocument {
  const result = legacyDocumentSchema.safeParse(input)
  if (!result.success) throw new Error('This file is not a valid NAI canvas.')
  return result.data
}

/** The allowlisted form a NAI canvas was stored in. */
export function serializeLegacyNaiDocument(
  document: LegacyNaiDocument
): LegacyNaiDocument {
  return {
    version: 1,
    viewport: document.viewport,
    settings: legacySettingsSchema.parse(document.settings),
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

function drawingSettings(settings: LegacyNaiSettings): ImageSettings {
  return settingsForImageModel(
    { ...DEFAULT_IMAGE_SETTINGS, ...settings, generationMode: 'tags' },
    settings.model
  )
}

/**
 * A NAI canvas as a drawing canvas: the same images, prompts and NovelAI
 * settings, generated with tags. A generation the NAI page left running died
 * with that page, so it is shown as stopped.
 */
export function convertLegacyNaiDocument(
  document: LegacyNaiDocument
): DrawingDocument {
  return {
    version: 1,
    viewport: document.viewport,
    settings: drawingSettings(document.settings),
    edges: [],
    referenceIds: [],
    mask: null,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: 'image',
      dragHandle: '.drawing-node-handle',
      position: node.position,
      width: node.width,
      height: node.height,
      data: {
        ...(node.data.asset ? { asset: node.data.asset } : {}),
        prompt: node.data.prompt,
        settings: drawingSettings(node.data.settings),
        status: node.data.status === 'pending' ? 'cancelled' : node.data.status,
        ...(node.data.error ? { error: node.data.error } : {}),
        createdAt: node.data.createdAt,
        ...(node.data.usage ? { usage: node.data.usage } : {}),
      },
    })),
  }
}

/** Read, never write, the single canvas the NAI page kept before projects. */
export async function loadLegacyNaiDocument(
  userId: number
): Promise<LegacyNaiDocument | null> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('new-api-nai-drawing', 1)
    request.addEventListener('upgradeneeded', () =>
      request.result.createObjectStore('canvases')
    )
    request.addEventListener('error', () => reject(request.error))
    request.addEventListener('blocked', () =>
      reject(
        new Error(
          'Canvas storage is unavailable. Export your canvas to keep a copy.'
        )
      )
    )
    request.addEventListener('success', () => resolve(request.result))
  })
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction('canvases', 'readonly')
      const request = transaction.objectStore('canvases').get(userId)
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () => reject(request.error))
    })
    return value ? parseLegacyNaiDocument(value) : null
  } finally {
    database.close()
  }
}

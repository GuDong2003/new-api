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

import type { DrawingDocument, DrawingNode } from '../types'
import { isSafeImageSource } from './image-assets'
import {
  imageSettingsSchema,
  normalizeStoredImageSettings,
} from './image-settings'

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
  type: z.literal('image'),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  width: z.number().positive().max(10000).optional(),
  height: z.number().positive().max(10000).optional(),
  data: z.object({
    asset: assetSchema.optional(),
    prompt: z.string().max(32000),
    settings: imageSettingsSchema,
    status: z.enum(['pending', 'complete', 'error', 'cancelled']),
    error: z.string().max(10000).optional(),
    revisedPrompt: z.string().max(64000).optional(),
    jobId: z.string().max(128).optional(),
    createdAt: z.number().finite(),
    referenceIds: z.array(z.string()).max(16).optional(),
    mask: assetSchema.optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
  }),
})
export const drawingDocumentSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(nodeSchema).max(500),
    edges: z
      .array(
        z.object({ id: z.string(), source: z.string(), target: z.string() })
      )
      .max(8000),
    viewport: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().min(0.1).max(4),
    }),
    settings: imageSettingsSchema,
    referenceIds: z.array(z.string()).max(16).default([]),
    mask: z
      .object({ referenceId: z.string(), asset: assetSchema })
      .nullable()
      .default(null),
  })
  .superRefine((document, context) => {
    const ids = new Set(document.nodes.map((node) => node.id))
    if (
      ids.size !== document.nodes.length ||
      document.edges.some(
        (edge) => !ids.has(edge.source) || !ids.has(edge.target)
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid canvas nodes or connections.',
      })
    }
    if (
      document.referenceIds.some(
        (id) =>
          !document.nodes.some(
            (node) =>
              node.id === id &&
              node.data.status === 'complete' &&
              node.data.asset
          )
      )
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid reference images.' })
    }
    if (document.mask) {
      const reference = document.nodes.find(
        (node) => node.id === document.referenceIds[0]
      )?.data.asset
      if (
        !reference ||
        document.mask.referenceId !== document.referenceIds[0] ||
        document.mask.asset.mimeType !== 'image/png' ||
        reference.width !== document.mask.asset.width ||
        reference.height !== document.mask.asset.height
      ) {
        context.addIssue({ code: 'custom', message: 'Invalid image mask.' })
      }
    }
  })

export function parseDrawingDocument(input: unknown): DrawingDocument {
  const result = drawingDocumentSchema.safeParse(input)
  if (!result.success) {
    throw new Error('This file is not a valid drawing canvas.')
  }
  return {
    ...result.data,
    nodes: result.data.nodes.map((node) => ({
      ...node,
      dragHandle: '.drawing-node-handle',
      data: {
        ...node.data,
        jobId: undefined,
        status: node.data.status === 'pending' ? 'cancelled' : node.data.status,
      },
    })),
  }
}

export function serializeDrawingDocument(
  document: DrawingDocument
): DrawingDocument {
  return {
    version: 1,
    viewport: document.viewport,
    settings: normalizeStoredImageSettings(document.settings),
    referenceIds: document.referenceIds,
    mask: document.mask,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: 'image',
      position: node.position,
      width: node.width,
      height: node.height,
      data: {
        ...node.data,
        settings: normalizeStoredImageSettings(node.data.settings),
        progress: undefined,
      },
    })),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
  }
}

export function arrangeImageNodes(nodes: DrawingNode[]): DrawingNode[] {
  let y = 0
  const result: DrawingNode[] = []
  for (let index = 0; index < nodes.length; index += 3) {
    const row = nodes.slice(index, index + 3)
    let x = 0
    let rowHeight = 0
    for (const node of row) {
      result.push({ ...node, position: { x, y } })
      x += (node.width || 280) + 40
      rowHeight = Math.max(rowHeight, node.height || 340)
    }
    y += rowHeight + 40
  }
  return result
}

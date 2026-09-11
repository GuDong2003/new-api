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

import {
  parseDrawingDocument,
  serializeDrawingDocument,
} from '../../playground/drawing/lib/canvas-document'
import { isSafeImageSource } from '../../playground/drawing/lib/image-assets'
import type {
  DrawingDocument,
  ImageAsset,
} from '../../playground/drawing/types'
import {
  parseNaiCanvasDocument,
  serializeNaiCanvasDocument,
} from '../../playground/nai/lib/canvas-storage'
import type { NaiCanvasDocument } from '../../playground/nai/types'
import type {
  CanvasAssetRef,
  CanvasAssetRole,
  CanvasBinary,
  CanvasKind,
  LocalCanvas,
} from '../types'

type EditorDocument = DrawingDocument | NaiCanvasDocument
export type CanvasCodecContext = {
  roles?: Readonly<Record<string, { role: CanvasAssetRole; nodeId: string }>>
  existingAssets?: readonly CanvasBinary[]
  // Task 4 captures the session and safe-download policy; no global auth lookup.
  readOriginal?: (asset: ImageAsset, signal?: AbortSignal) => Promise<Blob>
  signal?: AbortSignal
}

const placeholder = 'data:image/png;base64,AA=='
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .optional()
const details = z
  .object({
    text_tokens: count,
    image_tokens: count,
    audio_tokens: count,
    cached_tokens: count,
    reasoning_tokens: count,
    accepted_prediction_tokens: count,
    rejected_prediction_tokens: count,
  })
  .optional()
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  total_tokens: count,
  prompt_tokens: count,
  completion_tokens: count,
  input_tokens_details: details,
  output_tokens_details: details,
  prompt_tokens_details: details,
  completion_tokens_details: details,
})

// Only known asset positions are traversed; arbitrary metadata is never treated
// as a source or fetched. Parsers below own the supported editor schema.
function mapDocumentAssets(
  input: unknown,
  map: (asset: ImageAsset, nodeId: string, mask: boolean) => unknown
): unknown {
  const document = input as EditorDocument
  return {
    ...document,
    nodes: document.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        ...(node.data.asset
          ? { asset: map(node.data.asset, node.id, false) }
          : {}),
        ...('mask' in node.data && node.data.mask
          ? { mask: map(node.data.mask, node.id, true) }
          : {}),
      },
    })),
    ...('mask' in document && document.mask
      ? {
          mask: {
            ...document.mask,
            asset: map(document.mask.asset, document.mask.referenceId, true),
          },
        }
      : {}),
  }
}

function parseDocument(kind: CanvasKind, input: unknown): EditorDocument {
  const parsed =
    kind === 'drawing'
      ? parseDrawingDocument(input)
      : parseNaiCanvasDocument(input)
  for (const node of parsed.nodes) {
    if (node.data.usage) node.data.usage = usageSchema.parse(node.data.usage)
  }
  return parsed
}

function descriptor(asset: ImageAsset): CanvasAssetRef {
  return {
    id: asset.id,
    name: asset.name,
    width: asset.width,
    height: asset.height,
    mimeType: asset.mimeType,
  }
}

/** Validate and allowlist a descriptor-only document without fetching anything. */
export function normalizeCanvasDocument(
  kind: CanvasKind,
  input: unknown
): Record<string, unknown> {
  const parsed = parseDocument(
    kind,
    mapDocumentAssets(input, (asset) => ({ ...asset, src: placeholder }))
  )
  const serialized =
    kind === 'drawing'
      ? serializeDrawingDocument(parsed as DrawingDocument)
      : serializeNaiCanvasDocument(parsed as NaiCanvasDocument)
  return mapDocumentAssets(serialized, (asset) => {
    if (!uuid.test(asset.id)) throw new Error('Invalid canvas asset ID.')
    return descriptor(asset)
  }) as Record<string, unknown>
}

export function canvasDocumentAssetIds(
  document: Record<string, unknown>
): string[] {
  const ids = new Set<string>()
  mapDocumentAssets(document, (asset) => {
    ids.add(asset.id)
    return asset
  })
  return [...ids]
}

export function remapCanvasDocumentAssetIds(
  kind: CanvasKind,
  document: Record<string, unknown>,
  ids: Readonly<Record<string, string>>
): Record<string, unknown> {
  return normalizeCanvasDocument(
    kind,
    mapDocumentAssets(document, (asset) => ({
      ...asset,
      id: ids[asset.id] ?? asset.id,
    }))
  )
}

export async function encodeCanvas(
  kind: CanvasKind,
  document: EditorDocument,
  context: CanvasCodecContext = {}
): Promise<{ document: Record<string, unknown>; assets: CanvasBinary[] }> {
  const sources = new Map<
    string,
    { asset: ImageAsset; nodeId: string; mask: boolean }
  >()
  const ids = new Map<string, string>()
  const prepared = mapDocumentAssets(document, (asset, nodeId, mask) => {
    const previous = sources.get(asset.id)
    if (
      previous &&
      (previous.asset.src !== asset.src ||
        previous.mask !== mask ||
        previous.asset.width !== asset.width ||
        previous.asset.height !== asset.height ||
        previous.asset.mimeType !== asset.mimeType)
    ) {
      throw new Error('Conflicting canvas original.')
    }
    if (!previous) sources.set(asset.id, { asset, nodeId, mask })
    if (!ids.has(asset.id)) {
      ids.set(
        asset.id,
        uuid.test(asset.id) ? asset.id.toLowerCase() : crypto.randomUUID()
      )
    }
    return { ...asset, id: ids.get(asset.id), src: placeholder }
  })
  const normalized = normalizeCanvasDocument(kind, prepared)
  const assets: CanvasBinary[] = []
  for (const [oldId, source] of sources) {
    context.signal?.throwIfAborted()
    const existing = context.existingAssets?.find((item) => item.id === oldId)
    const relation = context.roles?.[oldId] ?? existing
    const role = source.mask ? 'mask' : relation?.role
    if (!role || (!source.mask && role === 'mask')) {
      throw new Error('Canvas original role is required.')
    }
    let blob: Blob
    if (existing) {
      blob = existing.blob
    } else if (
      source.asset.src.startsWith('data:') &&
      isSafeImageSource(source.asset.src)
    ) {
      const bytes = Uint8Array.from(
        atob(source.asset.src.split(',')[1]),
        (char) => char.charCodeAt(0)
      )
      blob = new Blob([bytes], {
        type: source.asset.src.slice(5, source.asset.src.indexOf(';')),
      })
    } else if (
      context.readOriginal &&
      (isSafeImageSource(source.asset.src) ||
        source.asset.src.startsWith('blob:'))
    ) {
      blob = await context.readOriginal(source.asset, context.signal)
    } else {
      throw new Error('Canvas original reader is required.')
    }
    const bytes = await blob.arrayBuffer()
    context.signal?.throwIfAborted()
    if (!bytes.byteLength || blob.type !== source.asset.mimeType) {
      throw new Error('Invalid canvas original bytes.')
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    const id = ids.get(oldId)
    if (!id) throw new Error('Invalid canvas asset ID.')
    assets.push({
      id,
      blob: new Blob([bytes], { type: blob.type }),
      role,
      nodeId: relation?.nodeId ?? source.nodeId,
      sha256,
    })
  }
  return { document: normalized, assets }
}

/** Portable data sources have no session-lifetime object URLs to leak/export. */
export async function decodeCanvas(
  canvas: LocalCanvas,
  assets: CanvasBinary[]
): Promise<EditorDocument> {
  const normalized = normalizeCanvasDocument(canvas.kind, canvas.document)
  const sources = new Map<string, string>()
  for (const id of canvasDocumentAssetIds(normalized)) {
    const binary = assets.find((asset) => asset.id === id)
    if (!binary) throw new Error('Canvas original is unavailable.')
    const bytes = new Uint8Array(await binary.blob.arrayBuffer())
    const chunks: string[] = []
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      chunks.push(
        String.fromCharCode(...bytes.subarray(offset, offset + 16384))
      )
    }
    sources.set(id, `data:${binary.blob.type};base64,${btoa(chunks.join(''))}`)
  }
  // Parse the small descriptors first, avoiding the old reference-upload size
  // ceiling for generated originals. Hydration never changes their bytes.
  const parsed = parseDocument(
    canvas.kind,
    mapDocumentAssets(normalized, (asset) => ({ ...asset, src: placeholder }))
  )
  return mapDocumentAssets(parsed, (asset) => {
    const src = sources.get(asset.id)
    if (!src) throw new Error('Canvas original is unavailable.')
    return { ...asset, src }
  }) as EditorDocument
}

export function pruneCanvasDocumentAsset(
  kind: CanvasKind,
  input: Record<string, unknown>,
  assetId: string
): Record<string, unknown> {
  const document = normalizeCanvasDocument(
    kind,
    input
  ) as unknown as EditorDocument
  const removedNodes = new Set(
    document.nodes
      .filter((node) => node.data.asset?.id === assetId)
      .map((node) => node.id)
  )
  document.nodes = document.nodes.filter(
    (node) => !removedNodes.has(node.id)
  ) as typeof document.nodes
  if ('edges' in document) {
    document.edges = document.edges.filter(
      (edge) => !removedNodes.has(edge.source) && !removedNodes.has(edge.target)
    )
    document.referenceIds = document.referenceIds.filter(
      (id) => !removedNodes.has(id)
    )
    if (
      document.mask &&
      (document.mask.asset.id === assetId ||
        removedNodes.has(document.mask.referenceId))
    ) {
      document.mask = null
    }
    for (const node of document.nodes) {
      const references = node.data.referenceIds ?? []
      if (
        node.data.mask?.id === assetId ||
        references.some((id) => removedNodes.has(id))
      ) {
        delete node.data.mask
      }
      if (node.data.referenceIds) {
        node.data.referenceIds = references.filter(
          (id) => !removedNodes.has(id)
        )
      }
    }
  }
  return normalizeCanvasDocument(kind, document)
}

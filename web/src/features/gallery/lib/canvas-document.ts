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
import {
  IMAGE_MIME_TYPES,
  isSafeImageSource,
} from '../../playground/drawing/lib/image-assets'
import {
  convertLegacyNaiDocument,
  parseLegacyNaiDocument,
  serializeLegacyNaiDocument,
  type LegacyNaiDocument,
} from '../../playground/drawing/lib/legacy-nai-document'
import type {
  DrawingDocument,
  ImageAsset,
} from '../../playground/drawing/types'
import type {
  CanvasAssetRef,
  CanvasAssetRole,
  CanvasBinary,
  CanvasKind,
  LocalCanvas,
} from '../types'
import { adoptCanvasObjectUrls } from './canvas-object-urls'

// A stored canvas is a drawing document, or a NAI document the former NAI page
// saved; the NAI kind is only ever read, and opens as a drawing document.
type StoredDocument = DrawingDocument | LegacyNaiDocument
export type CanvasCodecContext = {
  roles?: Readonly<Record<string, { role: CanvasAssetRole; nodeId: string }>>
  existingAssets?: readonly CanvasBinary[]
  // Task 4 captures the session and safe-download policy; no global auth lookup.
  readOriginal?: (
    asset: ImageAsset,
    signal?: AbortSignal,
    source?: 'gallery-preview'
  ) => Promise<Blob>
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
  const document = input as StoredDocument
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

function parseDocument(kind: CanvasKind, input: unknown): StoredDocument {
  const parsed =
    kind === 'drawing'
      ? parseDrawingDocument(input)
      : parseLegacyNaiDocument(input)
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
      : serializeLegacyNaiDocument(parsed as LegacyNaiDocument)
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

/**
 * A canvas nobody has put anything on yet. Creating one is how you start
 * drawing, so until it holds something it is not a thing worth listing next to
 * the canvases that do.
 */
export function isCanvasDocumentEmpty(
  document: Record<string, unknown>
): boolean {
  const nodes = document.nodes
  return !Array.isArray(nodes) || nodes.length === 0
}

/** Text equal for equal stored documents, whatever order their keys are in. */
export function documentKey(document: unknown): string {
  return (
    JSON.stringify(document, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]])
          )
        : value
    ) ?? ''
  )
}

type MergedNode = {
  id: string
  data: {
    asset?: { id: string }
    mask?: { id: string }
    referenceIds?: string[]
    status?: string
  }
} & Record<string, unknown>
type MergedEdge = { id?: string; source: string; target: string }
type MergedDrawing = {
  nodes: MergedNode[]
  edges: MergedEdge[]
  referenceIds: string[]
  mask: { referenceId: string; asset: { id: string } } | null
  settings: unknown
}

/**
 * A stored drawing canvas once the edits of two tabs meet: `base` is what this
 * tab last read from storage, `mine` holds its edits since and `theirs` what
 * another tab stored meanwhile. A change only one side made is kept. Where both
 * changed the same thing, the same side wins in either tab, so tabs saving in
 * turn settle on one document instead of trading theirs forever. Originals in
 * `removedAssetIds` never come back.
 */
export function mergeCanvasDocuments(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  removedAssetIds: readonly string[]
): Record<string, unknown> {
  const was = base as unknown as MergedDrawing
  const ours = mine as unknown as MergedDrawing
  const other = theirs as unknown as MergedDrawing
  const pick = <T>(before: T, left: T, right: T): T => {
    if (documentKey(left) === documentKey(before)) return right
    if (documentKey(right) === documentKey(before)) return left
    return documentKey(left) <= documentKey(right) ? left : right
  }
  const baseNodes = new Map(was.nodes.map((node) => [node.id, node]))
  const ourNodes = new Set(ours.nodes.map((node) => node.id))
  const otherNodes = new Map(other.nodes.map((node) => [node.id, node]))
  const nodes: MergedNode[] = []
  for (const node of ours.nodes) {
    const before = baseNodes.get(node.id)
    const after = otherNodes.get(node.id)
    if (!before || !after) {
      // Added here, or deleted there after this tab changed it again.
      if (!before || documentKey(node) !== documentKey(before)) nodes.push(node)
      continue
    }
    // Field by field, so a result landing there and a move here both stay.
    const keys = new Set([
      ...Object.keys(before),
      ...Object.keys(node),
      ...Object.keys(after),
    ])
    nodes.push(
      Object.fromEntries(
        [...keys].map((key) => [key, pick(before[key], node[key], after[key])])
      ) as MergedNode
    )
  }
  for (const node of other.nodes) {
    if (!ourNodes.has(node.id) && !baseNodes.has(node.id)) nodes.push(node)
  }
  const removed = new Set(removedAssetIds)
  const kept = nodes.filter(
    (node) => !node.data.asset || !removed.has(node.data.asset.id)
  )
  const ids = new Set(kept.map((node) => node.id))
  const cleaned = kept.map((node) => {
    const references = node.data.referenceIds ?? []
    const remaining = references.filter((id) => ids.has(id))
    if (
      remaining.length === references.length &&
      !(node.data.mask && removed.has(node.data.mask.id))
    ) {
      return node
    }
    // A mask belongs to the references it was drawn for.
    const { mask: _mask, ...data } = node.data
    return {
      ...node,
      data: {
        ...data,
        ...(node.data.referenceIds ? { referenceIds: remaining } : {}),
      },
    }
  })
  const edgeId = (edge: MergedEdge) =>
    edge.id ?? `${edge.source}->${edge.target}`
  const baseEdges = new Set(was.edges.map(edgeId))
  const ourEdges = new Set(ours.edges.map(edgeId))
  const otherEdges = new Set(other.edges.map(edgeId))
  const edges = [
    ...ours.edges.filter(
      (edge) => !baseEdges.has(edgeId(edge)) || otherEdges.has(edgeId(edge))
    ),
    ...other.edges.filter(
      (edge) => !baseEdges.has(edgeId(edge)) && !ourEdges.has(edgeId(edge))
    ),
  ].filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  const complete = new Set(
    cleaned
      .filter((node) => node.data.status === 'complete' && node.data.asset)
      .map((node) => node.id)
  )
  const referenceIds = pick(
    was.referenceIds,
    ours.referenceIds,
    other.referenceIds
  ).filter((id) => complete.has(id))
  const mask = pick(was.mask, ours.mask, other.mask)
  return {
    ...mine,
    settings: pick(was.settings, ours.settings, other.settings),
    referenceIds,
    mask:
      mask &&
      mask.referenceId === referenceIds[0] &&
      !removed.has(mask.asset.id)
        ? mask
        : null,
    nodes: cleaned,
    edges,
  }
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

/**
 * The stored drawing document for a stored NAI document: same assets, nodes
 * and settings. Throws when the NAI document cannot be read.
 */
export function upgradeLegacyNaiCanvasDocument(
  input: Record<string, unknown>
): Record<string, unknown> {
  const legacy = parseLegacyNaiDocument(
    mapDocumentAssets(normalizeCanvasDocument('nai', input), (asset) => ({
      ...asset,
      src: placeholder,
    }))
  )
  return normalizeCanvasDocument('drawing', convertLegacyNaiDocument(legacy))
}

export async function encodeCanvas(
  kind: CanvasKind,
  document: StoredDocument,
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
  // The type an original arrived in wins over the one its asset claimed.
  const types = new Map<string, string>()
  for (const [oldId, source] of sources) {
    context.signal?.throwIfAborted()
    const existing = context.existingAssets?.find((item) => item.id === oldId)
    const relation = context.roles?.[oldId] ?? existing
    const role = source.mask ? 'mask' : relation?.role
    if (!role || (!source.mask && role === 'mask')) {
      throw new Error('Canvas original role is required.')
    }
    const id = ids.get(oldId)
    if (!id) throw new Error('Invalid canvas asset ID.')
    const nodeId = relation?.nodeId ?? source.nodeId
    const src = source.asset.src
    let blob: Blob | undefined
    if (existing && !existing.previewOnly && !existing.remoteSource) {
      blob = existing.blob
    } else if (
      !existing?.previewOnly &&
      src.startsWith('data:') &&
      isSafeImageSource(src)
    ) {
      const type = src.slice(5, src.indexOf(';'))
      // A data source names its own type; one its asset contradicts is corrupt.
      if (type !== source.asset.mimeType) {
        throw new Error('Invalid canvas original bytes.')
      }
      const bytes = Uint8Array.from(atob(src.split(',')[1]), (char) =>
        char.charCodeAt(0)
      )
      blob = new Blob([bytes], { type })
    } else if (
      existing?.previewOnly ||
      isSafeImageSource(src) ||
      src.startsWith('blob:')
    ) {
      if (context.readOriginal) {
        try {
          blob = await context.readOriginal(
            source.asset,
            context.signal,
            existing?.previewOnly ? 'gallery-preview' : undefined
          )
        } catch {
          context.signal?.throwIfAborted()
        }
      }
      // An original out of reach must not cost the rest of the canvas its
      // local save: a preview stays until its original arrives, and a link is
      // kept until a later save can download it.
      if (!blob && existing?.previewOnly) {
        assets.push({ ...existing, id, role, nodeId })
        continue
      }
      if (!blob && /^https?:\/\//i.test(src)) {
        assets.push({
          id,
          blob: new Blob([], { type: source.asset.mimeType }),
          role,
          nodeId,
          sha256: '',
          remoteSource: src,
        })
        continue
      }
      if (!blob) throw new Error('Canvas original is unavailable.')
    } else {
      throw new Error('Canvas original reader is required.')
    }
    const bytes = await blob.arrayBuffer()
    context.signal?.throwIfAborted()
    if (!bytes.byteLength || !IMAGE_MIME_TYPES.includes(blob.type)) {
      throw new Error('Invalid canvas original bytes.')
    }
    if (blob.type !== source.asset.mimeType) types.set(id, blob.type)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    assets.push({
      id,
      blob: new Blob([bytes], { type: blob.type }),
      role,
      nodeId,
      sha256,
    })
  }
  if (!types.size) return { document: normalized, assets }
  return {
    document: normalizeCanvasDocument(
      kind,
      mapDocumentAssets(prepared, (asset) => ({
        ...asset,
        mimeType: types.get(asset.id) ?? asset.mimeType,
      }))
    ),
    assets,
  }
}

/**
 * Data sources are portable — they survive being exported to a file and have no
 * session lifetime to manage — but encoding one costs a base64 pass over every
 * picture in the canvas. Pass `display` when the result is only going to be
 * shown in this tab: the pictures are handed over as object URLs instead, owned
 * by the open canvas and released when it closes.
 */
export async function decodeCanvas(
  canvas: LocalCanvas,
  assets: CanvasBinary[],
  display = false
): Promise<DrawingDocument> {
  const normalized = normalizeCanvasDocument(canvas.kind, canvas.document)
  const sources = new Map<string, string>()
  const urls: string[] = []
  for (const id of canvasDocumentAssetIds(normalized)) {
    const binary = assets.find((asset) => asset.id === id)
    if (!binary) throw new Error('Canvas original is unavailable.')
    if (binary.remoteSource) {
      sources.set(id, binary.remoteSource)
      continue
    }
    if (display) {
      const url = URL.createObjectURL(binary.blob)
      urls.push(url)
      sources.set(id, url)
      continue
    }
    const bytes = new Uint8Array(await binary.blob.arrayBuffer())
    const chunks: string[] = []
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      chunks.push(
        String.fromCharCode(...bytes.subarray(offset, offset + 16384))
      )
    }
    sources.set(id, `data:${binary.blob.type};base64,${btoa(chunks.join(''))}`)
  }
  if (display) adoptCanvasObjectUrls(canvas.kind, urls)
  // Parse the small descriptors first, avoiding the old reference-upload size
  // ceiling for generated originals. Hydration never changes their bytes.
  const parsed = parseDocument(
    canvas.kind,
    mapDocumentAssets(normalized, (asset) => ({ ...asset, src: placeholder }))
  )
  const decoded = mapDocumentAssets(parsed, (asset) => {
    const src = sources.get(asset.id)
    if (!src) throw new Error('Canvas original is unavailable.')
    return {
      ...asset,
      src,
      ...(assets.find((item) => item.id === asset.id)?.previewOnly
        ? { previewOnly: true }
        : {}),
    }
  })
  return canvas.kind === 'nai'
    ? convertLegacyNaiDocument(decoded as LegacyNaiDocument)
    : (decoded as DrawingDocument)
}

export function pruneCanvasDocumentAsset(
  kind: CanvasKind,
  input: Record<string, unknown>,
  assetId: string
): Record<string, unknown> {
  const document = normalizeCanvasDocument(
    kind,
    input
  ) as unknown as StoredDocument
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

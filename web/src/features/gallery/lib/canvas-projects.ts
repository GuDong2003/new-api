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
import { DEFAULT_IMAGE_SETTINGS } from '@/features/playground/drawing/lib/image-settings'
import type { DrawingDocument } from '@/features/playground/drawing/types'
import { DEFAULT_NAI_SETTINGS } from '@/features/playground/nai/lib/nai-settings'
import type { NaiCanvasDocument } from '@/features/playground/nai/types'
import { useDrawingStore } from '@/stores/drawing-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { getCanvasRecord, getGalleryFile } from '../api'
import type {
  CanvasKind,
  CanvasRecord,
  GalleryIdentity,
  LocalCanvas,
} from '../types'
import { decodeCanvas, encodeCanvas } from './canvas-document'
import {
  bindEditor,
  cancelEditorJobs,
  canvasOriginalReader,
  flushLocalEditors,
  getCanvasEditorState,
  sameIdentity,
  storeFor,
  updateState,
} from './canvas-editor'
import { canvasEditors, notifyCanvasProjects } from './canvas-events'
import { migrateLegacyCanvases } from './canvas-migration'
import {
  acknowledgeCanvasSave,
  listLocalCanvases,
  loadLocalCanvas,
  readCanvasAssets,
  readCanvasUserState,
  saveLocalCanvas,
  updateCanvasUserState,
} from './canvas-repository'
import { reconcileCanvasRecord, syncCanvas } from './canvas-sync'
import {
  galleryOwner,
  assertGalleryIdentity,
  isGalleryIdentityCurrent,
} from './session'

type EditorDocument = DrawingDocument | NaiCanvasDocument
export async function exportCanvasProject(
  identity: GalleryIdentity,
  kind: CanvasKind
): Promise<Blob> {
  assertGalleryIdentity(identity)
  const state = storeFor(kind).getState()
  const current = getCanvasEditorState(kind)?.canvas
  const existingAssets = current
    ? await readCanvasAssets(galleryOwner(identity), current.id).catch(() => [])
    : []
  const encoded = await encodeCanvas(kind, state, {
    existingAssets,
    roles: state.assetRoles,
    readOriginal: canvasOriginalReader(identity),
  })
  const portable = await decodeCanvas(
    initialCanvas(identity, kind, encoded.document),
    encoded.assets
  )
  assertGalleryIdentity(identity)
  return new Blob([JSON.stringify(portable, null, 2)], {
    type: 'application/json',
  })
}
function emptyDocument(kind: CanvasKind): EditorDocument {
  const common = {
    version: 1 as const,
    nodes: [],
    viewport: { x: 40, y: 40, zoom: 1 },
  }
  return kind === 'drawing'
    ? {
        ...common,
        settings: { ...DEFAULT_IMAGE_SETTINGS },
        edges: [],
        referenceIds: [],
        mask: null,
      }
    : { ...common, settings: { ...DEFAULT_NAI_SETTINGS } }
}
function initialCanvas(
  identity: GalleryIdentity,
  kind: CanvasKind,
  document: Record<string, unknown>,
  id: string = crypto.randomUUID()
): LocalCanvas {
  return {
    id,
    userId: galleryOwner(identity),
    kind,
    name: kind === 'drawing' ? '新画布' : 'NAI 新画布',
    document,
    revision: 0,
    cloudRevision: 0,
    localSavedAt: 0,
    cloudSavedRevision: 0,
    expiresAt: 0,
    status: 'pending',
    needsExplicitSave: false,
    removedAssetIds: [],
    deleted: false,
  }
}
export async function createCanvasProject(
  identity: GalleryIdentity,
  kind: CanvasKind,
  name?: string
): Promise<LocalCanvas> {
  assertGalleryIdentity(identity)
  const active = canvasEditors.get(kind)
  if (active && sameIdentity(active.identity, identity)) {
    await active.flush()
    if (getCanvasEditorState(kind)?.localStatus !== 'saved') {
      throw new Error('Save or export the current canvas before switching.')
    }
  }
  const encoded = await encodeCanvas(kind, emptyDocument(kind))
  const canvas = await saveLocalCanvas(
    {
      ...initialCanvas(identity, kind, encoded.document),
      ...(name?.trim() ? { name: name.trim().slice(0, 255) } : {}),
      status: 'local',
      needsExplicitSave: true,
    },
    encoded.assets
  )
  await updateCanvasUserState(galleryOwner(identity), (state) => ({
    ...state,
    lastOpened: { ...state.lastOpened, [kind]: canvas.id },
  }))
  if (canvasEditors.has(kind)) await openCanvasProject(identity, canvas.id)
  notifyCanvasProjects()
  return canvas
}
async function downloadCloudCanvas(
  identity: GalleryIdentity,
  remote: CanvasRecord,
  existing?: LocalCanvas
): Promise<LocalCanvas> {
  if (remote.state !== 'ready' || !remote.document) {
    throw new Error('Canvas original is unavailable.')
  }
  const assets = await Promise.all(
    remote.assets.map(async (asset) => ({
      id: asset.id,
      role: asset.role,
      nodeId: asset.node_id,
      sha256: asset.sha256,
      blob: await getGalleryFile(identity, asset.id, false),
    }))
  )
  assertGalleryIdentity(identity)
  const canvas = await saveLocalCanvas(
    {
      ...(existing ??
        initialCanvas(identity, remote.kind, remote.document, remote.id)),
      name: remote.name,
      document: remote.document,
      status: 'pending',
      needsExplicitSave: false,
      cloudRevision: remote.revision,
    },
    assets
  )
  return acknowledgeCanvasSave(galleryOwner(identity), remote.id, {
    localRevision: canvas.revision,
    cloudRevision: remote.revision,
    expiresAt: remote.expires_at,
    assetIdMap: remote.asset_id_map,
    assets: remote.assets,
  })
}
export async function openCanvasProject(
  identity: GalleryIdentity,
  id: string,
  focusAssetId?: string,
  expectedKind?: CanvasKind
): Promise<void> {
  assertGalleryIdentity(identity)
  let canvas = await loadLocalCanvas(galleryOwner(identity), id)
  if (!canvas) {
    canvas = await downloadCloudCanvas(
      identity,
      await getCanvasRecord(identity, id)
    )
  }
  if (canvas.deleted) throw new Error('Canvas has been deleted.')
  if (expectedKind && canvas.kind !== expectedKind) {
    throw new Error('Canvas type does not match this editor.')
  }
  const old = canvasEditors.get(canvas.kind)
  if (old && sameIdentity(old.identity, identity)) {
    await old.flush()
    assertGalleryIdentity(identity)
    if (getCanvasEditorState(canvas.kind)?.localStatus !== 'saved') {
      throw new Error('Save or export the current canvas before switching.')
    }
    if (old.canvasId === id) {
      // The initial lookup predates flush: reopening this same project must
      // hydrate the committed latest editor revision, never that stale object.
      const latest = await loadLocalCanvas(galleryOwner(identity), id)
      assertGalleryIdentity(identity)
      if (!latest || latest.deleted) throw new Error('Canvas has been deleted.')
      canvas = latest
    }
    if (canvasEditors.get(canvas.kind) !== old || !old.isLocallySaved()) {
      throw new Error('The canvas changed. Please try again.')
    }
    cancelEditorJobs(canvas.kind, identity)
    old.stop()
    void syncCanvas(identity, old.canvasId, 'leave')
  } else old?.stop()
  const document = await decodeCanvas(
    canvas,
    await readCanvasAssets(galleryOwner(identity), id)
  )
  assertGalleryIdentity(identity)
  if (canvas.kind === 'drawing') {
    useDrawingStore
      .getState()
      .initialize(galleryOwner(identity), document as DrawingDocument)
  } else {
    useNaiDrawingStore
      .getState()
      .initialize(galleryOwner(identity), document as NaiCanvasDocument)
  }
  await updateCanvasUserState(galleryOwner(identity), (state) => ({
    ...state,
    lastOpened: { ...state.lastOpened, [canvas.kind]: id },
  }))
  bindEditor(identity, canvas)
  if (focusAssetId) {
    const node = storeFor(canvas.kind)
      .getState()
      .nodes.find((node) => node.data.asset?.id === focusAssetId)
    if (node) {
      storeFor(canvas.kind)
        .getState()
        .changeNodes([{ id: node.id, type: 'select', selected: true }])
    }
  }
  // Local content renders first. The owner-scoped state check never replaces edits.
  const opened = canvas
  void getCanvasRecord(identity, id)
    .then((remote) => reconcileCanvasRecord(identity, opened, remote))
    .catch(() => undefined)
}
export async function reloadCanvasProject(
  identity: GalleryIdentity,
  id: string
): Promise<void> {
  const current = await loadLocalCanvas(galleryOwner(identity), id)
  if (!current || current.deleted) throw new Error('Canvas has been deleted.')
  // Deliberate conflict action only; callers confirm discarding their local version.
  const binding = canvasEditors.get(current.kind)
  if (binding?.canvasId === id) {
    await binding.flush()
    binding.stop()
  }
  const latest = await loadLocalCanvas(galleryOwner(identity), id)
  if (!latest || latest.deleted) throw new Error('Canvas has been deleted.')
  await downloadCloudCanvas(
    identity,
    await getCanvasRecord(identity, id),
    latest
  )
  await openCanvasProject(identity, id)
}
export async function renameCanvasProject(
  identity: GalleryIdentity,
  id: string,
  name: string
): Promise<void> {
  assertGalleryIdentity(identity)
  const normalized = name.trim()
  if (
    !normalized ||
    [...normalized].length > 255 ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error('Invalid canvas name.')
  }
  await flushLocalEditors(identity)
  const current =
    (await loadLocalCanvas(galleryOwner(identity), id)) ??
    (await downloadCloudCanvas(identity, await getCanvasRecord(identity, id)))
  if (current.deleted) throw new Error('Canvas has been deleted.')
  if (
    canvasEditors.get(current.kind)?.canvasId === id &&
    getCanvasEditorState(current.kind)?.localStatus !== 'saved'
  ) {
    throw new Error('Save or export the current canvas before switching.')
  }
  const canvas = await saveLocalCanvas(
    { ...current, name: normalized, needsExplicitSave: false },
    []
  )
  if (canvasEditors.get(canvas.kind)?.canvasId === id) {
    updateState(canvas.kind, { canvas, localStatus: 'saved' })
  } else notifyCanvasProjects()
}
const startingEditors = new Map<string, Promise<void>>()
export function startCanvasEditor(
  identity: GalleryIdentity,
  kind: CanvasKind
): Promise<void> {
  const key = `${identity.userId}:${identity.sessionId}:${kind}`
  const pending = startingEditors.get(key)
  if (pending) return pending
  const work = startEditor(identity, kind).finally(() =>
    startingEditors.delete(key)
  )
  startingEditors.set(key, work)
  return work
}
async function startEditor(
  identity: GalleryIdentity,
  kind: CanvasKind
): Promise<void> {
  const existing = canvasEditors.get(kind)
  if (existing && sameIdentity(existing.identity, identity)) return
  existing?.stop()
  assertGalleryIdentity(identity)
  updateState(kind, { canvas: null, localStatus: 'loading' })
  try {
    const state = await readCanvasUserState(galleryOwner(identity))
    const canvases = await listLocalCanvases(galleryOwner(identity))
    const local =
      canvases.find(
        (canvas) => canvas.kind === kind && canvas.id === state.lastOpened[kind]
      ) ?? canvases.find((canvas) => canvas.kind === kind)
    const migrate = () =>
      migrateLegacyCanvases(
        galleryOwner(identity),
        {
          readOriginal: canvasOriginalReader(identity),
        },
        [kind]
      )
    // Existing browser drafts must not depend on legacy originals being online.
    if (local) {
      await openCanvasProject(identity, local.id)
      void migrate()
        .then(() => notifyCanvasProjects())
        .catch(() => undefined)
      return
    }
    const migrated = await migrate().catch(() => [])
    assertGalleryIdentity(identity)
    const selected =
      migrated.find((canvas) => canvas.kind === kind) ??
      (await createCanvasProject(identity, kind))
    const binding = canvasEditors.get(kind)
    if (
      !binding ||
      binding.canvasId !== selected.id ||
      !sameIdentity(binding.identity, identity)
    ) {
      await openCanvasProject(identity, selected.id)
    }
  } catch (error) {
    if (isGalleryIdentityCurrent(identity)) {
      updateState(kind, {
        canvas: null,
        localStatus: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'Canvas storage is unavailable.',
      })
    }
    throw error
  }
}

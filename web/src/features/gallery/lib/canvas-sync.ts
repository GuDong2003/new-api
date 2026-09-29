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
import axios from 'axios'
import i18next from 'i18next'
import { toast } from 'sonner'

import { useAuthStore } from '@/stores/auth-store'

import { getCanvasRecord, getGalleryUsage, saveCanvasRecord } from '../api'
import type {
  CanvasBinary,
  CanvasCloudBase,
  CanvasKind,
  CanvasRecord,
  CanvasSaveMetadata,
  GalleryIdentity,
  LocalCanvas,
  GalleryUsage,
} from '../types'
import {
  canvasContentKey,
  canvasDocumentAssetIds,
  mergeCanvasDocuments,
  normalizeCanvasDocument,
} from './canvas-document'
import {
  canvasEditors,
  emitCanvasEvent,
  notifyCanvasProjects,
} from './canvas-events'
import { enqueueCanvasMutation } from './canvas-mutation-queue'
import {
  acknowledgeCanvasSave,
  listLocalCanvases,
  loadLocalCanvas,
  readCanvasAssets,
  readCanvasUserState,
  removeLocalCanvas,
  removeLocalCanvasAsset,
  retireCanvasMasks,
  saveLocalCanvas,
  updateCanvasCloudState,
  updateCanvasUserState,
} from './canvas-repository'
import { loadGalleryFile } from './gallery-file-source'
import {
  galleryOwner,
  assertGalleryIdentity,
  isGalleryIdentityCurrent,
} from './session'

export const CANVAS_CLOUD_INTERVAL = 300_000
// Coming back to a canvas looks at the cloud copy at most this often.
const CANVAS_PULL_INTERVAL = 10_000
export const CANVAS_FULL_MESSAGE =
  'Saved locally. Cloud storage is full; upload is paused.'
type Session = {
  identity: GalleryIdentity
  controller: AbortController
  uploads: Map<string, Promise<void>>
  requests: Map<string, AbortController>
  lastUploads: Map<string, number>
  lastPulls: Map<string, number>
}
const sessions = new Map<string, Session>()
const key = (identity: GalleryIdentity) =>
  `${identity.userId}:${identity.sessionId}`
function sessionFor(identity: GalleryIdentity) {
  assertGalleryIdentity(identity)
  let session = sessions.get(key(identity))
  if (!session) {
    session = {
      identity: { ...identity },
      controller: new AbortController(),
      uploads: new Map(),
      requests: new Map(),
      lastUploads: new Map(),
      lastPulls: new Map(),
    }
    sessions.set(key(identity), session)
  }
  return session
}
export function cancelCanvasSession(identity: GalleryIdentity) {
  const session = sessions.get(key(identity))
  session?.controller.abort()
  session?.requests.forEach((controller) => controller.abort())
  sessions.delete(key(identity))
}
export function cancelCanvasUpload(identity: GalleryIdentity, id: string) {
  sessions.get(key(identity))?.requests.get(id)?.abort()
}
useAuthStore.subscribe((state, previous) => {
  if (
    state.auth.user?.id !== previous.auth.user?.id ||
    state.auth.session?.sid !== previous.auth.session?.sid
  ) {
    cancelCanvasSession({
      userId: previous.auth.user?.id ?? null,
      sessionId: previous.auth.session?.sid ?? null,
    })
  }
})
export function canvasResponseStatus(error: unknown) {
  return axios.isAxiosError(error) ? error.response?.status : undefined
}
async function cloudStatus(
  identity: GalleryIdentity,
  id: string,
  status: LocalCanvas['status']
) {
  const canvas = await updateCanvasCloudState(
    galleryOwner(identity),
    id,
    (current) => ({ ...current, status })
  )
  if (canvas) await emitCanvasEvent({ identity, canvas })
}
async function pause(
  identity: GalleryIdentity,
  bytes: number,
  images: number,
  reason: string
) {
  let notify = false
  await updateCanvasUserState(galleryOwner(identity), (state) => {
    notify = !state.cloudPause?.notified
    return {
      ...state,
      cloudPause: {
        reason,
        requiredBytes: Math.max(bytes, state.cloudPause?.requiredBytes ?? 0),
        requiredImages: Math.max(images, state.cloudPause?.requiredImages ?? 0),
        lastQuotaCheck: Date.now(),
        notified: true,
      },
    }
  })
  if (notify && isGalleryIdentityCurrent(identity)) {
    toast.warning(i18next.t(CANVAS_FULL_MESSAGE))
  }
  notifyCanvasProjects()
}

/**
 * What a cloud record holds, in the form this browser stores a canvas. The
 * server leaves out fields it does not know, so only in that form do a cloud
 * version and a copy stored here compare and merge field by field.
 */
export function cloudBaseOf(
  kind: CanvasKind,
  record: Pick<CanvasRecord, 'revision' | 'name' | 'document'>
): CanvasCloudBase | undefined {
  if (!record.document) return undefined
  try {
    return {
      revision: record.revision,
      name: record.name,
      document: normalizeCanvasDocument(kind, record.document),
    }
  } catch {
    return undefined
  }
}

export async function reconcileCanvasRecord(
  identity: GalleryIdentity,
  local: LocalCanvas,
  remote: CanvasRecord
): Promise<LocalCanvas | null> {
  if (remote.state === 'deleted') {
    await removeLocalCanvas(galleryOwner(identity), local.id)
    await updateCanvasUserState(galleryOwner(identity), (state) => ({
      ...state,
      pendingCanvasRemovals: state.pendingCanvasRemovals.filter(
        (item) => item.canvasId !== local.id
      ),
    }))
    const deleted = await loadLocalCanvas(galleryOwner(identity), local.id)
    if (!deleted) return null
    await emitCanvasEvent({ identity, canvas: deleted })
    return null
  }
  const removed = remote.removed_asset_ids.filter(
    (id) => !local.removedAssetIds.includes(id)
  )
  const stored = await readCanvasAssets(galleryOwner(identity), local.id)
  for (const id of removed) {
    if (stored.some((asset) => asset.id === id)) {
      await removeLocalCanvasAsset(galleryOwner(identity), local.id, id)
    }
  }
  if (removed.length) {
    await updateCanvasUserState(galleryOwner(identity), (state) => ({
      ...state,
      pendingAssetRemovals: state.pendingAssetRemovals.filter(
        (item) =>
          item.canvasId !== local.id ||
          !remote.removed_asset_ids.includes(item.assetId)
      ),
    }))
    const pruned = await loadLocalCanvas(galleryOwner(identity), local.id)
    if (!pruned) return null
    await emitCanvasEvent({ identity, canvas: pruned, removedIds: removed })
    local = pruned
  }
  if (remote.state === 'expired') {
    const canvas = await updateCanvasCloudState(
      galleryOwner(identity),
      local.id,
      (current) => ({
        ...current,
        cloudRevision: remote.revision,
        cloudSavedRevision: 0,
        expiresAt: 0,
        status: 'local',
        needsExplicitSave:
          current.needsExplicitSave ||
          current.revision === current.cloudSavedRevision,
      })
    )
    if (canvas) await emitCanvasEvent({ identity, canvas })
    return canvas
  }
  // A slow answer can come after this copy already moved on.
  if (remote.revision < local.cloudRevision) return local
  if (remote.revision !== local.cloudRevision) {
    const cloud = cloudBaseOf(local.kind, remote)
    // Each device keeps its own view of a canvas, which is no edit to it.
    if (
      cloud &&
      canvasContentKey(cloud.document) === canvasContentKey(local.document) &&
      remote.name === local.name
    ) {
      // The map names what an upload from here was given. Another device's
      // upload renamed images this browser never held.
      const assetIdMap = Object.fromEntries(
        Object.entries(remote.asset_id_map).filter(([sourceId]) =>
          stored.some((asset) => asset.id === sourceId)
        )
      )
      const acknowledged = await acknowledgeCanvasSave(
        galleryOwner(identity),
        local.id,
        {
          localRevision: local.revision,
          cloudRevision: remote.revision,
          expiresAt: remote.expires_at,
          assetIdMap,
          assets: remote.assets,
          cloudBase: cloud,
        }
      )
      await emitCanvasEvent({ identity, canvas: acknowledged, assetIdMap })
      return acknowledged
    }
    const adopted = await adoptCloudCanvas(identity, local, remote)
    if (adopted) return adopted
    await cloudStatus(identity, local.id, 'conflict')
    return null
  }
  return local
}

/**
 * Brings this browser's copy of a canvas up to a newer cloud version, such as
 * one another device saved. A copy with nothing left to upload takes that
 * version as it is. One with edits of its own merges them onto it from the
 * version both started from, and still owes the cloud the result. Without that
 * version nothing tells which side changed what, so it stays for the owner to
 * resolve.
 */
async function adoptCloudCanvas(
  identity: GalleryIdentity,
  local: LocalCanvas,
  remote: CanvasRecord
): Promise<LocalCanvas | null> {
  const cloudBase = cloudBaseOf(local.kind, remote)
  if (remote.state !== 'ready' || !cloudBase || remote.kind !== local.kind) {
    return null
  }
  const cloudDocument = cloudBase.document
  const owner = galleryOwner(identity)
  const current = await loadLocalCanvas(owner, local.id)
  if (!current || current.deleted) return null
  // A copy with edits of its own merges only from the version it still
  // follows, and only a drawing canvas merges at all. Otherwise its pictures
  // are not worth fetching.
  if (
    current.revision !== current.cloudSavedRevision &&
    (current.cloudBase?.revision !== current.cloudRevision ||
      current.kind !== 'drawing')
  ) {
    return null
  }
  // Its pictures arrive first and outside the queue: they take as long as they
  // take, and edits made here meanwhile go on being saved.
  const stored = await readCanvasAssets(owner, local.id)
  const shown = new Set(canvasDocumentAssetIds(cloudDocument))
  const arrived: CanvasBinary[] = await Promise.all(
    remote.assets
      .filter(
        (asset) =>
          shown.has(asset.id) && !stored.some((item) => item.id === asset.id)
      )
      .map(async (asset) => ({
        id: asset.id,
        role: asset.role,
        nodeId: asset.node_id,
        sha256: asset.sha256,
        previewOnly: asset.has_thumbnail,
        blob: await loadGalleryFile(
          identity,
          asset.id,
          asset.has_thumbnail,
          sessionFor(identity).controller.signal
        ),
      }))
  )
  assertGalleryIdentity(identity)
  const adopted = await enqueueCanvasMutation(identity, local.id, async () => {
    const latest = await loadLocalCanvas(owner, local.id)
    if (!latest || latest.deleted) return null
    // This copy reached that version, or a later one, meanwhile.
    if (remote.revision <= latest.cloudRevision) return latest
    const unchanged = latest.revision === latest.cloudSavedRevision
    let name = remote.name
    // Where this device's view stands stays its own.
    let document: Record<string, unknown> = {
      ...cloudDocument,
      viewport: latest.document.viewport,
    }
    if (!unchanged) {
      // Only the version the copy still follows is what both sides started from.
      const base =
        latest.cloudBase?.revision === latest.cloudRevision
          ? latest.cloudBase
          : undefined
      // The former NAI page stored another kind of canvas, which has no merge.
      if (!base || latest.kind !== 'drawing') return null
      const merged = mergeCanvasDocuments(
        base.document,
        latest.document,
        cloudDocument,
        [...latest.removedAssetIds, ...remote.removed_asset_ids]
      )
      try {
        document = normalizeCanvasDocument(latest.kind, merged)
      } catch {
        // A mask can end up fitting neither side's reference image.
        document = normalizeCanvasDocument(latest.kind, {
          ...merged,
          mask: null,
        })
      }
      // Renamed on one side only, the new name stands; renamed on both, both
      // devices settle on the same one.
      if (latest.name === base.name) name = remote.name
      else if (remote.name === base.name) name = latest.name
      else name = latest.name <= remote.name ? latest.name : remote.name
    }
    const kept = new Set(canvasDocumentAssetIds(document))
    const saved = await saveLocalCanvas(
      {
        ...latest,
        name,
        document,
        status: 'pending',
        needsExplicitSave: false,
        // Merged edits are a successor of the version they were merged onto.
        ...(unchanged
          ? {}
          : {
              cloudRevision: remote.revision,
              expiresAt: remote.expires_at,
              cloudBase,
            }),
      },
      arrived.filter((asset) => kept.has(asset.id))
    )
    if (!unchanged) return saved
    return acknowledgeCanvasSave(owner, local.id, {
      localRevision: saved.revision,
      cloudRevision: remote.revision,
      expiresAt: remote.expires_at,
      // The cloud's version already names every image as the cloud does.
      assetIdMap: {},
      assets: remote.assets,
      cloudBase,
    })
  })
  if (!adopted) return null
  await emitCanvasEvent({ identity, canvas: adopted })
  // The open editor shows the new version once it looks at storage again,
  // merging in whatever it has not saved yet.
  await [...canvasEditors.values()]
    .find(
      (editor) =>
        editor.canvasId === local.id && key(editor.identity) === key(identity)
    )
    ?.flush()
  return adopted
}

async function upload(
  session: Session,
  id: string,
  reason: 'timer' | 'leave' | 'manual',
  afterConflict = false
) {
  const { identity } = session
  const userId = galleryOwner(identity)
  const controller = new AbortController()
  session.requests.set(id, controller)
  const signal = AbortSignal.any([controller.signal, session.controller.signal])
  let requiredBytes = 0
  let requiredImages = 0
  try {
    let canvas = await loadLocalCanvas(userId, id)
    if (!canvas || canvas.deleted || canvas.status === 'conflict') return
    const activeEditor = [...canvasEditors.values()].find(
      (editor) =>
        editor.canvasId === id && key(editor.identity) === key(identity)
    )
    if (activeEditor && !activeEditor.isLocallySaved()) return
    const userState = await readCanvasUserState(userId)
    if (
      userState.cloudPause ||
      userState.pendingCanvasRemovals.some((item) => item.canvasId === id) ||
      userState.pendingAssetRemovals.some((item) => item.canvasId === id)
    ) {
      return
    }
    if (
      reason === 'timer' &&
      Date.now() - (session.lastUploads.get(id) ?? 0) < CANVAS_CLOUD_INTERVAL
    ) {
      return
    }
    let remote: CanvasRecord | null = null
    try {
      remote = await getCanvasRecord(identity, id, signal)
    } catch (error) {
      if (canvasResponseStatus(error) !== 404) throw error
    }
    signal.throwIfAborted()
    if (remote) canvas = await reconcileCanvasRecord(identity, canvas, remote)
    if (!canvas || canvas.deleted || canvas.status === 'conflict') return
    if (canvas.needsExplicitSave && reason !== 'manual') return
    if (canvas.revision === canvas.cloudSavedRevision) return
    const ids = new Set(canvasDocumentAssetIds(canvas.document))
    const assets = (await readCanvasAssets(userId, id)).filter((asset) =>
      ids.has(asset.id)
    )
    if (assets.length !== ids.size) {
      throw new Error('Canvas original is unavailable.')
    }
    // The cloud needs the bytes; a canvas still holding an original only as a
    // link uploads once a local save has downloaded it.
    if (assets.some((asset) => asset.remoteSource)) return
    const newAssets = assets.filter(
      (asset) =>
        !remote?.assets.some(
          (existing) =>
            existing.id === asset.id && existing.sha256 === asset.sha256
        )
    )
    // The cloud leaves out an original whose file it lost. A preview cannot
    // replace it; a browser that holds the original uploads it again.
    if (newAssets.some((asset) => asset.previewOnly)) return
    const metadata: CanvasSaveMetadata = {
      id,
      kind: canvas.kind,
      name: canvas.name,
      base_revision: canvas.cloudRevision,
      mutation_id: '',
      document: canvas.document,
      ...(canvas.needsExplicitSave ? { explicit_save: true } : {}),
      assets: assets.map((asset) => ({
        id: asset.id,
        role: asset.role,
        node_id: asset.nodeId,
        bytes: asset.blob.size,
        sha256: asset.sha256,
      })),
    }
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(metadata))
    )
    metadata.mutation_id = Array.from(
      new Uint8Array(digest).slice(0, 16),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('')
    requiredBytes =
      new TextEncoder().encode(JSON.stringify(metadata)).length +
      4096 +
      newAssets.reduce((sum, asset) => sum + asset.blob.size, 0)
    requiredImages = newAssets.filter((asset) => asset.role !== 'mask').length
    const budget = await getGalleryUsage(identity, signal, {
      required_bytes: requiredBytes,
      required_images: requiredImages,
    })
    if (!budget.can_save) {
      if (budget.reason === 'Gallery storage limit reached.') {
        await pause(identity, requiredBytes, requiredImages, budget.reason)
      } else await cloudStatus(identity, id, 'error')
      return
    }
    signal.throwIfAborted()
    if ((await readCanvasUserState(userId)).cloudPause) return
    const latest = await loadLocalCanvas(userId, id)
    if (
      !latest ||
      latest.deleted ||
      latest.removedAssetIds.some((removed) => ids.has(removed))
    ) {
      return
    }
    session.lastUploads.set(id, Date.now())
    const saved = await saveCanvasRecord(identity, metadata, newAssets, signal)
    signal.throwIfAborted()
    const acknowledged = await acknowledgeCanvasSave(userId, id, {
      localRevision: canvas.revision,
      cloudRevision: saved.revision,
      expiresAt: saved.expires_at,
      assetIdMap: saved.asset_id_map,
      assets: saved.assets,
      cloudBase: cloudBaseOf(canvas.kind, saved),
    })
    await emitCanvasEvent({
      identity,
      canvas: acknowledged,
      assetIdMap: saved.asset_id_map,
    })
    const binding = [...canvasEditors.values()].find(
      (editor) =>
        editor.canvasId === id && key(editor.identity) === key(identity)
    )
    await retireCanvasMasks(
      userId,
      id,
      canvas.revision,
      binding?.retainedAssetIds() ?? []
    )
  } catch (error) {
    if (signal.aborted || !isGalleryIdentityCurrent(identity)) return
    if (
      canvasResponseStatus(error) === 410 ||
      canvasResponseStatus(error) === 409
    ) {
      if (
        canvasResponseStatus(error) === 409 &&
        axios.isAxiosError(error) &&
        error.response?.data?.message === 'Gallery storage limit reached.'
      ) {
        await pause(
          identity,
          requiredBytes,
          requiredImages,
          String(
            error.response?.data?.message ?? 'Gallery storage limit reached.'
          )
        )
      } else if (
        canvasResponseStatus(error) === 410 ||
        (axios.isAxiosError(error) &&
          error.response?.data?.code === 'canvas_conflict')
      ) {
        let resolved = false
        let owed = false
        let failed = false
        try {
          const latest = await loadLocalCanvas(userId, id)
          const remote = await getCanvasRecord(identity, id, signal)
          if (latest) {
            const reconciled = await reconcileCanvasRecord(
              identity,
              latest,
              remote
            )
            // Another device saved first, and what it saved was taken in here.
            if (
              reconciled &&
              reconciled.cloudRevision !== latest.cloudRevision
            ) {
              resolved = true
              owed = reconciled.revision !== reconciled.cloudSavedRevision
            }
          }
        } catch {
          // A picture that failed to download, say, leaves the canvas as it
          // was; a later sync catches up with the cloud again.
          failed = true
        }
        if (failed) {
          await cloudStatus(identity, id, 'error')
        } else if (canvasResponseStatus(error) !== 410 && !resolved) {
          await cloudStatus(identity, id, 'conflict')
        } else if (owed && !afterConflict) {
          // The merge goes up now rather than with the next timer.
          await upload(session, id, 'leave', true)
        }
      } else await cloudStatus(identity, id, 'error')
    } else await cloudStatus(identity, id, 'error')
  } finally {
    session.requests.delete(id)
  }
}

export async function syncCanvas(
  identity: GalleryIdentity,
  canvasId: string,
  reason: 'timer' | 'leave' | 'manual'
): Promise<void> {
  if (!isGalleryIdentityCurrent(identity)) return
  const session = sessionFor(identity)
  const pending = session.uploads.get(canvasId)
  if (pending) {
    await pending
    return
  }
  const work = upload(session, canvasId, reason).finally(() =>
    session.uploads.delete(canvasId)
  )
  session.uploads.set(canvasId, work)
  await work
}

/**
 * Looks at the cloud copy for a version saved elsewhere, such as on another
 * device, and brings this browser's copy up to it.
 */
export async function pullCanvas(
  identity: GalleryIdentity,
  canvasId: string
): Promise<void> {
  if (!isGalleryIdentityCurrent(identity)) return
  const session = sessionFor(identity)
  // An upload looks at the cloud copy on its own.
  if (session.uploads.has(canvasId)) return
  if (
    Date.now() - (session.lastPulls.get(canvasId) ?? 0) <
    CANVAS_PULL_INTERVAL
  ) {
    return
  }
  session.lastPulls.set(canvasId, Date.now())
  const owner = galleryOwner(identity)
  const canvas = await loadLocalCanvas(owner, canvasId)
  if (
    !canvas ||
    canvas.deleted ||
    canvas.status === 'conflict' ||
    canvas.cloudRevision === 0
  ) {
    return
  }
  try {
    const remote = await getCanvasRecord(
      identity,
      canvasId,
      session.controller.signal
    )
    if (remote.revision === canvas.cloudRevision && remote.state === 'ready') {
      return
    }
    const latest = await loadLocalCanvas(owner, canvasId)
    if (!latest || latest.deleted || latest.status === 'conflict') return
    const reconciled = await reconcileCanvasRecord(identity, latest, remote)
    // Merged edits from here are still owed to the cloud.
    if (reconciled && reconciled.revision !== reconciled.cloudSavedRevision) {
      await syncCanvas(identity, canvasId, 'leave')
    }
  } catch {
    // The next sync looks at the cloud copy again.
  }
}

/**
 * Uploads a canvas another device may be waiting on, without waiting for the
 * timer: the task a generation started, then what the task produced.
 */
export async function syncCanvasNow(
  identity: GalleryIdentity,
  canvasId: string
): Promise<void> {
  if (!isGalleryIdentityCurrent(identity)) return
  try {
    await [...canvasEditors.values()]
      .find(
        (editor) =>
          editor.canvasId === canvasId && key(editor.identity) === key(identity)
      )
      ?.flush()
    // An upload already under way read the canvas before this change.
    await sessions.get(key(identity))?.uploads.get(canvasId)
    await syncCanvas(identity, canvasId, 'leave')
  } catch {
    // The timer uploads it later.
  }
}

export async function checkCanvasCapacity(
  identity: GalleryIdentity,
  forceAfterDelete = false
): Promise<GalleryUsage | undefined> {
  const session = sessionFor(identity)
  const pauseState = (await readCanvasUserState(galleryOwner(identity)))
    .cloudPause
  if (
    !pauseState ||
    (!forceAfterDelete &&
      Date.now() - pauseState.lastQuotaCheck < CANVAS_CLOUD_INTERVAL)
  ) {
    return
  }
  let allowed = false
  await updateCanvasUserState(galleryOwner(identity), (current) => {
    if (
      !current.cloudPause ||
      (!forceAfterDelete &&
        Date.now() - current.cloudPause.lastQuotaCheck < CANVAS_CLOUD_INTERVAL)
    ) {
      return current
    }
    allowed = true
    return {
      ...current,
      cloudPause: { ...current.cloudPause, lastQuotaCheck: Date.now() },
    }
  })
  if (!allowed) return
  const budget = await getGalleryUsage(identity, session.controller.signal, {
    required_bytes: pauseState.requiredBytes,
    required_images: pauseState.requiredImages,
  })
  if (!budget.can_save) return budget
  await updateCanvasUserState(galleryOwner(identity), (current) => ({
    ...current,
    cloudPause: null,
  }))
  notifyCanvasProjects()
  for (const canvas of await listLocalCanvases(galleryOwner(identity))) {
    if (
      !canvas.needsExplicitSave &&
      canvas.revision !== canvas.cloudSavedRevision
    ) {
      await syncCanvas(identity, canvas.id, 'leave')
    }
  }
  return budget
}

/** Gallery refresh respects the same durable quota-check clock as editor sync. */
export async function getCanvasGalleryUsage(
  identity: GalleryIdentity,
  signal?: AbortSignal
) {
  const state = await readCanvasUserState(galleryOwner(identity)).catch(
    () => null
  )
  if (state?.cloudPause) return (await checkCanvasCapacity(identity)) ?? null
  return getGalleryUsage(identity, signal)
}

export async function flushCanvasSession(
  identity: GalleryIdentity,
  options: { syncCloud?: boolean } = {}
): Promise<void> {
  if (!isGalleryIdentityCurrent(identity)) return
  const local = Promise.all(
    [...canvasEditors.values()]
      .filter((editor) => key(editor.identity) === key(identity))
      .map((editor) => editor.flush())
  )
  const work = local
    .then(async () => {
      if (options.syncCloud === false) return
      if ((await readCanvasUserState(galleryOwner(identity))).cloudPause) return
      for (const canvas of await listLocalCanvases(galleryOwner(identity))) {
        await syncCanvas(identity, canvas.id, 'leave')
      }
    })
    .catch(() => undefined)
  let timeout: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        cancelCanvasSession(identity)
        resolve()
      }, 5000)
    }),
  ])
  if (timeout) clearTimeout(timeout)
}

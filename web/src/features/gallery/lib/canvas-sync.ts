import axios from 'axios'
import i18next from 'i18next'
import { toast } from 'sonner'

import { useAuthStore } from '@/stores/auth-store'

import { getCanvasRecord, getGalleryUsage, saveCanvasRecord } from '../api'
import type {
  CanvasRecord,
  CanvasSaveMetadata,
  GalleryIdentity,
  LocalCanvas,
} from '../types'
import { canvasDocumentAssetIds } from './canvas-document'
import {
  canvasEditors,
  emitCanvasEvent,
  notifyCanvasProjects,
} from './canvas-events'
import {
  acknowledgeCanvasSave,
  listLocalCanvases,
  loadLocalCanvas,
  readCanvasAssets,
  readCanvasUserState,
  removeLocalCanvas,
  removeLocalCanvasAsset,
  retireCanvasMasks,
  updateCanvasCloudState,
  updateCanvasUserState,
} from './canvas-repository'
import {
  galleryOwner,
  assertGalleryIdentity,
  isGalleryIdentityCurrent,
} from './session'

export const CANVAS_CLOUD_INTERVAL = 300_000
export const CANVAS_FULL_MESSAGE = '已保存到本地，云端空间不足，暂未上传。'
type Session = {
  identity: GalleryIdentity
  controller: AbortController
  uploads: Map<string, Promise<void>>
  requests: Map<string, AbortController>
  lastUploads: Map<string, number>
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
function documentKey(document: unknown): string {
  return JSON.stringify(document, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]])
        )
      : value
  )
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
  if (remote.revision !== local.cloudRevision) {
    if (
      documentKey(remote.document) === documentKey(local.document) &&
      remote.name === local.name
    ) {
      const acknowledged = await acknowledgeCanvasSave(
        galleryOwner(identity),
        local.id,
        {
          localRevision: local.revision,
          cloudRevision: remote.revision,
          expiresAt: remote.expires_at,
          assetIdMap: remote.asset_id_map,
          assets: remote.assets,
        }
      )
      await emitCanvasEvent({
        identity,
        canvas: acknowledged,
        assetIdMap: remote.asset_id_map,
      })
      return acknowledged
    }
    await cloudStatus(identity, local.id, 'conflict')
    return null
  }
  return local
}

async function upload(
  session: Session,
  id: string,
  reason: 'timer' | 'leave' | 'manual'
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
      (editor) => editor.canvasId === id && editor.identity.userId === userId
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
    if (
      remote &&
      !(
        canvas.status === 'error' &&
        remote.state === 'ready' &&
        remote.revision !== canvas.cloudRevision &&
        documentKey(remote.document) !== documentKey(canvas.document)
      )
    ) {
      canvas = await reconcileCanvasRecord(identity, canvas, remote)
    }
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
    const newAssets = assets.filter(
      (asset) =>
        !remote?.assets.some(
          (existing) =>
            existing.id === asset.id && existing.sha256 === asset.sha256
        )
    )
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
      await pause(identity, requiredBytes, requiredImages, budget.reason)
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
    })
    await emitCanvasEvent({
      identity,
      canvas: acknowledged,
      assetIdMap: saved.asset_id_map,
    })
    const binding = [...canvasEditors.values()].find(
      (editor) => editor.canvasId === id && editor.identity.userId === userId
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
        error.response?.data?.code !== 'canvas_conflict'
      ) {
        await pause(
          identity,
          requiredBytes,
          requiredImages,
          String(
            error.response?.data?.message ?? 'Gallery storage limit reached.'
          )
        )
      } else {
        try {
          const latest = await loadLocalCanvas(userId, id)
          const remote = await getCanvasRecord(identity, id, signal)
          if (latest) await reconcileCanvasRecord(identity, latest, remote)
        } catch {
          /* Last complete local content remains available. */
        }
        if (canvasResponseStatus(error) !== 410) {
          await cloudStatus(identity, id, 'conflict')
        }
      }
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

export async function checkCanvasCapacity(
  identity: GalleryIdentity,
  forceAfterDelete = false
): Promise<void> {
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
  if (!budget.can_save) return
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
}

export async function flushCanvasSession(
  identity: GalleryIdentity
): Promise<void> {
  if (!isGalleryIdentityCurrent(identity)) return
  const local = Promise.all(
    [...canvasEditors.values()]
      .filter((editor) => key(editor.identity) === key(identity))
      .map((editor) => editor.flush())
  )
  const work = local
    .then(async () => {
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

import { deleteCanvasRecord, getCanvasRecord } from '../api'
import type { CanvasRecord, GalleryIdentity } from '../types'
import { emitCanvasEvent } from './canvas-events'
import {
  loadLocalCanvas,
  readCanvasUserState,
  removeLocalCanvas,
  removeLocalCanvasAsset,
  updateCanvasCloudState,
  updateCanvasUserState,
} from './canvas-repository'
import {
  cancelCanvasUpload,
  canvasResponseStatus,
  checkCanvasCapacity,
} from './canvas-sync'
import { galleryOwner, assertGalleryIdentity } from './session'

export async function replayCanvasRemovals(
  identity: GalleryIdentity
): Promise<void> {
  assertGalleryIdentity(identity)
  const state = await readCanvasUserState(galleryOwner(identity))
  for (const item of [
    ...state.pendingCanvasRemovals,
    ...state.pendingAssetRemovals,
  ]) {
    const assetId =
      'assetId' in item && typeof item.assetId === 'string'
        ? item.assetId
        : undefined
    try {
      let remote: CanvasRecord | null = null
      try {
        remote = await getCanvasRecord(identity, item.canvasId)
      } catch (error) {
        if (canvasResponseStatus(error) !== 404) throw error
      }
      if (
        remote &&
        remote.state !== 'deleted' &&
        (!assetId || !remote.removed_asset_ids.includes(assetId))
      ) {
        remote = await deleteCanvasRecord(
          identity,
          item.canvasId,
          remote.revision,
          assetId
        )
      }
      assertGalleryIdentity(identity)
      await updateCanvasUserState(galleryOwner(identity), (current) => ({
        ...current,
        pendingCanvasRemovals: current.pendingCanvasRemovals.filter(
          (entry) => Boolean(assetId) || entry.canvasId !== item.canvasId
        ),
        pendingAssetRemovals: current.pendingAssetRemovals.filter(
          (entry) =>
            entry.canvasId !== item.canvasId ||
            Boolean(assetId && entry.assetId !== assetId)
        ),
      }))
      if (assetId && remote) {
        const cloudRevision = remote.revision
        await updateCanvasCloudState(
          galleryOwner(identity),
          item.canvasId,
          (current) => ({ ...current, cloudRevision })
        )
      }
      if (remote) await checkCanvasCapacity(identity, true)
    } catch {
      /* Durable intent survives offline/conflicting sessions for replay. */
    }
  }
}

/** Call only after a confirmed destructive action. Local tombstones win races. */
export async function deleteCanvasProject(
  identity: GalleryIdentity,
  canvasId: string
): Promise<void> {
  assertGalleryIdentity(identity)
  cancelCanvasUpload(identity, canvasId)
  await removeLocalCanvas(galleryOwner(identity), canvasId)
  const canvas = await loadLocalCanvas(galleryOwner(identity), canvasId)
  if (canvas) await emitCanvasEvent({ identity, canvas })
  await replayCanvasRemovals(identity)
}
/** Detaching a reference is not this operation: this deletes the shared original. */
export async function deleteCanvasResource(
  identity: GalleryIdentity,
  canvasId: string,
  assetId: string
): Promise<void> {
  assertGalleryIdentity(identity)
  cancelCanvasUpload(identity, canvasId)
  const canvas = await removeLocalCanvasAsset(
    galleryOwner(identity),
    canvasId,
    assetId
  )
  await emitCanvasEvent({ identity, canvas, removedIds: [assetId] })
  await replayCanvasRemovals(identity)
}

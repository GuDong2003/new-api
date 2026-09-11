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
import { deleteCanvasRecord, getCanvasRecord } from '../api'
import type { CanvasRecord, GalleryIdentity } from '../types'
import { emitCanvasEvent, notifyCanvasProjects } from './canvas-events'
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
  if (!(await loadLocalCanvas(galleryOwner(identity), canvasId))) {
    const remote = await getCanvasRecord(identity, canvasId)
    await updateCanvasUserState(galleryOwner(identity), (state) => ({
      ...state,
      pendingCanvasRemovals: [
        ...state.pendingCanvasRemovals.filter(
          (item) => item.canvasId !== canvasId
        ),
        { canvasId, revision: remote.revision },
      ],
    }))
    notifyCanvasProjects()
    await replayCanvasRemovals(identity)
    return
  }
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
  if (!(await loadLocalCanvas(galleryOwner(identity), canvasId))) {
    const remote = await getCanvasRecord(identity, canvasId)
    await updateCanvasUserState(galleryOwner(identity), (state) => ({
      ...state,
      pendingAssetRemovals: [
        ...state.pendingAssetRemovals.filter(
          (item) => item.canvasId !== canvasId || item.assetId !== assetId
        ),
        { canvasId, assetId, revision: remote.revision },
      ],
    }))
    notifyCanvasProjects()
    await replayCanvasRemovals(identity)
    return
  }
  const canvas = await removeLocalCanvasAsset(
    galleryOwner(identity),
    canvasId,
    assetId
  )
  await emitCanvasEvent({ identity, canvas, removedIds: [assetId] })
  await replayCanvasRemovals(identity)
}

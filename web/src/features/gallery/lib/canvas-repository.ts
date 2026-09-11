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

import type {
  CanvasBinary,
  CanvasRemoteAsset,
  CanvasUserState,
  LocalCanvas,
} from '../types'
import {
  canvasDocumentAssetIds,
  normalizeCanvasDocument,
  pruneCanvasDocumentAsset,
  remapCanvasDocumentAssetIds,
} from './canvas-document'

const stores = ['canvases', 'assets', 'userState', 'canonicalAliases']
const userStateSchema = z.object({
  lastOpened: z
    .object({ drawing: z.string().optional(), nai: z.string().optional() })
    .default({}),
  cloudPause: z
    .object({
      reason: z.string(),
      requiredBytes: z.number().nonnegative(),
      requiredImages: z.number().int().nonnegative(),
      lastQuotaCheck: z.number().nonnegative(),
      notified: z.boolean(),
    })
    .nullable()
    .default(null),
  pendingCanvasRemovals: z
    .array(
      z.object({
        canvasId: z.string(),
        revision: z.number().int().nonnegative(),
      })
    )
    .default([]),
  pendingAssetRemovals: z
    .array(
      z.object({
        canvasId: z.string(),
        assetId: z.string(),
        revision: z.number().int().nonnegative(),
      })
    )
    .default([]),
  migratedKinds: z
    .object({ drawing: z.string().optional(), nai: z.string().optional() })
    .default({}),
})

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
  })
}

async function transact<T>(
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  const opening = indexedDB.open('new-api-gallery-canvases', 1)
  opening.addEventListener('upgradeneeded', () => {
    for (const name of stores) opening.result.createObjectStore(name)
  })
  const db = await requestValue(opening)
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode)
      let result: T
      let failure: unknown
      tx.addEventListener('complete', () => resolve(result))
      tx.addEventListener('abort', () =>
        reject(
          failure ??
            tx.error ??
            new Error('Canvas storage transaction aborted.')
        )
      )
      tx.addEventListener('error', () => {
        failure ??= tx.error
      })
      work(tx)
        .then((value) => {
          result = value
        })
        .catch((error: unknown) => {
          failure = error
          try {
            tx.abort()
          } catch {
            reject(error)
          }
        })
    })
  } finally {
    db.close()
  }
}

function canvasAssetRange(userId: number, id: string): IDBKeyRange {
  return IDBKeyRange.bound([userId, id], [userId, id, []])
}

async function stateInTransaction(
  tx: IDBTransaction,
  userId: number
): Promise<CanvasUserState> {
  return userStateSchema.parse(
    (await requestValue(tx.objectStore('userState').get(userId))) ?? {}
  )
}

/** Compare-and-swap: callers pass the revision read before their edit. */
async function persistCanvas(
  canvas: LocalCanvas,
  assets: CanvasBinary[],
  migration: boolean
): Promise<LocalCanvas> {
  const document = normalizeCanvasDocument(canvas.kind, canvas.document)
  const documentIds = canvasDocumentAssetIds(document)
  // Materialize all bytes before opening the transaction (never await I/O in it).
  const binaries = await Promise.all(
    assets.map(async (asset) => {
      const bytes = await asset.blob.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const checksum = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
      if (!bytes.byteLength || checksum !== asset.sha256) {
        throw new Error('Canvas original checksum mismatch.')
      }
      return {
        id: asset.id,
        blob: new Blob([bytes], { type: asset.blob.type }),
        role: asset.role,
        nodeId: asset.nodeId,
        sha256: asset.sha256,
      }
    })
  )
  return transact('readwrite', async (tx) => {
    const canvases = tx.objectStore('canvases')
    if (migration) {
      const state = await stateInTransaction(tx, canvas.userId)
      const migratedId = state.migratedKinds[canvas.kind]
      if (migratedId) {
        return requestValue(canvases.get([canvas.userId, migratedId]))
      }
      state.migratedKinds[canvas.kind] = canvas.id
      state.lastOpened[canvas.kind] ??= canvas.id
      tx.objectStore('userState').put(state, canvas.userId)
    }
    const current: LocalCanvas | undefined = await requestValue(
      canvases.get([canvas.userId, canvas.id])
    )
    if (current?.deleted) throw new Error('Canvas has been deleted.')
    const aliases: Record<string, string> =
      (await requestValue(
        tx.objectStore('canonicalAliases').get([canvas.userId, canvas.id])
      )) ?? {}
    if (
      [...documentIds, ...binaries.map((asset) => asset.id)].some((id) =>
        Object.hasOwn(aliases, id)
      )
    ) {
      throw new Error('Stale canonical asset IDs; reload the latest canvas.')
    }
    const removedAssetIds = [
      ...new Set([
        ...(current?.removedAssetIds ?? []),
        ...canvas.removedAssetIds,
      ]),
    ]
    if (
      documentIds.some((id) => removedAssetIds.includes(id)) ||
      binaries.some((asset) => removedAssetIds.includes(asset.id))
    ) {
      throw new Error('Canvas contains an explicitly removed asset.')
    }
    if (current && canvas.revision !== current.revision) {
      throw new Error('Stale canvas revision.')
    }
    const stored: CanvasBinary[] = await requestValue(
      tx
        .objectStore('assets')
        .getAll(canvasAssetRange(canvas.userId, canvas.id))
    )
    for (const id of documentIds) {
      if (
        !binaries.some((asset) => asset.id === id) &&
        !stored.some((asset) => asset.id === id)
      ) {
        throw new Error('Canvas original is unavailable.')
      }
    }
    for (const binary of binaries) {
      const previous = stored.find((asset) => asset.id === binary.id)
      if (previous && previous.sha256 !== binary.sha256) {
        throw new Error('Canvas original is immutable.')
      }
      tx.objectStore('assets').put(previous ?? binary, [
        canvas.userId,
        canvas.id,
        binary.id,
      ])
    }
    // Explicit field selection prevents arbitrary credentials on caller objects
    // from surviving structured cloning into this repository.
    const cloudMetadata =
      current && current.cloudRevision >= canvas.cloudRevision
        ? current
        : canvas
    let status = canvas.status
    if (
      status === 'synced' ||
      (status === 'local' && cloudMetadata.cloudRevision > 0)
    ) {
      status = 'pending'
    }
    const next: LocalCanvas = {
      id: canvas.id,
      userId: canvas.userId,
      kind: canvas.kind,
      name: canvas.name,
      document,
      revision: (current?.revision ?? 0) + 1,
      cloudRevision: cloudMetadata.cloudRevision,
      localSavedAt: Date.now(),
      cloudSavedRevision: cloudMetadata.cloudSavedRevision,
      expiresAt: cloudMetadata.expiresAt,
      status,
      needsExplicitSave: canvas.needsExplicitSave,
      removedAssetIds,
      deleted: false,
    }
    canvases.put(next, [canvas.userId, canvas.id])
    return next
  })
}

export async function saveLocalCanvas(
  canvas: LocalCanvas,
  assets: CanvasBinary[]
): Promise<LocalCanvas> {
  return persistCanvas(canvas, assets, false)
}

/** Import completion marker and original bytes publish in the same transaction. */
export async function importLegacyCanvas(
  canvas: LocalCanvas,
  assets: CanvasBinary[]
): Promise<LocalCanvas> {
  return persistCanvas(
    { ...canvas, status: 'local', needsExplicitSave: true },
    assets,
    true
  )
}

export async function loadLocalCanvas(
  userId: number,
  id: string
): Promise<LocalCanvas | null> {
  return transact(
    'readonly',
    async (tx) =>
      (await requestValue(tx.objectStore('canvases').get([userId, id]))) ?? null
  )
}

export async function listLocalCanvases(
  userId: number
): Promise<LocalCanvas[]> {
  return transact('readonly', async (tx) => {
    const canvases: LocalCanvas[] = await requestValue(
      tx
        .objectStore('canvases')
        .getAll(IDBKeyRange.bound([userId], [userId, []]))
    )
    return canvases
      .filter((canvas) => !canvas.deleted)
      .sort((a, b) => b.localSavedAt - a.localSavedAt)
  })
}

export async function readCanvasAssets(
  userId: number,
  id: string
): Promise<CanvasBinary[]> {
  return transact('readonly', async (tx) =>
    requestValue(tx.objectStore('assets').getAll(canvasAssetRange(userId, id)))
  )
}

export async function removeLocalCanvasAsset(
  userId: number,
  id: string,
  assetId: string
): Promise<LocalCanvas> {
  return transact('readwrite', async (tx) => {
    const canvas: LocalCanvas | undefined = await requestValue(
      tx.objectStore('canvases').get([userId, id])
    )
    if (!canvas || canvas.deleted) throw new Error('Canvas has been deleted.')
    if (canvas.removedAssetIds.includes(assetId)) return canvas
    const assets: CanvasBinary[] = await requestValue(
      tx.objectStore('assets').getAll(canvasAssetRange(userId, id))
    )
    if (!assets.some((asset) => asset.id === assetId)) {
      throw new Error('Canvas original is unavailable.')
    }
    const document = pruneCanvasDocumentAsset(
      canvas.kind,
      canvas.document,
      assetId
    )
    const remaining = new Set(canvasDocumentAssetIds(document))
    // Dependent masks are retired with their reference, never unrelated originals.
    const removed = assets.filter(
      (asset) =>
        asset.id === assetId ||
        (asset.role === 'mask' && !remaining.has(asset.id))
    )
    for (const asset of removed) {
      tx.objectStore('assets').delete([userId, id, asset.id])
    }
    const next: LocalCanvas = {
      ...canvas,
      document,
      revision: canvas.revision + 1,
      localSavedAt: Date.now(),
      status: 'pending',
      removedAssetIds: [
        ...new Set([
          ...canvas.removedAssetIds,
          ...removed.map((asset) => asset.id),
        ]),
      ],
    }
    const state = await stateInTransaction(tx, userId)
    state.pendingAssetRemovals.push({
      canvasId: id,
      assetId,
      revision: canvas.cloudRevision,
    })
    tx.objectStore('userState').put(state, userId)
    tx.objectStore('canvases').put(next, [userId, id])
    return next
  })
}

export async function removeLocalCanvas(
  userId: number,
  id: string
): Promise<void> {
  return transact('readwrite', async (tx) => {
    const canvas: LocalCanvas | undefined = await requestValue(
      tx.objectStore('canvases').get([userId, id])
    )
    if (!canvas || canvas.deleted) return
    const state = await stateInTransaction(tx, userId)
    state.pendingCanvasRemovals.push({
      canvasId: id,
      revision: canvas.cloudRevision,
    })
    state.pendingAssetRemovals = state.pendingAssetRemovals.filter(
      (item) => item.canvasId !== id
    )
    if (state.lastOpened[canvas.kind] === id) {
      delete state.lastOpened[canvas.kind]
    }
    tx.objectStore('userState').put(state, userId)
    tx.objectStore('assets').delete(canvasAssetRange(userId, id))
    tx.objectStore('canonicalAliases').delete([userId, id])
    tx.objectStore('canvases').put(
      {
        ...canvas,
        document: {},
        deleted: true,
        revision: canvas.revision + 1,
        localSavedAt: Date.now(),
      },
      [userId, id]
    )
  })
}

export async function readCanvasUserState(
  userId: number
): Promise<CanvasUserState> {
  return transact('readonly', async (tx) => stateInTransaction(tx, userId))
}

/** The callback must be synchronous; overlapping tab/async updates serialize in IDB. */
export async function updateCanvasUserState(
  userId: number,
  update: (state: CanvasUserState) => CanvasUserState
): Promise<CanvasUserState> {
  return transact('readwrite', async (tx) => {
    const next = userStateSchema.parse(
      update(await stateInTransaction(tx, userId))
    )
    tx.objectStore('userState').put(next, userId)
    return next
  })
}

export async function writeCanvasUserState(
  userId: number,
  state: CanvasUserState
): Promise<void> {
  await updateCanvasUserState(userId, () => state)
}

export type CanvasSaveAcknowledgement = {
  localRevision: number
  cloudRevision: number
  expiresAt: number
  assetIdMap: Readonly<Record<string, string>>
  assets: readonly CanvasRemoteAsset[]
}

/** Apply only the server's verified identifier map to the latest local edits. */
export async function acknowledgeCanvasSave(
  userId: number,
  id: string,
  ack: CanvasSaveAcknowledgement
): Promise<LocalCanvas> {
  return transact('readwrite', async (tx) => {
    const canvas: LocalCanvas | undefined = await requestValue(
      tx.objectStore('canvases').get([userId, id])
    )
    if (!canvas) throw new Error('Canvas is unavailable.')
    if (canvas.deleted) throw new Error('Canvas has been deleted.')
    const mappings = Object.entries(ack.assetIdMap)
    const acknowledgedIds = [
      ...mappings.flat(),
      ...ack.assets.map((asset) => asset.id),
    ]
    if (
      acknowledgedIds.some((assetId) =>
        canvas.removedAssetIds.includes(assetId)
      )
    ) {
      throw new Error('Canvas original was explicitly removed.')
    }
    if (ack.localRevision > canvas.revision || ack.localRevision < 1) {
      throw new Error('Invalid acknowledged canvas revision.')
    }
    if (ack.cloudRevision <= canvas.cloudRevision) return canvas
    const assetStore = tx.objectStore('assets')
    const originals: CanvasBinary[] = await requestValue(
      assetStore.getAll(canvasAssetRange(userId, id))
    )
    const ownerKeys = await requestValue(
      assetStore.getAllKeys(IDBKeyRange.bound([userId], [userId, []]))
    )
    const nextAssets = new Map(originals.map((asset) => [asset.id, asset]))
    for (const [sourceId, targetId] of mappings) {
      const source = originals.find((asset) => asset.id === sourceId)
      const remote = ack.assets.find((asset) => asset.id === targetId)
      if (
        !source ||
        !remote ||
        source.sha256 !== remote.sha256 ||
        source.blob.size !== remote.bytes ||
        source.blob.type !== remote.mime_type
      ) {
        throw new Error('Canonical original checksum mismatch.')
      }
      if (
        ownerKeys.some(
          (key) => Array.isArray(key) && key[2] === targetId && key[1] !== id
        )
      ) {
        throw new Error('Canonical original belongs to another canvas owner.')
      }
      const collision = nextAssets.get(targetId)
      if (collision && collision.sha256 !== source.sha256) {
        throw new Error('Canonical original checksum collision.')
      }
      if (sourceId !== targetId && Object.hasOwn(ack.assetIdMap, targetId)) {
        throw new Error('Invalid chained canonical original map.')
      }
      nextAssets.delete(sourceId)
      nextAssets.set(targetId, {
        ...source,
        id: targetId,
        role: remote.role,
        nodeId: remote.node_id,
      })
    }
    const document = remapCanvasDocumentAssetIds(
      canvas.kind,
      canvas.document,
      ack.assetIdMap
    )
    const aliases: Record<string, string> =
      (await requestValue(
        tx.objectStore('canonicalAliases').get([userId, id])
      )) ?? {}
    for (const [sourceId, targetId] of mappings) {
      if (sourceId !== targetId) {
        assetStore.delete([userId, id, sourceId])
        aliases[sourceId] = targetId
      }
    }
    for (const remote of ack.assets) {
      const original = nextAssets.get(remote.id)
      if (
        !original ||
        original.sha256 !== remote.sha256 ||
        original.blob.size !== remote.bytes ||
        original.blob.type !== remote.mime_type
      ) {
        throw new Error('Acknowledged original checksum mismatch.')
      }
      assetStore.put(
        { ...original, role: remote.role, nodeId: remote.node_id },
        [userId, id, remote.id]
      )
    }
    tx.objectStore('canonicalAliases').put(aliases, [userId, id])
    const next: LocalCanvas = {
      ...canvas,
      document,
      cloudRevision: ack.cloudRevision,
      cloudSavedRevision: Math.max(
        canvas.cloudSavedRevision,
        ack.localRevision
      ),
      expiresAt: ack.expiresAt,
      status: canvas.revision === ack.localRevision ? 'synced' : 'pending',
    }
    tx.objectStore('canvases').put(next, [userId, id])
    return next
  })
}

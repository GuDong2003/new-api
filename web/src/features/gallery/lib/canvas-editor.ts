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
import { cancelImageGenerationJobs } from '@/features/playground/drawing/hooks/use-image-generation'
import type {
  DrawingDocument,
  ImageAsset,
} from '@/features/playground/drawing/types'
import { cancelNaiGenerationJobs } from '@/features/playground/nai/hooks/use-nai-image-generation'
import type { NaiCanvasDocument } from '@/features/playground/nai/types'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { readRemoteCanvasOriginal } from '../api'
import type { CanvasKind, GalleryIdentity, LocalCanvas } from '../types'
import { replayCanvasRemovals } from './canvas-deletion'
import {
  canvasDocumentAssetIds,
  encodeCanvas,
  type CanvasCodecContext,
} from './canvas-document'
import { canvasEditors, notifyCanvasProjects } from './canvas-events'
import {
  loadLocalCanvas,
  readCanvasAssets,
  saveLocalCanvas,
} from './canvas-repository'
import {
  CANVAS_CLOUD_INTERVAL,
  checkCanvasCapacity,
  syncCanvas,
} from './canvas-sync'
import {
  galleryOwner,
  assertGalleryIdentity,
  isGalleryIdentityCurrent,
} from './session'

type EditorDocument = DrawingDocument | NaiCanvasDocument
export type CanvasLocalStatus = 'loading' | 'saving' | 'saved' | 'error'
const states: Partial<
  Record<
    CanvasKind,
    {
      canvas: LocalCanvas | null
      localStatus: CanvasLocalStatus
      error?: string
    }
  >
> = {}
export function getCanvasEditorState(kind: CanvasKind) {
  return states[kind]
}
export function updateState(
  kind: CanvasKind,
  value: NonNullable<(typeof states)[CanvasKind]>
) {
  states[kind] = value
  notifyCanvasProjects()
}
export function storeFor(kind: CanvasKind) {
  return kind === 'drawing' ? useDrawingStore : useNaiDrawingStore
}
export function cancelEditorJobs(kind: CanvasKind, identity: GalleryIdentity) {
  if (kind === 'drawing') {
    cancelImageGenerationJobs(identity.userId, identity.sessionId)
  } else cancelNaiGenerationJobs(identity.userId, identity.sessionId)
}
export const sameIdentity = (a: GalleryIdentity, b: GalleryIdentity) =>
  a.userId === b.userId && a.sessionId === b.sessionId
export function canvasOriginalReader(
  identity: GalleryIdentity
): NonNullable<CanvasCodecContext['readOriginal']> {
  return async (asset, signal) => {
    assertGalleryIdentity(identity)
    const blob = await readRemoteCanvasOriginal(identity, asset.src, signal)
    assertGalleryIdentity(identity)
    signal?.throwIfAborted()
    if (!blob.size || blob.type !== asset.mimeType) {
      throw new Error('Canvas original is unavailable.')
    }
    return blob
  }
}
function content(document: Record<string, unknown>) {
  const { viewport: _viewport, ...rest } = document
  return JSON.stringify(rest)
}

function remapEditorDocument(
  document: EditorDocument,
  ids: Readonly<Record<string, string>>
): EditorDocument {
  const asset = (value: ImageAsset) => ({
    ...value,
    id: ids[value.id] ?? value.id,
  })
  return {
    ...document,
    nodes: document.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        ...(node.data.asset ? { asset: asset(node.data.asset) } : {}),
        ...('mask' in node.data && node.data.mask
          ? { mask: asset(node.data.mask) }
          : {}),
      },
    })),
    ...('mask' in document && document.mask
      ? { mask: { ...document.mask, asset: asset(document.mask.asset) } }
      : {}),
  } as EditorDocument
}
export function bindEditor(identity: GalleryIdentity, initial: LocalCanvas) {
  const kind = initial.kind
  const store = storeFor(kind)
  let active = true
  let applying = false
  let savedEditorRevision = store.getState().revision
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  const controller = new AbortController()
  updateState(kind, { canvas: initial, localStatus: 'saved' })
  const save = async () => {
    if (!active || !isGalleryIdentityCurrent(identity)) return
    const snapshot = store.getState()
    if (!snapshot.ready || snapshot.revision === savedEditorRevision) return
    updateState(kind, {
      canvas: states[kind]?.canvas ?? initial,
      localStatus: 'saving',
    })
    try {
      for (let retry = 0; retry < 3; retry++) {
        const current = await loadLocalCanvas(
          galleryOwner(identity),
          initial.id
        )
        if (!current || current.deleted || !active) return
        const latestEditor = store.getState()
        const encoded = await encodeCanvas(kind, latestEditor, {
          existingAssets: await readCanvasAssets(
            galleryOwner(identity),
            initial.id
          ),
          readOriginal: canvasOriginalReader(identity),
          signal: controller.signal,
          roles: latestEditor.assetRoles,
        })
        if (!active) return
        assertGalleryIdentity(identity)
        try {
          const meaningful =
            content(current.document) !== content(encoded.document)
          const canvas = await saveLocalCanvas(
            {
              ...current,
              document: encoded.document,
              status: current.status === 'conflict' ? 'conflict' : 'pending',
              needsExplicitSave: meaningful ? false : current.needsExplicitSave,
            },
            encoded.assets
          )
          savedEditorRevision = latestEditor.revision
          updateState(kind, {
            canvas,
            localStatus:
              store.getState().revision === savedEditorRevision
                ? 'saved'
                : 'saving',
          })
          return
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/Stale (canvas revision|canonical asset IDs)/.test(
              error.message
            ) ||
            retry === 2
          ) {
            throw error
          }
        }
      }
    } catch (error) {
      if (active) {
        updateState(kind, {
          canvas: states[kind]?.canvas ?? initial,
          localStatus: 'error',
          error:
            error instanceof Error
              ? error.message
              : 'Canvas storage is unavailable.',
        })
      }
    }
  }
  const flush = () => {
    if (timer) clearTimeout(timer)
    queue = queue.catch(() => undefined).then(save)
    return queue
  }
  const unsubscribe = store.subscribe((state, previous) => {
    if (
      !active ||
      applying ||
      !state.ready ||
      state.revision === previous.revision
    ) {
      return
    }
    updateState(kind, {
      canvas: states[kind]?.canvas ?? initial,
      localStatus: 'saving',
    })
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void flush()
    }, 2000)
  })
  const leave = () => {
    void flush().then(() => syncCanvas(identity, initial.id, 'leave'))
  }
  const visibility = () => {
    if (document.visibilityState === 'hidden') leave()
  }
  const interval = setInterval(() => {
    void replayCanvasRemovals(identity)
      .then(() => checkCanvasCapacity(identity))
      .then(() => flush())
      .then(() => syncCanvas(identity, initial.id, 'timer'))
      .catch(() => undefined)
  }, CANVAS_CLOUD_INTERVAL)
  window.addEventListener('pagehide', leave)
  document.addEventListener('visibilitychange', visibility)
  const stop = () => {
    active = false
    controller.abort()
    unsubscribe()
    if (timer) clearTimeout(timer)
    clearInterval(interval)
    window.removeEventListener('pagehide', leave)
    document.removeEventListener('visibilitychange', visibility)
    if (canvasEditors.get(kind)?.canvasId === initial.id) {
      canvasEditors.delete(kind)
      delete states[kind]
      notifyCanvasProjects()
    }
  }
  canvasEditors.set(kind, {
    identity,
    kind,
    canvasId: initial.id,
    flush,
    isLocallySaved: () =>
      savedEditorRevision === store.getState().revision &&
      states[kind]?.localStatus === 'saved',
    stop,
    retainedAssetIds: () => {
      const state = store.getState()
      const documents = [
        state,
        ...state.past.map((snapshot) => ({ ...state, ...snapshot })),
        ...state.future.map((snapshot) => ({ ...state, ...snapshot })),
      ]
      return documents.flatMap((document) =>
        canvasDocumentAssetIds(document as unknown as Record<string, unknown>)
      )
    },
    receive: async (event) => {
      if (!active) return
      applying = true
      try {
        if (event.canvas.deleted) {
          cancelEditorJobs(kind, identity)
          store.getState().initialize(galleryOwner(identity))
          stop()
        } else if (event.removedIds?.length) {
          cancelEditorJobs(kind, identity)
          const state = store.getState()
          const removed = new Set(event.removedIds)
          const nodeIds = state.nodes
            .filter(
              (node) => node.data.asset && removed.has(node.data.asset.id)
            )
            .map((node) => node.id)
          // Prune only the deleted resource from the *latest* editor. Its other
          // unsaved settings/positions must not be replaced by the IDB snapshot.
          state.removeNodes(nodeIds)
          if (kind === 'drawing') {
            const drawing = useDrawingStore.getState()
            useDrawingStore.setState({
              past: [],
              future: [],
              nodes: drawing.nodes.map((node) => ({
                ...node,
                data: {
                  ...node.data,
                  referenceIds: node.data.referenceIds?.filter(
                    (id) => !nodeIds.includes(id)
                  ),
                  mask:
                    node.data.mask && removed.has(node.data.mask.id)
                      ? undefined
                      : node.data.mask,
                },
              })),
              mask:
                drawing.mask && removed.has(drawing.mask.asset.id)
                  ? null
                  : drawing.mask,
            })
          } else useNaiDrawingStore.setState({ past: [], future: [] })
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            void flush()
          }, 2000)
        } else if (event.assetIdMap && Object.keys(event.assetIdMap).length) {
          const idMap = event.assetIdMap
          const state = store.getState()
          const mapped = remapEditorDocument(state, event.assetIdMap)
          const assetRoles = Object.fromEntries(
            Object.entries(state.assetRoles).map(([id, role]) => [
              idMap[id] ?? id,
              role,
            ])
          )
          // The repository's authoritative manifest owns migrated provenance.
          for (const node of event.canvas.document.nodes as Array<{
            id: string
            data: { asset?: { id: string } }
          }>) {
            if (node.data.asset) delete assetRoles[node.data.asset.id]
          }
          if (kind === 'drawing') {
            const current = useDrawingStore.getState()
            const snapshot = (value: (typeof current.past)[number]) => {
              const remapped = remapEditorDocument(
                { ...current, ...value },
                idMap
              ) as DrawingDocument
              return {
                nodes: remapped.nodes,
                edges: remapped.edges,
                referenceIds: remapped.referenceIds,
                mask: remapped.mask,
              }
            }
            useDrawingStore.setState({
              ...(mapped as DrawingDocument),
              assetRoles,
              past: current.past.map(snapshot),
              future: current.future.map(snapshot),
            })
          } else {
            const current = useNaiDrawingStore.getState()
            const snapshot = (value: (typeof current.past)[number]) => ({
              nodes: (
                remapEditorDocument(
                  { ...current, ...value },
                  idMap
                ) as NaiCanvasDocument
              ).nodes,
            })
            useNaiDrawingStore.setState({
              ...(mapped as NaiCanvasDocument),
              assetRoles,
              past: current.past.map(snapshot),
              future: current.future.map(snapshot),
            })
          }
        }
        updateState(kind, {
          canvas: event.canvas,
          localStatus: states[kind]?.localStatus ?? 'saved',
        })
      } finally {
        applying = false
      }
    },
  })
}

export async function flushLocalEditors(
  identity: GalleryIdentity
): Promise<void> {
  await Promise.all(
    [...canvasEditors.values()]
      .filter((editor) => sameIdentity(editor.identity, identity))
      .map((editor) => editor.flush())
  )
}
export function stopCanvasEditors(identity: GalleryIdentity) {
  for (const editor of canvasEditors.values()) {
    if (sameIdentity(editor.identity, identity)) editor.stop()
  }
}
useAuthStore.subscribe((state, previous) => {
  if (
    state.auth.user?.id !== previous.auth.user?.id ||
    state.auth.session?.sid !== previous.auth.session?.sid
  ) {
    stopCanvasEditors({
      userId: previous.auth.user?.id ?? null,
      sessionId: previous.auth.session?.sid ?? null,
    })
    cancelImageGenerationJobs(
      previous.auth.user?.id ?? null,
      previous.auth.session?.sid ?? null
    )
    cancelNaiGenerationJobs(
      previous.auth.user?.id ?? null,
      previous.auth.session?.sid ?? null
    )
    useDrawingStore.getState().initialize(state.auth.user?.id ?? 0)
    useNaiDrawingStore.getState().initialize(state.auth.user?.id ?? 0)
    delete states.drawing
    delete states.nai
    notifyCanvasProjects()
  }
})

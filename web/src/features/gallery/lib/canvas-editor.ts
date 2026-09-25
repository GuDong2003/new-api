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
import { renumberReferenceMentions } from '@/features/playground/drawing/lib/reference-mentions'
import type {
  DrawingDocument,
  ImageAsset,
} from '@/features/playground/drawing/types'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { getGalleryFile, readRemoteCanvasOriginal } from '../api'
import type { CanvasKind, GalleryIdentity, LocalCanvas } from '../types'
import { replayCanvasRemovals } from './canvas-deletion'
import {
  canvasDocumentAssetIds,
  decodeCanvas,
  documentKey,
  encodeCanvas,
  mergeCanvasDocuments,
  normalizeCanvasDocument,
  pruneCanvasDocumentAsset,
  remapCanvasDocumentAssetIds,
  type CanvasCodecContext,
} from './canvas-document'
import { canvasEditors, notifyCanvasProjects } from './canvas-events'
import { enqueueCanvasMutation } from './canvas-mutation-queue'
import { releaseCanvasObjectUrls } from './canvas-object-urls'
import {
  loadLocalCanvas,
  readCanvasAliases,
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

export type CanvasLocalStatus = 'loading' | 'saving' | 'saved' | 'error'
const states: Partial<
  Record<
    CanvasKind,
    {
      canvas: LocalCanvas | null
      localStatus: CanvasLocalStatus
      error?: string
      /** Originals kept only as links, which the cloud copy waits for. */
      pendingOriginals?: number
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
// Every canvas opens in the drawing editor; a NAI canvas is upgraded first.
export function storeFor(_kind: CanvasKind) {
  return useDrawingStore
}
export const sameIdentity = (a: GalleryIdentity, b: GalleryIdentity) =>
  a.userId === b.userId && a.sessionId === b.sessionId
export function canvasOriginalReader(
  identity: GalleryIdentity
): NonNullable<CanvasCodecContext['readOriginal']> {
  return async (asset, signal, source) => {
    assertGalleryIdentity(identity)
    if (source === 'gallery-preview') {
      const blob = await getGalleryFile(identity, asset.id, false, signal)
      assertGalleryIdentity(identity)
      signal?.throwIfAborted()
      if (!blob.size || blob.type !== asset.mimeType) {
        throw new Error('Canvas original is unavailable.')
      }
      return blob
    }
    if (asset.src.startsWith('blob:')) {
      // Bytes this tab still shows, whatever another tab removed from storage.
      const response = await fetch(asset.src)
      const blob = await response.blob()
      signal?.throwIfAborted()
      if (!blob.size) throw new Error('Canvas original is unavailable.')
      return blob
    }
    // A link names no type the server has to honour; the one the server found
    // in the downloaded bytes is kept.
    const blob = await readRemoteCanvasOriginal(identity, asset.src, signal)
    assertGalleryIdentity(identity)
    signal?.throwIfAborted()
    if (!blob.size) throw new Error('Canvas original is unavailable.')
    return blob
  }
}
function content(document: Record<string, unknown>) {
  const { viewport: _viewport, ...rest } = document
  return JSON.stringify(rest)
}

function remapEditorDocument(
  document: DrawingDocument,
  ids: Readonly<Record<string, string>>
): DrawingDocument {
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
        ...(node.data.mask ? { mask: asset(node.data.mask) } : {}),
      },
    })),
    ...(document.mask
      ? { mask: { ...document.mask, asset: asset(document.mask.asset) } }
      : {}),
  }
}
export function bindEditor(identity: GalleryIdentity, initial: LocalCanvas) {
  const kind = initial.kind
  const store = storeFor(kind)
  const owner = galleryOwner(identity)
  let active = true
  let applying = false
  let savedEditorRevision = store.getState().revision
  // The stored canvas this editor's document builds on. Storage moving past it
  // without this editor means another tab saved there, and the next save here
  // merges the two instead of overwriting what that tab kept.
  let base = { revision: initial.revision, document: initial.document }
  // Originals this canvas keeps only as links. An opened canvas shows each one
  // as its link, and every save tries to download them again.
  let waiting = new Set(
    store
      .getState()
      .nodes.flatMap((node) =>
        node.data.asset && /^https?:\/\//i.test(node.data.asset.src)
          ? [node.data.asset.id]
          : []
      )
  ).size
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  const controller = new AbortController()
  useDrawingStore.setState({ canvasId: initial.id })
  updateState(kind, {
    canvas: initial,
    localStatus: 'saved',
    pendingOriginals: waiting,
  })
  const shownAssetIds = () => {
    const state = store.getState()
    return new Set(
      [
        ...state.nodes.flatMap((node) => [
          node.data.asset?.id,
          node.data.mask?.id,
        ]),
        state.mask?.asset.id,
      ].filter((id): id is string => Boolean(id))
    )
  }
  // Every original the editor shows or can bring back through undo and redo.
  const heldAssetIds = () => {
    const state = store.getState()
    const documents = [
      state,
      ...state.past.map((snapshot) => ({ ...state, ...snapshot })),
      ...state.future.map((snapshot) => ({ ...state, ...snapshot })),
    ]
    return documents.flatMap((document) =>
      canvasDocumentAssetIds(document as unknown as Record<string, unknown>)
    )
  }
  // Canonical IDs the cloud gave originals reach this editor's document and
  // history, so nothing here keeps saving them under the IDs they replaced.
  const remapAssets = (
    idMap: Readonly<Record<string, string>>,
    stored: Record<string, unknown>
  ) => {
    const state = store.getState()
    const mapped = remapEditorDocument(state, idMap)
    const assetRoles = Object.fromEntries(
      Object.entries(state.assetRoles).map(([id, role]) => [
        idMap[id] ?? id,
        role,
      ])
    )
    // The repository's authoritative manifest owns migrated provenance.
    for (const node of stored.nodes as Array<{
      id: string
      data: { asset?: { id: string } }
    }>) {
      if (node.data.asset) delete assetRoles[node.data.asset.id]
    }
    const current = useDrawingStore.getState()
    const snapshot = (value: (typeof current.past)[number]) => {
      const remapped = remapEditorDocument({ ...current, ...value }, idMap)
      return {
        nodes: remapped.nodes,
        edges: remapped.edges,
        referenceIds: remapped.referenceIds,
        mask: remapped.mask,
      }
    }
    useDrawingStore.setState({
      ...mapped,
      assetRoles,
      past: current.past.map(snapshot),
      future: current.future.map(snapshot),
    })
  }
  // Removed originals leave this editor with whatever depends on them, and
  // undo cannot bring them back: saving one is refused.
  const pruneRemoved = (removedIds: readonly string[]) => {
    const state = store.getState()
    const removed = new Set(removedIds)
    const nodeIds = state.nodes
      .filter((node) => node.data.asset && removed.has(node.data.asset.id))
      .map((node) => node.id)
    // Prune only the deleted resource from the *latest* editor. Its other
    // unsaved settings/positions must not be replaced by the IDB snapshot.
    state.removeNodes(nodeIds)
    const drawing = useDrawingStore.getState()
    useDrawingStore.setState({
      past: [],
      future: [],
      nodes: drawing.nodes.map((node) => {
        const referenceIds = node.data.referenceIds?.filter(
          (id) => !nodeIds.includes(id)
        )
        return {
          ...node,
          data: {
            ...node.data,
            referenceIds,
            // A retry sends this prompt with the references that remain.
            prompt: renumberReferenceMentions(
              node.data.prompt,
              node.data.referenceIds ?? [],
              referenceIds ?? []
            ),
            mask:
              node.data.mask && removed.has(node.data.mask.id)
                ? undefined
                : node.data.mask,
          },
        }
      }),
      mask:
        drawing.mask && removed.has(drawing.mask.asset.id)
          ? null
          : drawing.mask,
    })
  }
  // Show a stored canvas here, unless an edit made since would be lost; the
  // next save then merges again.
  const adopt = async (
    canvas: LocalCanvas,
    encodedRevision: number,
    settings: boolean
  ) => {
    const assets = await readCanvasAssets(owner, initial.id)
    if (!active || store.getState().revision !== encodedRevision) return
    const document = await decodeCanvas(canvas, assets, true)
    applying = true
    try {
      useDrawingStore.setState({
        nodes: document.nodes,
        edges: document.edges,
        referenceIds: document.referenceIds,
        mask: document.mask,
        ...(settings ? { settings: document.settings } : {}),
        past: [],
        future: [],
      })
    } finally {
      applying = false
    }
    base = { revision: canvas.revision, document: canvas.document }
  }
  const save = async () => {
    if (!active || !isGalleryIdentityCurrent(identity)) return
    if (!store.getState().ready) return
    let reported = false
    try {
      for (let retry = 0; retry < 3; retry++) {
        let current = await loadLocalCanvas(owner, initial.id)
        if (!active) return
        // A new editor starts with an in-memory canvas. Materialize that
        // placeholder only when the first real editor change needs saving.
        if (!current && initial.revision === 0 && initial.localSavedAt === 0) {
          current = initial
        }
        if (!current || current.deleted) return
        // Only another drawing document can be merged into this one; the
        // former NAI page stored a different kind of canvas.
        const foreign =
          current.kind === kind &&
          (current.revision !== base.revision ||
            documentKey(current.document) !== documentKey(base.document))
        const edited = store.getState().revision !== savedEditorRevision
        if (!edited && !waiting && !foreign) return
        if (edited && !reported) {
          reported = true
          updateState(kind, {
            canvas: states[kind]?.canvas ?? initial,
            localStatus: 'saving',
            pendingOriginals: waiting,
          })
        }
        let from = base.document
        if (foreign) {
          // Catch up with the tab that saved meanwhile before encoding: the IDs
          // its uploads were given and the originals it removed apply here too.
          const aliases = await readCanvasAliases(owner, initial.id)
          if (!active) return
          applying = true
          try {
            // Undo history counts too: undoing into an old ID fails a save.
            const held = new Set(heldAssetIds())
            if (Object.keys(aliases).some((id) => held.has(id))) {
              remapAssets(aliases, current.document)
            }
            const shown = shownAssetIds()
            const removed = current.removedAssetIds.filter((id) =>
              shown.has(id)
            )
            if (removed.length) pruneRemoved(removed)
          } finally {
            applying = false
          }
          from = remapCanvasDocumentAssetIds(kind, base.document, aliases)
        }
        const stored = await readCanvasAssets(owner, initial.id)
        const latestEditor = store.getState()
        const encoded = await encodeCanvas(kind, latestEditor, {
          existingAssets: stored,
          readOriginal: canvasOriginalReader(identity),
          signal: controller.signal,
          roles: latestEditor.assetRoles,
        })
        if (!active) return
        assertGalleryIdentity(identity)
        let document = encoded.document
        if (foreign) {
          const merged = mergeCanvasDocuments(
            from,
            encoded.document,
            current.document,
            current.removedAssetIds
          )
          try {
            document = normalizeCanvasDocument(kind, merged)
          } catch {
            // A mask can end up fitting neither side's reference image.
            document = normalizeCanvasDocument(kind, { ...merged, mask: null })
          }
        }
        const kept = new Set(canvasDocumentAssetIds(document))
        const assets = encoded.assets.filter((asset) => kept.has(asset.id))
        const originals = new Map(
          [...stored, ...assets].map((asset) => [asset.id, asset])
        )
        const links = [...kept].filter(
          (id) => originals.get(id)?.remoteSource
        ).length
        const theirs = documentKey(document) !== documentKey(encoded.document)
        const settings =
          documentKey(document.settings) !==
          documentKey(encoded.document.settings)
        // Unedited and no original arrived: there is nothing new to keep.
        if (
          latestEditor.revision === savedEditorRevision &&
          links === waiting &&
          content(document) === content(current.document)
        ) {
          if (foreign) await adopt(current, latestEditor.revision, settings)
          return
        }
        try {
          const meaningful = content(current.document) !== content(document)
          const canvas = await saveLocalCanvas(
            {
              ...current,
              document,
              status: current.status === 'conflict' ? 'conflict' : 'pending',
              needsExplicitSave: meaningful ? false : current.needsExplicitSave,
            },
            assets
          )
          savedEditorRevision = latestEditor.revision
          waiting = links
          if (theirs) await adopt(canvas, latestEditor.revision, settings)
          else base = { revision: canvas.revision, document: canvas.document }
          updateState(kind, {
            canvas,
            localStatus:
              store.getState().revision === savedEditorRevision
                ? 'saved'
                : 'saving',
            pendingOriginals: waiting,
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
          pendingOriginals: waiting,
        })
      }
    }
  }
  const flush = () => {
    if (timer) clearTimeout(timer)
    queue = queue
      .catch(() => undefined)
      .then(() => enqueueCanvasMutation(identity, initial.id, save))
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
      pendingOriginals: waiting,
    })
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void flush()
    }, 2000)
  })
  const leave = () => {
    void flush().then(() => syncCanvas(identity, initial.id, 'leave'))
  }
  // Coming back to this tab shows what another tab saved meanwhile.
  const visibility = () => {
    if (document.visibilityState === 'hidden') leave()
    else void flush()
  }
  const focus = () => {
    void flush()
  }
  const interval = setInterval(() => {
    void replayCanvasRemovals(identity)
      .then(() => checkCanvasCapacity(identity))
      .then(() => flush())
      .then(() => syncCanvas(identity, initial.id, 'timer'))
      .catch(() => undefined)
  }, CANVAS_CLOUD_INTERVAL)
  window.addEventListener('pagehide', leave)
  window.addEventListener('focus', focus)
  document.addEventListener('visibilitychange', visibility)
  const stop = () => {
    active = false
    controller.abort()
    unsubscribe()
    if (timer) clearTimeout(timer)
    clearInterval(interval)
    window.removeEventListener('pagehide', leave)
    window.removeEventListener('focus', focus)
    document.removeEventListener('visibilitychange', visibility)
    if (store.getState().canvasId === initial.id) {
      useDrawingStore.setState({ canvasId: null })
    }
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
    retainedAssetIds: heldAssetIds,
    receive: async (event) => {
      if (!active) return
      applying = true
      try {
        if (event.canvas.deleted) {
          store.getState().initialize(galleryOwner(identity))
          stop()
        } else if (event.removedIds?.length) {
          // A removed reference retires the masks drawn for it. The repository
          // names every original this editor may no longer hold.
          const removed = [...event.removedIds, ...event.canvas.removedAssetIds]
          pruneRemoved(removed)
          const held = new Set(canvasDocumentAssetIds(base.document))
          base = {
            ...base,
            document: removed
              .filter((id) => held.has(id))
              .reduce(
                (document, id) => pruneCanvasDocumentAsset(kind, document, id),
                base.document
              ),
          }
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            void flush()
          }, 2000)
        } else if (event.assetIdMap && Object.keys(event.assetIdMap).length) {
          remapAssets(event.assetIdMap, event.canvas.document)
          base = {
            ...base,
            document: remapCanvasDocumentAssetIds(
              kind,
              base.document,
              event.assetIdMap
            ),
          }
        }
        updateState(kind, {
          canvas: event.canvas,
          localStatus: states[kind]?.localStatus ?? 'saved',
          pendingOriginals: waiting,
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
  for (const [kind, editor] of canvasEditors) {
    if (!sameIdentity(editor.identity, identity)) continue
    editor.stop()
    releaseCanvasObjectUrls(kind)
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
    useDrawingStore.getState().initialize(state.auth.user?.id ?? 0)
    delete states.drawing
    delete states.nai
    notifyCanvasProjects()
  }
})

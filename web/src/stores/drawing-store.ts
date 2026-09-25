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
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type Edge,
  type Viewport,
} from '@xyflow/react'
import { create } from 'zustand'

import { arrangeImageNodes } from '@/features/playground/drawing/lib/canvas-document'
import type { ImageGenerationMode } from '@/features/playground/drawing/lib/image-models'
import {
  DEFAULT_IMAGE_SETTINGS,
  imageSettingsSchema,
  settingsForImageModel,
} from '@/features/playground/drawing/lib/image-settings'
import {
  canConnectReference,
  getAvailableReferenceNodes,
} from '@/features/playground/drawing/lib/reference-connections'
import { renumberReferenceMentions } from '@/features/playground/drawing/lib/reference-mentions'
import type {
  DrawingDocument,
  DrawingMask,
  DrawingNode,
  ImageNodeData,
  ImageSettings,
} from '@/features/playground/drawing/types'

// The composer prompt rides along so undo can give back mentions exactly, even
// of images that share a name. A snapshot rebuilt without it, as a cloud remap
// of asset IDs does, has its mentions followed instead.
type CanvasSnapshot = Pick<
  DrawingDocument,
  'nodes' | 'edges' | 'referenceIds' | 'mask'
> & { prompt?: string }
type ReferenceList = Pick<DrawingDocument, 'nodes' | 'referenceIds'>
type GenerationModeSettings = Partial<
  Record<ImageGenerationMode, ImageSettings>
>
type DrawingState = DrawingDocument & {
  assetRoles: Record<
    string,
    { role: 'generated' | 'reference' | 'mask'; nodeId: string }
  >
  userId: number | null
  canvasId: string | null
  ready: boolean
  revision: number
  past: CanvasSnapshot[]
  future: CanvasSnapshot[]
  previewId: string | null
  // The settings each generation mode was last left with, so switching back
  // restores that mode's model and parameters.
  modeSettings: GenerationModeSettings
  initialize: (userId: number, document?: DrawingDocument) => void
  hydrate: (document: DrawingDocument | null) => void
  checkpoint: () => void
  changeNodes: (changes: NodeChange<DrawingNode>[]) => void
  changeEdges: (changes: EdgeChange[]) => void
  connectReference: (
    connection: Pick<Connection, 'source' | 'target'>
  ) => boolean
  addNodes: (nodes: DrawingNode[], edges?: Edge[]) => void
  removeNodes: (ids: string[]) => void
  updateNodeData: (
    id: string,
    data: Partial<ImageNodeData>,
    jobId?: string
  ) => void
  updateSettings: (settings: Partial<ImageSettings>) => void
  switchGenerationMode: (mode: ImageGenerationMode) => void
  setViewport: (viewport: Viewport) => void
  toggleReference: (id: string) => void
  setReferences: (ids: string[]) => void
  reorderReferences: (sourceId: string, targetId: string) => void
  reuseNodeSettings: (id: string) => void
  setMask: (mask: DrawingMask | null) => void
  setPreview: (id: string | null) => void
  undo: () => void
  redo: () => void
  arrange: () => void
  clear: () => void
  replaceDocument: (document: DrawingDocument) => void
}

const MODE_SETTINGS_KEY = 'new-api:drawing-generation-modes'

function readModeSettings(userId: number): GenerationModeSettings {
  try {
    const stored = JSON.parse(
      localStorage.getItem(`${MODE_SETTINGS_KEY}:${userId}`) ?? '{}'
    ) as Record<string, unknown>
    const modes: GenerationModeSettings = {}
    for (const mode of ['description', 'tags'] as const) {
      const parsed = imageSettingsSchema.safeParse(stored[mode])
      if (parsed.success) modes[mode] = parsed.data
    }
    return modes
  } catch {
    return {}
  }
}

// The prompt belongs to whichever mode is showing, so it is not remembered.
function rememberModeSettings(
  userId: number | null,
  modes: GenerationModeSettings,
  settings: ImageSettings
): GenerationModeSettings {
  const next = {
    ...modes,
    [settings.generationMode]: { ...settings, prompt: '' },
  }
  if (userId !== null) {
    try {
      localStorage.setItem(
        `${MODE_SETTINGS_KEY}:${userId}`,
        JSON.stringify(next)
      )
    } catch {
      // Storage is optional: a mode then starts from its defaults next time.
    }
  }
  return next
}

function syncModeAfterReferenceChange(
  settings: ImageSettings,
  previousCount: number,
  nextCount: number
): ImageSettings {
  if (previousCount === 0 && nextCount > 0) {
    return { ...settings, mode: 'edit' }
  }
  if (previousCount > 0 && nextCount === 0) {
    return { ...settings, mode: 'generate' }
  }
  return settings
}

// A request numbers its references by their order, so once the composer's
// references change, the prompt's mentions move with the images they named.
function followReferenceMentions(
  settings: ImageSettings,
  previous: ReferenceList,
  next: ReferenceList
): ImageSettings {
  const previousIds = getAvailableReferenceNodes(
    previous.nodes,
    previous.referenceIds
  ).map((node) => node.id)
  const nextIds = getAvailableReferenceNodes(next.nodes, next.referenceIds).map(
    (node) => node.id
  )
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((id, index) => id === nextIds[index])
  ) {
    return settings
  }
  const prompt = renumberReferenceMentions(
    settings.prompt,
    previousIds,
    nextIds
  )
  return prompt === settings.prompt ? settings : { ...settings, prompt }
}

// Undo and redo give back the prompt the snapshot kept when only reference
// changes moved its mentions since, which restores even mentions left unbound.
// A prompt edited in between keeps the edits and has its mentions followed.
function settingsAfterRestore(
  settings: ImageSettings,
  current: ReferenceList,
  snapshot: CanvasSnapshot
): ImageSettings {
  const kept = snapshot.prompt
  if (
    kept !== undefined &&
    followReferenceMentions({ ...settings, prompt: kept }, snapshot, current)
      .prompt === settings.prompt
  ) {
    return { ...settings, prompt: kept }
  }
  return followReferenceMentions(settings, current, snapshot)
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
  assetRoles: {},
  version: 1,
  nodes: [],
  edges: [],
  viewport: { x: 40, y: 40, zoom: 1 },
  settings: DEFAULT_IMAGE_SETTINGS,
  userId: null,
  canvasId: null,
  ready: false,
  revision: 0,
  past: [],
  future: [],
  referenceIds: [],
  mask: null,
  previewId: null,
  modeSettings: {},

  initialize: (userId, document) =>
    set({
      assetRoles: {},
      modeSettings: readModeSettings(userId),
      userId,
      canvasId: null,
      ready: Boolean(document),
      revision: 0,
      past: [],
      future: [],
      previewId: null,
      referenceIds: document?.referenceIds || [],
      mask: document?.mask || null,
      nodes: document?.nodes || [],
      edges: document?.edges || [],
      viewport: document?.viewport || { x: 40, y: 40, zoom: 1 },
      settings: document?.settings || { ...DEFAULT_IMAGE_SETTINGS },
    }),
  hydrate: (document) =>
    set({
      ready: true,
      ...(document
        ? {
            nodes: document.nodes,
            edges: document.edges,
            viewport: document.viewport,
            settings: document.settings,
            referenceIds: document.referenceIds,
            mask: document.mask,
          }
        : {}),
    }),
  checkpoint: () =>
    set((state) => ({
      past: [
        ...state.past.slice(-29),
        {
          nodes: state.nodes,
          edges: state.edges,
          referenceIds: state.referenceIds,
          mask: state.mask,
          prompt: state.settings.prompt,
        },
      ],
      future: [],
    })),
  changeNodes: (changes) => {
    const edited = changes.some(
      (change) =>
        change.type === 'remove' ||
        (change.type === 'position' && change.dragging === undefined)
    )
    if (edited) get().checkpoint()
    set((state) => {
      const nodes = applyNodeChanges(changes, state.nodes)
      const ids = new Set(nodes.map((node) => node.id))
      const referenceIds = state.referenceIds.filter((id) => ids.has(id))
      return {
        nodes,
        edges: state.edges.filter(
          (edge) => ids.has(edge.source) && ids.has(edge.target)
        ),
        referenceIds,
        mask: state.mask && ids.has(state.mask.referenceId) ? state.mask : null,
        settings: followReferenceMentions(
          syncModeAfterReferenceChange(
            state.settings,
            state.referenceIds.length,
            referenceIds.length
          ),
          state,
          { nodes, referenceIds }
        ),
        revision:
          state.revision +
          (changes.some((change) => change.type !== 'select') ? 1 : 0),
      }
    })
  },
  connectReference: (connection) => {
    if (!canConnectReference(get().nodes, connection)) return false
    get().checkpoint()
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === connection.target
          ? {
              ...node,
              data: {
                ...node.data,
                referenceIds: [
                  ...(node.data.referenceIds || []),
                  connection.source,
                ],
                settings: { ...node.data.settings, mode: 'edit' },
                mask: node.data.referenceIds?.length
                  ? node.data.mask
                  : undefined,
              },
            }
          : node
      ),
      edges: [
        ...state.edges,
        {
          id: `${connection.source}-${connection.target}`,
          source: connection.source,
          target: connection.target,
        },
      ],
      revision: state.revision + 1,
    }))
    return true
  },
  changeEdges: (changes) => {
    const state = get()
    const allowed = changes.filter((change) => {
      if (change.type !== 'remove') return change.type === 'select'
      const edge = state.edges.find((item) => item.id === change.id)
      return (
        edge &&
        !state.nodes.some(
          (node) => node.id === edge.target && node.data.status === 'pending'
        )
      )
    })
    const removedIds = new Set(
      allowed.flatMap((change) => (change.type === 'remove' ? [change.id] : []))
    )
    if (removedIds.size) get().checkpoint()
    set((current) => {
      const removed = current.edges.filter((edge) => removedIds.has(edge.id))
      return {
        edges: applyEdgeChanges(allowed, current.edges),
        nodes: current.nodes.map((node) => {
          const sources = removed
            .filter((edge) => edge.target === node.id)
            .map((edge) => edge.source)
          if (!sources.length) return node
          const references = node.data.referenceIds || []
          const referenceIds = references.filter((id) => !sources.includes(id))
          return {
            ...node,
            data: {
              ...node.data,
              referenceIds,
              // A retry sends this prompt with the references that remain.
              prompt: renumberReferenceMentions(
                node.data.prompt,
                references,
                referenceIds
              ),
              settings: {
                ...node.data.settings,
                mode: referenceIds.length ? 'edit' : 'generate',
              },
              mask:
                references[0] === referenceIds[0] ? node.data.mask : undefined,
            },
          }
        }),
        revision: current.revision + (removedIds.size ? 1 : 0),
      }
    })
  },
  addNodes: (nodes, edges = []) => {
    get().checkpoint()
    set((state) => ({
      assetRoles: {
        ...state.assetRoles,
        ...Object.fromEntries(
          nodes.flatMap((node) =>
            node.data.asset
              ? [
                  [
                    node.data.asset.id,
                    { role: 'reference' as const, nodeId: node.id },
                  ],
                ]
              : []
          )
        ),
      },
    }))
    set((state) => ({
      nodes: [
        ...state.nodes.map((node) => ({ ...node, selected: false })),
        ...nodes,
      ],
      edges: [...state.edges, ...edges],
      revision: state.revision + 1,
    }))
  },
  removeNodes: (ids) => {
    get().checkpoint()
    const removed = new Set(ids)
    set((state) => {
      const nodes = state.nodes.filter((node) => !removed.has(node.id))
      const referenceIds = state.referenceIds.filter((id) => !removed.has(id))
      return {
        nodes,
        edges: state.edges.filter(
          (edge) => !removed.has(edge.source) && !removed.has(edge.target)
        ),
        referenceIds,
        mask:
          state.mask && !removed.has(state.mask.referenceId)
            ? state.mask
            : null,
        settings: followReferenceMentions(
          syncModeAfterReferenceChange(
            state.settings,
            state.referenceIds.length,
            referenceIds.length
          ),
          state,
          { nodes, referenceIds }
        ),
        revision: state.revision + 1,
      }
    })
  },
  updateNodeData: (id, data, jobId) =>
    set((state) => {
      // Keep undo/redo snapshots in sync with asynchronous generation results.
      // Undoing a move must never turn a completed image back into a pending job.
      const update = (nodes: DrawingNode[], preserveSettings = false) =>
        nodes.map((node) => {
          if (
            node.id !== id ||
            (jobId !== undefined && node.data.jobId !== jobId)
          ) {
            return node
          }
          return {
            ...node,
            data: {
              ...node.data,
              ...data,
              // Reference edits remain undoable after a retried job settles.
              settings: preserveSettings
                ? node.data.settings
                : (data.settings ?? node.data.settings),
            },
          }
        })
      return {
        assetRoles:
          data.asset && jobId
            ? {
                ...state.assetRoles,
                [data.asset.id]: { role: 'generated' as const, nodeId: id },
              }
            : state.assetRoles,
        nodes: update(state.nodes),
        past: state.past.map((snapshot) => ({
          ...snapshot,
          nodes: update(snapshot.nodes, true),
        })),
        future: state.future.map((snapshot) => ({
          ...snapshot,
          nodes: update(snapshot.nodes, true),
        })),
        revision: state.revision + 1,
      }
    }),
  updateSettings: (settings) =>
    set((state) => {
      const next = { ...state.settings, ...settings }
      return {
        settings: next,
        // Reusing another mode's settings leaves the current mode remembered.
        modeSettings:
          next.generationMode === state.settings.generationMode
            ? state.modeSettings
            : rememberModeSettings(
                state.userId,
                state.modeSettings,
                state.settings
              ),
        revision: state.revision + 1,
      }
    }),
  switchGenerationMode: (mode) =>
    set((state) => {
      if (state.settings.generationMode === mode) return state
      const remembered = state.modeSettings[mode]
      // The prompt, group and reference-driven mode carry over; the model and
      // its parameters come back as this mode last had them.
      const settings = settingsForImageModel(
        {
          ...DEFAULT_IMAGE_SETTINGS,
          ...remembered,
          generationMode: mode,
          group: state.settings.group,
          prompt: state.settings.prompt,
          mode: state.settings.mode,
        },
        remembered?.model ?? ''
      )
      return {
        settings,
        modeSettings: rememberModeSettings(
          state.userId,
          state.modeSettings,
          state.settings
        ),
        revision: state.revision + 1,
      }
    }),
  setViewport: (viewport) =>
    set((state) => ({ viewport, revision: state.revision + 1 })),
  toggleReference: (id) =>
    set((state) => {
      if (state.referenceIds.includes(id)) {
        const referenceIds = state.referenceIds.filter((value) => value !== id)
        return {
          referenceIds,
          mask: state.mask?.referenceId === id ? null : state.mask,
          settings: followReferenceMentions(
            syncModeAfterReferenceChange(
              state.settings,
              state.referenceIds.length,
              referenceIds.length
            ),
            state,
            { nodes: state.nodes, referenceIds }
          ),
          revision: state.revision + 1,
        }
      }
      if (
        state.referenceIds.length >= 16 ||
        !state.nodes.some(
          (node) =>
            node.id === id && node.data.asset && node.data.status === 'complete'
        )
      ) {
        return state
      }
      const referenceIds = [...state.referenceIds, id]
      return {
        referenceIds,
        settings: followReferenceMentions(
          syncModeAfterReferenceChange(
            state.settings,
            state.referenceIds.length,
            referenceIds.length
          ),
          state,
          { nodes: state.nodes, referenceIds }
        ),
        revision: state.revision + 1,
      }
    }),
  // Replaces the whole list, so its caller owns the prompt that goes with it;
  // appending, as an upload does, moves no mention.
  setReferences: (ids) =>
    set((state) => {
      const referenceIds = [...new Set(ids)]
        .filter((id) =>
          state.nodes.some(
            (node) =>
              node.id === id &&
              node.data.status === 'complete' &&
              node.data.asset
          )
        )
        .slice(0, 16)
      return {
        referenceIds,
        mask: state.mask?.referenceId === referenceIds[0] ? state.mask : null,
        settings: syncModeAfterReferenceChange(
          state.settings,
          state.referenceIds.length,
          referenceIds.length
        ),
        revision: state.revision + 1,
      }
    }),
  reorderReferences: (sourceId, targetId) =>
    set((state) => {
      const sourceIndex = state.referenceIds.indexOf(sourceId)
      const targetIndex = state.referenceIds.indexOf(targetId)
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return state
      }
      const referenceIds = [...state.referenceIds]
      referenceIds.splice(sourceIndex, 1)
      referenceIds.splice(targetIndex, 0, sourceId)
      return {
        referenceIds,
        mask: state.mask?.referenceId === referenceIds[0] ? state.mask : null,
        settings: followReferenceMentions(state.settings, state, {
          nodes: state.nodes,
          referenceIds,
        }),
        revision: state.revision + 1,
      }
    }),
  reuseNodeSettings: (id) => {
    const state = get()
    const node = state.nodes.find((item) => item.id === id)
    if (!node) return
    const nodeReferenceIds = node.data.referenceIds || []
    const referenceIds = nodeReferenceIds.filter((referenceId) =>
      state.nodes.some((item) => item.id === referenceId)
    )
    state.updateSettings({
      ...node.data.settings,
      // The image's mentions count through its own references; carry them
      // over to the ones the composer can bring back.
      prompt: renumberReferenceMentions(
        node.data.prompt,
        nodeReferenceIds,
        getAvailableReferenceNodes(state.nodes, referenceIds).map(
          (item) => item.id
        )
      ),
    })
    get().setReferences(referenceIds)
  },
  setMask: (mask) => set((state) => ({ mask, revision: state.revision + 1 })),
  setPreview: (previewId) => set({ previewId }),
  undo: () =>
    set((state) => {
      const snapshot = state.past.at(-1)
      if (!snapshot) return state
      return {
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        referenceIds: snapshot.referenceIds,
        mask: snapshot.mask,
        settings: settingsAfterRestore(
          syncModeAfterReferenceChange(
            state.settings,
            state.referenceIds.length,
            snapshot.referenceIds.length
          ),
          state,
          snapshot
        ),
        past: state.past.slice(0, -1),
        future: [
          {
            nodes: state.nodes,
            edges: state.edges,
            referenceIds: state.referenceIds,
            mask: state.mask,
            prompt: state.settings.prompt,
          },
          ...state.future,
        ],
        revision: state.revision + 1,
      }
    }),
  redo: () =>
    set((state) => {
      const snapshot = state.future[0]
      if (!snapshot) return state
      return {
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        referenceIds: snapshot.referenceIds,
        mask: snapshot.mask,
        settings: settingsAfterRestore(
          syncModeAfterReferenceChange(
            state.settings,
            state.referenceIds.length,
            snapshot.referenceIds.length
          ),
          state,
          snapshot
        ),
        future: state.future.slice(1),
        past: [
          ...state.past,
          {
            nodes: state.nodes,
            edges: state.edges,
            referenceIds: state.referenceIds,
            mask: state.mask,
            prompt: state.settings.prompt,
          },
        ],
        revision: state.revision + 1,
      }
    }),
  arrange: () => {
    get().checkpoint()
    set((state) => ({
      nodes: arrangeImageNodes(state.nodes, state.edges),
      revision: state.revision + 1,
    }))
  },
  clear: () => {
    get().checkpoint()
    set((state) => ({
      nodes: [],
      edges: [],
      referenceIds: [],
      mask: null,
      settings: followReferenceMentions(
        syncModeAfterReferenceChange(
          state.settings,
          state.referenceIds.length,
          0
        ),
        state,
        { nodes: [], referenceIds: [] }
      ),
      revision: state.revision + 1,
    }))
  },
  replaceDocument: (document) => {
    get().checkpoint()
    set((state) => ({
      ...document,
      settings: document.settings,
      previewId: null,
      revision: state.revision + 1,
    }))
  },
}))

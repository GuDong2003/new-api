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
import { applyNodeChanges, type NodeChange, type Viewport } from '@xyflow/react'
import { create } from 'zustand'

import {
  DEFAULT_NAI_SETTINGS,
  naiSettingsSchema,
} from '@/features/playground/nai/lib/nai-settings'
import type {
  NaiCanvasDocument,
  NaiCanvasNode,
  NaiImageNodeData,
  NaiSettings,
} from '@/features/playground/nai/types'

type NaiSnapshot = Pick<NaiCanvasDocument, 'nodes'>

type NaiDrawingState = NaiCanvasDocument & {
  assetRoles: Record<
    string,
    { role: 'generated' | 'reference' | 'mask'; nodeId: string }
  >
  userId: number | null
  ready: boolean
  revision: number
  past: NaiSnapshot[]
  future: NaiSnapshot[]
  previewId: string | null
  initialize: (userId: number, document?: NaiCanvasDocument) => void
  hydrate: (document: NaiCanvasDocument | null) => void
  checkpoint: () => void
  changeNodes: (changes: NodeChange<NaiCanvasNode>[]) => void
  addNodes: (nodes: NaiCanvasNode[]) => void
  removeNodes: (ids: string[]) => void
  updateNodeData: (
    id: string,
    data: Partial<NaiImageNodeData>,
    jobId?: string
  ) => void
  updateSettings: (settings: Partial<NaiSettings>) => void
  setViewport: (viewport: Viewport) => void
  setPreview: (id: string | null) => void
  undo: () => void
  redo: () => void
  arrange: () => void
  clear: () => void
}

const defaultViewport: Viewport = { x: 40, y: 40, zoom: 1 }

function arrangeNodes(nodes: NaiCanvasNode[]): NaiCanvasNode[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  return nodes.map((node, index) => ({
    ...node,
    position: {
      x: (index % columns) * 320,
      y: Math.floor(index / columns) * 370,
    },
  }))
}

export const useNaiDrawingStore = create<NaiDrawingState>((set, get) => ({
  assetRoles: {},
  version: 1,
  nodes: [],
  viewport: defaultViewport,
  settings: DEFAULT_NAI_SETTINGS,
  userId: null,
  ready: false,
  revision: 0,
  past: [],
  future: [],
  previewId: null,
  initialize: (userId, document) =>
    set({
      assetRoles: {},
      userId,
      ready: Boolean(document),
      revision: 0,
      past: [],
      future: [],
      previewId: null,
      nodes: document?.nodes || [],
      viewport: document?.viewport || defaultViewport,
      settings: document?.settings || { ...DEFAULT_NAI_SETTINGS },
    }),
  hydrate: (document) =>
    set({
      ready: true,
      ...(document
        ? {
            nodes: document.nodes,
            viewport: document.viewport,
            settings: document.settings,
          }
        : {}),
    }),
  checkpoint: () =>
    set((state) => ({
      past: [...state.past.slice(-29), { nodes: state.nodes }],
      future: [],
    })),
  changeNodes: (changes) => {
    const edited = changes.some(
      (change) =>
        change.type === 'remove' ||
        (change.type === 'position' && change.dragging === undefined)
    )
    if (edited) get().checkpoint()
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      revision:
        state.revision +
        (changes.some((change) => change.type !== 'select') ? 1 : 0),
    }))
  },
  addNodes: (nodes) => {
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
      revision: state.revision + 1,
    }))
  },
  removeNodes: (ids) => {
    get().checkpoint()
    const removed = new Set(ids)
    set((state) => ({
      nodes: state.nodes.filter((node) => !removed.has(node.id)),
      revision: state.revision + 1,
    }))
  },
  updateNodeData: (id, data, jobId) =>
    set((state) => ({
      assetRoles:
        data.asset && jobId
          ? {
              ...state.assetRoles,
              [data.asset.id]: { role: 'generated' as const, nodeId: id },
            }
          : state.assetRoles,
      nodes: state.nodes.map((node) => {
        if (node.id !== id || (jobId && node.data.jobId !== jobId)) return node
        return { ...node, data: { ...node.data, ...data } }
      }),
      revision: state.revision + 1,
    })),
  updateSettings: (settings) =>
    set((state) => ({
      settings: naiSettingsSchema.parse({ ...state.settings, ...settings }),
      revision: state.revision + 1,
    })),
  setViewport: (viewport) =>
    set((state) => ({ viewport, revision: state.revision + 1 })),
  setPreview: (previewId) => set({ previewId }),
  undo: () =>
    set((state) => {
      const snapshot = state.past.at(-1)
      if (!snapshot) return state
      return {
        nodes: snapshot.nodes,
        past: state.past.slice(0, -1),
        future: [{ nodes: state.nodes }, ...state.future],
        revision: state.revision + 1,
      }
    }),
  redo: () =>
    set((state) => {
      const snapshot = state.future[0]
      if (!snapshot) return state
      return {
        nodes: snapshot.nodes,
        future: state.future.slice(1),
        past: [...state.past, { nodes: state.nodes }],
        revision: state.revision + 1,
      }
    }),
  arrange: () => {
    get().checkpoint()
    set((state) => ({
      nodes: arrangeNodes(state.nodes),
      revision: state.revision + 1,
    }))
  },
  clear: () => {
    get().checkpoint()
    set((state) => ({
      nodes: [],
      previewId: null,
      revision: state.revision + 1,
    }))
  },
}))

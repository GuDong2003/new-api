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
import { DEFAULT_IMAGE_SETTINGS } from '@/features/playground/drawing/lib/image-settings'
import { canConnectReference } from '@/features/playground/drawing/lib/reference-connections'
import type {
  DrawingDocument,
  DrawingMask,
  DrawingNode,
  ImageNodeData,
  ImageSettings,
} from '@/features/playground/drawing/types'

type CanvasSnapshot = Pick<
  DrawingDocument,
  'nodes' | 'edges' | 'referenceIds' | 'mask'
>
type DrawingState = DrawingDocument & {
  userId: number | null
  ready: boolean
  revision: number
  past: CanvasSnapshot[]
  future: CanvasSnapshot[]
  previewId: string | null
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
  setViewport: (viewport: Viewport) => void
  toggleReference: (id: string) => void
  setReferences: (ids: string[]) => void
  setMask: (mask: DrawingMask | null) => void
  setPreview: (id: string | null) => void
  undo: () => void
  redo: () => void
  arrange: () => void
  clear: () => void
  replaceDocument: (document: DrawingDocument) => void
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
  version: 1,
  nodes: [],
  edges: [],
  viewport: { x: 40, y: 40, zoom: 1 },
  settings: DEFAULT_IMAGE_SETTINGS,
  userId: null,
  ready: false,
  revision: 0,
  past: [],
  future: [],
  referenceIds: [],
  mask: null,
  previewId: null,

  initialize: (userId, document) =>
    set({
      userId,
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
      return {
        nodes,
        edges: state.edges.filter(
          (edge) => ids.has(edge.source) && ids.has(edge.target)
        ),
        referenceIds: state.referenceIds.filter((id) => ids.has(id)),
        mask: state.mask && ids.has(state.mask.referenceId) ? state.mask : null,
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
    set((state) => ({
      nodes: state.nodes.filter((node) => !removed.has(node.id)),
      edges: state.edges.filter(
        (edge) => !removed.has(edge.source) && !removed.has(edge.target)
      ),
      referenceIds: state.referenceIds.filter((id) => !removed.has(id)),
      mask:
        state.mask && !removed.has(state.mask.referenceId) ? state.mask : null,
      revision: state.revision + 1,
    }))
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
    set((state) => ({
      settings: { ...state.settings, ...settings },
      revision: state.revision + 1,
    })),
  setViewport: (viewport) =>
    set((state) => ({ viewport, revision: state.revision + 1 })),
  toggleReference: (id) =>
    set((state) => {
      if (state.referenceIds.includes(id)) {
        return {
          referenceIds: state.referenceIds.filter((value) => value !== id),
          mask: state.mask?.referenceId === id ? null : state.mask,
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
      return {
        referenceIds: [...state.referenceIds, id],
        settings: { ...state.settings, mode: 'edit' },
        revision: state.revision + 1,
      }
    }),
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
        revision: state.revision + 1,
      }
    }),
  setMask: (mask) => set((state) => ({ mask, revision: state.revision + 1 })),
  setPreview: (previewId) => set({ previewId }),
  undo: () =>
    set((state) => {
      const snapshot = state.past.at(-1)
      if (!snapshot) return state
      return {
        ...snapshot,
        past: state.past.slice(0, -1),
        future: [
          {
            nodes: state.nodes,
            edges: state.edges,
            referenceIds: state.referenceIds,
            mask: state.mask,
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
        ...snapshot,
        future: state.future.slice(1),
        past: [
          ...state.past,
          {
            nodes: state.nodes,
            edges: state.edges,
            referenceIds: state.referenceIds,
            mask: state.mask,
          },
        ],
        revision: state.revision + 1,
      }
    }),
  arrange: () => {
    get().checkpoint()
    set((state) => ({
      nodes: arrangeImageNodes(state.nodes),
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
      revision: state.revision + 1,
    }))
  },
  replaceDocument: (document) => {
    get().checkpoint()
    set((state) => ({
      ...document,
      previewId: null,
      revision: state.revision + 1,
    }))
  },
}))

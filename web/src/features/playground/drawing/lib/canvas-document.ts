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
import dagre from '@dagrejs/dagre'
import type { Edge } from '@xyflow/react'
import { z } from 'zod'

import type { DrawingDocument, DrawingNode } from '../types'
import {
  CANVAS_NODE_GAP as NODE_GAP,
  CANVAS_NODE_HEIGHT as DEFAULT_NODE_HEIGHT,
  CANVAS_NODE_WIDTH as DEFAULT_NODE_WIDTH,
} from './canvas-geometry'
import { isSafeImageSource } from './image-assets'
import {
  imageSettingsSchema,
  normalizeStoredImageSettings,
} from './image-settings'

const assetSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(512),
  src: z
    .string()
    .max(72 * 1024 * 1024)
    .refine(isSafeImageSource),
  width: z.number().int().positive().max(32768),
  height: z.number().int().positive().max(32768),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
})
const nodeSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('image'),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  width: z.number().positive().max(10000).optional(),
  height: z.number().positive().max(10000).optional(),
  data: z.object({
    asset: assetSchema.optional(),
    prompt: z.string().max(32000),
    settings: imageSettingsSchema,
    status: z.enum(['pending', 'complete', 'error', 'cancelled']),
    error: z.string().max(10000).optional(),
    revisedPrompt: z.string().max(64000).optional(),
    jobId: z.string().max(128).optional(),
    taskId: z.string().max(128).optional(),
    createdAt: z.number().finite(),
    referenceIds: z.array(z.string()).max(16).optional(),
    mask: assetSchema.optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
  }),
})
export const drawingDocumentSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(nodeSchema).max(500),
    edges: z
      .array(
        z.object({ id: z.string(), source: z.string(), target: z.string() })
      )
      .max(8000),
    viewport: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().min(0.1).max(4),
    }),
    settings: imageSettingsSchema,
    referenceIds: z.array(z.string()).max(16).default([]),
    mask: z
      .object({ referenceId: z.string(), asset: assetSchema })
      .nullable()
      .default(null),
  })
  .superRefine((document, context) => {
    const ids = new Set(document.nodes.map((node) => node.id))
    if (
      ids.size !== document.nodes.length ||
      document.edges.some(
        (edge) => !ids.has(edge.source) || !ids.has(edge.target)
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid canvas nodes or connections.',
      })
    }
    if (
      document.referenceIds.some(
        (id) =>
          !document.nodes.some(
            (node) =>
              node.id === id &&
              node.data.status === 'complete' &&
              node.data.asset
          )
      )
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid reference images.' })
    }
    if (document.mask) {
      const reference = document.nodes.find(
        (node) => node.id === document.referenceIds[0]
      )?.data.asset
      if (
        !reference ||
        document.mask.referenceId !== document.referenceIds[0] ||
        document.mask.asset.mimeType !== 'image/png' ||
        reference.width !== document.mask.asset.width ||
        reference.height !== document.mask.asset.height
      ) {
        context.addIssue({ code: 'custom', message: 'Invalid image mask.' })
      }
    }
  })

export function parseDrawingDocument(input: unknown): DrawingDocument {
  const result = drawingDocumentSchema.safeParse(input)
  if (!result.success) {
    throw new Error('This file is not a valid drawing canvas.')
  }
  return {
    ...result.data,
    nodes: result.data.nodes.map((node) => ({
      ...node,
      dragHandle: '.drawing-node-handle',
      data: {
        ...node.data,
        jobId: undefined,
        // A pending node backed by an async task can be resumed: the gateway
        // kept generating while the canvas was closed. Without a task there is
        // nothing left to reattach to.
        status:
          node.data.status === 'pending' && !node.data.taskId
            ? 'cancelled'
            : node.data.status,
      },
    })),
  }
}

export function serializeDrawingDocument(
  document: DrawingDocument
): DrawingDocument {
  return {
    version: 1,
    viewport: document.viewport,
    settings: normalizeStoredImageSettings(document.settings),
    referenceIds: document.referenceIds,
    mask: document.mask,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: 'image',
      position: node.position,
      width: node.width,
      height: node.height,
      data: {
        ...node.data,
        settings: normalizeStoredImageSettings(node.data.settings),
        progress: undefined,
      },
    })),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
  }
}

type CanvasPosition = { x: number; y: number }
type CanvasEdge = Pick<Edge, 'source' | 'target'> & Partial<Pick<Edge, 'id'>>
type NodeSize = { width: number; height: number }
type LayoutEntry = {
  node: DrawingNode
  position: CanvasPosition
}
type LayerLayout = {
  entries: LayoutEntry[]
  width: number
  height: number
}
type ComponentLayout = {
  positions: Map<string, CanvasPosition>
  width: number
  height: number
}

const COMPONENT_GAP = 96

function getNodeSize(node: DrawingNode): NodeSize {
  const width =
    typeof node.width === 'number' &&
    Number.isFinite(node.width) &&
    node.width > 0
      ? node.width
      : DEFAULT_NODE_WIDTH
  const height =
    typeof node.height === 'number' &&
    Number.isFinite(node.height) &&
    node.height > 0
      ? node.height
      : DEFAULT_NODE_HEIGHT
  return { width, height }
}

function getValidEdges(nodes: DrawingNode[], edges: CanvasEdge[]) {
  const ids = new Set(nodes.map((node) => node.id))
  return edges.filter(
    (edge) =>
      edge.source !== edge.target &&
      ids.has(edge.source) &&
      ids.has(edge.target)
  )
}

function getConnectedSelection(
  nodes: DrawingNode[],
  edges: CanvasEdge[]
): Set<string> {
  const selectedIds = nodes
    .filter((node) => node.selected)
    .map((node) => node.id)
  if (!selectedIds.length) return new Set(nodes.map((node) => node.id))

  const neighbors = new Map<string, string[]>()
  for (const node of nodes) neighbors.set(node.id, [])
  for (const edge of getValidEdges(nodes, edges)) {
    neighbors.get(edge.source)?.push(edge.target)
    neighbors.get(edge.target)?.push(edge.source)
  }

  const included = new Set<string>()
  const queue = [...selectedIds]
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]
    if (!id || included.has(id)) continue
    included.add(id)
    queue.push(...(neighbors.get(id) || []))
  }
  return included
}

function getComponents(
  nodes: DrawingNode[],
  edges: CanvasEdge[]
): DrawingNode[][] {
  const neighbors = new Map<string, string[]>()
  for (const node of nodes) neighbors.set(node.id, [])
  for (const edge of edges) {
    neighbors.get(edge.source)?.push(edge.target)
    neighbors.get(edge.target)?.push(edge.source)
  }

  const visited = new Set<string>()
  const components: DrawingNode[][] = []
  for (const node of nodes) {
    if (visited.has(node.id)) continue
    const ids: string[] = []
    const queue = [node.id]
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]
      if (!id || visited.has(id)) continue
      visited.add(id)
      ids.push(id)
      queue.push(...(neighbors.get(id) || []))
    }
    const idsInComponent = new Set(ids)
    components.push(nodes.filter((item) => idsInComponent.has(item.id)))
  }
  return components
}

// layoutLayer packs an unconnected batch into a near-square grid. Connected
// nodes go through layoutComponent instead, which ranks them by their edges.
function layoutLayer(nodes: DrawingNode[]): LayerLayout {
  if (!nodes.length) return { entries: [], width: 0, height: 0 }

  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  const rows = Math.ceil(nodes.length / columns)
  const sizes = nodes.map((node) => getNodeSize(node))
  const columnWidths = Array.from({ length: columns }, () => 0)
  const rowHeights = Array.from({ length: rows }, () => 0)
  for (const [index, size] of sizes.entries()) {
    const column = index % columns
    const row = Math.floor(index / columns)
    columnWidths[column] = Math.max(columnWidths[column], size.width)
    rowHeights[row] = Math.max(rowHeights[row], size.height)
  }

  const columnOffsets: number[] = []
  let x = 0
  for (const width of columnWidths) {
    columnOffsets.push(x)
    x += width + NODE_GAP
  }
  const rowOffsets: number[] = []
  let y = 0
  for (const height of rowHeights) {
    rowOffsets.push(y)
    y += height + NODE_GAP
  }

  const entries = nodes.map((node, index) => ({
    node,
    position: {
      x: columnOffsets[index % columns],
      y: rowOffsets[Math.floor(index / columns)],
    },
  }))
  return {
    entries,
    width: x - NODE_GAP,
    height: y - NODE_GAP,
  }
}

// layoutComponent ranks one connected group left to right with dagre. A layer
// holds every node at the same distance from a source, so a fan-out stacks in
// one column instead of reading as a longer chain, and each node settles on the
// centre of the nodes it comes from.
function layoutComponent(
  nodes: DrawingNode[],
  edges: CanvasEdge[]
): ComponentLayout {
  const graph = new dagre.graphlib.Graph({ directed: true })
  graph.setGraph({ rankdir: 'LR', nodesep: NODE_GAP, ranksep: NODE_GAP })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) {
    graph.setNode(node.id, getNodeSize(node))
  }
  const componentEdges = getValidEdges(nodes, edges)
  for (const edge of componentEdges) {
    graph.setEdge(edge.source, edge.target)
  }
  dagre.layout(graph)

  // dagre orders a layer by a crossing heuristic, which is free to flip nodes
  // that nothing constrains against each other, so arranging twice could
  // reshuffle a set of references. Re-stack each layer in the order the canvas
  // holds its nodes, walking left to right so every layer lands on the middle
  // of the images it was generated from.
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const sources = new Map<string, string[]>()
  for (const edge of componentEdges) {
    const known = sources.get(edge.target)
    if (known) known.push(edge.source)
    else sources.set(edge.target, [edge.source])
  }
  const layers = new Map<number, DrawingNode[]>()
  for (const node of nodes) {
    const rank = Math.round(graph.node(node.id).x)
    const layer = layers.get(rank)
    if (layer) layer.push(node)
    else layers.set(rank, [node])
  }

  const centres = new Map<string, number>()
  const spanOf = (members: DrawingNode[], placed: boolean) => {
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const member of members) {
      const centre = placed ? centres.get(member.id) : graph.node(member.id).y
      if (centre === undefined) continue
      const { height } = getNodeSize(member)
      top = Math.min(top, centre - height / 2)
      bottom = Math.max(bottom, centre + height / 2)
    }
    return top <= bottom ? (top + bottom) / 2 : undefined
  }
  for (const rank of [...layers.keys()].sort((a, b) => a - b)) {
    const layer = layers.get(rank) ?? []
    const parents = layer.flatMap((node) =>
      (sources.get(node.id) ?? []).flatMap((id) => byID.get(id) ?? [])
    )
    const centre = spanOf(parents, true) ?? spanOf(layer, false) ?? 0
    let stacked = NODE_GAP * (layer.length - 1)
    for (const node of layer) stacked += getNodeSize(node).height
    let cursor = centre - stacked / 2
    for (const node of layer) {
      const { height } = getNodeSize(node)
      centres.set(node.id, cursor + height / 2)
      cursor += height + NODE_GAP
    }
  }

  // dagre reports centres; the canvas positions nodes by their top-left corner.
  const positions = new Map<string, CanvasPosition>()
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    const size = getNodeSize(node)
    const laid = graph.node(node.id)
    const x = laid.x - size.width / 2
    const y = (centres.get(node.id) ?? laid.y) - size.height / 2
    positions.set(node.id, { x, y })
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x + size.width)
    bottom = Math.max(bottom, y + size.height)
  }
  for (const [id, position] of positions) {
    positions.set(id, { x: position.x - left, y: position.y - top })
  }
  return { positions, width: right - left, height: bottom - top }
}

function getBounds(
  nodes: DrawingNode[],
  positions: Map<string, CanvasPosition> = new Map()
) {
  if (!nodes.length) return { left: 0, top: 0, right: 0, bottom: 0 }
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    const position = positions.get(node.id) || node.position
    const size = getNodeSize(node)
    left = Math.min(left, position.x)
    top = Math.min(top, position.y)
    right = Math.max(right, position.x + size.width)
    bottom = Math.max(bottom, position.y + size.height)
  }
  return { left, top, right, bottom }
}

function packComponents(components: ComponentLayout[]) {
  if (!components.length) return new Map<string, CanvasPosition>()
  const columns = Math.max(1, Math.ceil(Math.sqrt(components.length)))
  const rows = Math.ceil(components.length / columns)
  const columnWidths = Array.from({ length: columns }, () => 0)
  const rowHeights = Array.from({ length: rows }, () => 0)
  for (const [index, component] of components.entries()) {
    const column = index % columns
    const row = Math.floor(index / columns)
    columnWidths[column] = Math.max(columnWidths[column], component.width)
    rowHeights[row] = Math.max(rowHeights[row], component.height)
  }
  const columnOffsets: number[] = []
  let x = 0
  for (const width of columnWidths) {
    columnOffsets.push(x)
    x += width + COMPONENT_GAP
  }
  const rowOffsets: number[] = []
  let y = 0
  for (const height of rowHeights) {
    rowOffsets.push(y)
    y += height + COMPONENT_GAP
  }

  const positions = new Map<string, CanvasPosition>()
  for (const [index, component] of components.entries()) {
    const offset = {
      x: columnOffsets[index % columns],
      y: rowOffsets[Math.floor(index / columns)],
    }
    for (const [id, position] of component.positions) {
      positions.set(id, {
        x: position.x + offset.x,
        y: position.y + offset.y,
      })
    }
  }
  return positions
}

function getOverlapSafeOffset(
  nodes: DrawingNode[],
  positions: Map<string, CanvasPosition>,
  obstacles: DrawingNode[]
) {
  if (!nodes.length || !obstacles.length) return { x: 0, y: 0 }
  const baseBounds = getBounds(nodes, positions)
  const obstacleBounds = obstacles.map((node) => getBounds([node]))
  let offsetX = 0
  for (let attempt = 0; attempt <= obstacleBounds.length; attempt += 1) {
    const conflict = obstacleBounds.find((obstacle) =>
      nodes.some((node) => {
        const position = positions.get(node.id)
        if (!position) return false
        const size = getNodeSize(node)
        const left = position.x + offsetX
        const top = position.y
        return (
          left < obstacle.right &&
          left + size.width > obstacle.left &&
          top < obstacle.bottom &&
          top + size.height > obstacle.top
        )
      })
    )
    if (!conflict) break
    offsetX = Math.max(offsetX, conflict.right - baseBounds.left + NODE_GAP)
  }
  return { x: offsetX, y: 0 }
}

export function arrangeImageNodes(
  nodes: DrawingNode[],
  edges: CanvasEdge[] = []
): DrawingNode[] {
  if (!nodes.length) return []
  const includedIds = getConnectedSelection(nodes, edges)
  const arrangedNodes = nodes.filter((node) => includedIds.has(node.id))
  const arrangedEdges = getValidEdges(arrangedNodes, edges)
  const components = getComponents(arrangedNodes, arrangedEdges).map(
    (component) => {
      const componentIds = new Set(component.map((node) => node.id))
      return layoutComponent(
        component,
        arrangedEdges.filter(
          (edge) =>
            componentIds.has(edge.source) && componentIds.has(edge.target)
        )
      )
    }
  )
  const positions = packComponents(components)
  const hasSelection = nodes.some((node) => node.selected)
  if (hasSelection) {
    const currentBounds = getBounds(arrangedNodes)
    const arrangedBounds = getBounds(arrangedNodes, positions)
    const offsetX =
      (currentBounds.left + currentBounds.right) / 2 -
      (arrangedBounds.left + arrangedBounds.right) / 2
    const offsetY =
      (currentBounds.top + currentBounds.bottom) / 2 -
      (arrangedBounds.top + arrangedBounds.bottom) / 2
    for (const [id, position] of positions) {
      positions.set(id, { x: position.x + offsetX, y: position.y + offsetY })
    }
  }
  return nodes.map((node) => {
    const position = positions.get(node.id)
    return position ? { ...node, position } : node
  })
}

export function positionGeneratedImageNodes(
  existingNodes: DrawingNode[],
  generatedNodes: DrawingNode[],
  referenceNodes: DrawingNode[],
  anchor: CanvasPosition
): DrawingNode[] {
  if (!generatedNodes.length) return []
  const layer = layoutLayer(generatedNodes)
  const referenceBounds = getBounds(referenceNodes)
  const initialPositions = new Map<string, CanvasPosition>()
  const origin = referenceNodes.length
    ? {
        x: referenceBounds.right + NODE_GAP,
        y:
          referenceBounds.top +
          (referenceBounds.bottom - referenceBounds.top - layer.height) / 2,
      }
    : anchor
  for (const entry of layer.entries) {
    initialPositions.set(entry.node.id, {
      x: origin.x + entry.position.x,
      y: origin.y + entry.position.y,
    })
  }
  const referenceIds = new Set(referenceNodes.map((node) => node.id))
  const obstacles = existingNodes.filter((node) => !referenceIds.has(node.id))
  const offset = getOverlapSafeOffset(
    generatedNodes,
    initialPositions,
    obstacles
  )
  return generatedNodes.map((node) => {
    const position = initialPositions.get(node.id)
    return position
      ? {
          ...node,
          position: { x: position.x + offset.x, y: position.y + offset.y },
        }
      : node
  })
}

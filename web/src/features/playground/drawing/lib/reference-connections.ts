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
import { MarkerType, type Connection, type Edge } from '@xyflow/react'

import type { DrawingNode } from '../types'
import { getImageModelFamily } from './image-settings'

export function getAvailableReferenceNodes(
  nodes: DrawingNode[],
  referenceIds: readonly string[]
): DrawingNode[] {
  return referenceIds.flatMap((id) => {
    const node = nodes.find(
      (item) => item.id === id && item.data.status === 'complete'
    )
    return node?.data.asset ? [node] : []
  })
}

export function canConnectReference(
  nodes: DrawingNode[],
  connection: Pick<Connection, 'source' | 'target'>
): boolean {
  if (connection.source === connection.target) return false
  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  if (
    !source?.data.asset ||
    source.data.status !== 'complete' ||
    !target ||
    target.data.status === 'pending'
  ) {
    return false
  }

  const family = getImageModelFamily(target.data.settings.model)
  const references = target.data.referenceIds || []
  if (
    family === 'dall-e-3' ||
    references.includes(source.id) ||
    references.length >= (family === 'dall-e-2' ? 1 : 16)
  ) {
    return false
  }

  // A reference must not depend on the image it is being attached to.
  const ancestors = [source.id]
  const visited = new Set<string>()
  while (ancestors.length) {
    const id = ancestors.pop()
    if (id === undefined) continue
    if (id === target.id) return false
    if (visited.has(id)) continue
    visited.add(id)
    ancestors.push(
      ...(nodes.find((node) => node.id === id)?.data.referenceIds || [])
    )
  }
  return true
}

// A reference connection is context rather than the subject of the canvas, so
// it stays quiet until it is selected or the image it feeds starts generating.
export const referenceEdgeOptions = {
  type: 'smoothstep',
  style: { stroke: 'var(--muted-foreground)', opacity: 0.5, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)' },
}

const activeReferenceEdgeStyle = {
  stroke: 'var(--primary)',
  opacity: 1,
  strokeWidth: 2.5,
}

// decorateReferenceEdges raises the connections worth looking at. Marching ants
// mark a reference that is being consumed right now, so a long generation shows
// which images it is reading without opening anything.
export function decorateReferenceEdges<T extends Edge>(
  edges: T[],
  generatingTargets: ReadonlySet<string>
): T[] {
  return edges.map((edge) => {
    const feedsGeneration = generatingTargets.has(edge.target)
    if (!edge.selected && !feedsGeneration) return edge
    return {
      ...edge,
      animated: feedsGeneration,
      style: {
        ...referenceEdgeOptions.style,
        ...edge.style,
        ...activeReferenceEdgeStyle,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--primary)' },
    }
  })
}

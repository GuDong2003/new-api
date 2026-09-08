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
import type { Connection } from '@xyflow/react'

import type { DrawingNode } from '../types'
import { getImageModelFamily } from './image-settings'

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

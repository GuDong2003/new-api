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

// Opening a canvas downloads one image per asset. Concurrent opens of the same
// canvas share a single download, so progress is published per canvas here
// rather than handed to one caller through a callback.

export type CanvasOpenProgress = { loaded: number; total: number }

const progress = new Map<string, CanvasOpenProgress>()
const listeners = new Map<string, Set<() => void>>()

function announce(canvasId: string) {
  for (const listener of listeners.get(canvasId) ?? []) listener()
}

export function startCanvasOpenProgress(canvasId: string, total: number) {
  progress.set(canvasId, { loaded: 0, total })
  announce(canvasId)
}

export function advanceCanvasOpenProgress(canvasId: string) {
  const current = progress.get(canvasId)
  if (!current) return
  progress.set(canvasId, { ...current, loaded: current.loaded + 1 })
  announce(canvasId)
}

export function clearCanvasOpenProgress(canvasId: string) {
  if (!progress.delete(canvasId)) return
  announce(canvasId)
}

export function getCanvasOpenProgress(
  canvasId: string
): CanvasOpenProgress | undefined {
  return progress.get(canvasId)
}

export function subscribeCanvasOpenProgress(
  canvasId: string,
  listener: () => void
): () => void {
  const known = listeners.get(canvasId) ?? new Set<() => void>()
  known.add(listener)
  listeners.set(canvasId, known)
  return () => {
    known.delete(listener)
    if (!known.size) listeners.delete(canvasId)
  }
}

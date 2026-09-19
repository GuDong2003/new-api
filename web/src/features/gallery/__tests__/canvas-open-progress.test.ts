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
import { afterEach, expect, it, vi } from 'vitest'

import {
  advanceCanvasOpenProgress,
  clearCanvasOpenProgress,
  getCanvasOpenProgress,
  startCanvasOpenProgress,
  subscribeCanvasOpenProgress,
} from '../lib/canvas-open-progress'

afterEach(() => {
  clearCanvasOpenProgress('canvas-a')
  clearCanvasOpenProgress('canvas-b')
})

it('counts each downloaded image against the canvas total', () => {
  startCanvasOpenProgress('canvas-a', 3)
  advanceCanvasOpenProgress('canvas-a')
  advanceCanvasOpenProgress('canvas-a')

  expect(getCanvasOpenProgress('canvas-a')).toEqual({ loaded: 2, total: 3 })
})

// Two views can open the same canvas, and they share one download, so both have
// to see the same progress rather than the first caller consuming it.
it('publishes progress to every subscriber of the same canvas', () => {
  const first = vi.fn()
  const second = vi.fn()
  subscribeCanvasOpenProgress('canvas-a', first)
  subscribeCanvasOpenProgress('canvas-a', second)

  startCanvasOpenProgress('canvas-a', 2)
  advanceCanvasOpenProgress('canvas-a')

  expect(first).toHaveBeenCalledTimes(2)
  expect(second).toHaveBeenCalledTimes(2)
})

it('keeps canvases from reporting each other progress', () => {
  const listener = vi.fn()
  subscribeCanvasOpenProgress('canvas-a', listener)

  startCanvasOpenProgress('canvas-b', 4)
  advanceCanvasOpenProgress('canvas-b')

  expect(listener).not.toHaveBeenCalled()
  expect(getCanvasOpenProgress('canvas-a')).toBeUndefined()
})

it('stops reporting once the open settles so a reopen starts from nothing', () => {
  startCanvasOpenProgress('canvas-a', 2)
  advanceCanvasOpenProgress('canvas-a')
  clearCanvasOpenProgress('canvas-a')

  expect(getCanvasOpenProgress('canvas-a')).toBeUndefined()
  // A stray report after the open finished must not resurrect a stale count.
  advanceCanvasOpenProgress('canvas-a')
  expect(getCanvasOpenProgress('canvas-a')).toBeUndefined()
})

it('releases a subscriber so a closed view stops being notified', () => {
  const listener = vi.fn()
  const unsubscribe = subscribeCanvasOpenProgress('canvas-a', listener)

  unsubscribe()
  startCanvasOpenProgress('canvas-a', 1)

  expect(listener).not.toHaveBeenCalled()
})

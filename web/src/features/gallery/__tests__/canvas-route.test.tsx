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
import { renderHook, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { login } from './fixtures'
import { useCanvasRoute } from '../hooks/use-canvas-route'

const startCanvasEditor = vi.hoisted(() => vi.fn())
const openCanvasProject = vi.hoisted(() => vi.fn())

vi.mock('../lib/canvas-projects', () => ({
  openCanvasProject,
  startCanvasEditor,
}))

describe('canvas route loading state', () => {
  beforeEach(() => {
    login(901, 'route-session')
    startCanvasEditor.mockResolvedValue(undefined)
    openCanvasProject.mockResolvedValue(undefined)
  })

  afterEach(() => {
    startCanvasEditor.mockReset()
    openCanvasProject.mockReset()
  })

  it('stays loading until the requested canvas has opened', async () => {
    let finishOpen!: () => void
    openCanvasProject.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve
        })
    )

    const { result } = renderHook(
      () => useCanvasRoute('drawing', '44444444-4444-4444-8444-444444444444'),
      { wrapper: ReactFlowProvider }
    )

    await waitFor(() => expect(openCanvasProject).toHaveBeenCalled())
    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeNull()

    finishOpen()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
  })

  it('exposes retry after opening the requested canvas fails', async () => {
    let failed = true
    openCanvasProject.mockImplementation(async () => {
      if (failed) throw new Error('Canvas storage is unavailable.')
    })

    const { result } = renderHook(
      () => useCanvasRoute('drawing', '55555555-5555-4555-8555-555555555555'),
      { wrapper: ReactFlowProvider }
    )

    await waitFor(() =>
      expect(result.current.error).toBe('Canvas storage is unavailable.')
    )
    expect(result.current.loading).toBe(false)

    failed = false
    result.current.retry()
    await waitFor(() => expect(openCanvasProject).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.error).toBeNull())
    expect(result.current.loading).toBe(false)
  })
})

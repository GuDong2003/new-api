import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useCanvasRoute } from '../hooks/use-canvas-route'
import { login } from './fixtures'

const openCanvasProject = vi.hoisted(() => vi.fn())
const startCanvasEditor = vi.hoisted(() => vi.fn())
const flowCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useReactFlow: () => {
    flowCalls.count += 1
    return {
      fitView: vi.fn().mockResolvedValue(undefined),
      setViewport: vi.fn().mockResolvedValue(undefined),
    }
  },
}))
vi.mock('../lib/canvas-projects', () => ({
  openCanvasProject,
  startCanvasEditor,
}))

beforeEach(() => {
  login(902, 'route-stability-session')
  openCanvasProject.mockResolvedValue(undefined)
  startCanvasEditor.mockResolvedValue(undefined)
  flowCalls.count = 0
})

afterEach(() => {
  openCanvasProject.mockReset()
  startCanvasEditor.mockReset()
})

it('opens a canvas once even when React Flow returns a new instance on rerender', async () => {
  const { result } = renderHook(() =>
    useCanvasRoute('drawing', '66666666-6666-4666-8666-666666666666')
  )

  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(openCanvasProject).toHaveBeenCalledTimes(1)
  expect(flowCalls.count).toBeGreaterThan(1)
})

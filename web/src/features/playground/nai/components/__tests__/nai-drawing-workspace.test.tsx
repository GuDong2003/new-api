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
*/
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { NaiDrawing } from '../NaiDrawingWorkspace'

vi.mock('@xyflow/react', () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  )

  return {
    Background: Container,
    BackgroundVariant: { Dots: 'dots' },
    MiniMap: Container,
    Panel: Container,
    ReactFlow: Container,
    ReactFlowProvider: Container,
    useReactFlow: () => ({
      fitView: vi.fn(),
      screenToFlowPosition: vi.fn(),
    }),
  }
})

vi.mock('@/context/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

vi.mock('@/hooks/use-media-query', () => ({
  useMediaQuery: () => false,
}))

vi.mock('../hooks/use-nai-drawing-persistence', () => ({
  useNaiDrawingPersistenceStatus: () => 'saved',
}))

vi.mock('../hooks/use-nai-image-generation', () => ({
  useNaiImageGeneration: () => ({
    cancel: vi.fn(),
    generate: vi.fn(() => false),
    pendingCount: 0,
  }),
}))

vi.mock('../NaiImageCanvasNode', () => ({
  NaiImageCanvasNode: () => null,
}))

vi.mock('../NaiImagePreview', () => ({
  NaiImagePreview: () => null,
}))

vi.mock('../NaiSettings', () => ({
  NaiSettings: () => <div data-testid='nai-settings' />,
}))

describe('NAI drawing workspace', () => {
  beforeEach(() => {
    useAuthStore.getState().auth.setUser({
      id: 1,
      username: 'alice',
      role: 1,
    })
    useNaiDrawingStore.setState({
      nodes: [],
      ready: true,
      userId: 1,
      past: [],
      future: [],
      previewId: null,
      revision: 0,
    })
  })

  it('shows guidance when the NAI canvas has no image nodes', () => {
    render(<NaiDrawing />)

    expect(screen.getByText('Room for every idea')).toBeInTheDocument()
    expect(
      screen.getByText('Create and refine images on your canvas.')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Scroll to zoom · Space + drag to pan · Shift + drag to select'
      )
    ).toBeInTheDocument()
  })
})

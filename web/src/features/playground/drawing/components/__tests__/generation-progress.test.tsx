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
import { act, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { DrawingNode } from '../../types'
import { ImageCanvasNode } from '../ImageCanvasNode'

afterEach(() => vi.useRealTimers())

describe('Image generation progress', () => {
  it('shows elapsed time and actual preview progress, resets for a retry and disappears on completion', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100000)
    useDrawingStore.getState().initialize(819)
    const props: NodeProps<DrawingNode> = {
      id: 'B',
      type: 'image',
      draggable: true,
      dragging: false,
      selectable: true,
      selected: false,
      deletable: true,
      isConnectable: true,
      zIndex: 0,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      data: {
        prompt: 'A cup',
        settings: DEFAULT_IMAGE_SETTINGS,
        createdAt: 1,
        status: 'pending',
        progress: {
          startedAt: Date.now(),
          phase: 'generating',
          previewCount: 0,
        },
      },
    }
    const view = render(
      <ReactFlowProvider>
        <ImageCanvasNode {...props} />
      </ReactFlowProvider>
    )
    expect(screen.getByText('Elapsed: 0s')).toBeTruthy()
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(
      false
    )
    act(() => vi.advanceTimersByTime(65000))
    expect(screen.getByText('Elapsed: 65s')).toBeTruthy()

    const preview = {
      id: 'preview',
      src: 'data:image/png;base64,YWJj',
      name: 'cup.png',
      mimeType: 'image/png',
      width: 512,
      height: 512,
    }
    view.rerender(
      <ReactFlowProvider>
        <ImageCanvasNode
          {...props}
          data={{
            ...props.data,
            asset: preview,
            progress: { startedAt: 100000, phase: 'decoding', previewCount: 2 },
          }}
        />
      </ReactFlowProvider>
    )
    expect(screen.getByRole('status').textContent).toBe('Preparing image…')
    expect(screen.getByText('Previews received: 2')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'A cup' })).toBeTruthy()

    view.rerender(
      <ReactFlowProvider>
        <ImageCanvasNode
          {...props}
          data={{
            ...props.data,
            progress: {
              startedAt: Date.now(),
              phase: 'generating',
              previewCount: 0,
            },
          }}
        />
      </ReactFlowProvider>
    )
    expect(screen.getByText('Elapsed: 0s')).toBeTruthy()
    expect(screen.queryByText('Previews received: 2')).toBeNull()
    view.rerender(
      <ReactFlowProvider>
        <ImageCanvasNode
          {...props}
          data={{ ...props.data, status: 'complete', asset: preview }}
        />
      </ReactFlowProvider>
    )
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useDrawingStore } from '@/stores/drawing-store'

import { ImageRetryContext } from '../../context/image-retry-context'
import { useImageGeneration } from '../../hooks/use-image-generation'
import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { DrawingNode } from '../../types'
import { ImageCanvasNode } from '../ImageCanvasNode'

function RetryImageCard() {
  const generation = useImageGeneration()
  const node = useDrawingStore((state) => state.nodes[0])
  if (!node) return null
  return (
    <ImageRetryContext value={generation.retry}>
      <ImageCanvasNode
        id={node.id}
        type='image'
        data={node.data}
        draggable
        dragging={false}
        selectable
        selected={false}
        deletable
        isConnectable={false}
        zIndex={0}
        positionAbsoluteX={node.position.x}
        positionAbsoluteY={node.position.y}
      />
    </ImageRetryContext>
  )
}

describe('Canvas image result', () => {
  it('exposes reference ports for completed images and disables them while the image is generating', () => {
    useDrawingStore.getState().initialize(820)
    const props: NodeProps<DrawingNode> = {
      id: 'image',
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
        status: 'complete',
        asset: {
          id: 'asset',
          name: 'cup.png',
          src: 'data:image/png;base64,YWJj',
          mimeType: 'image/png',
          width: 512,
          height: 512,
        },
      },
    }
    const view = render(
      <ReactFlowProvider>
        <ImageCanvasNode {...props} />
      </ReactFlowProvider>
    )
    const output = screen.getByRole('button', { name: 'Reference output' })
    expect(output.getAttribute('aria-disabled')).toBe('false')
    expect(output.tabIndex).toBe(0)
    view.rerender(
      <ReactFlowProvider>
        <ImageCanvasNode
          {...props}
          data={{ ...props.data, status: 'pending' }}
        />
      </ReactFlowProvider>
    )
    expect(
      screen
        .getByRole('button', { name: 'Reference input' })
        .getAttribute('aria-disabled')
    ).toBe('true')
    expect(output.getAttribute('aria-disabled')).toBe('true')
    expect(output.tabIndex).toBe(-1)
  })

  it('retries a failed card by click and keyboard and offers retry again after another failure', async () => {
    const user = userEvent.setup()
    const client = new QueryClient()
    let rejectFirstRetry: (reason: Error) => void
    const firstRetry = new Promise<never>((_resolve, reject) => {
      rejectFirstRetry = reject
    })
    vi.spyOn(api, 'post')
      .mockReturnValueOnce(firstRetry)
      .mockRejectedValueOnce(new Error('Provider is still unavailable'))
    useDrawingStore.getState().initialize(815)
    useDrawingStore.getState().addNodes([
      {
        id: 'failed-image',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          prompt: 'A cup',
          settings: {
            ...DEFAULT_IMAGE_SETTINGS,
            model: 'gpt-image-1',
            prompt: 'A cup',
          },
          createdAt: 1,
          status: 'error',
          error: 'Image generation failed.',
        },
      },
    ])
    const view = render(
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <RetryImageCard />
        </ReactFlowProvider>
      </QueryClientProvider>
    )
    expect(screen.getByRole('alert').textContent).toBe(
      'Image generation failed.'
    )

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByRole('status', { name: '' }).textContent).toBe(
      'Generating image…'
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('article', { name: 'A cup' })).toBeTruthy()
    await act(async () =>
      rejectFirstRetry(new Error('Provider is unavailable'))
    )
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Provider is unavailable'
      )
    )

    const retryButton = screen.getByRole('button', { name: 'Retry' })
    retryButton.focus()
    expect(document.activeElement).toBe(retryButton)
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Provider is still unavailable'
      )
    )
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')
    ).toBe(false)
    expect(useDrawingStore.getState().nodes.map((node) => node.id)).toEqual([
      'failed-image',
    ])
    view.unmount()
    client.clear()
  })

  it('shows the final image even if its earlier streaming preview failed to load', () => {
    useDrawingStore.getState().initialize(815)
    const asset = {
      id: 'preview',
      src: 'data:image/png;base64,YWJj',
      mimeType: 'image/png',
      name: 'A cup',
      width: 512,
      height: 512,
    }
    const props: NodeProps<DrawingNode> = {
      id: 'image-result',
      type: 'image',
      data: {
        prompt: 'A cup',
        settings: DEFAULT_IMAGE_SETTINGS,
        createdAt: 1,
        status: 'pending',
        asset,
      },
      draggable: true,
      dragging: false,
      selectable: true,
      selected: false,
      deletable: true,
      isConnectable: false,
      zIndex: 0,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
    }
    const view = render(
      <ReactFlowProvider>
        <ImageCanvasNode {...props} />
      </ReactFlowProvider>
    )
    fireEvent.error(screen.getByRole('img', { name: 'A cup' }))
    expect(screen.getByText('The image could not be loaded.')).toBeTruthy()
    view.rerender(
      <ReactFlowProvider>
        <ImageCanvasNode
          {...props}
          data={{
            ...props.data,
            status: 'complete',
            asset: { ...asset, src: 'data:image/png;base64,ZGVm' },
          }}
        />
      </ReactFlowProvider>
    )
    expect(screen.getByRole('img', { name: 'A cup' }).getAttribute('src')).toBe(
      'data:image/png;base64,ZGVm'
    )
    expect(screen.queryByText('The image could not be loaded.')).toBeNull()
  })
})

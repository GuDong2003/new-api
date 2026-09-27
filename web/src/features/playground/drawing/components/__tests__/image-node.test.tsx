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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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

const client = new QueryClient()

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
  const madeAt = new Date(2026, 8, 27, 21, 30, 5).getTime()

  function imageNode(
    id: string,
    data: Partial<DrawingNode['data']> = {}
  ): DrawingNode {
    return {
      id,
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        prompt: '一只橘猫在窗台上',
        settings: DEFAULT_IMAGE_SETTINGS,
        createdAt: madeAt,
        status: 'complete',
        asset: {
          id: `${id}-asset`,
          name: 'gpt-image-2-1',
          src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKn0AAAAASUVORK5CYII=',
          mimeType: 'image/png',
          width: 1,
          height: 1,
        },
        ...data,
      },
    }
  }

  // Renders the node, downloads its original and returns the name it was
  // saved under.
  async function downloadedName(node: DrawingNode) {
    const saved: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        saved.push(this.download)
      }
    )
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:download')
        static revokeObjectURL = vi.fn()
      }
    )
    try {
      render(
        <QueryClientProvider client={client}>
          <ReactFlowProvider>
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
              positionAbsoluteX={0}
              positionAbsoluteY={0}
            />
          </ReactFlowProvider>
        </QueryClientProvider>
      )
      await userEvent.click(screen.getByRole('button', { name: 'Download' }))
      await waitFor(() => expect(saved).toHaveLength(1))
      return saved[0]
    } finally {
      vi.unstubAllGlobals()
    }
  }

  // Every download used to read "new-api-" and the node's id, so a folder of
  // them could not be told apart. A picture is saved under what it shows and
  // when it was made.
  it('downloads the original under its prompt and the time it was made', async () => {
    useDrawingStore.getState().initialize(820)
    const node = imageNode('only')
    useDrawingStore.getState().addNodes([node])

    expect(await downloadedName(node)).toBe(
      '一只橘猫在窗台上-20260927-213005.png'
    )
  })

  // A batch shares its prompt and second, so without its place each picture of
  // it would be saved under the same name. A picture of another prompt or
  // second is not of the batch, while one that failed keeps its place, so a
  // retry renumbers none of the others.
  it('numbers the pictures generated together by their place in the batch', async () => {
    useDrawingStore.getState().initialize(820)
    const nodes = [
      imageNode('earlier', { createdAt: madeAt - 1000 }),
      imageNode('first'),
      imageNode('another prompt', { prompt: '一只黑猫' }),
      imageNode('failed', { status: 'error', asset: undefined }),
      imageNode('third', { createdAt: madeAt + 400 }),
    ]
    useDrawingStore.getState().addNodes(nodes)

    expect(await downloadedName(nodes[4])).toBe(
      '一只橘猫在窗台上-20260927-213005-3.png'
    )
  })

  it('keeps selected nodes to one outline while retaining resize controls', () => {
    useDrawingStore.getState().initialize(820)
    const props: NodeProps<DrawingNode> = {
      id: 'selected-image',
      type: 'image',
      draggable: true,
      dragging: false,
      selectable: true,
      selected: true,
      deletable: true,
      isConnectable: false,
      zIndex: 0,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      data: {
        prompt: 'A cup',
        settings: DEFAULT_IMAGE_SETTINGS,
        createdAt: 1,
        status: 'complete',
      },
    }
    render(
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <ImageCanvasNode {...props} />
        </ReactFlowProvider>
      </QueryClientProvider>
    )

    // The resizer draws four separate straight lines, which cannot round the
    // corners of the card and leave them open, so the card carries the outline
    // and the lines stay invisible rather than adding a second square one.
    const article = screen.getByRole('article', { name: 'A cup' })
    expect(article.className).toContain('ring-2')

    const lines = [
      ...document.querySelectorAll('.react-flow__resize-control.line'),
    ]
    expect(lines.length).toBeGreaterThan(0)
    expect(
      lines.every((line) => line.className.includes('border-transparent'))
    ).toBe(true)

    const resizeControls = [
      ...document.querySelectorAll('.react-flow__resize-control.handle'),
    ]
    expect(resizeControls.length).toBeGreaterThan(0)
    expect(
      resizeControls.every((control) =>
        control.className.includes('bg-background')
      )
    ).toBe(true)
  })

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
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <ImageCanvasNode {...props} />
        </ReactFlowProvider>
      </QueryClientProvider>
    )
    const output = screen.getByRole('button', { name: 'Reference output' })
    expect(output.getAttribute('aria-disabled')).toBe('false')
    expect(output.tabIndex).toBe(0)
    view.rerender(
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <ImageCanvasNode
            {...props}
            data={{ ...props.data, status: 'pending' }}
          />
        </ReactFlowProvider>
      </QueryClientProvider>
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
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Image generation failed.'
    )

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      screen.getByRole('status', { name: 'Generating image…' })
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('article', { name: 'A cup' })).toBeTruthy()
    await act(async () =>
      rejectFirstRetry(new Error('Provider is unavailable'))
    )
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Provider is unavailable'
      )
    )

    const retryButton = screen.getByRole('button', { name: 'Retry' })
    retryButton.focus()
    expect(document.activeElement).toBe(retryButton)
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
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

  it('shows the failure heading together with the provider reason', () => {
    useDrawingStore.getState().initialize(815)
    useDrawingStore.getState().addNodes([
      {
        id: 'failed-image-with-reason',
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
          error: 'insufficient quota',
        },
      },
    ])

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReactFlowProvider>
          <RetryImageCard />
        </ReactFlowProvider>
      </QueryClientProvider>
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Image generation failed.'
    )
    expect(screen.getByRole('alert')).toHaveTextContent('insufficient quota')
  })

  it('shows each cause of a failed generation on a line of its own', () => {
    useDrawingStore.getState().initialize(815)
    useDrawingStore.getState().addNodes([
      {
        id: 'failed-image-with-causes',
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
          error:
            '提示词有安全风险，请调整提示词重试\nAfter a retry: The upstream service timed out.',
        },
      },
    ])

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReactFlowProvider>
          <RetryImageCard />
        </ReactFlowProvider>
      </QueryClientProvider>
    )

    const alert = screen.getByRole('alert')
    expect(
      within(alert).getByText('提示词有安全风险，请调整提示词重试')
    ).toBeTruthy()
    expect(
      within(alert).getByText('After a retry: The upstream service timed out.')
    ).toBeTruthy()
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
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <ImageCanvasNode {...props} />
        </ReactFlowProvider>
      </QueryClientProvider>
    )
    fireEvent.error(screen.getByRole('img', { name: 'A cup' }))
    expect(screen.queryByText('The image could not be loaded.')).toBeNull()
    view.rerender(
      <QueryClientProvider client={client}>
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
      </QueryClientProvider>
    )
    expect(screen.getByRole('img', { name: 'A cup' }).getAttribute('src')).toBe(
      'data:image/png;base64,ZGVm'
    )
    expect(screen.queryByText('The image could not be loaded.')).toBeNull()
  })
})

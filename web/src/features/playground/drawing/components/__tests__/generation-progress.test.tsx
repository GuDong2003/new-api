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
import { act, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import i18n from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { DrawingNode } from '../../types'
import { ImageCanvasNode } from '../ImageCanvasNode'
import { ImageGenerationProgress } from '../ImageGenerationProgress'

const client = new QueryClient()

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
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <ImageCanvasNode {...props} />
        </ReactFlowProvider>
      </QueryClientProvider>
    )
    expect(screen.getByText('Elapsed: 0s')).toBeTruthy()
    expect(screen.getByRole('status')).toHaveAccessibleName('Generating image…')
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
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <ImageCanvasNode
            {...props}
            data={{
              ...props.data,
              asset: preview,
              progress: {
                startedAt: 100000,
                phase: 'decoding',
                previewCount: 2,
              },
            }}
          />
        </ReactFlowProvider>
      </QueryClientProvider>
    )
    expect(screen.getByRole('status')).toHaveAccessibleName('Preparing image…')
    expect(screen.getByText('Previews received: 2')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'A cup' })).toBeTruthy()

    view.rerender(
      <QueryClientProvider client={client}>
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
      </QueryClientProvider>
    )
    expect(screen.getByText('Elapsed: 0s')).toBeTruthy()
    expect(screen.queryByText('Previews received: 2')).toBeNull()
    view.rerender(
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <ImageCanvasNode
            {...props}
            data={{ ...props.data, status: 'complete', asset: preview }}
          />
        </ReactFlowProvider>
      </QueryClientProvider>
    )
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// The flare sweeps behind one word, so the label is split per letter. Screen
// readers must still get the whole phrase, and the stagger has to come from the
// word's own length or a translation of another length would animate wrong.
it('animates the label letter by letter while keeping it readable as one phrase', () => {
  render(
    <QueryClientProvider client={client}>
      <ReactFlowProvider>
        <ImageGenerationProgress
          progress={{
            startedAt: Date.now(),
            phase: 'generating',
            previewCount: 0,
          }}
        />
      </ReactFlowProvider>
    </QueryClientProvider>
  )

  const status = screen.getByRole('status')
  expect(status).toHaveAccessibleName('Generating image…')

  const letters = [...status.querySelectorAll('.drawing-generation-letter')]
  expect(letters).toHaveLength('Generating'.length)
  expect(letters.map((letter) => letter.textContent).join('')).toBe(
    'Generating'
  )
  for (const letter of letters) {
    expect(letter).toHaveAttribute('aria-hidden', 'true')
  }
  expect(letters[0].getAttribute('style')).toContain(
    '--drawing-generation-delay: 0.100s'
  )
  // The word lights up over one fixed span however many letters it has, so the
  // colour sweeping behind it stays in step with them in every language. Ten
  // letters reproduce the original 0.105s stagger exactly.
  expect(letters[1].getAttribute('style')).toContain(
    '--drawing-generation-delay: 0.205s'
  )
  expect(letters.at(-1)?.getAttribute('style')).toContain(
    '--drawing-generation-delay: 1.045s'
  )
})

it('lights a translation of another length over that same span', () => {
  const word = '图片生成中'
  i18n.addResource('en', 'translation', 'Generating', word)
  try {
    render(
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <ImageGenerationProgress
            progress={{
              startedAt: Date.now(),
              phase: 'generating',
              previewCount: 0,
            }}
          />
        </ReactFlowProvider>
      </QueryClientProvider>
    )

    const letters = [
      ...screen
        .getByRole('status')
        .querySelectorAll('.drawing-generation-letter'),
    ]
    expect(letters).toHaveLength([...word].length)
    expect(letters[0].getAttribute('style')).toContain(
      '--drawing-generation-delay: 0.100s'
    )
    expect(letters.at(-1)?.getAttribute('style')).toContain(
      '--drawing-generation-delay: 1.045s'
    )
  } finally {
    i18n.addResource('en', 'translation', 'Generating', 'Generating')
  }
})

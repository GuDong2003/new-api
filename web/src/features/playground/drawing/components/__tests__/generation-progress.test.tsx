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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import i18n from 'i18next'
import postcss from 'postcss'
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

// A provider can refuse a prompt minutes before a retry elsewhere ends. Only a
// refusal it answered as a client error is a verdict on the prompt; the same
// words in a server error are how some proxies word any failure.
it.each([
  {
    answer: 'a client error',
    failures: [
      {
        kind: 'content_policy',
        status: 422,
        message: '当前提示词暂时无法生成，请更换提示词后重试',
      },
    ],
    notice:
      'An upstream service refused this prompt. Retrying automatically; you can also edit the prompt and generate again.',
    reasons: ['当前提示词暂时无法生成，请更换提示词后重试'],
  },
  {
    answer: 'a server error',
    failures: [
      {
        kind: 'content_policy',
        status: 502,
        message: '提示词有安全风险，请调整提示词重试',
      },
      { kind: 'timeout', status: 524 },
    ],
    notice: 'The last attempt failed. Retrying automatically…',
    reasons: [
      '提示词有安全风险，请调整提示词重试',
      'After a retry: The upstream service timed out.',
    ],
  },
])(
  'announces why an attempt the provider answered with $answer failed while it retries',
  (test) => {
    render(
      <ImageGenerationProgress
        progress={{
          startedAt: Date.now(),
          phase: 'generating',
          previewCount: 0,
          failedAttempts: test.failures,
        }}
      />
    )

    const notice = screen.getByText(test.notice).closest('[aria-live="polite"]')
    expect(notice).not.toBeNull()
    for (const reason of test.reasons) {
      expect(notice).toContainElement(screen.getByText(reason))
    }
  }
)

// Screen readers often skip a live region that arrives already filled, so the
// region is there from the start and the notice goes into it.
it('announces a failed attempt through a region that was there before it', () => {
  const progress = {
    startedAt: Date.now(),
    phase: 'generating' as const,
    previewCount: 0,
  }
  const view = render(<ImageGenerationProgress progress={progress} />)
  const region = view.container.querySelector('[aria-live="polite"]')
  expect(region).toBeEmptyDOMElement()

  view.rerender(
    <ImageGenerationProgress
      progress={{
        ...progress,
        failedAttempts: [{ kind: 'timeout', status: 524 }],
      }}
    />
  )

  expect(region).toContainElement(
    screen.getByText('The last attempt failed. Retrying automatically…')
  )
})

it('stops saying it is retrying once the image is being prepared', () => {
  render(
    <ImageGenerationProgress
      progress={{
        startedAt: Date.now(),
        phase: 'decoding',
        previewCount: 0,
        failedAttempts: [{ kind: 'timeout', status: 524 }],
      }}
    />
  )

  expect(screen.getByRole('status')).toHaveAccessibleName('Preparing image…')
  expect(
    screen.queryByText('The last attempt failed. Retrying automatically…')
  ).toBeNull()
})

function styleSheet() {
  return postcss.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../../../styles/index.css'),
      'utf8'
    )
  )
}

function styleDeclarations() {
  const declarations = new Map<string, Map<string, string>>()
  styleSheet().walkRules((rule) => {
    const values = declarations.get(rule.selector) ?? new Map()
    rule.walkDecls((declaration) => {
      values.set(declaration.prop, declaration.value)
    })
    declarations.set(rule.selector, values)
  })
  return declarations
}

// The word takes the whole picture area of an empty node, which left a notice
// under it, such as why an attempt failed, pushed out of the card. The word is
// sized against the room the notice leaves instead.
it('sizes the word against the room a notice under it leaves', () => {
  render(
    <ImageGenerationProgress
      progress={{
        startedAt: Date.now(),
        phase: 'generating',
        previewCount: 0,
        failedAttempts: [{ kind: 'timeout', status: 524 }],
      }}
    />
  )
  const stage = screen
    .getByRole('status', { name: 'Generating image…' })
    .closest('.drawing-generation-stage')
  const notice = screen
    .getByText('The last attempt failed. Retrying automatically…')
    .closest('[aria-live="polite"]')

  expect(stage).not.toBeNull()
  expect(stage).not.toContainElement(notice as HTMLElement)
  const room = styleDeclarations().get(
    '.drawing-generation-fill .drawing-generation-stage'
  )
  expect(room?.get('container-type')).toBe('size')
  expect(room?.get('flex')).toBe('1 1 0')
  expect(room?.get('min-height')).toBe('0')
})

// A notice longer than the smallest node has room for was cut off at its top
// and bottom, heading first. It scrolls instead, and the wheel scrolls it
// rather than zooming the canvas.
it('scrolls a notice longer than the node has room for', () => {
  render(
    <ImageGenerationProgress
      progress={{
        startedAt: Date.now(),
        phase: 'generating',
        previewCount: 0,
        failedAttempts: [{ kind: 'timeout', status: 524 }],
      }}
    />
  )

  const notice = screen
    .getByText('The last attempt failed. Retrying automatically…')
    .closest('[aria-live="polite"]')
  expect(notice).toHaveClass('min-h-0', 'overflow-y-auto', 'nowheel', 'nodrag')
})

// In the smallest node the notice leaves the word a sliver of room, which only
// drew a speck of colour above the notice. What draws the word gives way, while
// the status it announces stays for screen readers.
it('hides the word when a notice leaves it too little room to be read', () => {
  const hidden: string[] = []
  styleSheet().walkAtRules('container', (query) => {
    query.walkRules((rule) => {
      rule.walkDecls('visibility', (declaration) => {
        if (declaration.value !== 'hidden') return
        hidden.push(
          ...rule.selectors.map((selector) => `${query.params} ${selector}`)
        )
      })
    })
  })

  expect(hidden).toEqual([
    '(height < 3rem) .drawing-generation-stage .drawing-generation-letter',
    '(height < 3rem) .drawing-generation-stage .drawing-generation-flare',
  ])
})

// The colour behind the word is a ring sized to the box around the letters, so
// the box is what keeps the ring as close to the lit letter as in the template.
it('keeps the template box around the word however tall the node is', () => {
  const declarations = styleDeclarations()
  const box = declarations.get('.drawing-generation')
  const filled = declarations.get(
    '.drawing-generation-fill .drawing-generation'
  )

  // 120px at the template's 1.6em type, never stretched to the picture area.
  expect(box?.get('height')).toBe('4.6875em')
  expect(box?.get('flex')).toBe('none')
  // A node with nothing in it yet only enlarges the type, and the box still fits.
  expect([...(filled?.keys() ?? [])]).toEqual(['font-size'])
  const heightCap = Number(
    /([\d.]+)cqh/.exec(filled?.get('font-size') ?? '')?.[1]
  )
  expect(heightCap * 4.6875).toBeLessThanOrEqual(100)
})

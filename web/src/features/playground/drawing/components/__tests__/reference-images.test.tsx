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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { DrawingNode } from '../../types'
import { ReferenceImages } from '../ReferenceImages'

function imageNode(id: string): DrawingNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      prompt: id,
      settings: { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1' },
      status: 'complete',
      createdAt: 1,
      asset: {
        id,
        name: `${id}.png`,
        src: 'data:image/png;base64,YWJj',
        mimeType: 'image/png',
        width: 64,
        height: 64,
      },
    },
  }
}

describe('ReferenceImages', () => {
  beforeEach(() => {
    useDrawingStore.getState().initialize(850)
    useDrawingStore.getState().addNodes([imageNode('A'), imageNode('B')])
    useDrawingStore.getState().setReferences(['A', 'B'])
  })

  it('reorders the horizontal reference list when one image is dropped on another', () => {
    render(
      <ReferenceImages
        onUpload={vi.fn()}
        onMaskUpload={vi.fn()}
        onClearMask={vi.fn()}
        onDrawMask={vi.fn()}
      />
    )
    const source = screen.getByAltText('B.png').parentElement
    const target = screen.getByAltText('A.png').parentElement
    const dataTransfer = {
      dropEffect: 'move',
      effectAllowed: 'move',
      getData: vi.fn(() => 'B'),
      setData: vi.fn(),
    }

    expect(source).not.toBeNull()
    expect(target).not.toBeNull()
    fireEvent.dragStart(source as HTMLElement, { dataTransfer })
    fireEvent.drop(target as HTMLElement, { dataTransfer })

    expect(useDrawingStore.getState().referenceIds).toEqual(['B', 'A'])
  })

  it('shows the saved mask on the first reference and removes it when the mask is cleared', () => {
    const client = new QueryClient()
    const props = {
      onUpload: vi.fn(),
      onMaskUpload: vi.fn(),
      onClearMask: vi.fn(),
      onDrawMask: vi.fn(),
    }
    const mask = {
      id: 'mask',
      name: 'mask.png',
      src: 'data:image/png;base64,YWJj',
      width: 64,
      height: 64,
      mimeType: 'image/png',
    }
    const view = render(
      <QueryClientProvider client={client}>
        <ReferenceImages {...props} mask={mask} />
      </QueryClientProvider>
    )
    const references = screen.getAllByRole('listitem')
    expect(
      within(references[0]).getByRole('img', { name: 'Mask preview' })
    ).toBeVisible()
    expect(
      within(references[1]).queryByRole('img', { name: 'Mask preview' })
    ).toBeNull()

    view.rerender(
      <QueryClientProvider client={client}>
        <ReferenceImages {...props} />
      </QueryClientProvider>
    )
    expect(screen.queryByRole('img', { name: 'Mask preview' })).toBeNull()
    client.clear()
  })

  it('does not show a saved mask when the selected model cannot use masks', () => {
    render(
      <ReferenceImages
        mask={imageNode('mask').data.asset}
        maskable={false}
        onUpload={vi.fn()}
        onMaskUpload={vi.fn()}
        onClearMask={vi.fn()}
        onDrawMask={vi.fn()}
      />
    )
    expect(screen.queryByRole('img', { name: 'Mask preview' })).toBeNull()
  })

  it('reports a mask image loading failure and clears the error for a replacement', () => {
    const client = new QueryClient()
    const props = {
      onUpload: vi.fn(),
      onMaskUpload: vi.fn(),
      onClearMask: vi.fn(),
      onDrawMask: vi.fn(),
    }
    const mask = {
      id: 'mask',
      name: 'mask.png',
      src: 'data:image/png;base64,YWJj',
      width: 64,
      height: 64,
      mimeType: 'image/png',
    }
    const view = render(
      <QueryClientProvider client={client}>
        <ReferenceImages {...props} mask={mask} />
      </QueryClientProvider>
    )
    const preview = screen.getByRole('img', { name: 'Mask preview' })
    expect(preview).toHaveAttribute('aria-busy', 'true')
    const source = preview.querySelector('image')
    expect(source).not.toBeNull()
    fireEvent.error(source as SVGImageElement)
    expect(screen.getByRole('status')).toHaveTextContent(
      'The mask could not be loaded.'
    )
    expect(preview).toHaveAttribute('aria-busy', 'false')
    view.rerender(
      <QueryClientProvider client={client}>
        <ReferenceImages
          {...props}
          mask={{
            ...mask,
            id: 'replacement',
            src: 'data:image/png;base64,ZGVm',
          }}
        />
      </QueryClientProvider>
    )
    fireEvent.load(preview.querySelector('image') as SVGImageElement)
    expect(screen.queryByRole('status')).toBeNull()
    expect(preview).toHaveAttribute('aria-busy', 'false')
    client.clear()
  })
})

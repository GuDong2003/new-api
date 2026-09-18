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
import { fireEvent, render, screen } from '@testing-library/react'
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
})

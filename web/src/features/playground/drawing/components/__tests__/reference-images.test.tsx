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
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
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

  it('offers an empty upload placeholder that can be opened with the keyboard and reused', async () => {
    useDrawingStore.getState().setReferences([])
    const onUpload = vi.fn()
    render(
      <ReferenceImages
        onUpload={onUpload}
        onMaskUpload={vi.fn()}
        onClearMask={vi.fn()}
        onDrawMask={vi.fn()}
      />
    )
    const user = userEvent.setup()
    const button = screen.getByRole('button', {
      name: 'Upload reference images',
    })
    expect(within(button).getByText('Upload reference images')).toBeVisible()
    expect(button).toHaveAccessibleDescription(
      'Drop images here or click to upload PNG, JPEG or WebP'
    )
    const input = screen.getByLabelText('Upload reference images', {
      selector: 'input',
    })
    const openPicker = vi.spyOn(input as HTMLInputElement, 'click')
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(openPicker).toHaveBeenCalledOnce()

    const file = new File(['image'], 'reference.png', { type: 'image/png' })
    await user.upload(input, file)
    expect(onUpload).toHaveBeenLastCalledWith([file])
    expect(input).toHaveValue('')
    await user.upload(input, file)
    expect(onUpload).toHaveBeenCalledTimes(2)
  })

  it('replaces the empty placeholder with the uploaded reference and restores it after removing the last reference', async () => {
    useDrawingStore.getState().setReferences([])
    render(
      <ReferenceImages
        onUpload={() => useDrawingStore.getState().setReferences(['A'])}
        onMaskUpload={vi.fn()}
        onClearMask={vi.fn()}
        onDrawMask={vi.fn()}
      />
    )
    fireEvent.drop(
      screen.getByRole('button', { name: 'Upload reference images' }),
      {
        dataTransfer: {
          files: [new File(['image'], 'A.png', { type: 'image/png' })],
          types: ['Files'],
        },
      }
    )

    expect(screen.getByRole('img', { name: 'A.png' })).toBeVisible()
    expect(screen.queryByText('Upload reference images')).toBeNull()
    expect(screen.queryByText('Drop images here or click to upload')).toBeNull()
    expect(screen.queryByText('PNG, JPEG or WebP')).toBeNull()
    const addButton = screen.getByRole('button', {
      name: 'Upload reference images',
    })
    expect(addButton).toBeEnabled()
    expect(addButton).toHaveClass('size-24')
    const input = screen.getByLabelText('Upload reference images', {
      selector: 'input',
    })
    const openPicker = vi.spyOn(input as HTMLInputElement, 'click')
    const user = userEvent.setup()
    addButton.focus()
    await user.keyboard('{Enter}')
    expect(openPicker).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Remove reference' }))
    expect(screen.queryByRole('img', { name: 'A.png' })).toBeNull()
    expect(screen.getByText('Upload reference images')).toBeVisible()
    expect(
      screen.getByText('Drop images here or click to upload')
    ).toBeVisible()
    expect(screen.getByText('PNG, JPEG or WebP')).toBeVisible()
  })

  it('accepts dropped files through the compact add button without bubbling to another importer', () => {
    const onUpload = vi.fn()
    const parentDrop = vi.fn()
    render(
      <div onDrop={parentDrop}>
        <ReferenceImages
          onUpload={onUpload}
          onMaskUpload={vi.fn()}
          onClearMask={vi.fn()}
          onDrawMask={vi.fn()}
        />
      </div>
    )
    const files = [
      new File(['image'], 'reference.webp', { type: 'image/webp' }),
    ]
    const placeholder = screen.getByRole('button', {
      name: 'Upload reference images',
    })
    expect(screen.queryByText('Drop images here or click to upload')).toBeNull()
    const dataTransfer = { files, types: ['Files'], dropEffect: 'none' }
    fireEvent.dragOver(placeholder, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('copy')
    fireEvent.drop(placeholder, { dataTransfer })
    expect(onUpload).toHaveBeenCalledExactlyOnceWith(files)
    expect(parentDrop).not.toHaveBeenCalled()
  })

  it('rejects a dropped batch larger than the remaining reference slots', () => {
    const onUpload = vi.fn()
    const errorToast = vi.spyOn(toast, 'error')
    render(
      <ReferenceImages
        limit={3}
        onUpload={onUpload}
        onMaskUpload={vi.fn()}
        onClearMask={vi.fn()}
        onDrawMask={vi.fn()}
      />
    )
    const files = ['C', 'D'].map(
      (name) => new File(['image'], `${name}.png`, { type: 'image/png' })
    )
    fireEvent.drop(
      screen.getByRole('button', { name: 'Upload reference images' }),
      {
        dataTransfer: { files, types: ['Files'] },
      }
    )
    expect(onUpload).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledWith(
      'Too many reference images for this model.'
    )
  })

  it.each([
    { limit: 2, uploading: false },
    { limit: 16, uploading: true },
  ])(
    'blocks picker and drops when the limit is $limit and uploading is $uploading',
    (props) => {
      const onUpload = vi.fn()
      render(
        <ReferenceImages
          {...props}
          onUpload={onUpload}
          onMaskUpload={vi.fn()}
          onClearMask={vi.fn()}
          onDrawMask={vi.fn()}
        />
      )
      const button = screen.getByRole('button', {
        name: 'Upload reference images',
      })
      expect(button).toBeDisabled()
      expect(
        screen.getByLabelText('Upload reference images', { selector: 'input' })
      ).toBeDisabled()
      fireEvent.drop(button, {
        dataTransfer: {
          files: [new File(['image'], 'C.png', { type: 'image/png' })],
          types: ['Files'],
        },
      })
      expect(onUpload).not.toHaveBeenCalled()
    }
  )

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

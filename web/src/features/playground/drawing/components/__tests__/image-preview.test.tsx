/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { DrawingNode, ImageAsset } from '../../types'
import { ImagePreview } from '../ImagePreview'

const reference: ImageAsset = {
  id: 'reference-image',
  name: 'reference.png',
  src: 'data:image/png;base64,YWJj',
  width: 1024,
  height: 512,
  mimeType: 'image/png',
}
const mask = { ...reference, id: 'saved-mask', name: 'mask.png' }

function renderPreview() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ImagePreview />
    </QueryClientProvider>
  )
}

describe('Image mask preview', () => {
  beforeEach(() => {
    const store = useDrawingStore.getState()
    store.initialize(990)
    const nodes: DrawingNode[] = ['reference', 'result'].map((id) => ({
      id,
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        asset: { ...reference, id },
        prompt: id,
        settings: { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1' },
        status: 'complete',
        createdAt: 1,
        ...(id === 'result' ? { referenceIds: ['reference'], mask } : {}),
      },
    }))
    store.addNodes(nodes)
    store.setReferences(['reference'])
    store.setMask({ referenceId: 'reference', asset: mask })
    store.setPreview('reference')
  })

  it('shows the current reference mask and lets the user hide and show it', async () => {
    renderPreview()
    expect(screen.getByRole('img', { name: 'Mask preview' })).toBeVisible()
    const user = userEvent.setup()
    const toggle = screen.getByRole('switch', { name: 'Show mask' })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(screen.queryByRole('img', { name: 'Mask preview' })).toBeNull()
    await user.click(toggle)
    expect(screen.getByRole('img', { name: 'Mask preview' })).toBeVisible()
  })

  it('does not overlay the input mask on a generated result', () => {
    useDrawingStore.getState().setPreview('result')
    renderPreview()
    expect(screen.queryByRole('img', { name: 'Mask preview' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Show mask' })).toBeNull()
    expect(screen.getByRole('img', { name: 'result' })).toBeVisible()
  })

  it('removes the preview overlay when the mask is removed', () => {
    renderPreview()
    expect(screen.getByRole('img', { name: 'Mask preview' })).toBeVisible()
    act(() => useDrawingStore.getState().setMask(null))
    expect(screen.queryByRole('img', { name: 'Mask preview' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Show mask' })).toBeNull()
  })
})

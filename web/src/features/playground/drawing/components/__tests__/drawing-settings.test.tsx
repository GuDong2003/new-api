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
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { DrawingNode } from '../../types'
import { DrawingSettings } from '../DrawingSettings'

function imageNode(): DrawingNode {
  return {
    id: 'reference-a',
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      prompt: '',
      settings: { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1' },
      status: 'complete',
      createdAt: 1,
      asset: {
        id: 'reference-a',
        name: 'A.png',
        src: 'data:image/png;base64,YWJj',
        mimeType: 'image/png',
        width: 64,
        height: 64,
      },
    },
  }
}

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(
    ['drawing-groups', 851],
    [{ value: 'default', label: 'default', ratio: 1 }]
  )
  client.setQueryData(
    ['drawing-models', 851, 'default'],
    [{ value: 'gpt-image-1', label: 'gpt-image-1' }]
  )
  render(
    <QueryClientProvider client={client}>
      <DrawingSettings
        userId={851}
        pendingCount={0}
        onGenerate={vi.fn()}
        onCancel={vi.fn()}
        onUploadReferences={vi.fn()}
        onMaskUpload={vi.fn()}
        onClearMask={vi.fn()}
        onDrawMask={vi.fn()}
      />
    </QueryClientProvider>
  )
}

describe('DrawingSettings reference prompt interactions', () => {
  beforeEach(() => {
    useDrawingStore.getState().initialize(851)
    useDrawingStore.getState().addNodes([imageNode()])
    useDrawingStore.getState().setReferences(['reference-a'])
    useDrawingStore.getState().updateSettings({
      model: 'gpt-image-1',
      prompt: '',
    })
  })

  it('opens the reference picker after typing @ and inserts the selected mention', async () => {
    renderSettings()
    expect(screen.getByLabelText('Mode')).toHaveValue('edit')
    const prompt = screen.getByLabelText('Prompt')
    await userEvent.setup().type(prompt, 'Use @')

    await userEvent
      .setup()
      .click(screen.getByRole('option', { name: '@1 (A.png)' }))

    expect(prompt).toHaveValue('Use @1 (A.png)')
  })

  it('inserts a reference mention when a thumbnail is dropped into the prompt', async () => {
    renderSettings()
    const prompt = screen.getByLabelText('Prompt')
    await userEvent.setup().type(prompt, 'Use ')
    const dataTransfer = {
      types: ['application/x-new-api-reference'],
      getData: vi.fn(() => 'reference-a'),
    }

    fireEvent.drop(prompt, { dataTransfer })

    expect(prompt).toHaveValue('Use @1 (A.png)')
  })
})

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

describe('DrawingSettings generation modes', () => {
  function renderModes() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(
      ['drawing-groups', 852],
      [{ value: 'default', label: 'default', ratio: 1 }]
    )
    client.setQueryData(
      ['drawing-models', 852, 'default'],
      [
        { value: 'gpt-image-1', label: 'gpt-image-1' },
        { value: 'nai-diffusion-4-5-full', label: 'nai-diffusion-4-5-full' },
        { value: 'qwen-image', label: 'qwen-image' },
      ]
    )
    render(
      <QueryClientProvider client={client}>
        <DrawingSettings
          userId={852}
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

  beforeEach(() => {
    localStorage.clear()
    useDrawingStore.getState().initialize(852)
    useDrawingStore.getState().updateSettings({ model: 'gpt-image-1' })
  })

  it('switches between description and tag models, explaining each mode', async () => {
    const user = userEvent.setup()
    renderModes()
    const description = screen.getByRole('button', { name: 'Description mode' })
    const tags = screen.getByRole('button', { name: 'Tag mode' })
    expect(description).toHaveAttribute('aria-pressed', 'true')
    expect(tags).toHaveAttribute('aria-pressed', 'false')

    await user.hover(tags)
    expect(
      await screen.findByText(
        "Write what you want and don't want as separate tags or phrases, and adjust the seed and other parameters."
      )
    ).toBeInTheDocument()

    await user.click(tags)
    expect(useDrawingStore.getState().settings.model).toBe(
      'nai-diffusion-4-5-full'
    )
    expect(tags).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Positive prompt')).toBeInTheDocument()
    expect(screen.getByLabelText('Negative prompt')).toBeInTheDocument()
    expect(screen.getByLabelText('Width')).toHaveValue(832)
    expect(screen.getByLabelText('Sampler')).toHaveValue('k_euler_ancestral')

    await user.click(description)
    expect(useDrawingStore.getState().settings.model).toBe('gpt-image-1')
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument()
    expect(screen.queryByLabelText('Negative prompt')).not.toBeInTheDocument()
  })

  it('offers the controls an Alibaba text-to-image model accepts', async () => {
    useDrawingStore.getState().switchGenerationMode('tags')
    useDrawingStore.getState().updateSettings({
      model: 'qwen-image',
      size: '1328*1328',
    })
    renderModes()

    expect(screen.getByLabelText('Image size')).toHaveValue('1328*1328')
    expect(screen.getByText('Prompt rewriting')).toBeInTheDocument()
    expect(screen.getByLabelText('Seed')).toBeInTheDocument()
    // Qwen-Image only generates from text, so it takes no references.
    expect(screen.queryByText('Reference images')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Image editing' })).toBeDisabled()
  })
})

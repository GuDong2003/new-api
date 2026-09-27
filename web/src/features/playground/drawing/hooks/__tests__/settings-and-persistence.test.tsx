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
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { login } from '@/features/gallery/__tests__/fixtures'
import type { CanvasSetting } from '@/features/playground/types'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import {
  settingsForImageModel,
  validateImageSettings,
} from '../../lib/image-settings'
import { useDrawingPersistence } from '../use-drawing-persistence'
import { useImageOptions } from '../use-image-options'

describe('Drawing settings and persistence', () => {
  afterEach(() => useAuthStore.getState().auth.reset())
  it('reports unsaved changes immediately while waiting for the autosave debounce', async () => {
    login(811)
    const hook = renderHook(() => useDrawingPersistence(811))
    await waitFor(() => expect(hook.result.current).toBe('saved'))
    act(() =>
      useDrawingStore.getState().updateSettings({ prompt: 'A new draft' })
    )
    expect(hook.result.current).toBe('saving')
    await waitFor(() => expect(hook.result.current).toBe('saved'))
    hook.unmount()
  })

  it('selects compatible parameters when the available model is DALL·E 3', async () => {
    useDrawingStore.getState().initialize(812)
    useDrawingStore.getState().hydrate(null)
    useDrawingStore.getState().updateSettings({
      mode: 'edit',
      prompt: 'A cup',
      n: 2,
      size: '1536x1024',
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(
      ['drawing-groups', 812],
      [{ value: 'default', label: 'default', ratio: 1 }]
    )
    client.setQueryData(
      ['drawing-models', 812, 'default'],
      [{ value: 'dall-e-3', label: 'dall-e-3' }]
    )
    const hook = renderHook(() => useImageOptions(812), {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    await waitFor(() =>
      expect(useDrawingStore.getState().settings.model).toBe('dall-e-3')
    )
    expect(
      validateImageSettings(useDrawingStore.getState().settings, 0)
    ).toBeNull()
    expect(useDrawingStore.getState().settings).toMatchObject({
      n: 1,
      mode: 'generate',
      size: '1024x1024',
      quality: 'standard',
    })
    hook.unmount()
    client.clear()
  })

  it('exposes only supported image models and replaces a text model selection', async () => {
    useDrawingStore.getState().initialize(813)
    useDrawingStore.getState().hydrate(null)
    useDrawingStore.getState().updateSettings({
      model: 'gpt-5.6',
      prompt: 'A cup',
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(
      ['drawing-groups', 813],
      [{ value: 'default', label: 'default', ratio: 1 }]
    )
    client.setQueryData(
      ['drawing-models', 813, 'default'],
      [
        { value: 'gpt-5.6', label: 'gpt-5.6' },
        { value: 'imagen-4.0-generate-001', label: 'Imagen 4' },
        { value: 'nai-diffusion-4-5-full', label: 'NAI' },
      ]
    )
    const hook = renderHook(() => useImageOptions(813), {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    await waitFor(() =>
      expect(
        hook.result.current.imageModels.map((model) => model.value)
      ).toEqual(['imagen-4.0-generate-001'])
    )
    await waitFor(() =>
      expect(useDrawingStore.getState().settings.model).toBe(
        'imagen-4.0-generate-001'
      )
    )

    // The tag mode lists NovelAI and Alibaba's models instead.
    act(() => useDrawingStore.getState().switchGenerationMode('tags'))
    await waitFor(() =>
      expect(
        hook.result.current.imageModels.map((model) => model.value)
      ).toEqual(['nai-diffusion-4-5-full'])
    )
    await waitFor(() =>
      expect(useDrawingStore.getState().settings).toMatchObject({
        generationMode: 'tags',
        model: 'nai-diffusion-4-5-full',
        prompt: 'A cup',
      })
    )
    hook.unmount()
    client.clear()
  })

  it('brings back what each generation mode was left with, sharing the prompt', () => {
    localStorage.clear()
    const store = useDrawingStore.getState()
    store.initialize(814)
    store.hydrate(null)
    store.updateSettings({
      model: 'gpt-image-1',
      prompt: 'A fox',
      size: '1536x1024',
      quality: 'high',
    })

    act(() => useDrawingStore.getState().switchGenerationMode('tags'))
    expect(useDrawingStore.getState().settings).toMatchObject({
      generationMode: 'tags',
      model: '',
      prompt: 'A fox',
    })
    useDrawingStore.getState().updateSettings({
      model: 'nai-diffusion-4-5-full',
      negativePrompt: 'blur',
      seed: 7,
      prompt: '1girl, fox ears',
    })

    act(() => useDrawingStore.getState().switchGenerationMode('description'))
    expect(useDrawingStore.getState().settings).toMatchObject({
      generationMode: 'description',
      model: 'gpt-image-1',
      size: '1536x1024',
      quality: 'high',
      prompt: '1girl, fox ears',
    })

    act(() => useDrawingStore.getState().switchGenerationMode('tags'))
    expect(useDrawingStore.getState().settings).toMatchObject({
      model: 'nai-diffusion-4-5-full',
      negativePrompt: 'blur',
      seed: 7,
    })
  })

  it('remembers the other generation mode for the same person after a reload', () => {
    localStorage.clear()
    useDrawingStore.getState().initialize(815)
    useDrawingStore.getState().updateSettings({ model: 'gpt-image-1' })
    act(() => useDrawingStore.getState().switchGenerationMode('tags'))

    useDrawingStore.getState().initialize(815)
    expect(useDrawingStore.getState().modeSettings.description?.model).toBe(
      'gpt-image-1'
    )
    useDrawingStore.getState().initialize(816)
    expect(useDrawingStore.getState().modeSettings).toEqual({})
  })
})

describe('the canvas setting of the user group', () => {
  const adapter = api.defaults.adapter
  afterEach(() => {
    api.defaults.adapter = adapter
  })

  function renderImageOptions(
    userId: number,
    models: string[],
    canvasSetting?: CanvasSetting
  ) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(
      ['drawing-groups', userId],
      [{ value: 'default', label: 'default', ratio: 1 }]
    )
    client.setQueryData(
      ['drawing-models', userId, 'default'],
      models.map((value) => ({ value, label: value }))
    )
    if (canvasSetting) {
      client.setQueryData(['canvas-setting', userId], canvasSetting)
    }
    const hook = renderHook(() => useImageOptions(userId), {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    return {
      hook,
      unmount: () => {
        hook.unmount()
        client.clear()
      },
    }
  }

  function startCanvas(userId: number, model = '') {
    useDrawingStore.getState().initialize(userId)
    useDrawingStore.getState().hydrate(null)
    if (model) {
      useDrawingStore
        .getState()
        .updateSettings(
          settingsForImageModel(useDrawingStore.getState().settings, model)
        )
    }
  }

  it('starts a new canvas on the group default model rather than its own pick', async () => {
    startCanvas(861)
    const view = renderImageOptions(861, ['gpt-image-2', 'nano-banana-pro'], {
      default_model: 'nano-banana-pro',
      disabled_resolutions: [],
    })
    await waitFor(() =>
      expect(useDrawingStore.getState().settings.model).toBe('nano-banana-pro')
    )
    view.unmount()
  })

  it('keeps the model a canvas already uses when the group default differs', () => {
    startCanvas(862, 'gpt-image-2')
    const view = renderImageOptions(862, ['gpt-image-2', 'nano-banana-pro'], {
      default_model: 'nano-banana-pro',
      disabled_resolutions: [],
    })
    expect(useDrawingStore.getState().settings.model).toBe('gpt-image-2')
    view.unmount()
  })

  it('picks a model by itself when the canvas setting cannot be read', async () => {
    api.defaults.adapter = async () => {
      throw new Error('The server is unavailable.')
    }
    startCanvas(863)
    const view = renderImageOptions(863, ['nano-banana-pro', 'gpt-image-2'])
    await waitFor(() =>
      expect(useDrawingStore.getState().settings.model).toBe('gpt-image-2')
    )
    view.unmount()
  })

  it('moves a canvas off a withheld tier to the nearest tier offered', async () => {
    startCanvas(864, 'gpt-image-2')
    // 16:9 at 4K.
    useDrawingStore.getState().updateSettings({ size: '3328x1872' })
    const view = renderImageOptions(864, ['gpt-image-2'], {
      default_model: '',
      disabled_resolutions: ['4K'],
    })
    // 16:9 at 2K.
    await waitFor(() =>
      expect(useDrawingStore.getState().settings.size).toBe('2560x1440')
    )
    view.unmount()
  })

  it('leaves a fixed-size model on its size when the matching tier is withheld', () => {
    startCanvas(865, 'dall-e-3')
    const view = renderImageOptions(865, ['dall-e-3'], {
      default_model: '',
      disabled_resolutions: ['1K'],
    })
    expect(view.hook.result.current.disabledResolutions).toEqual(['1K'])
    expect(useDrawingStore.getState().settings.size).toBe('1024x1024')
    view.unmount()
  })
})

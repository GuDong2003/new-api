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
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import i18next from 'i18next'
import { Toaster } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useImageGeneration } from '@/features/playground/drawing/hooks/use-image-generation'
import { DEFAULT_IMAGE_SETTINGS } from '@/features/playground/drawing/lib/image-settings'
import { useNaiImageGeneration } from '@/features/playground/nai/hooks/use-nai-image-generation'
import { DEFAULT_NAI_SETTINGS } from '@/features/playground/nai/lib/nai-settings'
import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { cancelGallerySaves } from '../lib/save-queue'
import { galleryImage, login, response, usage } from './fixtures'

const adapter = api.defaults.adapter
const decoders: EventTarget[] = []
const saved: FormData[] = []
beforeEach(() => {
  login()
  saved.length = 0
  decoders.length = 0
  useDrawingStore.getState().initialize(813)
  useDrawingStore.getState().hydrate(null)
  useNaiDrawingStore.getState().initialize(813)
  useNaiDrawingStore.getState().hydrate(null)
  vi.stubGlobal(
    'Image',
    class extends EventTarget {
      naturalWidth = 512
      naturalHeight = 512
      src = ''
      constructor() {
        super()
        decoders.push(this)
      }
      set onload(callback: EventListener) {
        this.addEventListener('load', callback)
      }
      set onerror(callback: EventListener) {
        this.addEventListener('error', callback)
      }
    }
  )
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') saved.push(config.data as FormData)
    return response(config, config.method === 'post' ? galleryImage : usage)
  }
})
afterEach(async () => {
  cancelGallerySaves(813, 'gallery-session')
  useAuthStore.getState().auth.reset()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
  await i18next.changeLanguage('en')
})

it.each(['preflight', 'upload'])(
  'completes drawing when gallery rejects at %s and independently displays the Chinese warning',
  async (stage) => {
    i18next.addResourceBundle('zh', 'translation', zh.translation, true, true)
    await i18next.changeLanguage('zh')
    api.defaults.adapter = async (config) => {
      if (config.method === 'post') {
        return {
          ...response(config, null),
          data: { success: false, message: 'Gallery storage limit reached.' },
        }
      }
      return response(
        config,
        stage === 'upload'
          ? usage
          : {
              ...usage,
              can_save: false,
              reason: 'Gallery storage limit reached.',
            }
      )
    }
    vi.spyOn(api, 'post').mockResolvedValue({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }] })).body,
    })
    render(<Toaster />)
    const hook = renderHook(useImageGeneration)
    act(() =>
      hook.result.current.generate(
        { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
        { x: 0, y: 0 }
      )
    )
    await waitFor(() => expect(decoders).toHaveLength(1))
    await act(async () => decoders[0].dispatchEvent(new Event('load')))
    await waitFor(() =>
      expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
    )
    expect(
      await screen.findByText('图库空间已满，本次图片未保存到图库')
    ).toBeVisible()
  }
)

it('completes drawing without waiting for an admitted gallery upload to finish', async () => {
  let finish: (() => void) | undefined
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    return response(config, config.method === 'post' ? galleryImage : usage)
  }
  vi.spyOn(api, 'post').mockResolvedValue({
    headers: { 'content-type': 'application/json' },
    data: new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }] })).body,
  })
  const hook = renderHook(useImageGeneration)
  act(() =>
    hook.result.current.generate(
      { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
      { x: 0, y: 0 }
    )
  )
  await waitFor(() => expect(finish).toBeDefined())
  await act(async () => decoders[0].dispatchEvent(new Event('load')))
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  await act(async () => finish?.())
})

it('saves only the final streamed result even if later browser image decoding fails', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array>
  vi.spyOn(api, 'post').mockResolvedValue({
    headers: { 'content-type': 'text/event-stream' },
    data: new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller
      },
    }),
  })
  const hook = renderHook(useImageGeneration)
  act(() =>
    hook.result.current.generate(
      {
        ...DEFAULT_IMAGE_SETTINGS,
        model: 'gpt-image-1',
        prompt: 'A forest',
        stream: true,
      },
      { x: 0, y: 0 }
    )
  )
  await act(async () =>
    stream.enqueue(
      new TextEncoder().encode(
        'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"YWJj"}\n\n'
      )
    )
  )
  await waitFor(() =>
    expect(
      useDrawingStore.getState().nodes[0].data.progress?.previewCount
    ).toBe(1)
  )
  expect(saved).toEqual([])
  await act(async () => {
    stream.enqueue(
      new TextEncoder().encode(
        'data: {"type":"image_generation.completed","b64_json":"ZGVmZw=="}\n\n'
      )
    )
    stream.close()
  })
  await waitFor(() => expect(saved).toHaveLength(1))
  expect((saved[0].get('file') as File).size).toBe(4)
  const node = useDrawingStore.getState().nodes[0]
  expect(JSON.parse(String(saved[0].get('metadata')))).toMatchObject({
    source: 'drawing',
    source_id: `${node.data.jobId}:0`,
  })
  await act(async () => decoders[0].dispatchEvent(new Event('error')))
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('error')
  )
  expect(saved).toHaveLength(1)
})

it('saves NAI final images with request-builder parameter names and no group or reference binaries', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { data: [{ b64_json: 'YWJj' }] },
  })
  const hook = renderHook(useNaiImageGeneration)
  act(() =>
    hook.result.current.generate({
      ...DEFAULT_NAI_SETTINGS,
      model: 'nai-diffusion-4-5-full',
      group: 'private-group',
      prompt: 'A fox',
      negativePrompt: 'noise',
      seed: 42,
      ucPreset: 'humanFocus',
      qualityToggle: true,
    })
  )
  await waitFor(() =>
    expect(useNaiDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  await waitFor(() => expect(saved).toHaveLength(1))
  const metadata = JSON.parse(String(saved[0].get('metadata')))
  expect(metadata).toMatchObject({
    source: 'nai',
    negative_prompt: 'noise',
    parameters: {
      seed: 42,
      ucPresetId: 'humanFocus',
      noise_schedule: 'karras',
      cfg_rescale: 0,
    },
  })
  expect(metadata.parameters).not.toHaveProperty('negative_prompt')
  expect(metadata).not.toHaveProperty('group')
  expect(JSON.stringify(metadata)).not.toContain('private-group')
})

it('does not save a final NAI result after the generation’s original session changes', async () => {
  let finish: (value: unknown) => void = () => {}
  vi.spyOn(api, 'post').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(useNaiImageGeneration)
  act(() =>
    hook.result.current.generate({
      ...DEFAULT_NAI_SETTINGS,
      model: 'nai-diffusion-4-5-full',
      prompt: 'A fox',
    })
  )
  act(() => login(813, 'new-session'))
  await act(async () => finish({ data: { data: [{ b64_json: 'YWJj' }] } }))
  expect(saved).toEqual([])
})

it('saves an edit result but never copies the canvas reference image into the gallery', async () => {
  const settings = {
    ...DEFAULT_IMAGE_SETTINGS,
    model: 'gpt-image-1',
    prompt: 'A forest',
  }
  useDrawingStore.getState().addNodes([
    {
      id: 'reference',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        prompt: 'Reference only',
        settings,
        status: 'complete',
        createdAt: 1,
        asset: {
          id: 'reference',
          name: 'reference.png',
          src: 'data:image/png;base64,YWJj',
          mimeType: 'image/png',
          width: 512,
          height: 512,
        },
      },
    },
  ])
  useDrawingStore.getState().setReferences(['reference'])
  vi.spyOn(api, 'post').mockResolvedValue({
    headers: { 'content-type': 'application/json' },
    data: new Response(JSON.stringify({ data: [{ b64_json: 'ZGVmZw==' }] }))
      .body,
  })
  const hook = renderHook(useImageGeneration)
  act(() =>
    hook.result.current.generate({ ...settings, mode: 'edit' }, { x: 0, y: 0 })
  )
  await waitFor(() => expect(saved).toHaveLength(1))
  expect((saved[0].get('file') as File).size).toBe(4)
  expect(JSON.parse(String(saved[0].get('metadata')))).toMatchObject({
    prompt: 'A forest',
  })
  expect(String(saved[0].get('metadata'))).not.toContain('reference')
  await act(async () => decoders[0].dispatchEvent(new Event('load')))
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[1].data.status).toBe('complete')
  )
})

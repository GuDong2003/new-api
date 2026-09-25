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
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'

import { act, renderHook, waitFor } from '@testing-library/react'
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useImageGeneration } from '@/features/playground/drawing/hooks/use-image-generation'
import { DEFAULT_IMAGE_SETTINGS } from '@/features/playground/drawing/lib/image-settings'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { deleteCanvasNodes } from '../components/canvas-node-deletion'
import { deleteCanvasProject } from '../lib/canvas-deletion'
import {
  flushLocalEditors,
  stopCanvasEditors,
  getCanvasEditorState,
} from '../lib/canvas-editor'
import { preserveCanvasOriginalSource } from '../lib/canvas-original'
import {
  createCanvasProject,
  startCanvasEditor,
  exportCanvasProject,
  openCanvasProject,
} from '../lib/canvas-projects'
import {
  readCanvasAssets,
  loadLocalCanvas,
  updateCanvasUserState,
} from '../lib/canvas-repository'
import { flushCanvasSession } from '../lib/canvas-sync'
import { login, required, response, usage } from './fixtures'

const identity = { userId: 813, sessionId: 'gallery-session' }
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKn0AAAAASUVORK5CYII='
// NovelAI generates on the drawing page with tag prompts.
const tagSettings = {
  ...DEFAULT_IMAGE_SETTINGS,
  generationMode: 'tags' as const,
  model: 'nai-diffusion-4-5-full',
  prompt: '一只狐狸',
}
const imageResponse = () => ({
  headers: { 'content-type': 'application/json' },
  data: new Response(JSON.stringify({ data: [{ b64_json: png }] })).body,
})
const adapter = api.defaults.adapter
let posts: string[]
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'Image',
    class extends EventTarget {
      naturalWidth = 1
      naturalHeight = 1
      set src(_value: string) {
        queueMicrotask(() => this.dispatchEvent(new Event('load')))
      }
      set onload(callback: EventListener) {
        this.addEventListener('load', callback)
      }
      set onerror(callback: EventListener) {
        this.addEventListener('error', callback)
      }
    }
  )
  login()
  posts = []
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') posts.push(required(config.url))
    return response(config, usage)
  }
})
afterEach(() => {
  stopCanvasEditors(identity)
  useAuthStore.getState().auth.reset()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
})

it('preserves generated originals in the shared local path while full without an immediate cloud queue', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  await updateCanvasUserState(813, (state) => ({
    ...state,
    cloudPause: {
      reason: 'full',
      requiredBytes: 100,
      requiredImages: 1,
      notified: true,
      lastQuotaCheck: Date.now(),
    },
  }))
  vi.spyOn(api, 'post').mockResolvedValue({
    headers: { 'content-type': 'application/json' },
    data: new Response(JSON.stringify({ data: [{ b64_json: png }] })).body,
  })
  const hook = renderHook(useImageGeneration)
  act(() => {
    hook.result.current.generate(
      { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
      { x: 0, y: 0 }
    )
  })
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  await flushLocalEditors(identity)
  const assets = await readCanvasAssets(813, canvas.id)
  expect(assets).toHaveLength(1)
  expect(assets[0]).toMatchObject({
    role: 'generated',
    nodeId: useDrawingStore.getState().nodes[0].id,
  })
  expect(assets[0].blob.size).toBe(68)
  expect(posts).toEqual([])
})

it('finishes URL generation before private original acquisition, and keeps saving the canvas while storage fails', async () => {
  await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    headers: { 'content-type': 'application/json' },
    data: new Response(
      JSON.stringify({ data: [{ url: 'https://images.example/final.png' }] })
    ).body,
  })
  api.defaults.adapter = async () => {
    throw new Error('storage unavailable')
  }
  const hook = renderHook(useImageGeneration)
  act(() => {
    hook.result.current.generate(
      { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
      { x: 0, y: 0 }
    )
  })
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  post.mockRestore()
  await flushLocalEditors(identity)
  expect(getCanvasEditorState('drawing')).toMatchObject({
    localStatus: 'saved',
    pendingOriginals: 1,
  })
  expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
})

describe('a returned link this browser cannot display', () => {
  const link = 'https://chatgpt.com/backend-api/estuary/content?id=file_1'
  let originals: string[]
  beforeEach(async () => {
    vi.stubGlobal(
      'Image',
      class extends EventTarget {
        naturalWidth = 3
        naturalHeight = 2
        set src(value: string) {
          const type = value.startsWith('data:') ? 'load' : 'error'
          queueMicrotask(() => this.dispatchEvent(new Event(type)))
        }
      }
    )
    originals = []
    vi.spyOn(api, 'post').mockResolvedValue({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ url: link }] })).body,
    })
    await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
  })
  const answerOriginals = (
    answer: (config: InternalAxiosRequestConfig) => AxiosResponse
  ) => {
    api.defaults.adapter = async (config) => {
      if (config.url !== '/api/gallery/original') {
        return response(config, usage)
      }
      originals.push(JSON.parse(config.data).url)
      return answer(config)
    }
  }
  const generate = () => {
    const hook = renderHook(useImageGeneration)
    act(() => {
      hook.result.current.generate(
        { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
        { x: 0, y: 0 }
      )
    })
  }
  const settled = () =>
    waitFor(() =>
      expect(useDrawingStore.getState().nodes[0].data.status).not.toBe(
        'pending'
      )
    )

  it('fails the image when the server finds no picture behind it either, and the canvas keeps saving', async () => {
    answerOriginals((config) => {
      throw new AxiosError(
        'invalid',
        '',
        config,
        {},
        { ...response(config, {}), status: 400 }
      )
    })

    generate()
    await settled()

    expect(useDrawingStore.getState().nodes[0].data).toMatchObject({
      status: 'error',
      error: 'The returned image could not be downloaded.',
    })
    expect(useDrawingStore.getState().nodes[0].data.asset).toBeUndefined()
    await flushLocalEditors(identity)
    expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
  })

  it('keeps the original the server downloads, in the type the server found', async () => {
    answerOriginals((config) => ({
      ...response(config, {}),
      data: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
        type: 'image/jpeg',
      }),
    }))

    generate()
    await settled()

    expect(useDrawingStore.getState().nodes[0].data).toMatchObject({
      status: 'complete',
      asset: {
        src: 'data:image/jpeg;base64,/9j/2Q==',
        mimeType: 'image/jpeg',
        width: 3,
        height: 2,
      },
    })
    await flushLocalEditors(identity)
    expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
    // Saving keeps the bytes already downloaded rather than asking again.
    expect(originals).toEqual([link])
  })

  it('keeps the link while the server cannot be asked', async () => {
    answerOriginals((config) => {
      throw new AxiosError(
        'unavailable',
        '',
        config,
        {},
        { ...response(config, {}), status: 503 }
      )
    })

    generate()
    await settled()

    expect(useDrawingStore.getState().nodes[0].data).toMatchObject({
      status: 'complete',
      asset: { src: link },
    })
  })
})

it('keeps an in-flight generation alive when the current canvas is reopened', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  let finish!: (value: unknown) => void
  let signal: { aborted: boolean } | undefined
  vi.spyOn(api, 'post').mockImplementation((_url, _data, config) => {
    signal = config?.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const hook = renderHook(useImageGeneration)
  act(() => {
    hook.result.current.generate(
      { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
      { x: 0, y: 0 }
    )
  })
  await waitFor(() => expect(signal).toBeDefined())

  await openCanvasProject(identity, canvas.id)

  expect(signal?.aborted).toBe(false)
  expect(useDrawingStore.getState().nodes[0].data.status).toBe('pending')
  await act(async () => {
    finish({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: png }] })).body,
    })
  })
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
})

it('does not cloud-sync a canvas while its image generation is in flight', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  const galleryRequests: string[] = []
  api.defaults.adapter = async (config) => {
    galleryRequests.push(required(config.url))
    return response(config, usage)
  }
  let finish!: (value: unknown) => void
  let signal: { aborted: boolean } | undefined
  vi.spyOn(api, 'post').mockImplementation((_url, _data, config) => {
    signal = config?.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const hook = renderHook(useImageGeneration)
  act(() => {
    hook.result.current.generate(
      { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
      { x: 0, y: 0 }
    )
  })
  await waitFor(() => expect(signal).toBeDefined())

  await flushCanvasSession(identity, { syncCloud: false })

  expect(signal?.aborted).toBe(false)
  expect(galleryRequests).not.toContain(`/api/gallery/canvases/${canvas.id}`)
  await act(async () => {
    finish({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: png }] })).body,
    })
  })
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  hook.unmount()
})

it('keeps a pending tag generation alive while arranging the canvas', async () => {
  await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  let signal: { aborted: boolean } | undefined
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'post').mockImplementation((_url, _data, config) => {
    signal = config?.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const hook = renderHook(useImageGeneration)
  act(() => {
    hook.result.current.generate(tagSettings, { x: 0, y: 0 })
  })
  await waitFor(() => expect(useDrawingStore.getState().nodes).toHaveLength(1))
  const node = useDrawingStore.getState().nodes[0]
  const jobId = node.data.jobId

  act(() => useDrawingStore.getState().arrange())

  expect(signal?.aborted).toBe(false)
  expect(useDrawingStore.getState().nodes[0].data).toMatchObject({
    status: 'pending',
    jobId,
  })
  await act(async () => finish(imageResponse()))
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  hook.unmount()
})

it('keeps a pending drawing generation alive while deleting its node', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  let signal: { aborted: boolean } | undefined
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'post').mockImplementation((_url, _data, config) => {
    signal = config?.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const hook = renderHook(useImageGeneration)
  act(() =>
    hook.result.current.generate(
      { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
      { x: 0, y: 0 }
    )
  )
  await waitFor(() => expect(signal).toBeDefined())
  const nodeId = useDrawingStore.getState().nodes[0].id

  await deleteCanvasNodes('drawing', [nodeId])

  expect(signal?.aborted).toBe(false)
  await act(async () => {
    finish({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: png }] })).body,
    })
  })
  expect(useDrawingStore.getState().nodes).toEqual([])
  expect((await loadLocalCanvas(813, canvas.id))?.deleted).toBe(false)
})

it('stores a drawing result on its original canvas while another canvas is open', async () => {
  const source = await createCanvasProject(identity, 'drawing', '源画布')
  await startCanvasEditor(identity, 'drawing')
  let signal: { aborted: boolean } | undefined
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'post').mockImplementation((_url, _data, config) => {
    signal = config?.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const hook = renderHook(useImageGeneration)
  act(() =>
    hook.result.current.generate(
      { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
      { x: 0, y: 0 }
    )
  )
  await waitFor(() => expect(signal).toBeDefined())
  const nodeId = useDrawingStore.getState().nodes[0].id
  const target = await createCanvasProject(identity, 'drawing', '目标画布')
  await openCanvasProject(identity, target.id)

  expect(signal?.aborted).toBe(false)
  await act(async () => {
    finish({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: png }] })).body,
    })
  })

  await waitFor(async () => {
    const stored = await loadLocalCanvas(813, source.id)
    expect(stored?.document.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: nodeId,
          data: expect.objectContaining({ status: 'complete' }),
        }),
      ])
    )
  })
  await openCanvasProject(identity, source.id)
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  hook.unmount()
})

it('does not resurrect a generation result after explicit canvas deletion', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  let finish!: (value: unknown) => void
  let signal: { aborted: boolean } | undefined
  vi.spyOn(api, 'post').mockImplementation((_url, _data, config) => {
    signal = config?.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const hook = renderHook(useImageGeneration)
  act(() => {
    hook.result.current.generate(
      { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A forest' },
      { x: 0, y: 0 }
    )
  })
  await deleteCanvasProject(identity, canvas.id)
  expect(signal?.aborted).toBe(false)
  await act(async () => {
    finish({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ data: [{ b64_json: png }] })).body,
    })
  })
  expect((await loadLocalCanvas(813, canvas.id))?.deleted).toBe(true)
  expect(await readCanvasAssets(813, canvas.id)).toEqual([])
  expect(useDrawingStore.getState().nodes).toEqual([])
  expect(posts).toEqual([])
})

it('acquires remote originals through the captured private transport, with no cloud budget read', async () => {
  const urls: string[] = []
  api.defaults.adapter = async (config) => {
    urls.push(required(config.url))
    expect(JSON.parse(config.data)).toEqual({
      url: 'https://images.example/final.png',
    })
    return {
      ...response(config, {}),
      data: new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
        type: 'image/png',
      }),
    }
  }
  expect(
    await preserveCanvasOriginalSource(
      identity,
      'https://images.example/final.png',
      new AbortController().signal
    )
  ).toEqual({ src: `data:image/png;base64,${png}`, mimeType: 'image/png' })
  expect(urls).toEqual(['/api/gallery/original'])
})

it('exports a portable canvas document even when local storage is unavailable', async () => {
  useDrawingStore.getState().initialize(813)
  useDrawingStore.getState().hydrate(null)
  useDrawingStore.getState().addNodes([
    {
      id: 'tag-node',
      type: 'image',
      position: { x: 9, y: 10 },
      data: {
        asset: {
          id: '11111111-1111-4111-8111-111111111111',
          src: `data:image/png;base64,${png}`,
          width: 1,
          height: 1,
          name: 'image.png',
          mimeType: 'image/png',
        },
        prompt: '便携导出',
        settings: { ...tagSettings, negativePrompt: 'noise' },
        status: 'complete',
        createdAt: 1,
      },
    },
  ])
  vi.spyOn(indexedDB, 'open').mockImplementation(() => {
    throw new Error('storage blocked')
  })
  const blob = await exportCanvasProject(identity, 'drawing')
  const document = JSON.parse(await blob.text())
  expect(document.nodes[0]).toMatchObject({
    position: { x: 9, y: 10 },
    data: {
      prompt: '便携导出',
      asset: { src: `data:image/png;base64,${png}` },
      settings: { generationMode: 'tags', negativePrompt: 'noise' },
    },
  })
})

it('saves tag generated originals and settings locally without an independent image publication', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  vi.spyOn(api, 'post').mockImplementation(async () => imageResponse())
  const hook = renderHook(useImageGeneration)
  act(() => {
    hook.result.current.generate(
      { ...tagSettings, prompt: '狐狸', negativePrompt: 'noise', seed: 42 },
      { x: 0, y: 0 }
    )
  })
  await waitFor(() =>
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  await flushLocalEditors(identity)
  const assets = await readCanvasAssets(813, canvas.id)
  expect(assets).toHaveLength(1)
  expect(assets[0]).toMatchObject({
    role: 'generated',
    nodeId: useDrawingStore.getState().nodes[0].id,
  })
  expect((await loadLocalCanvas(813, canvas.id))?.document.nodes).toMatchObject(
    [
      {
        data: {
          settings: {
            generationMode: 'tags',
            seed: 42,
            negativePrompt: 'noise',
          },
        },
      },
    ]
  )
  expect(posts).toEqual([])
  hook.unmount()
})

it('discards generation results after the captured session changes', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'post').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(useImageGeneration)
  act(() => {
    hook.result.current.generate(tagSettings, { x: 0, y: 0 })
  })
  await waitFor(() => expect(api.post).toHaveBeenCalled())
  act(() => {
    login(813, 'replacement')
  })
  await act(async () => {
    finish(imageResponse())
  })
  expect(await readCanvasAssets(813, canvas.id)).toEqual([])
  expect(posts).toEqual([])
  hook.unmount()
})

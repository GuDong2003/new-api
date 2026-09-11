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
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useImageGeneration } from '@/features/playground/drawing/hooks/use-image-generation'
import { DEFAULT_IMAGE_SETTINGS } from '@/features/playground/drawing/lib/image-settings'
import { useNaiImageGeneration } from '@/features/playground/nai/hooks/use-nai-image-generation'
import { DEFAULT_NAI_SETTINGS } from '@/features/playground/nai/lib/nai-settings'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

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
} from '../lib/canvas-projects'
import {
  readCanvasAssets,
  loadLocalCanvas,
  updateCanvasUserState,
} from '../lib/canvas-repository'
import { login, required, response, usage } from './fixtures'

const identity = { userId: 813, sessionId: 'gallery-session' }
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKn0AAAAASUVORK5CYII='
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

it('finishes URL generation before private original acquisition, and preserves generation success on storage failure', async () => {
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
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('error')
  expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
})

it('discards a generation result arriving after explicit canvas deletion', async () => {
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
  expect(signal?.aborted).toBe(true)
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
      'image/png',
      new AbortController().signal
    )
  ).toBe(`data:image/png;base64,${png}`)
  expect(urls).toEqual(['/api/gallery/original'])
})

it('exports a portable NAI document even when local storage is unavailable', async () => {
  const { useNaiDrawingStore } = await import('@/stores/nai-drawing-store')
  useNaiDrawingStore.getState().initialize(813)
  useNaiDrawingStore.getState().hydrate(null)
  useNaiDrawingStore.getState().addNodes([
    {
      id: 'nai-node',
      type: 'nai-image',
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
        settings: useNaiDrawingStore.getState().settings,
        status: 'complete',
        createdAt: 1,
      },
    },
  ])
  vi.spyOn(indexedDB, 'open').mockImplementation(() => {
    throw new Error('storage blocked')
  })
  const blob = await exportCanvasProject(identity, 'nai')
  const document = JSON.parse(await blob.text())
  expect(document.nodes[0]).toMatchObject({
    position: { x: 9, y: 10 },
    data: {
      prompt: '便携导出',
      asset: { src: `data:image/png;base64,${png}` },
    },
  })
})

it('saves NAI generated originals and settings locally without an independent image publication', async () => {
  const canvas = await createCanvasProject(identity, 'nai')
  await startCanvasEditor(identity, 'nai')
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { data: [{ b64_json: png }] },
  })
  const hook = renderHook(useNaiImageGeneration)
  act(() => {
    hook.result.current.generate({
      ...DEFAULT_NAI_SETTINGS,
      model: 'nai-diffusion-4-5-full',
      prompt: '狐狸',
      negativePrompt: 'noise',
      seed: 42,
    })
  })
  await waitFor(() =>
    expect(useNaiDrawingStore.getState().nodes[0].data.status).toBe('complete')
  )
  await flushLocalEditors(identity)
  const assets = await readCanvasAssets(813, canvas.id)
  expect(assets).toHaveLength(1)
  expect(assets[0]).toMatchObject({
    role: 'generated',
    nodeId: useNaiDrawingStore.getState().nodes[0].id,
  })
  expect((await loadLocalCanvas(813, canvas.id))?.document.nodes).toMatchObject(
    [{ data: { settings: { seed: 42, negativePrompt: 'noise' } } }]
  )
  expect(posts).toEqual([])
})

it('discards NAI results after the captured session changes', async () => {
  const canvas = await createCanvasProject(identity, 'nai')
  await startCanvasEditor(identity, 'nai')
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'post').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(useNaiImageGeneration)
  act(() => {
    hook.result.current.generate({
      ...DEFAULT_NAI_SETTINGS,
      model: 'nai-diffusion-4-5-full',
      prompt: '狐狸',
    })
  })
  act(() => {
    login(813, 'replacement')
  })
  await act(async () => {
    finish({ data: { data: [{ b64_json: png }] } })
  })
  expect(await readCanvasAssets(813, canvas.id)).toEqual([])
  expect(posts).toEqual([])
})

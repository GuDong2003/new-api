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

import {
  AxiosError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logout } from '@/features/auth/api'
import * as legacyDrawing from '@/features/playground/drawing/lib/canvas-storage'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { deleteCanvasNodes } from '../components/canvas-node-deletion'
import { deleteCanvasResource } from '../lib/canvas-deletion'
import {
  flushLocalEditors,
  stopCanvasEditors,
  getCanvasEditorState,
} from '../lib/canvas-editor'
import {
  createCanvasProject,
  overwriteCanvasProject,
  startCanvasEditor,
  openCanvasProject,
} from '../lib/canvas-projects'
import {
  loadLocalCanvas,
  readCanvasUserState,
  updateCanvasUserState,
  saveLocalCanvas,
  readCanvasAssets,
  listLocalCanvases,
  removeLocalCanvasAsset,
} from '../lib/canvas-repository'
import {
  syncCanvas,
  checkCanvasCapacity,
  flushCanvasSession,
  cancelCanvasSession,
} from '../lib/canvas-sync'
import type { CanvasRecord, CanvasSaveMetadata } from '../types'
import { login, required, response, usage } from './fixtures'

const identity = { userId: 813, sessionId: 'gallery-session' }
const adapter = api.defaults.adapter
let requests: InternalAxiosRequestConfig[]
let full = false
let remote: CanvasRecord | null
beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('FormData', (await import('undici')).FormData)
  login()
  requests = []
  remote = null
  full = false
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (config.url?.endsWith('/usage')) {
      return response(config, {
        ...usage,
        can_save: !full,
        reason: full ? 'Gallery storage limit reached.' : '',
        available_bytes: full ? 0 : 1e9,
        available_images: full ? 0 : 100,
      })
    }
    if (config.method === 'post') {
      const meta = JSON.parse(
        String((config.data as FormData).get('metadata'))
      ) as CanvasSaveMetadata
      remote = {
        ...meta,
        revision: meta.base_revision + 1,
        state: 'ready',
        updated_at: 1,
        expires_at: 9000,
        removed_asset_ids: [],
        assets: meta.assets.map((asset) => ({
          ...asset,
          width: 1,
          height: 1,
          mime_type: 'image/png',
          has_thumbnail: false,
        })),
        asset_id_map: {},
      }
      return response(config, remote)
    }
    if (!remote) {
      throw new AxiosError(
        'not found',
        '',
        config,
        {},
        { ...response(config, {}), status: 404 }
      )
    }
    return response(config, remote)
  }
})
afterEach(() => {
  stopCanvasEditors(identity)
  cancelCanvasSession(identity)
  useAuthStore.getState().auth.reset()
  api.defaults.adapter = adapter
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const posts = () => requests.filter((r) => r.method === 'post')

it('reopens the same canvas from its post-flush revision without losing pending editor changes', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  useDrawingStore
    .getState()
    .updateSettings({ prompt: '尚未 debounce 的新提示词' })
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('saving')
  await openCanvasProject(identity, canvas.id)
  expect(useDrawingStore.getState().settings.prompt).toBe(
    '尚未 debounce 的新提示词'
  )
  expect(
    (await loadLocalCanvas(813, canvas.id))?.document.settings
  ).toMatchObject({ prompt: '尚未 debounce 的新提示词' })
})

it('does not create a default canvas during concurrent startup', async () => {
  await Promise.all([
    startCanvasEditor(identity, 'drawing'),
    startCanvasEditor(identity, 'drawing'),
  ])
  expect(
    (await listLocalCanvases(813)).filter((canvas) => canvas.kind === 'drawing')
  ).toHaveLength(0)
})

it('materializes the transient canvas only after its first editor change', async () => {
  await startCanvasEditor(identity, 'drawing')
  expect(await listLocalCanvases(813)).toHaveLength(0)

  useDrawingStore.getState().updateSettings({ prompt: '第一次编辑' })
  await flushLocalEditors(identity)

  const canvases = (await listLocalCanvases(813)).filter(
    (canvas) => canvas.kind === 'drawing'
  )
  expect(canvases).toHaveLength(1)
  expect(canvases[0].document).toMatchObject({
    settings: { prompt: '第一次编辑' },
  })
})

it('opens an existing browser draft even when legacy migration cannot read its original', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  const legacy = vi
    .spyOn(legacyDrawing, 'loadDrawingDocument')
    .mockRejectedValue(new Error('legacy original unavailable'))
  await startCanvasEditor(identity, 'drawing')
  expect(getCanvasEditorState('drawing')?.canvas?.id).toBe(canvas.id)
  legacy.mockRestore()
})

it('ignores a remembered canvas belonging to the other editor kind', async () => {
  const drawing = await createCanvasProject(identity, 'drawing')
  const nai = await createCanvasProject(identity, 'nai')
  await updateCanvasUserState(813, (state) => ({
    ...state,
    lastOpened: { ...state.lastOpened, drawing: nai.id },
  }))
  await startCanvasEditor(identity, 'drawing')
  expect(getCanvasEditorState('drawing')?.canvas?.id).toBe(drawing.id)
})

it.each(['Gallery storage is unavailable.', 'Gallery is disabled.'])(
  'does not persist a capacity pause for %s',
  async (reason) => {
    const canvas = await createCanvasProject(identity, 'drawing')
    api.defaults.adapter = async (config) => {
      if (config.url?.endsWith('/usage')) {
        return response(config, { ...usage, can_save: false, reason })
      }
      throw new AxiosError(
        'not found',
        '',
        config,
        {},
        { ...response(config, {}), status: 404 }
      )
    }
    await syncCanvas(identity, canvas.id, 'manual')
    expect((await readCanvasUserState(813)).cloudPause).toBeNull()
    expect((await loadLocalCanvas(813, canvas.id))?.status).toBe('error')
  }
)
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKn0AAAAASUVORK5CYII='
const sourceId = '11111111-1111-4111-8111-111111111111'
const targetId = '22222222-2222-4222-8222-222222222222'
function addOriginal(id = sourceId) {
  const state = useDrawingStore.getState()
  state.addNodes([
    {
      id: `node-${id}`,
      type: 'image',
      position: { x: 11, y: 12 },
      data: {
        asset: {
          id,
          name: 'image.png',
          src: `data:image/png;base64,${png}`,
          width: 1,
          height: 1,
          mimeType: 'image/png',
        },
        settings: state.settings,
        prompt: '',
        status: 'complete',
        createdAt: 1,
      },
    },
  ])
}

it('commits real editor changes only after the two second local debounce', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  useDrawingStore.getState().updateSettings({ prompt: '新提示' })
  await vi.advanceTimersByTimeAsync(1999)
  expect(
    (await loadLocalCanvas(813, canvas.id))?.document.settings
  ).toMatchObject({ prompt: '' })
  await vi.advanceTimersByTimeAsync(1)
  await flushLocalEditors(identity)
  expect(
    (await loadLocalCanvas(813, canvas.id))?.document.settings
  ).toMatchObject({ prompt: '新提示' })
  expect((await loadLocalCanvas(813, canvas.id))?.status).toBe('pending')
  expect(posts()).toHaveLength(0)
})

it('persists full pause and prevents manual, leave and logout publications', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  full = true
  await syncCanvas(identity, canvas.id, 'manual')
  expect((await readCanvasUserState(813)).cloudPause).toMatchObject({
    notified: true,
  })
  cancelCanvasSession(identity)
  await syncCanvas(identity, canvas.id, 'manual')
  await syncCanvas(identity, canvas.id, 'leave')
  await flushCanvasSession(identity)
  expect(posts()).toHaveLength(0)
  expect(requests.filter((r) => r.url?.endsWith('/usage'))).toHaveLength(1)
})

it('checks the pending budget after a deletion and resumes only with enough capacity', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await saveLocalCanvas(
    { ...canvas, name: '编辑过', needsExplicitSave: false },
    []
  )
  await updateCanvasUserState(813, (state) => ({
    ...state,
    cloudPause: {
      reason: 'full',
      requiredBytes: 9000,
      requiredImages: 2,
      notified: true,
      lastQuotaCheck: Date.now(),
    },
  }))
  full = true
  await checkCanvasCapacity(identity, true)
  expect(requests.at(-1)?.params).toMatchObject({
    required_bytes: 9000,
    required_images: 2,
  })
  await syncCanvas(identity, canvas.id, 'manual')
  expect(posts()).toHaveLength(0)
  full = false
  await checkCanvasCapacity(identity, true)
  expect((await readCanvasUserState(813)).cloudPause).toBeNull()
  expect(posts()).toHaveLength(1)
})

it('leaves untouched new drafts local-only and uploads dirty timer changes at most once per five minutes', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await syncCanvas(identity, canvas.id, 'timer')
  expect(posts()).toHaveLength(0)
  let current = required(await loadLocalCanvas(813, canvas.id))
  await saveLocalCanvas(
    { ...current, name: '首次编辑', needsExplicitSave: false },
    []
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  await syncCanvas(identity, canvas.id, 'timer')
  expect(posts()).toHaveLength(1)
  current = required(await loadLocalCanvas(813, canvas.id))
  await saveLocalCanvas({ ...current, name: '再次编辑' }, [])
  await syncCanvas(identity, canvas.id, 'timer')
  expect(posts()).toHaveLength(1)
  vi.setSystemTime(Date.now() + 300_000)
  await syncCanvas(identity, canvas.id, 'timer')
  expect(posts()).toHaveLength(2)
})

// The cloud leaves out an original whose file it lost, which asks the browser
// for it again. A preview cannot stand in for that original.
it('keeps the cloud copy waiting when an original the cloud lost is held here only as a preview', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await syncCanvas(identity, canvas.id, 'manual')
  expect(posts()).toHaveLength(1)
  const current = required(await loadLocalCanvas(813, canvas.id))
  await saveLocalCanvas(
    {
      ...current,
      document: {
        ...current.document,
        nodes: [
          {
            id: `node-${sourceId}`,
            type: 'image',
            position: { x: 0, y: 0 },
            data: {
              asset: {
                id: sourceId,
                name: 'image.png',
                src: 'data:image/png;base64,AA==',
                width: 1,
                height: 1,
                mimeType: 'image/png',
              },
              settings: {},
              prompt: '',
              status: 'complete',
              createdAt: 1,
            },
          },
        ],
      },
    },
    [
      {
        id: sourceId,
        role: 'generated',
        nodeId: `node-${sourceId}`,
        sha256: 'a'.repeat(64),
        previewOnly: true,
        blob: new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
          type: 'image/jpeg',
        }),
      },
    ]
  )

  await syncCanvas(identity, canvas.id, 'manual')

  expect(posts()).toHaveLength(1)
})

it('keeps transaction failures visibly unsaved and the last complete document intact', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  const other = await createCanvasProject(identity, 'drawing')
  await openCanvasProject(identity, canvas.id)
  const put = IDBObjectStore.prototype.put
  const failure = vi
    .spyOn(IDBObjectStore.prototype, 'put')
    .mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args)
      if (this.name === 'canvases') this.transaction.abort()
      return request
    })
  useDrawingStore.getState().updateSettings({ prompt: '未提交' })
  await flushLocalEditors(identity)
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('error')
  await expect(openCanvasProject(identity, other.id)).rejects.toThrow()
  expect(useDrawingStore.getState().settings.prompt).toBe('未提交')
  expect(
    (await loadLocalCanvas(813, canvas.id))?.document.settings
  ).toMatchObject({ prompt: '' })
  failure.mockRestore()
})

it('retains a conflicting local document and never overwrites the server', async () => {
  let canvas = await createCanvasProject(identity, 'drawing')
  await syncCanvas(identity, canvas.id, 'manual')
  canvas = required(await loadLocalCanvas(813, canvas.id))
  await saveLocalCanvas({ ...canvas, name: '保留本地名字' }, [])
  remote = { ...required(remote), revision: 9 }
  await syncCanvas(identity, canvas.id, 'manual')
  expect(await loadLocalCanvas(813, canvas.id)).toMatchObject({
    name: '保留本地名字',
    status: 'conflict',
  })
  expect(posts()).toHaveLength(1)
})

// The counterpart to reloading: a conflict can also be resolved by keeping what
// is on screen. The upload names the revision it succeeds, so replacing has to
// adopt whatever the cloud holds now or the server rejects it all over again.
it('replaces the cloud version with the local one as its successor', async () => {
  let canvas = await createCanvasProject(identity, 'drawing')
  await syncCanvas(identity, canvas.id, 'manual')
  canvas = required(await loadLocalCanvas(813, canvas.id))
  // A real conflict is a document that diverged, not just a renamed one.
  await saveLocalCanvas(
    {
      ...canvas,
      name: '保留本地名字',
      document: { ...canvas.document, settings: { prompt: '本地修改' } },
    },
    []
  )
  remote = {
    ...required(remote),
    revision: 9,
    document: {
      ...required(remote).document,
      settings: { prompt: '云端修改' },
    },
  }
  await syncCanvas(identity, canvas.id, 'manual')
  expect(await loadLocalCanvas(813, canvas.id)).toMatchObject({
    status: 'conflict',
  })

  await overwriteCanvasProject(identity, canvas.id)

  const sent = JSON.parse(
    String((required(posts().at(-1)).data as FormData).get('metadata'))
  ) as CanvasSaveMetadata
  expect(sent.base_revision).toBe(9)
  expect(sent.document).toMatchObject({ settings: { prompt: '本地修改' } })
  expect(await loadLocalCanvas(813, canvas.id)).toMatchObject({
    name: '保留本地名字',
    status: 'synced',
  })
})

// The cloud lets an original go only through an explicit removal, so keeping the
// local canvas has to remove the ones it no longer has; otherwise the server
// refuses the replacement as one more conflict.
it('replaces the cloud version even where the cloud holds an image this canvas no longer has', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  addOriginal()
  addOriginal(targetId)
  await flushLocalEditors(identity)
  await syncCanvas(identity, canvas.id, 'manual')
  // Undo takes the second image off this canvas; the cloud still holds it.
  useDrawingStore.getState().undo()
  await flushLocalEditors(identity)
  const cloud = api.defaults.adapter as AxiosAdapter
  api.defaults.adapter = async (config) => {
    const stored = required(remote)
    if (config.method === 'delete') {
      requests.push(config)
      const assetId = decodeURIComponent(
        required(required(config.url).split('/').at(-1))
      )
      remote = {
        ...stored,
        revision: stored.revision + 1,
        assets: stored.assets.filter((asset) => asset.id !== assetId),
        removed_asset_ids: [...stored.removed_asset_ids, assetId],
      }
      return response(config, remote)
    }
    if (config.method === 'post' && config.url === '/api/gallery/canvases') {
      const sent = JSON.parse(
        String((config.data as FormData).get('metadata'))
      ) as CanvasSaveMetadata
      const dropped = stored.assets.some(
        (asset) =>
          asset.role !== 'mask' &&
          !sent.assets.some((item) => item.id === asset.id)
      )
      if (dropped) {
        requests.push(config)
        throw new AxiosError(
          'conflict',
          '',
          config,
          {},
          {
            ...response(config, {}),
            status: 409,
            data: {
              success: false,
              message: 'Canvas conflict.',
              code: 'canvas_conflict',
            },
          }
        )
      }
    }
    return cloud(config)
  }
  await syncCanvas(identity, canvas.id, 'manual')
  expect((await loadLocalCanvas(813, canvas.id))?.status).toBe('conflict')

  await overwriteCanvasProject(identity, canvas.id)

  expect((await loadLocalCanvas(813, canvas.id))?.status).toBe('synced')
  expect(remote?.assets.map((asset) => asset.id)).toEqual([sourceId])
})

it('marks expiry without content revision changes or unchanged automatic reupload', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await syncCanvas(identity, canvas.id, 'manual')
  const saved = required(await loadLocalCanvas(813, canvas.id))
  remote = {
    ...required(remote),
    revision: 2,
    state: 'expired',
    document: null,
    assets: [],
  }
  await syncCanvas(identity, canvas.id, 'leave')
  const expired = required(await loadLocalCanvas(813, canvas.id))
  expect(expired).toMatchObject({
    revision: saved.revision,
    status: 'local',
    needsExplicitSave: true,
    expiresAt: 0,
  })
  await syncCanvas(identity, canvas.id, 'timer')
  expect(posts()).toHaveLength(1)
})

it('aborts captured-session requests on account replacement', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  let pending: InternalAxiosRequestConfig | undefined
  let release!: () => void
  api.defaults.adapter = async (config) => {
    pending = config
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return response(config, usage)
  }
  const saving = syncCanvas(identity, canvas.id, 'manual')
  for (let i = 0; !pending && i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  login(814, 'replacement')
  expect(pending?.signal?.aborted).toBe(true)
  release()
  await saving
  expect((await loadLocalCanvas(813, canvas.id))?.cloudSavedRevision).toBe(0)
})

it('flushes editor content before server logout while known-full starts no cloud request', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  await updateCanvasUserState(813, (state) => ({
    ...state,
    cloudPause: {
      reason: 'full',
      requiredBytes: 1000,
      requiredImages: 1,
      notified: true,
      lastQuotaCheck: Date.now(),
    },
  }))
  useDrawingStore.getState().updateSettings({ prompt: '登出前保存' })
  let serverPrompt: unknown
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (config.url === '/api/user/auth/logout') {
      serverPrompt = (await loadLocalCanvas(813, canvas.id))?.document.settings
    }
    return { ...response(config, {}), data: { success: true, message: '' } }
  }
  await logout()
  expect(serverPrompt).toMatchObject({ prompt: '登出前保存' })
  expect(
    requests
      .filter((request) => request.method === 'post')
      .map((request) => request.url)
  ).toEqual(['/api/user/auth/logout'])
})

it('bounds eligible cloud flush at five seconds and cancels the outstanding request', async () => {
  await createCanvasProject(identity, 'drawing')
  let pending: InternalAxiosRequestConfig | undefined
  let release!: () => void
  api.defaults.adapter = async (config) => {
    pending = config
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return response(config, usage)
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  let finished = false
  const work = flushCanvasSession(identity).then(() => {
    finished = true
  })
  for (let i = 0; !pending && i < 100; i++) await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(4999)
  expect(finished).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await work
  expect(pending?.signal?.aborted).toBe(true)
  release()
})

it('deletes one shared original without discarding unrelated unsaved edits or allowing undo resurrection', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  addOriginal()
  addOriginal(targetId)
  await flushLocalEditors(identity)
  useDrawingStore.getState().updateSettings({ prompt: '删除时仍在编辑' })
  await deleteCanvasResource(identity, canvas.id, sourceId)
  expect(useDrawingStore.getState().settings.prompt).toBe('删除时仍在编辑')
  expect(
    useDrawingStore.getState().nodes.map((node) => node.data.asset?.id)
  ).toEqual([targetId])
  useDrawingStore.getState().undo()
  expect(
    useDrawingStore.getState().nodes.map((node) => node.data.asset?.id)
  ).toEqual([targetId])
  await flushLocalEditors(identity)
  expect(
    (await loadLocalCanvas(813, canvas.id))?.document.settings
  ).toMatchObject({ prompt: '删除时仍在编辑' })
})

// A retry sends an image's own prompt with the references it still has, so a
// deleted original unbinds the mention that named it and moves the rest up.
it('renumbers the prompt of an image whose reference original is deleted', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  addOriginal()
  addOriginal(targetId)
  const state = useDrawingStore.getState()
  state.addNodes(
    [
      {
        id: 'edited',
        type: 'image',
        position: { x: 60, y: 12 },
        data: {
          prompt: '把@2 (image.png)的角色放进@1 (image.png)',
          referenceIds: [`node-${sourceId}`, `node-${targetId}`],
          settings: { ...state.settings, mode: 'edit' },
          status: 'error',
          createdAt: 3,
        },
      },
    ],
    [
      { id: 'source-edited', source: `node-${sourceId}`, target: 'edited' },
      { id: 'target-edited', source: `node-${targetId}`, target: 'edited' },
    ]
  )
  await flushLocalEditors(identity)
  const renumbered = {
    referenceIds: [`node-${targetId}`],
    prompt: '把@1 (image.png)的角色放进@? (image.png)',
  }

  await deleteCanvasResource(identity, canvas.id, sourceId)

  expect(
    useDrawingStore.getState().nodes.find((node) => node.id === 'edited')?.data
  ).toMatchObject(renumbered)
  await flushLocalEditors(identity)
  const stored = required(await loadLocalCanvas(813, canvas.id)).document
    .nodes as Array<{ id: string; data: Record<string, unknown> }>
  expect(stored.find((node) => node.id === 'edited')?.data).toMatchObject(
    renumbered
  )
})

describe('an original this browser cannot download yet', () => {
  const link = 'https://images.example/final.png'
  // The type the server hands the original back in, or nothing while it cannot.
  let original: string | null
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:stored-original')
        static revokeObjectURL = vi.fn()
      }
    )
    original = null
    const cloud = api.defaults.adapter as AxiosAdapter
    api.defaults.adapter = async (config) => {
      if (config.url !== '/api/gallery/original') return cloud(config)
      requests.push(config)
      if (!original) {
        throw new AxiosError(
          'unavailable',
          '',
          config,
          {},
          { ...response(config, {}), status: 503 }
        )
      }
      return {
        ...response(config, {}),
        data: new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
          type: original,
        }),
      }
    }
  })
  const addLinked = () => {
    const state = useDrawingStore.getState()
    state.addNodes([
      {
        id: 'linked',
        type: 'image',
        position: { x: 40, y: 12 },
        data: {
          asset: {
            id: targetId,
            name: 'final.png',
            src: link,
            width: 1,
            height: 1,
            mimeType: 'image/png',
          },
          settings: state.settings,
          prompt: '',
          status: 'complete',
          createdAt: 2,
        },
      },
    ])
  }
  const uploads = () =>
    requests.filter(
      (request) =>
        request.method === 'post' && request.url === '/api/gallery/canvases'
    )

  it('saves everything else in this browser and keeps the image as its link', async () => {
    await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    addOriginal()
    addLinked()

    await flushLocalEditors(identity)

    expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
    stopCanvasEditors(identity)
    await startCanvasEditor(identity, 'drawing')
    expect(
      useDrawingStore
        .getState()
        .nodes.map((node) => [node.id, node.data.asset?.src])
    ).toEqual([
      [`node-${sourceId}`, 'blob:stored-original'],
      ['linked', link],
    ])
  })

  it('keeps the cloud copy waiting for the original, and uploads once it arrives', async () => {
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    addOriginal()
    addLinked()
    await flushLocalEditors(identity)
    await syncCanvas(identity, canvas.id, 'manual')
    expect(uploads()).toEqual([])
    expect(getCanvasEditorState('drawing')?.pendingOriginals).toBe(1)

    original = 'image/png'
    await flushLocalEditors(identity)
    await syncCanvas(identity, canvas.id, 'manual')

    expect(getCanvasEditorState('drawing')?.pendingOriginals).toBe(0)
    expect(uploads()).toHaveLength(1)
    expect(remote?.assets.map((asset) => asset.id).sort()).toEqual(
      [sourceId, targetId].sort()
    )
  })

  it('keeps saving an original that arrives in another type than its link said', async () => {
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    original = 'image/jpeg'
    addLinked()
    await flushLocalEditors(identity)
    expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')

    useDrawingStore.getState().updateSettings({ prompt: '再改一次' })
    await flushLocalEditors(identity)

    expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
    expect((await readCanvasAssets(813, canvas.id))[0].blob.type).toBe(
      'image/jpeg'
    )
  })
})

describe('a canvas another tab saves too', () => {
  type StoredNode = { id: string; data: Record<string, unknown> } & Record<
    string,
    unknown
  >
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:stored-original')
        static revokeObjectURL = vi.fn()
      }
    )
  })
  // Another tab's save reaches this browser's storage and nothing else here.
  const saveElsewhere = async (
    id: string,
    change: (nodes: StoredNode[]) => StoredNode[],
    binaries: Awaited<ReturnType<typeof readCanvasAssets>> = []
  ) => {
    const stored = required(await loadLocalCanvas(813, id))
    await saveLocalCanvas(
      {
        ...stored,
        document: {
          ...stored.document,
          nodes: change(stored.document.nodes as StoredNode[]),
        },
      },
      binaries
    )
  }
  const addElsewhere = async (id: string, nodeId: string, assetId: string) => {
    const [binary] = await readCanvasAssets(813, id)
    await saveElsewhere(
      id,
      (nodes) => [
        ...nodes,
        {
          ...nodes[0],
          id: nodeId,
          position: { x: 90, y: 12 },
          data: {
            ...nodes[0].data,
            asset: { ...(nodes[0].data.asset as object), id: assetId },
          },
        },
      ],
      [{ ...binary, id: assetId, role: 'reference', nodeId }]
    )
  }
  const storedIds = async (id: string) =>
    (
      required(await loadLocalCanvas(813, id)).document.nodes as StoredNode[]
    ).map((node) => node.id)
  const shownIds = () => useDrawingStore.getState().nodes.map((node) => node.id)

  it('keeps a reference another tab added when this tab saves its own edit', async () => {
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    addOriginal()
    await flushLocalEditors(identity)
    await addElsewhere(canvas.id, 'reference-there', targetId)

    useDrawingStore.getState().updateSettings({ prompt: '这边的修改' })
    await flushLocalEditors(identity)

    expect(await storedIds(canvas.id)).toEqual([
      `node-${sourceId}`,
      'reference-there',
    ])
    expect(
      required(await loadLocalCanvas(813, canvas.id)).document.settings
    ).toMatchObject({ prompt: '这边的修改' })
    expect(shownIds()).toEqual([`node-${sourceId}`, 'reference-there'])
  })

  it('lets an image another tab deleted stay deleted', async () => {
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    addOriginal()
    addOriginal(targetId)
    await flushLocalEditors(identity)
    await removeLocalCanvasAsset(813, canvas.id, targetId)

    useDrawingStore.getState().updateSettings({ prompt: '这边的修改' })
    await flushLocalEditors(identity)

    expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
    expect(await storedIds(canvas.id)).toEqual([`node-${sourceId}`])
    expect(shownIds()).toEqual([`node-${sourceId}`])
  })

  it('shows what another tab saved when this tab is back in focus', async () => {
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    addOriginal()
    await flushLocalEditors(identity)
    await addElsewhere(canvas.id, 'reference-there', targetId)

    window.dispatchEvent(new Event('focus'))
    await flushLocalEditors(identity)

    expect(shownIds()).toEqual([`node-${sourceId}`, 'reference-there'])
  })

  it('takes the result another tab stored for an image still generating here', async () => {
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    addOriginal()
    const state = useDrawingStore.getState()
    state.addNodes([
      {
        id: 'generating',
        type: 'image',
        position: { x: 0, y: 40 },
        data: {
          settings: state.settings,
          prompt: '',
          status: 'pending',
          createdAt: 3,
          jobId: 'job-there',
        },
      },
    ])
    await flushLocalEditors(identity)
    const [binary] = await readCanvasAssets(813, canvas.id)
    await saveElsewhere(
      canvas.id,
      (nodes) =>
        nodes.map((node) =>
          node.id === 'generating'
            ? {
                ...node,
                data: {
                  ...node.data,
                  status: 'complete',
                  asset: {
                    id: targetId,
                    name: 'result.png',
                    width: 1,
                    height: 1,
                    mimeType: 'image/png',
                  },
                },
              }
            : node
        ),
      [{ ...binary, id: targetId, role: 'generated', nodeId: 'generating' }]
    )

    useDrawingStore.getState().updateSettings({ prompt: '这边的修改' })
    await flushLocalEditors(identity)

    const generated = useDrawingStore
      .getState()
      .nodes.find((node) => node.id === 'generating')
    expect(generated?.data).toMatchObject({
      status: 'complete',
      asset: { id: targetId },
    })
  })
})

it('keeps an image another node on the canvas still shows', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  addOriginal()
  const state = useDrawingStore.getState()
  state.addNodes([
    { ...state.nodes[0], id: 'same-picture', position: { x: 60, y: 12 } },
  ])
  await flushLocalEditors(identity)

  await deleteCanvasNodes('drawing', ['same-picture'])
  await flushLocalEditors(identity)

  expect(useDrawingStore.getState().nodes.map((node) => node.id)).toEqual([
    `node-${sourceId}`,
  ])
  expect(
    (await readCanvasAssets(813, canvas.id)).map((asset) => asset.id)
  ).toEqual([sourceId])
  expect((await readCanvasUserState(813)).pendingAssetRemovals).toEqual([])
})

it('keeps saving after deleting the reference a masked edit was made from', async () => {
  await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  addOriginal()
  const state = useDrawingStore.getState()
  const image = (id: string, name: string) => ({
    id,
    name,
    src: `data:image/png;base64,${png}`,
    width: 1,
    height: 1,
    mimeType: 'image/png',
  })
  state.addNodes([
    {
      id: 'masked-edit',
      type: 'image',
      position: { x: 40, y: 12 },
      data: {
        asset: image(targetId, 'edit.png'),
        mask: image('33333333-3333-4333-8333-333333333333', 'mask.png'),
        referenceIds: [`node-${sourceId}`],
        settings: state.settings,
        prompt: 'edit',
        status: 'complete',
        createdAt: 2,
      },
    },
  ])
  await flushLocalEditors(identity)
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')

  await deleteCanvasNodes('drawing', [`node-${sourceId}`])
  useDrawingStore.getState().updateSettings({ prompt: '删掉参考图之后' })
  await flushLocalEditors(identity)

  expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
})

it('deletes an image whose original is gone, which keeps the canvas from saving', async () => {
  await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  const cloud = api.defaults.adapter as AxiosAdapter
  api.defaults.adapter = async (config) => {
    if (config.url !== '/api/gallery/original') return cloud(config)
    throw new AxiosError(
      'invalid',
      '',
      config,
      {},
      { ...response(config, {}), status: 400 }
    )
  }
  addOriginal()
  const state = useDrawingStore.getState()
  state.addNodes([
    {
      id: 'unreadable',
      type: 'image',
      position: { x: 40, y: 12 },
      data: {
        // Shown from this tab's copy of an original another tab has deleted.
        asset: {
          id: targetId,
          name: 'unreadable.png',
          src: 'blob:deleted-elsewhere',
          width: 1024,
          height: 1024,
          mimeType: 'image/png',
        },
        settings: state.settings,
        prompt: '',
        status: 'complete',
        createdAt: 2,
      },
    },
  ])
  await flushLocalEditors(identity)
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('error')

  await deleteCanvasNodes('drawing', ['unreadable'])

  expect(useDrawingStore.getState().nodes.map((node) => node.id)).toEqual([
    `node-${sourceId}`,
  ])
  await flushLocalEditors(identity)
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
})

it('clears the removal of an original the cloud canvas never held, so the canvas uploads again', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  addOriginal()
  await flushLocalEditors(identity)
  await syncCanvas(identity, canvas.id, 'manual')
  // Added after that upload, this original exists only in this browser.
  addOriginal(targetId)
  await flushLocalEditors(identity)
  const cloud = api.defaults.adapter as AxiosAdapter
  api.defaults.adapter = async (config) => {
    if (config.method !== 'delete') return cloud(config)
    requests.push(config)
    throw new AxiosError(
      'not found',
      '',
      config,
      {},
      { ...response(config, {}), status: 404 }
    )
  }

  await deleteCanvasResource(identity, canvas.id, targetId)

  // Deleting replays the removal itself.
  await vi.waitFor(async () =>
    expect((await readCanvasUserState(813)).pendingAssetRemovals).toEqual([])
  )
  await flushLocalEditors(identity)
  const uploads = posts().length
  await syncCanvas(identity, canvas.id, 'manual')
  expect(posts()).toHaveLength(uploads + 1)
  expect(remote?.assets.map((asset) => asset.id)).toEqual([sourceId])
})

it('applies canonical IDs to latest editor and undo snapshots without overwriting edits made during upload', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  addOriginal()
  await flushLocalEditors(identity)
  const binary = (await readCanvasAssets(813, canvas.id))[0]
  let finish!: () => void
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/usage')) return response(config, usage)
    if (config.method !== 'post') {
      throw new AxiosError(
        'not found',
        '',
        config,
        {},
        { ...response(config, {}), status: 404 }
      )
    }
    requests.push(config)
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    const meta = JSON.parse(String((config.data as FormData).get('metadata')))
    return response(config, {
      ...meta,
      revision: 1,
      state: 'ready',
      updated_at: 1,
      expires_at: 9000,
      removed_asset_ids: [],
      assets: [
        {
          id: targetId,
          role: 'generated',
          node_id: `node-${sourceId}`,
          sha256: binary.sha256,
          bytes: binary.blob.size,
          width: 1,
          height: 1,
          mime_type: 'image/png',
          has_thumbnail: false,
        },
      ],
      asset_id_map: { [sourceId]: targetId },
    })
  }
  const upload = syncCanvas(identity, canvas.id, 'manual')
  for (let i = 0; !finish && i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(finish).toBeDefined()
  useDrawingStore.getState().checkpoint()
  useDrawingStore.getState().updateSettings({ prompt: '上传中编辑' })
  finish()
  await upload
  expect(useDrawingStore.getState().settings.prompt).toBe('上传中编辑')
  expect(useDrawingStore.getState().nodes[0].data.asset?.id).toBe(targetId)
  useDrawingStore.getState().undo()
  expect(useDrawingStore.getState().nodes[0].data.asset?.id).toBe(targetId)
  await flushLocalEditors(identity)
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
  expect((await readCanvasAssets(813, canvas.id))[0].role).toBe('generated')
})

it('acknowledges a lost successful response with server key ordering without a false conflict', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  const transport = api.defaults.adapter as (
    config: InternalAxiosRequestConfig
  ) => Promise<unknown>
  let lost = true
  api.defaults.adapter = async (config) => {
    const result = await transport(config)
    if (config.method === 'post' && lost) {
      lost = false
      throw new Error('connection lost after publication')
    }
    return result as ReturnType<typeof response>
  }
  await syncCanvas(identity, canvas.id, 'manual')
  expect((await loadLocalCanvas(813, canvas.id))?.status).toBe('error')
  required(remote).document = JSON.parse(
    JSON.stringify(required(remote).document, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          )
        : value
    )
  )
  await syncCanvas(identity, canvas.id, 'manual')
  expect((await loadLocalCanvas(813, canvas.id))?.status).toBe('synced')
  expect(posts()).toHaveLength(1)
})

it('uploads only referenced masks and retires old local masks only after successful latest publication', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  addOriginal()
  const source = required(useDrawingStore.getState().nodes[0].data.asset)
  useDrawingStore.getState().setReferences([`node-${sourceId}`])
  useDrawingStore.getState().setMask({
    referenceId: `node-${sourceId}`,
    asset: { ...source, id: targetId },
  })
  await flushLocalEditors(identity)
  await syncCanvas(identity, canvas.id, 'manual')
  const newMask = '33333333-3333-4333-8333-333333333333'
  useDrawingStore.getState().setMask({
    referenceId: `node-${sourceId}`,
    asset: { ...source, id: newMask },
  })
  useDrawingStore.setState({ past: [], future: [] })
  await flushLocalEditors(identity)
  expect(
    (await readCanvasAssets(813, canvas.id)).map((asset) => asset.id)
  ).toContain(targetId)
  const transport = api.defaults.adapter as (
    config: InternalAxiosRequestConfig
  ) => Promise<ReturnType<typeof response>>
  let fail = true
  api.defaults.adapter = async (config) => {
    if (config.method === 'post' && fail) throw new Error('offline')
    return transport(config)
  }
  await syncCanvas(identity, canvas.id, 'manual')
  expect(
    (await readCanvasAssets(813, canvas.id)).map((asset) => asset.id)
  ).toContain(targetId)
  fail = false
  await syncCanvas(identity, canvas.id, 'manual')
  const form = required(posts().at(-1)).data as FormData
  expect([...form.keys()]).toEqual(['metadata', `file:${newMask}`])
  expect(
    (await readCanvasAssets(813, canvas.id)).map((asset) => asset.id).sort()
  ).toEqual([sourceId, newMask].sort())
})

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

import { act, renderHook } from '@testing-library/react'
import {
  AxiosError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logout } from '@/features/auth/api'
import { useImageGeneration } from '@/features/playground/drawing/hooks/use-image-generation'
import * as legacyDrawing from '@/features/playground/drawing/lib/canvas-storage'
import { DEFAULT_IMAGE_SETTINGS } from '@/features/playground/drawing/lib/image-settings'
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
  reloadCanvasProject,
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
  reconcileCanvasRecord,
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
      // The server keeps a canvas as it normalizes it, which leaves out what it
      // does not know. The Grok switch stands in for such a field.
      const settingsOf = (value: unknown) =>
        (value as { settings?: Record<string, unknown> }).settings
      for (const holder of [
        meta.document,
        ...((meta.document.nodes as { data: unknown }[]) ?? []).map(
          (node) => node.data
        ),
      ]) {
        delete settingsOf(holder)?.nsfw
      }
      // A save names the revision it succeeds; any other is refused.
      if (
        remote &&
        remote.state === 'ready' &&
        meta.base_revision !== remote.revision
      ) {
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
    // The cloud holds every original a canvas uploaded, which is this image.
    if (config.url?.endsWith('/file')) {
      return {
        ...response(config, {}),
        data: new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
          type: 'image/png',
        }),
      }
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

it('writes nothing to this browser for an editor change that leaves the saved canvas as it was', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  useDrawingStore.getState().addNodes([
    {
      id: 'node-pending',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        prompt: '狐狸',
        settings: useDrawingStore.getState().settings,
        status: 'pending',
        createdAt: 1,
      },
    },
  ])
  await flushLocalEditors(identity)
  const saved = required(await loadLocalCanvas(813, canvas.id))

  // A generation's progress shows on its node but is never stored.
  useDrawingStore.getState().updateNodeData('node-pending', {
    progress: { startedAt: 1, phase: 'decoding', previewCount: 0 },
  })
  await flushLocalEditors(identity)

  expect(required(await loadLocalCanvas(813, canvas.id)).revision).toBe(
    saved.revision
  )
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
})

it('remembers a moved view once it settles, without saving it as a change', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  useDrawingStore.getState().updateSettings({ prompt: '第一次编辑' })
  await flushLocalEditors(identity)
  const saved = required(await loadLocalCanvas(813, canvas.id))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  useDrawingStore.getState().setViewport({ x: 120, y: 80, zoom: 2 })
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
  await vi.advanceTimersByTimeAsync(2000)

  await vi.waitFor(async () =>
    expect(
      required(await loadLocalCanvas(813, canvas.id)).document.viewport
    ).toEqual({ x: 120, y: 80, zoom: 2 })
  )
  const current = required(await loadLocalCanvas(813, canvas.id))
  expect(current).toMatchObject({
    revision: saved.revision,
    localSavedAt: saved.localSavedAt,
    status: saved.status,
    cloudSavedRevision: saved.cloudSavedRevision,
  })
  expect(getCanvasEditorState('drawing')?.localStatus).toBe('saved')
})

it('remembers where the view stands once the page is left, without a new revision', async () => {
  const canvas = await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  useDrawingStore.getState().updateSettings({ prompt: '第一次编辑' })
  await flushLocalEditors(identity)
  const saved = required(await loadLocalCanvas(813, canvas.id))

  useDrawingStore.getState().setViewport({ x: 120, y: 80, zoom: 2 })
  window.dispatchEvent(new Event('pagehide'))
  await flushLocalEditors(identity)

  const current = required(await loadLocalCanvas(813, canvas.id))
  expect(current.document.viewport).toEqual({ x: 120, y: 80, zoom: 2 })
  expect(current.revision).toBe(saved.revision)
})

it('keeps the undo history when coming back to a canvas whose view it remembered', async () => {
  await createCanvasProject(identity, 'drawing')
  await startCanvasEditor(identity, 'drawing')
  useDrawingStore.getState().checkpoint()
  useDrawingStore.getState().updateSettings({ prompt: '第一次编辑' })
  await flushLocalEditors(identity)

  useDrawingStore.getState().setViewport({ x: 120, y: 80, zoom: 2 })
  window.dispatchEvent(new Event('pagehide'))
  await flushLocalEditors(identity)
  window.dispatchEvent(new Event('focus'))
  await flushLocalEditors(identity)

  expect(useDrawingStore.getState().past).toHaveLength(1)
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

it.each([
  [
    'the tab is hidden',
    () => {
      const hidden = vi
        .spyOn(document, 'visibilityState', 'get')
        .mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      hidden.mockRestore()
    },
  ],
  ['the page is left', () => window.dispatchEvent(new Event('pagehide'))],
])(
  'saves locally at once when %s but uploads to the cloud at most once per five minutes',
  async (_, leave) => {
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    useDrawingStore.getState().updateSettings({ prompt: '第一次编辑' })
    await flushLocalEditors(identity)
    await syncCanvas(identity, canvas.id, 'manual')
    expect(posts()).toHaveLength(1)

    useDrawingStore.getState().updateSettings({ prompt: '离开前的编辑' })
    leave()
    await flushLocalEditors(identity)
    await syncCanvas(identity, canvas.id, 'timer')

    expect(
      required(await loadLocalCanvas(813, canvas.id)).document.settings
    ).toMatchObject({ prompt: '离开前的编辑' })
    expect(posts()).toHaveLength(1)
  }
)

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

// What this browser stored before it kept the cloud version its edits start
// from: nothing tells which side changed what.
async function forgetCommonVersion(id: string) {
  const done = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () => reject(request.error))
    })
  const database = await done(indexedDB.open('new-api-gallery-canvases', 1))
  const store = database
    .transaction('canvases', 'readwrite')
    .objectStore('canvases')
  const canvas = (await done(store.get([813, id]))) as Record<string, unknown>
  delete canvas.cloudBase
  await done(store.put(canvas, [813, id]))
  database.close()
}

it('retains a conflicting local document it cannot merge and never overwrites the server', async () => {
  let canvas = await createCanvasProject(identity, 'drawing')
  await syncCanvas(identity, canvas.id, 'manual')
  canvas = required(await loadLocalCanvas(813, canvas.id))
  await saveLocalCanvas({ ...canvas, name: '保留本地名字' }, [])
  await forgetCommonVersion(canvas.id)
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
  // A real conflict is a document that diverged, not just a renamed one, on a
  // canvas that cannot tell what both versions came from.
  await saveLocalCanvas(
    {
      ...canvas,
      name: '保留本地名字',
      document: { ...canvas.document, settings: { prompt: '本地修改' } },
    },
    []
  )
  await forgetCommonVersion(canvas.id)
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

describe('a canvas another device saves too', () => {
  type StoredNode = {
    id: string
    position: unknown
    data: Record<string, unknown>
  } & Record<string, unknown>
  // Another device's save reaches the cloud and nothing else here.
  const saveOnAnotherDevice = (
    change: (document: Record<string, unknown>) => Record<string, unknown>
  ) => {
    const current = required(remote)
    remote = {
      ...current,
      revision: current.revision + 1,
      document: change(required(current.document)),
    }
  }
  const syncedCanvas = async () => {
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    addOriginal()
    await flushLocalEditors(identity)
    await syncCanvas(identity, canvas.id, 'manual')
    return canvas
  }
  // Another device adds a picture this browser does not hold yet.
  const addPictureOnAnotherDevice = async (nodeId: string, assetId: string) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    saveOnAnotherDevice((document) => ({
      ...document,
      nodes: [
        ...(document.nodes as StoredNode[]),
        {
          id: nodeId,
          type: 'image',
          position: { x: 300, y: 0 },
          data: {
            prompt: '',
            settings: {},
            status: 'complete',
            createdAt: 7,
            asset: {
              id: assetId,
              name: 'there.png',
              width: 1,
              height: 1,
              mimeType: 'image/png',
            },
          },
        },
      ],
    }))
    const current = required(remote)
    remote = {
      ...current,
      assets: [
        ...current.assets,
        {
          id: assetId,
          role: 'generated',
          node_id: nodeId,
          sha256,
          bytes: bytes.length,
          width: 1,
          height: 1,
          mime_type: 'image/png',
          has_thumbnail: false,
        },
      ],
    }
  }

  // A generation started there reaches this canvas still generating, with the
  // task to watch, instead of this canvas holding on to what it had.
  it('takes the version another device saved when nothing changed here since', async () => {
    const canvas = await syncedCanvas()
    saveOnAnotherDevice((document) => ({
      ...document,
      nodes: [
        ...(document.nodes as StoredNode[]),
        {
          id: 'generating-there',
          type: 'image',
          position: { x: 0, y: 400 },
          data: {
            prompt: '另一台设备在生成',
            settings: {},
            status: 'pending',
            taskId: 'task_there',
            createdAt: 5,
          },
        },
      ],
    }))

    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() =>
      expect(
        useDrawingStore
          .getState()
          .nodes.find((node) => node.id === 'generating-there')?.data
      ).toMatchObject({ status: 'pending', taskId: 'task_there' })
    )
    expect(required(await loadLocalCanvas(813, canvas.id))).toMatchObject({
      cloudRevision: 2,
      status: 'synced',
    })
    expect(posts()).toHaveLength(1)
  })

  // A slow look at the cloud can come back after this copy already moved on.
  it('keeps its copy when the cloud answers with a version older than the one it follows', async () => {
    const canvas = await syncedCanvas()
    const older = required(remote)
    useDrawingStore.getState().updateSettings({ prompt: '更新的版本' })
    await flushLocalEditors(identity)
    await syncCanvas(identity, canvas.id, 'manual')

    await reconcileCanvasRecord(
      identity,
      required(await loadLocalCanvas(813, canvas.id)),
      older
    )

    expect(required(await loadLocalCanvas(813, canvas.id))).toMatchObject({
      cloudRevision: 2,
      status: 'synced',
      document: { settings: { prompt: '更新的版本' } },
    })
  })

  // Downloading what another device added takes as long as its pictures do.
  it('keeps saving edits made here while it downloads a picture another device added', async () => {
    const canvas = await syncedCanvas()
    await addPictureOnAnotherDevice('added-there', targetId)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let asked = false
    const cloud = required(api.defaults.adapter) as AxiosAdapter
    api.defaults.adapter = async (config) => {
      if (config.url?.endsWith(`/${targetId}/file`)) {
        asked = true
        await held
      }
      return cloud(config)
    }

    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(asked).toBe(true))
    useDrawingStore.getState().updateSettings({ prompt: '下载时的修改' })
    await flushLocalEditors(identity)

    expect(
      required(await loadLocalCanvas(813, canvas.id)).document.settings
    ).toMatchObject({ prompt: '下载时的修改' })
    release()
    await vi.waitFor(() =>
      expect(useDrawingStore.getState().nodes.map((node) => node.id)).toContain(
        'added-there'
      )
    )
  })

  // This canvas can take in another device's version while it generates an
  // image itself, even before the gateway has named the task.
  it("keeps watching a generation of its own when it takes another device's version", async () => {
    const canvas = await syncedCanvas()
    const state = useDrawingStore.getState()
    state.addNodes([
      {
        id: 'generating-here',
        type: 'image',
        position: { x: 0, y: 400 },
        data: {
          settings: state.settings,
          prompt: '这里在生成',
          status: 'pending',
          createdAt: 3,
          jobId: 'job-here',
        },
      },
    ])
    await flushLocalEditors(identity)
    await syncCanvas(identity, canvas.id, 'manual')
    saveOnAnotherDevice((document) => ({
      ...document,
      settings: {
        ...(document.settings as object),
        prompt: '另一台设备的提示词',
      },
    }))

    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() =>
      expect(useDrawingStore.getState().settings.prompt).toBe(
        '另一台设备的提示词'
      )
    )
    expect(
      useDrawingStore
        .getState()
        .nodes.find((node) => node.id === 'generating-here')?.data
    ).toMatchObject({ status: 'pending', jobId: 'job-here' })
  })

  // The canvas can be closed here while another device's version arrives.
  it("keeps where this device's view stands when it takes another device's version", async () => {
    const canvas = await syncedCanvas()
    useDrawingStore.getState().setViewport({ x: 120, y: 80, zoom: 2 })
    await flushLocalEditors(identity)
    stopCanvasEditors(identity)
    saveOnAnotherDevice((document) => ({
      ...document,
      viewport: { x: -500, y: -300, zoom: 0.5 },
      settings: {
        ...(document.settings as object),
        prompt: '另一台设备的提示词',
      },
    }))

    await syncCanvas(identity, canvas.id, 'manual')

    const stored = required(await loadLocalCanvas(813, canvas.id))
    expect(stored.document.settings).toMatchObject({
      prompt: '另一台设备的提示词',
    })
    expect(stored.document.viewport).toEqual({ x: 120, y: 80, zoom: 2 })
  })

  // Another device can save between this upload's look at the cloud and the
  // upload itself. What it saved is merged in, and the merge goes up at once.
  it('uploads the merge at once when another device saved just before this upload', async () => {
    const canvas = await syncedCanvas()
    useDrawingStore.getState().updateSettings({ prompt: '这边的修改' })
    await flushLocalEditors(identity)
    let first = true
    const cloud = required(api.defaults.adapter) as AxiosAdapter
    api.defaults.adapter = async (config) => {
      if (config.method === 'post' && first) {
        first = false
        saveOnAnotherDevice((document) => ({
          ...document,
          nodes: [
            ...(document.nodes as StoredNode[]),
            {
              id: 'generating-there',
              type: 'image',
              position: { x: 0, y: 400 },
              data: {
                prompt: '另一台设备在生成',
                settings: {},
                status: 'pending',
                taskId: 'task_there',
                createdAt: 5,
              },
            },
          ],
        }))
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
      return cloud(config)
    }

    await syncCanvas(identity, canvas.id, 'manual')

    await vi.waitFor(() => expect(required(remote).revision).toBe(3))
    const saved = required(required(remote).document)
    expect(saved.settings).toMatchObject({ prompt: '这边的修改' })
    expect((saved.nodes as StoredNode[]).map((node) => node.id)).toContain(
      'generating-there'
    )
    expect(required(await loadLocalCanvas(813, canvas.id)).status).toBe(
      'synced'
    )
  })

  // A picture download can fail on a flaky connection. The canvas stays one a
  // later sync merges, not a conflict for its owner to resolve.
  it('tries the merge again later when a picture another device added fails to download', async () => {
    const canvas = await syncedCanvas()
    useDrawingStore.getState().updateSettings({ prompt: '这边的修改' })
    await flushLocalEditors(identity)
    let online = false
    let first = true
    const cloud = required(api.defaults.adapter) as AxiosAdapter
    api.defaults.adapter = async (config) => {
      if (config.url?.endsWith(`/${targetId}/file`) && !online) {
        throw new AxiosError('offline', AxiosError.ERR_NETWORK, config)
      }
      if (config.method === 'post' && first) {
        first = false
        await addPictureOnAnotherDevice('added-there', targetId)
      }
      return cloud(config)
    }

    await syncCanvas(identity, canvas.id, 'manual')
    expect(required(await loadLocalCanvas(813, canvas.id)).status).toBe('error')
    online = true
    await syncCanvas(identity, canvas.id, 'manual')

    expect(required(await loadLocalCanvas(813, canvas.id)).status).toBe(
      'synced'
    )
    const saved = required(required(remote).document)
    expect(saved.settings).toMatchObject({ prompt: '这边的修改' })
    expect((saved.nodes as StoredNode[]).map((node) => node.id)).toContain(
      'added-there'
    )
  })

  // Without the version both sides started from there is nothing to merge, so
  // the pictures the other side added are not worth fetching.
  it('downloads nothing for a canvas it cannot merge', async () => {
    const canvas = await syncedCanvas()
    useDrawingStore.getState().updateSettings({ prompt: '这边的修改' })
    await flushLocalEditors(identity)
    await forgetCommonVersion(canvas.id)
    await addPictureOnAnotherDevice('added-there', targetId)

    await syncCanvas(identity, canvas.id, 'manual')

    expect(required(await loadLocalCanvas(813, canvas.id)).status).toBe(
      'conflict'
    )
    expect(requests.some((request) => request.url?.endsWith('/file'))).toBe(
      false
    )
  })

  // Each device keeps its own view of a canvas, which is no edit to it.
  it('agrees with another device that saved the same canvas from another view', async () => {
    const canvas = await syncedCanvas()
    useDrawingStore.getState().updateSettings({ prompt: '两台设备一样的修改' })
    await flushLocalEditors(identity)
    const stored = required(await loadLocalCanvas(813, canvas.id))
    saveOnAnotherDevice(() => ({
      ...stored.document,
      viewport: { x: 300, y: 200, zoom: 2 },
    }))

    await syncCanvas(identity, canvas.id, 'manual')

    expect(required(await loadLocalCanvas(813, canvas.id))).toMatchObject({
      cloudRevision: 2,
      status: 'synced',
    })
    expect(posts()).toHaveLength(1)
  })

  it('merges an edit made here with one another device saved meanwhile', async () => {
    const canvas = await syncedCanvas()
    saveOnAnotherDevice((document) => ({
      ...document,
      settings: {
        ...(document.settings as object),
        prompt: '另一台设备的提示词',
      },
    }))
    useDrawingStore.getState().changeNodes([
      {
        id: `node-${sourceId}`,
        type: 'position',
        position: { x: 50, y: 60 },
      },
    ])
    await flushLocalEditors(identity)

    await syncCanvas(identity, canvas.id, 'manual')

    const saved = required(required(remote).document)
    expect(required(remote).revision).toBe(3)
    expect(saved.settings).toMatchObject({
      prompt: '另一台设备的提示词',
    })
    expect((saved.nodes as StoredNode[])[0].position).toEqual({
      x: 50,
      y: 60,
    })
    expect(required(await loadLocalCanvas(813, canvas.id)).status).toBe(
      'synced'
    )
    await vi.waitFor(() =>
      expect(useDrawingStore.getState().settings.prompt).toBe(
        '另一台设备的提示词'
      )
    )
  })

  // Reloading takes the cloud version as the one later edits start from, so
  // they merge with what another device saves next.
  it('merges edits on a canvas reloaded from the cloud with the next version another device saves', async () => {
    const canvas = await syncedCanvas()
    saveOnAnotherDevice((document) => ({
      ...document,
      settings: { ...(document.settings as object), prompt: '第一次' },
    }))
    await reloadCanvasProject(identity, canvas.id)
    saveOnAnotherDevice((document) => ({
      ...document,
      settings: { ...(document.settings as object), prompt: '第二次' },
    }))
    useDrawingStore.getState().changeNodes([
      {
        id: `node-${sourceId}`,
        type: 'position',
        position: { x: 70, y: 80 },
      },
    ])
    await flushLocalEditors(identity)

    await syncCanvas(identity, canvas.id, 'manual')

    const saved = required(required(remote).document)
    expect(saved.settings).toMatchObject({ prompt: '第二次' })
    expect((saved.nodes as StoredNode[])[0].position).toEqual({
      x: 70,
      y: 80,
    })
    expect(required(await loadLocalCanvas(813, canvas.id)).status).toBe(
      'synced'
    )
  })

  // Another device waits on the cloud copy for a generation started here: first
  // to learn which task to watch, then for the picture.
  it('uploads a canvas once its generation task is accepted and again once the picture arrives', async () => {
    vi.stubGlobal(
      'Image',
      class extends EventTarget {
        naturalWidth = 1
        naturalHeight = 1
        set src(_value: string) {
          queueMicrotask(() => this.dispatchEvent(new Event('load')))
        }
      }
    )
    const canvas = await createCanvasProject(identity, 'drawing')
    await startCanvasEditor(identity, 'drawing')
    useDrawingStore.getState().updateSettings({ prompt: '已经在云端' })
    await flushLocalEditors(identity)
    await syncCanvas(identity, canvas.id, 'manual')
    const taskId = `task_${'a'.repeat(32)}`
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const cloud = required(api.defaults.adapter) as AxiosAdapter
    api.defaults.adapter = async (config) => {
      if (config.url === `/pg/images/generations/${taskId}`) {
        await finished
        // The task endpoint answers as the image API does, without the envelope.
        return {
          ...response(config, {}),
          data: {
            task_id: taskId,
            status: 'completed',
            data: [{ b64_json: png, gallery_image_id: targetId }],
          },
        }
      }
      return cloud(config)
    }
    vi.spyOn(api, 'post').mockResolvedValue({
      headers: { 'content-type': 'application/json' },
      data: new Response(JSON.stringify({ task_id: taskId, status: 'queued' }))
        .body,
    })
    const uploadedNode = () => {
      const upload = posts().at(-1)
      if (!upload || posts().length < 2) return undefined
      const metadata = JSON.parse(
        String((upload.data as FormData).get('metadata'))
      ) as CanvasSaveMetadata
      return (metadata.document.nodes as StoredNode[]).at(-1)
    }
    const hook = renderHook(useImageGeneration)

    act(() => {
      hook.result.current.generate(
        { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: 'A fox' },
        { x: 0, y: 0 }
      )
    })

    await vi.waitFor(() =>
      expect(uploadedNode()?.data).toMatchObject({ status: 'pending', taskId })
    )
    act(() => finish())
    await vi.waitFor(() =>
      expect(uploadedNode()?.data).toMatchObject({
        status: 'complete',
        asset: { id: targetId },
      })
    )
    expect(required(await loadLocalCanvas(813, canvas.id)).status).toBe(
      'synced'
    )
    hook.unmount()
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

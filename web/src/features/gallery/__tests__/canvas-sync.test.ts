import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'

import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { logout } from '@/features/auth/api'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { deleteCanvasResource } from '../lib/canvas-deletion'
import {
  flushLocalEditors,
  stopCanvasEditors,
  getCanvasEditorState,
} from '../lib/canvas-editor'
import {
  createCanvasProject,
  startCanvasEditor,
  openCanvasProject,
} from '../lib/canvas-projects'
import {
  loadLocalCanvas,
  readCanvasUserState,
  updateCanvasUserState,
  saveLocalCanvas,
  readCanvasAssets,
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

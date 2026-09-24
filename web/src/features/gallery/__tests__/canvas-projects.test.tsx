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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReactFlowProvider } from '@xyflow/react'
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasFiles } from '@/features/playground/drawing/hooks/use-canvas-files'
import { DEFAULT_IMAGE_SETTINGS } from '@/features/playground/drawing/lib/image-settings'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { CanvasEditorHeader } from '../components/canvas-editor-header'
import {
  CanvasNodeDeletionContext,
  useCanvasNodeDeletion,
} from '../components/canvas-node-deletion'
import { CanvasSaveStatus } from '../components/canvas-save-status'
import { Gallery } from '../index'
import { deleteCanvasResource } from '../lib/canvas-deletion'
import { flushLocalEditors, stopCanvasEditors } from '../lib/canvas-editor'
import {
  createCanvasProject,
  exportCanvasProject,
  exportStoredCanvas,
  LEGACY_NAI_CANVAS_UNCONVERTIBLE,
  openCanvasProject,
  reloadCanvasProject,
  startCanvasEditor,
} from '../lib/canvas-projects'
import * as canvasRepository from '../lib/canvas-repository'
import {
  loadLocalCanvas,
  readCanvasAssets,
  updateCanvasUserState,
  updateCanvasCloudState,
} from '../lib/canvas-repository'
import { cancelCanvasSession, syncCanvas } from '../lib/canvas-sync'
import {
  galleryAssetFingerprint,
  writeGalleryThumbnail,
} from '../lib/gallery-thumbnail-cache'
import type { CanvasKind, CanvasRecord, GalleryImage } from '../types'
import { galleryImage, login, response, usage, required } from './fixtures'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
  Link: ({
    children,
    to,
    ...props
  }: React.ComponentProps<'a'> & { to?: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
const identity = { userId: 813, sessionId: 'gallery-session' }
const adapter = api.defaults.adapter
let client: QueryClient
let remoteImages: GalleryImage[]
let fileReads: string[]
let fileParams: unknown[]
let usageReads: number
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:local-original')
      static revokeObjectURL = vi.fn()
    }
  )
  login()
  navigate.mockReset()
  remoteImages = []
  fileReads = []
  fileParams = []
  usageReads = 0
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/usage')) {
      usageReads++
      return response(config, usage)
    }
    if (config.url?.endsWith('/images')) {
      return response(config, {
        items: remoteImages,
        page: 1,
        page_size: 24,
        total: remoteImages.length,
      })
    }
    if (config.url?.endsWith('/canvases')) {
      return response(config, { items: [], page: 1, page_size: 24, total: 0 })
    }
    if (config.url?.endsWith('/file')) {
      fileReads.push(config.url)
      fileParams.push(config.params)
      return {
        ...response(config, {}),
        data: new Blob(['remote'], { type: 'image/png' }),
      }
    }
    throw new AxiosError(
      'not found',
      '',
      config,
      {},
      { ...response(config, {}), status: 404 }
    )
  }
})
afterEach(() => {
  stopCanvasEditors(identity)
  cancelCanvasSession(identity)
  useAuthStore.getState().auth.reset()
  client.clear()
  api.defaults.adapter = adapter
  vi.unstubAllGlobals()
})
const renderGallery = (view?: 'images' | 'canvases') =>
  render(
    <QueryClientProvider client={client}>
      <Gallery initialView={view} />
    </QueryClientProvider>
  )
const assetId = '11111111-1111-4111-8111-111111111111'

// A canvas that holds something without holding a picture, for the tests whose
// subject is the listing around it rather than what is on it. A `nai` canvas
// is one the former NAI page saved.
async function drawnCanvas(kind: CanvasKind, name: string) {
  const canvas = await createCanvasProject(identity, 'drawing', name)
  const node = {
    id: 'sketch',
    position: { x: 0, y: 0 },
    data: { prompt: name, status: 'error', createdAt: 1 },
  }
  return canvasRepository.saveLocalCanvas(
    {
      ...canvas,
      kind,
      document:
        kind === 'drawing'
          ? {
              ...canvas.document,
              nodes: [
                {
                  ...node,
                  type: 'image',
                  data: { ...node.data, settings: DEFAULT_IMAGE_SETTINGS },
                },
              ],
            }
          : {
              version: 1,
              viewport: { x: 0, y: 0, zoom: 1 },
              settings: { model: 'nai-diffusion-4-5-full' },
              nodes: [
                {
                  ...node,
                  type: 'nai-image',
                  data: {
                    ...node.data,
                    settings: { model: 'nai-diffusion-4-5-full' },
                  },
                },
              ],
            },
    },
    []
  )
}

async function localImage() {
  const canvas = await createCanvasProject(identity, 'drawing', '本地画布')
  await startCanvasEditor(identity, 'drawing')
  const state = useDrawingStore.getState()
  state.addNodes([
    {
      id: 'precise-node',
      type: 'image',
      position: { x: 1200, y: 1800 },
      data: {
        prompt: '本地狐狸',
        settings: state.settings,
        status: 'complete',
        createdAt: Date.now(),
        asset: {
          id: assetId,
          name: 'fox.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKn0AAAAASUVORK5CYII=',
        },
      },
    },
  ])
  useDrawingStore.setState({
    assetRoles: { [assetId]: { role: 'generated', nodeId: 'precise-node' } },
  })
  await flushLocalEditors(identity)
  return canvas
}

it('deduplicates linked images, previews the local original and navigates with the exact asset ID', async () => {
  const canvas = await localImage()
  remoteImages = [
    {
      ...galleryImage,
      id: assetId,
      canvas_id: canvas.id,
      node_id: 'precise-node',
    } as typeof galleryImage,
  ]
  renderGallery()
  const preview = await screen.findByRole('button', {
    name: 'Preview original',
  })
  expect(
    screen.getAllByRole('button', { name: 'Preview original' })
  ).toHaveLength(1)
  await userEvent.click(preview)
  expect(
    await within(screen.getByRole('dialog')).findByRole('img')
  ).toHaveAttribute('src', 'blob:local-original')
  expect(fileReads).toEqual([])
  await userEvent.keyboard('{Escape}')
  await userEvent.click(
    screen.getByRole('button', { name: 'Open source canvas' })
  )
  // Opening happens on the canvas, which is what selects the node; the gallery's
  // job is to get there carrying the exact picture that was asked for.
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/canvas/drawing',
      search: { canvas: canvas.id, image: assetId },
    })
  )
})

const canvasId = '22222222-2222-4222-8222-222222222222'
const remoteAssetId = '33333333-3333-4333-8333-333333333333'

function remoteDrawingCanvas(settings: unknown): CanvasRecord {
  return {
    id: canvasId,
    kind: 'drawing',
    name: '远程缩略图画布',
    revision: 3,
    state: 'ready',
    updated_at: 100,
    expires_at: 200,
    document: {
      version: 1,
      nodes: [
        {
          id: 'remote-node',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            prompt: '远程图片',
            settings,
            status: 'complete',
            createdAt: 100,
            asset: {
              id: remoteAssetId,
              name: 'remote.png',
              width: 1,
              height: 1,
              mimeType: 'image/png',
            },
          },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings,
      referenceIds: [],
      mask: null,
    },
    removed_asset_ids: [],
    assets: [
      {
        id: remoteAssetId,
        role: 'generated',
        node_id: 'remote-node',
        sha256: 'remote-original-sha',
        bytes: 12,
        width: 1,
        height: 1,
        mime_type: 'image/png',
        has_thumbnail: true,
      },
    ],
    asset_id_map: {},
  }
}

function serveRemoteDrawingCanvas(remote: CanvasRecord) {
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith(`/canvases/${canvasId}`)) {
      return response(config, remote)
    }
    if (config.url?.endsWith('/file')) {
      fileParams.push(config.params)
      const thumbnail = (config.params as { thumbnail?: boolean } | undefined)
        ?.thumbnail
      return {
        ...response(config, {}),
        data: new Blob([thumbnail ? 'thumbnail' : 'original'], {
          type: thumbnail ? 'image/jpeg' : 'image/png',
        }),
      }
    }
    throw new AxiosError(
      'not found',
      '',
      config,
      {},
      { ...response(config, {}), status: 404 }
    )
  }
}

it('opens a remote canvas from thumbnails and reads originals only when exporting', async () => {
  await startCanvasEditor(identity, 'drawing')
  serveRemoteDrawingCanvas(
    remoteDrawingCanvas(useDrawingStore.getState().settings)
  )

  await openCanvasProject(identity, canvasId, undefined, 'drawing')
  expect(fileParams).toEqual([{ thumbnail: true }])
  expect((await readCanvasAssets(813, canvasId))[0]?.previewOnly).toBe(true)

  await exportCanvasProject(identity, 'drawing')
  expect(fileParams).toEqual([{ thumbnail: true }, undefined])
})

// Base64 is only worth its cost when the document has to outlive the tab, as an
// export does. Encoding every picture on the way into the editor is what made a
// canvas sit on "loading" after its images had already arrived.
it('shows an opened canvas from object URLs and exports it as portable data', async () => {
  await startCanvasEditor(identity, 'drawing')
  serveRemoteDrawingCanvas(
    remoteDrawingCanvas(useDrawingStore.getState().settings)
  )

  await openCanvasProject(identity, canvasId, undefined, 'drawing')
  expect(useDrawingStore.getState().nodes[0]?.data.asset?.src).toBe(
    'blob:local-original'
  )

  const exported = await exportCanvasProject(identity, 'drawing')
  expect(await exported.text()).toContain('data:image/png;base64')
})

it('releases an opened canvas from memory once its editor stops', async () => {
  await startCanvasEditor(identity, 'drawing')
  serveRemoteDrawingCanvas(
    remoteDrawingCanvas(useDrawingStore.getState().settings)
  )
  await openCanvasProject(identity, canvasId, undefined, 'drawing')
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()

  stopCanvasEditors(identity)

  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-original')
})

// The images tab and a canvas show the same pictures. Downloading them again on
// the way into a canvas is what made opening one feel slow even though the grid
// had already fetched every thumbnail.
it('opens a remote canvas from thumbnails the images tab already cached', async () => {
  await startCanvasEditor(identity, 'drawing')
  serveRemoteDrawingCanvas(
    remoteDrawingCanvas(useDrawingStore.getState().settings)
  )
  await writeGalleryThumbnail(
    813,
    remoteAssetId,
    galleryAssetFingerprint(remoteAssetId),
    new Blob(['cached'], { type: 'image/jpeg' })
  )

  await openCanvasProject(identity, canvasId, undefined, 'drawing')

  expect(fileParams).toEqual([])
  expect((await readCanvasAssets(813, canvasId))[0]?.blob.size).toBe(6)
})

// The NAI page merged into the drawing page. Its canvases open there as drawing
// canvases prompted with tags, and are kept as drawing canvases from then on.
it('opens a canvas the NAI page saved as a drawing canvas and keeps it one', async () => {
  const legacy = await drawnCanvas('nai', 'NAI 画布')
  await startCanvasEditor(identity, 'drawing')

  await openCanvasProject(identity, legacy.id, undefined, 'drawing')

  expect(useDrawingStore.getState().nodes[0]).toMatchObject({
    type: 'image',
    data: {
      prompt: 'NAI 画布',
      status: 'error',
      settings: { generationMode: 'tags', model: 'nai-diffusion-4-5-full' },
    },
  })
  const stored = await loadLocalCanvas(813, legacy.id)
  expect(stored).toMatchObject({
    kind: 'drawing',
    revision: legacy.revision + 1,
  })
  expect(stored?.document.nodes).toMatchObject([{ type: 'image' }])
})

it('uploads a cloud NAI canvas as a drawing canvas after its first open', async () => {
  const remote = remoteDrawingCanvas(useDrawingStore.getState().settings)
  const node = (remote.document as { nodes: Record<string, unknown>[] }).nodes
  const legacy: CanvasRecord = {
    ...remote,
    kind: 'nai',
    document: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { model: 'nai-diffusion-4-5-full', negativePrompt: 'blur' },
      nodes: [
        {
          ...node[0],
          type: 'nai-image',
          data: {
            ...(node[0].data as Record<string, unknown>),
            settings: {
              model: 'nai-diffusion-4-5-full',
              negativePrompt: 'blur',
            },
          },
        },
      ],
    },
  }
  serveRemoteDrawingCanvas(legacy)
  const serve = api.defaults.adapter as (
    config: InternalAxiosRequestConfig
  ) => Promise<AxiosResponse>
  const uploads: Record<string, unknown>[] = []
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/usage')) return response(config, usage)
    if (config.method === 'post' && config.url?.endsWith('/canvases')) {
      const metadata = JSON.parse(
        String((config.data as FormData).get('metadata'))
      )
      uploads.push(metadata)
      return response(config, {
        ...legacy,
        kind: 'drawing',
        revision: legacy.revision + 1,
        document: metadata.document,
      })
    }
    return serve(config)
  }
  await startCanvasEditor(identity, 'drawing')

  await openCanvasProject(identity, canvasId, undefined, 'drawing')

  expect(useDrawingStore.getState().nodes[0]?.data.settings).toMatchObject({
    generationMode: 'tags',
    negativePrompt: 'blur',
  })
  expect(await loadLocalCanvas(813, canvasId)).toMatchObject({
    kind: 'drawing',
    status: 'pending',
    cloudRevision: legacy.revision,
  })
  await syncCanvas(identity, canvasId, 'manual')
  expect(uploads).toMatchObject([
    { kind: 'drawing', base_revision: legacy.revision },
  ])
})

it('reloads the cloud copy of a NAI canvas over its upgraded local copy', async () => {
  const remote = remoteDrawingCanvas(useDrawingStore.getState().settings)
  const [node] = (remote.document as { nodes: Record<string, unknown>[] }).nodes
  const legacy = (prompt: string): CanvasRecord => ({
    ...remote,
    kind: 'nai',
    document: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { model: 'nai-diffusion-4-5-full' },
      nodes: [
        {
          ...node,
          type: 'nai-image',
          data: {
            ...(node.data as Record<string, unknown>),
            prompt,
            settings: { model: 'nai-diffusion-4-5-full' },
          },
        },
      ],
    },
  })
  serveRemoteDrawingCanvas(legacy('本地打开时'))
  await startCanvasEditor(identity, 'drawing')
  await openCanvasProject(identity, canvasId, undefined, 'drawing')
  await updateCanvasCloudState(813, canvasId, (current) => ({
    ...current,
    status: 'conflict',
  }))
  serveRemoteDrawingCanvas(legacy('云端版本'))

  await reloadCanvasProject(identity, canvasId)

  expect(useDrawingStore.getState().nodes[0]?.data.prompt).toBe('云端版本')
  expect((await loadLocalCanvas(813, canvasId))?.kind).toBe('drawing')
})

it('leaves a NAI canvas it cannot convert untouched and exports it as stored', async () => {
  const original = Uint8Array.from(atob('YWJj'), (char) => char.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', original)
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  const legacy = await drawnCanvas('nai', 'NAI 画布')
  const withImage = await canvasRepository.saveLocalCanvas(
    {
      ...legacy,
      document: {
        ...legacy.document,
        nodes: [
          {
            id: 'sketch',
            type: 'nai-image',
            position: { x: 0, y: 0 },
            data: {
              prompt: 'NAI 画布',
              settings: { model: 'nai-diffusion-4-5-full' },
              status: 'complete',
              createdAt: 1,
              asset: {
                id: assetId,
                name: 'nai.png',
                width: 1,
                height: 1,
                mimeType: 'image/png',
              },
            },
          },
        ],
      },
    },
    [
      {
        id: assetId,
        blob: new Blob([original], { type: 'image/png' }),
        role: 'generated',
        nodeId: 'sketch',
        sha256,
      },
    ]
  )
  // A record this build can no longer read, as damaged browser storage leaves.
  const damaged = {
    ...withImage,
    document: {
      ...withImage.document,
      nodes: (withImage.document.nodes as Record<string, unknown>[]).map(
        (node) => ({ ...node, type: 'unknown-node' })
      ),
    },
  }
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('new-api-gallery-canvases', 1)
    opening.addEventListener('success', () => resolve(opening.result))
    opening.addEventListener('error', () => reject(opening.error))
  })
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('canvases', 'readwrite')
    tx.objectStore('canvases').put(damaged, [813, legacy.id])
    tx.addEventListener('complete', () => resolve())
    tx.addEventListener('error', () => reject(tx.error))
  })
  database.close()
  await startCanvasEditor(identity, 'drawing')

  await expect(
    openCanvasProject(identity, legacy.id, undefined, 'drawing')
  ).rejects.toThrow(LEGACY_NAI_CANVAS_UNCONVERTIBLE)

  expect(await loadLocalCanvas(813, legacy.id)).toEqual(damaged)
  const exported = JSON.parse(
    await (await exportStoredCanvas(identity, legacy.id)).text()
  )
  expect(exported.nodes[0]).toMatchObject({
    type: 'unknown-node',
    data: {
      prompt: 'NAI 画布',
      asset: { id: assetId, src: 'data:image/png;base64,YWJj' },
    },
  })
})

it('marks an unuploaded image in a synced canvas local-only until its exact asset appears remotely', async () => {
  const canvas = await localImage()
  await updateCanvasCloudState(813, canvas.id, (current) => ({
    ...current,
    cloudRevision: 1,
    expiresAt: 1900000000,
    needsExplicitSave: false,
  }))
  renderGallery()
  expect(await screen.findByText('Local draft')).toBeVisible()
  await userEvent.click(
    screen.getByRole('button', { name: 'Preview original' })
  )
  expect(
    await within(screen.getByRole('dialog')).findByText('Local draft')
  ).toBeVisible()
  await userEvent.keyboard('{Escape}')
  remoteImages = [{ ...galleryImage, id: assetId, expires_at: 2000000000 }]
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(await screen.findByText(galleryImage.prompt)).toBeVisible()
  expect(screen.queryByText('Local draft')).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('button', { name: 'Preview original' })
  )
  const preview = screen.getByRole('dialog')
  expect(await within(preview).findByRole('img')).toHaveAttribute(
    'src',
    'blob:local-original'
  )
  expect(
    within(preview).getByText(new Date(2000000000 * 1000).toLocaleString())
  ).toBeVisible()
  expect(fileReads).toEqual([])
})

it('filters and paginates local canvases using the same title, source and sort controls', async () => {
  for (let index = 0; index < 25; index++) {
    await drawnCanvas('drawing', `画布 ${String(index).padStart(2, '0')}`)
  }
  const longName = `特别的 NAI 画布${'很长的名称'.repeat(20)}`
  await drawnCanvas('nai', longName)
  renderGallery()
  await userEvent.click(screen.getByRole('tab', { name: /^Canvases/ }))
  await waitFor(() =>
    expect(
      screen.getAllByRole('button', { name: /^Open canvas:/ })
    ).toHaveLength(24)
  )
  await userEvent.click(screen.getByRole('button', { name: 'Go to next page' }))
  expect(screen.getAllByRole('button', { name: /^Open canvas:/ })).toHaveLength(
    2
  )
  await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), '特别')
  expect(screen.getAllByRole('button', { name: /^Open canvas:/ })).toHaveLength(
    1
  )
  expect(screen.getByTitle(longName)).toBeVisible()
  // A NAI canvas opens in the drawing page, so it is a drawing canvas.
  await userEvent.click(screen.getByRole('combobox', { name: 'Source' }))
  expect(
    screen.queryByRole('option', { name: 'NAI Canvas' })
  ).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('option', { name: 'Drawing' }))
  expect(screen.getByTitle(longName)).toBeVisible()
  await userEvent.click(screen.getByRole('combobox', { name: 'Source' }))
  await userEvent.click(screen.getByRole('option', { name: 'API' }))
  expect(await screen.findByText('No canvases')).toBeVisible()
})

it('creates the user-entered canvas name and confirms image and whole-canvas deletion', async () => {
  const canvas = await localImage()
  renderGallery()
  await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  let dialog = screen.getByRole('alertdialog')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(await readCanvasAssets(813, canvas.id)).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await userEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
  )
  await waitFor(() => expect(useDrawingStore.getState().nodes).toHaveLength(0))
  expect(await readCanvasAssets(813, canvas.id)).toHaveLength(0)
  await userEvent.click(await screen.findByRole('tab', { name: /^Canvases/ }))
  await userEvent.click(
    await screen.findByRole('button', { name: 'Delete canvas' })
  )
  dialog = screen.getByRole('alertdialog')
  expect(
    within(dialog).getByText('The canvas and its images will be deleted.')
  ).toBeVisible()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
  await waitFor(async () =>
    expect((await loadLocalCanvas(813, canvas.id))?.deleted).toBe(true)
  )
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  )
  const createButton = screen.getByRole('button', { name: 'New canvas' })
  await waitFor(() => expect(createButton).toBeEnabled())
  await userEvent.click(createButton)
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Canvas name' }),
    '用户指定画布'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Create canvas' }))
  await waitFor(() => expect(navigate).toHaveBeenCalled())
  const created = required(navigate.mock.calls.at(-1))[0].search
    .canvas as string
  expect((await loadLocalCanvas(813, created))?.name).toBe('用户指定画布')
})

it('removes cached gallery images when their canvas is deleted', async () => {
  const canvas = await localImage()
  remoteImages = [
    {
      ...galleryImage,
      id: assetId,
      canvas_id: canvas.id,
    },
  ]
  renderGallery()
  expect(await screen.findByText(galleryImage.prompt)).toBeVisible()
  await userEvent.click(screen.getByRole('tab', { name: /^Canvases/ }))
  await userEvent.click(
    await screen.findByRole('button', { name: 'Delete canvas' })
  )
  await userEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
  )
  await waitFor(() =>
    expect(
      client.getQueryData([
        'gallery',
        identity.userId,
        identity.sessionId,
        'images',
      ])
    ).toEqual([])
  )
})

it('removes a gallery image immediately when it is deleted from the canvas', async () => {
  const canvas = await localImage()
  remoteImages = [
    {
      ...galleryImage,
      id: assetId,
      canvas_id: canvas.id,
    },
  ]
  renderGallery()
  expect(await screen.findByText(galleryImage.prompt)).toBeVisible()

  await deleteCanvasResource(identity, canvas.id, assetId)

  await waitFor(() =>
    expect(
      client.getQueryData([
        'gallery',
        identity.userId,
        identity.sessionId,
        'images',
      ])
    ).toEqual([])
  )
  expect(screen.queryByText(galleryImage.prompt)).not.toBeInTheDocument()
})

it('reconciles a cached image when entering the gallery after canvas deletion', async () => {
  const canvas = await localImage()
  remoteImages = [
    {
      ...galleryImage,
      id: assetId,
      canvas_id: canvas.id,
    },
  ]
  const rendered = renderGallery()
  expect(await screen.findByText(galleryImage.prompt)).toBeVisible()
  rendered.unmount()

  await deleteCanvasResource(identity, canvas.id, assetId)
  renderGallery()

  await waitFor(() =>
    expect(screen.queryByText(galleryImage.prompt)).not.toBeInTheDocument()
  )
  await waitFor(() =>
    expect(
      client.getQueryData([
        'gallery',
        identity.userId,
        identity.sessionId,
        'images',
      ])
    ).toEqual([])
  )
})

it('shows persisted full status on direct gallery reload without a binding or quota-refresh bypass', async () => {
  await localImage()
  stopCanvasEditors(identity)
  // A fresh page has no in-memory editor state.
  login(813, 'new-session')
  await updateCanvasUserState(813, (state) => ({
    ...state,
    cloudPause: {
      reason: 'Gallery storage limit reached.',
      requiredBytes: 1000,
      requiredImages: 1,
      notified: true,
      lastQuotaCheck: Date.now(),
    },
  }))
  renderGallery()
  expect(
    await screen.findByText('已保存到本地，云端空间不足，暂未上传。')
  ).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(usageReads).toBe(0)
})

it('requires an explicit conflict reload and offers local export without a native prompt', async () => {
  const canvas = await localImage()
  await updateCanvasCloudState(813, canvas.id, (current) => ({
    ...current,
    status: 'conflict',
  }))
  await openCanvasProject(identity, canvas.id)
  render(<CanvasEditorHeader kind='drawing' />)
  expect(
    await screen.findByRole('button', { name: 'Export canvas' })
  ).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Canvas title' }))
  const title = screen.getByRole('textbox', { name: 'Canvas title' })
  await userEvent.clear(title)
  await userEvent.type(title, '冲突本地画布')
  await userEvent.keyboard('{Escape}')
  expect(
    screen.getByRole('button', { name: 'Canvas title' })
  ).toHaveTextContent('本地画布')
  await userEvent.click(
    screen.getByRole('button', { name: 'Reload cloud version' })
  )
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'This discards the local conflicting version.'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(useDrawingStore.getState().nodes).toHaveLength(1)
})

// A conflict previously offered only export and reload, so keeping the local
// version meant exporting it and rebuilding the canvas by hand.
it('offers replacing the cloud version and confirms before discarding it', async () => {
  const canvas = await localImage()
  await updateCanvasCloudState(813, canvas.id, (current) => ({
    ...current,
    status: 'conflict',
  }))
  await openCanvasProject(identity, canvas.id)
  render(<CanvasEditorHeader kind='drawing' />)

  await userEvent.click(
    await screen.findByRole('button', { name: 'Replace cloud version' })
  )

  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'This discards the version stored in the cloud.'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(useDrawingStore.getState().nodes).toHaveLength(1)
})

it('shows the canvas title as text until it is clicked', async () => {
  await localImage()
  render(<CanvasEditorHeader kind='drawing' />)
  expect(
    screen.queryByRole('textbox', { name: 'Canvas title' })
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Canvas title' })
  ).toHaveTextContent('本地画布')
  await userEvent.click(screen.getByRole('button', { name: 'Canvas title' }))
  expect(
    await screen.findByRole('textbox', { name: 'Canvas title' })
  ).toHaveValue('本地画布')
  expect(screen.getByRole('button', { name: 'New canvas' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Open canvas' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Save canvas' })).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Rename canvas' })
  ).not.toBeInTheDocument()
})

it('guards gallery canvas switching until unsaved changes are resolved', async () => {
  const current = await localImage()
  const target = await drawnCanvas('drawing', '目标画布')
  await openCanvasProject(identity, current.id)
  useDrawingStore.getState().updateSettings({ prompt: '未保存修改' })

  renderGallery()
  await userEvent.click(screen.getByRole('tab', { name: /^Canvases/ }))
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open canvas: 目标画布' })
  )

  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent('Unsaved canvas changes')
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Discard changes' })
  )

  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/canvas/drawing',
      search: { canvas: target.id, image: undefined },
    })
  )
  expect(useDrawingStore.getState().settings.prompt).not.toBe('未保存修改')
})

it('closes the create dialog before showing the unsaved changes dialog', async () => {
  const current = await localImage()
  await openCanvasProject(identity, current.id)
  useDrawingStore.getState().updateSettings({ prompt: '未保存修改' })

  render(<CanvasEditorHeader kind='drawing' />)
  await userEvent.click(screen.getByRole('button', { name: 'New canvas' }))
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Canvas name' }),
    '新的画布'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Create canvas' }))

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(await screen.findByRole('alertdialog')).toHaveTextContent(
    'Unsaved canvas changes'
  )
})

it('guards switching to a NAI canvas, which opens in the drawing page', async () => {
  const current = await localImage()
  const target = await drawnCanvas('nai', '目标 NAI 画布')
  await openCanvasProject(identity, current.id)
  useDrawingStore.getState().updateSettings({ prompt: '未保存修改' })

  renderGallery()
  await userEvent.click(screen.getByRole('tab', { name: /^Canvases/ }))
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open canvas: 目标 NAI 画布' })
  )

  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent('Unsaved canvas changes')
  expect(navigate).not.toHaveBeenCalled()

  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Discard changes' })
  )
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/canvas/drawing',
      search: { canvas: target.id, image: undefined },
    })
  )
  expect(useDrawingStore.getState().settings.prompt).not.toBe('未保存修改')
})

it('keeps the switch dialog actionable after a save failure', async () => {
  const current = await localImage()
  const target = await drawnCanvas('drawing', '目标画布')
  await openCanvasProject(identity, current.id)
  useDrawingStore.getState().updateSettings({ prompt: '未保存修改' })

  const failure = vi
    .spyOn(canvasRepository, 'saveLocalCanvas')
    .mockRejectedValue(new Error('Canvas storage is unavailable.'))

  renderGallery()
  await userEvent.click(screen.getByRole('tab', { name: /^Canvases/ }))
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open canvas: 目标画布' })
  )
  const dialog = await screen.findByRole('alertdialog')
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Save and continue' })
  )

  await waitFor(() =>
    expect(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Discard changes',
      })
    ).toBeEnabled()
  )
  failure.mockRestore()

  await userEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Discard changes',
    })
  )
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/canvas/drawing',
      search: { canvas: target.id, image: undefined },
    })
  )
})

it('saves a title edited from the text view with Enter', async () => {
  const canvas = await localImage()
  render(<CanvasEditorHeader kind='drawing' />)

  await userEvent.click(screen.getByRole('button', { name: 'Canvas title' }))
  const title = screen.getByRole('textbox', { name: 'Canvas title' })
  await userEvent.clear(title)
  await userEvent.type(title, '新的画布标题')
  await userEvent.keyboard('{Enter}')

  expect(
    await screen.findByRole('button', { name: 'Canvas title' })
  ).toHaveTextContent('新的画布标题')
  expect((await loadLocalCanvas(813, canvas.id))?.name).toBe('新的画布标题')
})

it('discards asynchronous Drawing file import when the selected canvas changes', async () => {
  await localImage()
  let finish!: (value: string) => void
  const text = new Promise<string>((resolve) => {
    finish = resolve
  })
  const hook = renderHook(useCanvasFiles, { wrapper: ReactFlowProvider })
  let importing!: Promise<void>
  act(() => {
    importing = hook.result.current.importCanvas({
      size: 1,
      text: () => text,
    } as File)
  })
  const replacement = await createCanvasProject(identity, 'drawing')
  await act(async () => {
    finish(JSON.stringify({ ...useDrawingStore.getState(), version: 1 }))
    await importing
  })
  expect(hook.result.current.pendingImport).toBeNull()
  expect((await loadLocalCanvas(813, replacement.id))?.document.nodes).toEqual(
    []
  )
})

it('imports a canvas file exported from the former NAI page as a drawing canvas', async () => {
  await startCanvasEditor(identity, 'drawing')
  const exported = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { model: 'nai-diffusion-4-5-full', negativePrompt: 'blur' },
    nodes: [
      {
        id: 'nai-node',
        type: 'nai-image',
        position: { x: 5, y: 6 },
        data: {
          prompt: '白狐',
          settings: { model: 'nai-diffusion-4-5-full', seed: 42 },
          status: 'complete',
          createdAt: 1,
          asset: {
            id: assetId,
            name: 'nai.png',
            src: 'data:image/png;base64,YWJj',
            width: 1,
            height: 1,
            mimeType: 'image/png',
          },
        },
      },
    ],
  }
  const hook = renderHook(useCanvasFiles, { wrapper: ReactFlowProvider })

  await act(() =>
    hook.result.current.importCanvas({
      size: 1,
      text: async () => JSON.stringify(exported),
    } as unknown as File)
  )

  expect(hook.result.current.pendingImport).toMatchObject({
    settings: { generationMode: 'tags', negativePrompt: 'blur' },
    edges: [],
    nodes: [
      {
        id: 'nai-node',
        type: 'image',
        position: { x: 5, y: 6 },
        data: {
          prompt: '白狐',
          settings: { generationMode: 'tags', seed: 42 },
        },
      },
    ],
  })
})

function DeleteHarness() {
  const deletion = useCanvasNodeDeletion('drawing')
  return (
    <CanvasNodeDeletionContext value={deletion.request}>
      <button type='button' onClick={() => deletion.request(['precise-node'])}>
        Delete selected image
      </button>
      {deletion.dialog}
    </CanvasNodeDeletionContext>
  )
}
it('routes the editor deletion confirmation through durable original deletion and clears undo', async () => {
  const canvas = await localImage()
  render(<DeleteHarness />)
  await userEvent.click(
    screen.getByRole('button', { name: 'Delete selected image' })
  )
  expect(useDrawingStore.getState().nodes).toHaveLength(1)
  await userEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
  )
  await waitFor(() => expect(useDrawingStore.getState().nodes).toHaveLength(0))
  expect(useDrawingStore.getState().past).toEqual([])
  expect(await readCanvasAssets(813, canvas.id)).toEqual([])
})

it('closes the editor deletion confirmation before a remote deletion finishes', async () => {
  const canvas = await localImage()
  let release!: () => void
  api.defaults.adapter = async (config) => {
    if (
      config.method === 'get' &&
      config.url === `/api/gallery/canvases/${canvas.id}`
    ) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    throw new AxiosError(
      'remote deletion pending',
      '',
      config,
      {},
      { ...response(config, {}), status: 503 }
    )
  }
  render(<DeleteHarness />)
  await userEvent.click(
    screen.getByRole('button', { name: 'Delete selected image' })
  )
  await userEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
  )

  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  )
  expect(useDrawingStore.getState().nodes).toHaveLength(0)
  expect(await readCanvasAssets(813, canvas.id)).toEqual([])
  release()
})

describe('canvas project save status', () => {
  it('renders the durable full-quota status when local persistence succeeded', () => {
    render(
      <CanvasSaveStatus
        localStatus='saved'
        cloudStatus='full'
        statusText='已保存到本地，云端空间不足，暂未上传。'
      />
    )

    expect(
      screen.getByText('已保存到本地，云端空间不足，暂未上传。')
    ).toBeVisible()
  })
  it('never claims local save when current runtime content has not been saved', () => {
    render(
      <CanvasSaveStatus
        localStatus='error'
        cloudStatus='full'
        statusText='已保存到本地，云端空间不足，暂未上传。'
        error='Canvas not saved'
      />
    )
    expect(
      screen.queryByText('已保存到本地，云端空间不足，暂未上传。')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Canvas not saved')).toBeVisible()
  })
  // Nothing to say is not the same as an empty thing to look at: a canvas that
  // has not settled yet left a blank status element sitting in the toolbar.
  it('leaves nothing behind while the canvas has no status to report', () => {
    render(<CanvasSaveStatus localStatus='loading' cloudStatus='' />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('carries clipping on the status line itself and keeps the full message in its title', () => {
    render(
      <CanvasSaveStatus
        localStatus='saved'
        cloudStatus='error'
        className='truncate'
      />
    )

    const status = screen.getByRole('status')
    expect(status).toHaveClass('truncate')
    expect(status).toHaveAttribute(
      'title',
      'Saved locally. Cloud save failed; try again later.'
    )
  })
})

// Starting a canvas is not the same as having one: a draft nobody has drawn on
// yet would otherwise show up as a canvas the moment it was created.
it('leaves a canvas nobody has drawn on out of the listing until it holds something', async () => {
  await localImage()
  await createCanvasProject(identity, 'drawing', '空白草稿')

  renderGallery('canvases')

  expect(await screen.findByText('本地画布')).toBeVisible()
  expect(screen.queryByText('空白草稿')).toBeNull()
})

// The canvas draws its own progress bar, which it never got to show while the
// gallery held the click until every last picture had arrived.
it('goes to the canvas straight away rather than downloading it first', async () => {
  await startCanvasEditor(identity, 'drawing')
  const remote = remoteDrawingCanvas(useDrawingStore.getState().settings)
  let releaseDownload = () => undefined as void
  const download = new Promise<void>((resolve) => {
    releaseDownload = () => resolve()
  })
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/usage')) return response(config, usage)
    if (config.url?.endsWith(`/canvases/${canvasId}`)) {
      return response(config, remote)
    }
    if (config.url?.endsWith('/canvases')) {
      return response(config, {
        items: [{ ...remote, cover_asset_ids: [remoteAssetId] }],
        page: 1,
        page_size: 24,
        total: 1,
      })
    }
    if (config.url?.endsWith('/file')) {
      await download
      return {
        ...response(config, {}),
        data: new Blob(['remote'], { type: 'image/png' }),
      }
    }
    throw new AxiosError(
      'not found',
      '',
      config,
      {},
      { ...response(config, {}), status: 404 }
    )
  }

  renderGallery('canvases')
  await userEvent.click(
    await screen.findByRole('button', { name: `Open canvas: ${remote.name}` })
  )

  // Still mid-download, and already on the canvas.
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/canvas/drawing',
      search: { canvas: canvasId, image: undefined },
    })
  )
  releaseDownload()
})

// The tools sit on one line and are scrolled sideways when they do not fit.
// Asking only for horizontal scrolling silently grants vertical scrolling too,
// which put a scrollbar down the middle of the toolbar the moment a rerender
// made the row a fraction taller than its box.
it('scrolls the canvas tools sideways without scrolling them vertically', () => {
  render(<CanvasEditorHeader kind='drawing' />)

  const tools = screen.getByRole('toolbar').firstElementChild
  expect(tools).toHaveClass('overflow-x-auto')
  expect(tools).toHaveClass('overflow-y-hidden')
})

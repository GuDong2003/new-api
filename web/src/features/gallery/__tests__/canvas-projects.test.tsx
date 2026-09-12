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
import { AxiosError } from 'axios'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasFiles } from '@/features/playground/drawing/hooks/use-canvas-files'
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
import { flushLocalEditors, stopCanvasEditors } from '../lib/canvas-editor'
import {
  createCanvasProject,
  openCanvasProject,
  startCanvasEditor,
} from '../lib/canvas-projects'
import {
  loadLocalCanvas,
  readCanvasAssets,
  updateCanvasUserState,
  updateCanvasCloudState,
} from '../lib/canvas-repository'
import { cancelCanvasSession } from '../lib/canvas-sync'
import type { GalleryImage } from '../types'
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
const renderGallery = () =>
  render(
    <QueryClientProvider client={client}>
      <Gallery />
    </QueryClientProvider>
  )
const assetId = '11111111-1111-4111-8111-111111111111'
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
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/canvas/drawing',
      search: { canvas: canvas.id, image: assetId },
    })
  )
  expect(
    useDrawingStore.getState().nodes.find((node) => node.id === 'precise-node')
      ?.selected
  ).toBe(true)
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
    await createCanvasProject(
      identity,
      'drawing',
      `画布 ${String(index).padStart(2, '0')}`
    )
  }
  const longName = `特别的 NAI 画布${'很长的名称'.repeat(20)}`
  await createCanvasProject(identity, 'nai', longName)
  renderGallery()
  await userEvent.click(screen.getByRole('tab', { name: 'Canvases' }))
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
  await userEvent.click(screen.getByRole('combobox', { name: 'Source' }))
  await userEvent.click(screen.getByRole('option', { name: 'Drawing' }))
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
  await userEvent.click(await screen.findByRole('tab', { name: 'Canvases' }))
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
  await userEvent.click(screen.getByRole('button', { name: 'New canvas' }))
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
  await userEvent.click(screen.getByRole('tab', { name: 'Canvases' }))
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
  const title = screen.getByRole('textbox', { name: 'Canvas title' })
  await userEvent.clear(title)
  await userEvent.type(title, '冲突本地画布')
  await userEvent.keyboard('{Escape}')
  expect(title).toHaveValue('本地画布')
  await userEvent.click(
    screen.getByRole('button', { name: 'Reload cloud version' })
  )
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'This discards the local conflicting version.'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(useDrawingStore.getState().nodes).toHaveLength(1)
})

it('keeps the title editable and exposes compact canvas actions beside it', async () => {
  await localImage()
  render(<CanvasEditorHeader kind='drawing' />)
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
})

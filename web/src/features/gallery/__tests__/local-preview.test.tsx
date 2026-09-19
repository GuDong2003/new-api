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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { CanvasCard } from '../components/canvas-card'
import { GalleryImageCard } from '../components/gallery-image-card'
import type { GalleryImage } from '../types'
import { galleryImage, login } from './fixtures'

// A picture the server never saw has no thumbnail to ask for, so every surface
// showing one was decoding the full original into a card a couple of hundred
// pixels wide.
const original = new NodeBlob([new Uint8Array(40000)], {
  type: 'image/png',
}) as unknown as Blob
const preview = new NodeBlob(['a much smaller picture'], {
  type: 'image/jpeg',
}) as unknown as Blob

const identity = { userId: 813, sessionId: 'gallery-session' }
let client: QueryClient

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:shown')
      static revokeObjectURL = vi.fn()
    }
  )
  vi.stubGlobal('createImageBitmap', async () => ({
    width: 2048,
    height: 1024,
    close: vi.fn(),
  }))
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        public width: number,
        public height: number
      ) {}
      getContext = () => ({ drawImage: vi.fn() })
      convertToBlob = async () => preview
    }
  )
  login()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  client.clear()
  vi.unstubAllGlobals()
})

const shownPictures = () =>
  (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => (call[0] as Blob).size
  )

it('shows a local image in the images tab from a derived preview', async () => {
  const image: GalleryImage = {
    ...galleryImage,
    has_thumbnail: false,
    localBlob: original,
    localSha256: 'sha-images-tab',
    localOnly: true,
  }

  render(
    <QueryClientProvider client={client}>
      <GalleryImageCard
        image={image}
        identity={identity}
        onPreview={vi.fn()}
        onDelete={vi.fn()}
      />
    </QueryClientProvider>
  )

  await waitFor(() => expect(shownPictures()).toContain(preview.size))
})

it('shows a local draft cover from a derived preview', async () => {
  render(
    <QueryClientProvider client={client}>
      <CanvasCard
        project={{
          id: 'canvas-1',
          kind: 'drawing',
          name: '本机草稿',
          revision: 1,
          state: 'ready',
          updatedAt: 1700000000,
          expiresAt: 0,
          coverAssetIds: ['asset-1'],
          coverAssets: {
            'asset-1': { blob: original, sha256: 'sha-canvas-cover' },
          },
          localOnly: true,
          status: 'local',
        }}
        identity={identity}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />
    </QueryClientProvider>
  )

  await waitFor(() => expect(shownPictures()).toContain(preview.size))
})

it('keeps showing the original when this browser cannot downscale it', async () => {
  vi.stubGlobal('createImageBitmap', undefined)
  const image: GalleryImage = {
    ...galleryImage,
    has_thumbnail: false,
    localBlob: original,
    localSha256: 'sha-no-bitmap',
    localOnly: true,
  }

  render(
    <QueryClientProvider client={client}>
      <GalleryImageCard
        image={image}
        identity={identity}
        onPreview={vi.fn()}
        onDelete={vi.fn()}
      />
    </QueryClientProvider>
  )

  await waitFor(() => expect(shownPictures()).toContain(original.size))
})

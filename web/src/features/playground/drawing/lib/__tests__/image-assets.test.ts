/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the License,
or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  imageAssetToFile,
  imageDownloadName,
  imageSourceToAsset,
} from '../image-assets'

class TestImage extends EventTarget {
  naturalWidth = 512
  naturalHeight = 512
  src = ''
}

afterEach(() => vi.unstubAllGlobals())

describe('image source assets', () => {
  it('rejects an invalid data image when the browser cannot decode it', async () => {
    const images: TestImage[] = []
    vi.stubGlobal(
      'Image',
      class extends TestImage {
        constructor() {
          super()
          images.push(this)
        }
      }
    )

    const result = imageSourceToAsset(
      'data:image/png;base64,YWJj',
      'broken.png',
      'image/png'
    )
    images[0]?.dispatchEvent(new Event('error'))

    await expect(result).rejects.toThrow('The image could not be loaded.')
  })

  it('keeps a remote result usable when browser probing is blocked', async () => {
    const images: TestImage[] = []
    vi.stubGlobal(
      'Image',
      class extends TestImage {
        constructor() {
          super()
          images.push(this)
        }
      }
    )

    const result = imageSourceToAsset(
      'https://images.example/final.png',
      'remote.png',
      'image/png'
    )
    images[0]?.dispatchEvent(new Event('error'))

    await expect(result).resolves.toMatchObject({
      src: 'https://images.example/final.png',
      width: 1024,
      height: 1024,
    })
  })
})

// A canvas opened from the gallery holds its pictures as object URLs, so an
// image used as a reference for the next generation arrives as one. Refusing to
// read it failed the generation outright with "the image response is invalid".
describe('reference images held by the canvas', () => {
  it('reads one the canvas is holding as an object URL', async () => {
    const bytes = new Blob(['a picture'], { type: 'image/png' })
    // Only what imageAssetToFile reads off a response. Building a real one ties
    // the test to whichever Blob and Response the runtime happens to ship.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => bytes }))
    )

    const file = await imageAssetToFile({
      id: 'asset-1',
      name: 'reference.png',
      src: 'blob:http://localhost/9f1c',
      width: 1024,
      height: 1024,
      mimeType: 'image/png',
    })

    expect(file.type).toBe('image/png')
    expect(file.name).toBe('asset-1.png')
    expect(fetch).toHaveBeenCalledWith(
      'blob:http://localhost/9f1c',
      expect.anything()
    )
  })

  it('still refuses a source this tab has no business reading', async () => {
    await expect(
      imageAssetToFile({
        id: 'asset-2',
        name: 'reference.png',
        src: 'file:///etc/passwd',
        width: 1,
        height: 1,
        mimeType: 'image/png',
      })
    ).rejects.toThrow('The image response is invalid.')
  })
})

// A folder of downloads that all read "new-api-" and a random id could not be
// told apart. Each picture is named for what it shows, then when it was made,
// so the folder reads and sorts on its own.
describe('image download names', () => {
  const madeAt = new Date(2026, 8, 27, 21, 30, 5).getTime()

  it.each([
    {
      prompt: '一只橘猫在窗台上',
      mimeType: 'image/png',
      name: '一只橘猫在窗台上-20260927-213005.png',
    },
    {
      prompt: 'A fox\nin the snow',
      mimeType: 'image/jpeg',
      name: 'A fox in the snow-20260927-213005.jpg',
    },
    {
      prompt: 'a/b:c*d?e"f<g>h|i\\j',
      mimeType: 'image/webp',
      name: 'a b c d e f g h i j-20260927-213005.webp',
    },
    // A desktop hides a file whose name starts with a dot.
    {
      prompt: '..a fox',
      mimeType: 'image/png',
      name: 'a fox-20260927-213005.png',
    },
    // The gateway sends the same name, and a browser would decode the %.
    {
      prompt: '100%Beef burger',
      mimeType: 'image/png',
      name: '100 Beef burger-20260927-213005.png',
    },
    { prompt: '  ', mimeType: 'image/png', name: 'image-20260927-213005.png' },
  ])('names a $mimeType picture made from "$prompt"', (test) => {
    expect(imageDownloadName(test.prompt, madeAt, test.mimeType)).toBe(
      test.name
    )
  })

  it('numbers the pictures of a batch after its first', () => {
    expect(
      [0, 1, 2].map((index) =>
        imageDownloadName('A fox', madeAt, 'image/png', index)
      )
    ).toEqual([
      'A fox-20260927-213005.png',
      'A fox-20260927-213005-2.png',
      'A fox-20260927-213005-3.png',
    ])
  })

  it('cuts a long prompt between characters, never inside one', () => {
    expect(imageDownloadName('🦊'.repeat(31), madeAt, 'image/png')).toBe(
      `${'🦊'.repeat(30)}-20260927-213005.png`
    )
  })

  it('keeps only the start of a long prompt', () => {
    expect(
      imageDownloadName(
        '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多余的字',
        madeAt,
        'image/png'
      )
    ).toBe(
      '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十-20260927-213005.png'
    )
  })
})

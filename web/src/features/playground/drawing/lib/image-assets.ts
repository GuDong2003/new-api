/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type { ImageAsset } from '../types'

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp']

export function isSafeImageSource(source: string): boolean {
  if (/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=\s]+$/.test(source)) {
    return true
  }
  try {
    const url = new URL(source)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export async function imageSourceToAsset(
  source: string,
  name: string,
  mimeType: string,
  signal?: AbortSignal
): Promise<ImageAsset> {
  if (!isSafeImageSource(source)) {
    throw new Error('The image response is invalid.')
  }
  signal?.throwIfAborted()
  const dimensions = await new Promise<{ width: number; height: number }>(
    (resolve, reject) => {
      const image = new Image()
      const cancel = () => {
        image.src = ''
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      image.addEventListener(
        'load',
        () => {
          signal?.removeEventListener('abort', cancel)
          resolve({ width: image.naturalWidth, height: image.naturalHeight })
        },
        { once: true }
      )
      image.addEventListener(
        'error',
        () => {
          signal?.removeEventListener('abort', cancel)
          reject(new Error('The image could not be loaded.'))
        },
        { once: true }
      )
      image.src = source
    }
  )
  return {
    id: crypto.randomUUID(),
    name: name.slice(0, 512),
    src: source,
    mimeType,
    ...dimensions,
  }
}

export async function imageFileToAsset(file: File): Promise<ImageAsset> {
  if (!IMAGE_MIME_TYPES.includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP image.')
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Each reference image must be smaller than 50 MB.')
  }
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('The image could not be loaded.'))
    reader.readAsDataURL(file)
  })
  return imageSourceToAsset(source, file.name, file.type)
}

export async function imageAssetToFile(
  asset: ImageAsset,
  signal?: AbortSignal
): Promise<File> {
  if (!isSafeImageSource(asset.src)) {
    throw new Error('The image response is invalid.')
  }
  const response = await fetch(asset.src, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok) {
    throw new Error(
      'The reference image could not be read. Try uploading it again.'
    )
  }
  const blob = await response.blob()
  if (!IMAGE_MIME_TYPES.includes(blob.type)) {
    throw new Error('Choose a PNG, JPEG or WebP image.')
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error('Each reference image must be smaller than 50 MB.')
  }
  const extension = blob.type.split('/')[1]
  // Materialize the bytes before constructing the File. In some runtimes (notably
  // Bun + jsdom), a Blob from another realm is stringified as "[object Blob]"
  // when passed directly as a File part instead of being copied as binary data.
  return new File([await blob.arrayBuffer()], `${asset.id}.${extension}`, {
    type: blob.type,
  })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // Give the browser time to start reading the object URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

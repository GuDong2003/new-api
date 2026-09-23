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
import {
  galleryAssetFingerprint,
  readGalleryThumbnail,
  writeGalleryThumbnail,
} from './gallery-thumbnail-cache'

// An image saved to the gallery gets a thumbnail from the server. One that only
// exists in this browser — a canvas still being drawn, a draft never synced —
// does not, so every surface showing it was decoding the full original into a
// box a couple of hundred pixels wide. These derive the same 512px preview
// locally and keep it in the cache the gallery already reads, so a picture is
// downscaled once no matter how many times it is shown.

/**
 * The longest edge of a preview, server-made or derived here. Both sides use
 * the same number so a picture looks the same wherever it appears, and so a
 * node can tell when it has been drawn large enough to outgrow one.
 */
export const GALLERY_PREVIEW_EDGE = 512
const LOCAL_THUMBNAIL_TYPE = 'image/jpeg'
const LOCAL_THUMBNAIL_QUALITY = 0.8

/** Content addressed: the same bytes never need downscaling twice. */
export function localThumbnailFingerprint(sha256: string) {
  return `local:${sha256}:${GALLERY_PREVIEW_EDGE}`
}

export async function renderLocalThumbnail(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(blob)
    const scale = GALLERY_PREVIEW_EDGE / Math.max(bitmap.width, bitmap.height)
    // An image already smaller than the preview gains nothing from a re-encode.
    if (scale >= 1) return null
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0, width, height)
    return await canvas.convertToBlob({
      type: LOCAL_THUMBNAIL_TYPE,
      quality: LOCAL_THUMBNAIL_QUALITY,
    })
  } catch {
    // A browser that cannot rasterise this picture still shows the original.
    return null
  } finally {
    bitmap?.close()
  }
}

/**
 * Returns a cached or freshly derived preview, or the original when it is
 * already small enough or cannot be downscaled here.
 */
/**
 * The preview for a picture the server stores but could not downscale: it
 * skips a thumbnail for anything too large to decode safely, which a 4K
 * generation is. Deriving one here costs a single download instead of one per
 * visit, and it lands in the same cache a server-made preview would.
 */
export async function getServerThumbnail(
  userId: number,
  assetId: string,
  download: () => Promise<Blob>,
  render: (input: Blob) => Promise<Blob | null> = renderLocalThumbnail
): Promise<Blob> {
  const fingerprint = galleryAssetFingerprint(assetId)
  try {
    const cached = await readGalleryThumbnail(userId, assetId, fingerprint)
    if (cached) return cached
  } catch {
    // Browser storage is an optimisation; failing to read it must not hide the
    // picture.
  }
  const downloaded = await download()
  // A preview the server made is already this size and needs no second pass,
  // and a picture that cannot be rasterised here has only the form it arrived
  // in. Either way the bytes crossed the wire once and are worth keeping.
  const thumbnail = (await render(downloaded)) ?? downloaded
  await writeGalleryThumbnail(userId, assetId, fingerprint, thumbnail).catch(
    () => undefined
  )
  return thumbnail
}

export async function getLocalThumbnail(
  userId: number,
  assetId: string,
  sha256: string,
  blob: Blob,
  render: (input: Blob) => Promise<Blob | null> = renderLocalThumbnail
): Promise<Blob> {
  if (!sha256) return blob
  const fingerprint = localThumbnailFingerprint(sha256)
  try {
    const cached = await readGalleryThumbnail(userId, assetId, fingerprint)
    if (cached) return cached
  } catch {
    // Browser storage is an optimisation; failing to read it must not hide the
    // picture.
  }
  const thumbnail = await render(blob)
  if (!thumbnail) return blob
  await writeGalleryThumbnail(userId, assetId, fingerprint, thumbnail).catch(
    () => undefined
  )
  return thumbnail
}

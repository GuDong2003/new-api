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

For commercial licensing, please contact support@quantumnous.com
*/
import { getGalleryFile } from '../api'
import type { GalleryIdentity } from '../types'
import {
  galleryAssetFingerprint,
  readGalleryThumbnail,
  writeGalleryThumbnail,
} from './gallery-thumbnail-cache'
import { createRequestGate } from './request-gate'

// A screenful of cards would otherwise open a request per tile, so thumbnails
// queue behind a fixed number of connections.
const requestThumbnail = createRequestGate(6)

/**
 * The one way in for every picture the gallery owns. The images tab, a canvas
 * cover and a canvas being opened all want the same bytes for the same image,
 * so the cache lives here rather than at each call site — opening a canvas used
 * to re-download thumbnails the images tab had already stored.
 */
export async function loadGalleryFile(
  identity: GalleryIdentity,
  id: string,
  thumbnail: boolean,
  signal?: AbortSignal
): Promise<Blob> {
  const userId = identity.userId
  // Originals are too big to keep, and are wanted one at a time anyway.
  const cacheable = thumbnail && userId !== null
  if (cacheable) {
    try {
      const cached = await readGalleryThumbnail(
        userId,
        id,
        galleryAssetFingerprint(id)
      )
      if (cached) return cached
    } catch {
      // Browser storage is an optimisation; a failure to read it must not stop
      // the picture from loading.
    }
  }
  const blob = thumbnail
    ? await requestThumbnail(
        () => getGalleryFile(identity, id, true, signal),
        signal
      )
    : await getGalleryFile(identity, id, false, signal)
  if (cacheable) {
    await writeGalleryThumbnail(
      userId,
      id,
      galleryAssetFingerprint(id),
      blob
    ).catch(() => undefined)
  }
  return blob
}

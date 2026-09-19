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
import { useStore } from '@xyflow/react'
import { useEffect, useState } from 'react'

import { CANVAS_NODE_WIDTH } from '@/features/playground/drawing/lib/canvas-geometry'
import { imageAssetToFile } from '@/features/playground/drawing/lib/image-assets'

import { loadGalleryFile } from '../lib/gallery-file-source'
import { GALLERY_PREVIEW_EDGE } from '../lib/local-thumbnail'
import type { GalleryIdentity } from '../types'
import { useGalleryFile } from './use-gallery-file'
import { useGalleryIdentity } from './use-gallery-identity'

/** What the drawing and NAI canvases both hang off an image node. */
type CanvasNodeAsset = {
  id: string
  name: string
  src: string
  width: number
  height: number
  mimeType: string
  previewOnly?: boolean
}

/**
 * A canvas opens from previews, which is what makes it open quickly at all. A
 * preview only stops being enough once its node is drawn large enough to show
 * more pixels than it has, so the original is fetched at that point and not
 * before — and then kept, because someone who has looked closely at a picture
 * once tends to look again.
 *
 * Returns the source the node should display.
 */
export function useCanvasNodeImage(
  asset: CanvasNodeAsset | undefined,
  width: number | undefined
): string {
  const identity = useGalleryIdentity()
  // Every node on the canvas runs this. Subscribing to the answer rather than
  // to the zoom keeps a pinch from re-rendering all of them on every frame.
  const outgrown = useStore(
    (state) =>
      Boolean(asset?.previewOnly) &&
      (width ?? CANVAS_NODE_WIDTH) *
        state.transform[2] *
        (globalThis.devicePixelRatio || 1) >
        GALLERY_PREVIEW_EDGE
  )
  const [sharpened, setSharpened] = useState(false)
  useEffect(() => {
    if (outgrown) setSharpened(true)
  }, [outgrown])
  const original = useGalleryFile(
    identity,
    asset?.id ?? '',
    false,
    sharpened && Boolean(asset?.previewOnly)
  )
  return original.url ?? asset?.src ?? ''
}

/** Shown as large as the window allows, so a preview is never enough here. */
export function useCanvasPreviewImage(
  asset: CanvasNodeAsset | undefined
): string {
  const identity = useGalleryIdentity()
  const original = useGalleryFile(
    identity,
    asset?.id ?? '',
    false,
    Boolean(asset?.previewOnly)
  )
  return original.url ?? asset?.src ?? ''
}

/**
 * The picture itself rather than whatever is currently on screen. Saving a
 * canvas image to disk must never hand over the preview it opened with.
 */
export async function readCanvasNodeOriginal(
  identity: GalleryIdentity,
  asset: CanvasNodeAsset
): Promise<File> {
  if (!asset.previewOnly) return imageAssetToFile(asset)
  const blob = await loadGalleryFile(identity, asset.id, false)
  return new File([blob], asset.name, { type: blob.type })
}

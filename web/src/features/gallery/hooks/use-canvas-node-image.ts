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
import { imageAssetToFile } from '@/features/playground/drawing/lib/image-assets'

import { loadGalleryFile } from '../lib/gallery-file-source'
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
 * A canvas opens from previews, which is what makes it open quickly at all.
 * They are a stand-in for the wait, not the answer: the original follows behind
 * each one and takes its place, so a node ends up showing the picture itself
 * however far in it is zoomed — and so does a right-click copy or save.
 *
 * Nodes scrolled out of view are not rendered, so this only fetches originals
 * for the part of the canvas actually being looked at.
 */
export function useCanvasNodeImage(asset: CanvasNodeAsset | undefined): string {
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
 * The picture itself rather than whatever a node happens to be showing. Saving
 * one to disk, or sending one upstream as the reference for the next
 * generation, must never hand over the preview it opened with.
 */
export async function readCanvasNodeOriginal(
  identity: GalleryIdentity,
  asset: CanvasNodeAsset,
  signal?: AbortSignal
): Promise<File> {
  if (!asset.previewOnly) return imageAssetToFile(asset, signal)
  const blob = await loadGalleryFile(identity, asset.id, false, signal)
  return new File([blob], asset.name, { type: blob.type })
}

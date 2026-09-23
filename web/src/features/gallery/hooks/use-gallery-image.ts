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
import type { GalleryIdentity } from '../types'
import { useGalleryFile } from './use-gallery-file'

type GalleryImageOptions = {
  enabled?: boolean
  /** Whether a preview exists to show first, on the server or in this browser. */
  preview?: boolean
  /** The original, when this browser already holds it. */
  blob?: Blob
  sha256?: string
  /** No copy of this picture exists on the server. */
  only?: boolean
}

/**
 * A picture at the size a list shows it.
 *
 * A grid puts many pictures on screen at once, and each original behind its
 * preview cost a page of the gallery tens of megabytes to show thumbnails. The
 * preview is the answer here, not a stand-in for one: the original belongs to
 * the surfaces that show a single picture at full size — the detail view and a
 * download — which read it directly.
 */
export function useGalleryImage(
  identity: GalleryIdentity,
  id: string,
  options: GalleryImageOptions = {}
) {
  const enabled = options.enabled ?? true
  const preview = useGalleryFile(
    identity,
    id,
    true,
    enabled && Boolean(options.preview),
    { blob: options.blob, sha256: options.sha256 }
  )
  // A picture with no preview of its own has only one form to show, and one
  // whose preview cannot be fetched would otherwise leave an empty card.
  const original = useGalleryFile(
    identity,
    id,
    false,
    enabled && (!options.preview || preview.isError),
    { blob: options.blob, only: options.only }
  )
  const url = preview.url ?? original.url
  return {
    url,
    // Whichever form is on screen is the one worth discarding when it will
    // not decode.
    retry: preview.url ? preview.retry : original.retry,
    isPending: !url && (preview.isPending || original.isPending),
    // A picture is only unavailable when neither form of it arrived.
    isError: !url && (preview.isError || original.isError),
  }
}

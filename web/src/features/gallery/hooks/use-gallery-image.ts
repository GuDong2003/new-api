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
import { useEffect, useState } from 'react'

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
 * A picture, shown as soon as there is anything of it to show.
 *
 * The preview goes up first so nothing waits on a blank box, and the original
 * follows and takes its place. The preview is a stand-in for the wait, not the
 * answer: what ends up on screen — and so what a right-click copies or saves —
 * is the picture itself.
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
  // Ask for the original once the preview is up, so the first thing shown is
  // never held back by the larger download behind it.
  const [full, setFull] = useState(!options.preview)
  useEffect(() => {
    if (preview.url || preview.isError) setFull(true)
  }, [preview.url, preview.isError])
  const original = useGalleryFile(identity, id, false, enabled && full, {
    blob: options.blob,
    only: options.only,
  })
  const url = original.url ?? preview.url
  return {
    url,
    isPending: !url && (preview.isPending || original.isPending),
    // A picture is only unavailable when neither form of it arrived.
    isError: !url && (preview.isError || original.isError),
  }
}

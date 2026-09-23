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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { loadGalleryFile } from '../lib/gallery-file-source'
import { removeGalleryThumbnail } from '../lib/gallery-thumbnail-cache'
import { getLocalThumbnail } from '../lib/local-thumbnail'
import type { GalleryIdentity } from '../types'

type GalleryFileOptions = {
  blob?: Blob
  /** Identifies `blob`'s bytes, so a preview of them is derived only once. */
  sha256?: string
  only?: boolean
}

export function useGalleryFile(
  identity: GalleryIdentity,
  id: string,
  thumbnail: boolean,
  enabled = true,
  local?: GalleryFileOptions
) {
  const userId = identity.userId
  // A picture held only in this browser has no server thumbnail to ask for, so
  // a preview of it is derived here and then read back from the same cache as
  // every other one. The original stays in hand and is shown until it is ready.
  const derive = Boolean(
    thumbnail && local?.blob && local?.sha256 && userId !== null
  )
  const sha256 = derive ? local?.sha256 : undefined
  const key = useMemo(
    () => [
      'gallery',
      userId,
      identity.sessionId,
      'file',
      id,
      thumbnail,
      sha256,
    ],
    [userId, identity.sessionId, id, thumbnail, sha256]
  )
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      derive
        ? getLocalThumbnail(
            userId as number,
            id,
            local?.sha256 as string,
            local?.blob as Blob
          )
        : loadGalleryFile(identity, id, thumbnail, signal),
    enabled: enabled && (derive || (!local?.blob && !local?.only)),
    retry: false,
    gcTime: 30 * 60 * 1000,
    staleTime: Infinity,
  })
  // A preview that will not decode is worth nothing, and a cached one keeps
  // being handed back. Dropping it is what lets the next ask reach the server.
  const client = useQueryClient()
  // Bytes that will not decode do not decode on the second try either, so one
  // attempt per picture is the difference between recovering and hammering.
  const retried = useRef(false)
  const retry = useCallback(async () => {
    if (retried.current) return
    retried.current = true
    if (userId !== null) {
      await removeGalleryThumbnail(userId, id).catch(() => undefined)
    }
    setResource(undefined)
    await client.refetchQueries({ queryKey: key })
  }, [client, id, userId, key])
  const [resource, setResource] = useState<{ blob: Blob; url: string }>()
  const blob = query.data ?? local?.blob
  useLayoutEffect(() => {
    if (!blob || !enabled) return
    const url = URL.createObjectURL(blob)
    setResource({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob, enabled, identity.userId, identity.sessionId])
  return {
    ...query,
    retry,
    isError: !blob && (query.isError || Boolean(local?.only)),
    isPending: !blob && query.isPending && !local?.only,
    url: enabled && resource?.blob === blob ? resource?.url : undefined,
  }
}

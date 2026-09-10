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
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { getGalleryFile } from '../api'
import type { GalleryIdentity } from '../types'

export function useGalleryFile(
  identity: GalleryIdentity,
  id: string,
  thumbnail: boolean,
  enabled = true
) {
  const query = useQuery({
    queryKey: [
      'gallery',
      identity.userId,
      identity.sessionId,
      'file',
      id,
      thumbnail,
    ],
    queryFn: ({ signal }) => getGalleryFile(identity, id, thumbnail, signal),
    enabled,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
  })
  const [resource, setResource] = useState<{ blob: Blob; url: string }>()
  useEffect(() => {
    if (!query.data || !enabled) return
    const url = URL.createObjectURL(query.data)
    setResource({ blob: query.data, url })
    return () => URL.revokeObjectURL(url)
  }, [query.data, enabled])
  return {
    ...query,
    url: enabled && resource?.blob === query.data ? resource?.url : undefined,
  }
}

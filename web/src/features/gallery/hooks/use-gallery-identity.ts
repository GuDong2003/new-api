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
import { useMemo } from 'react'

import { useAuthStore } from '@/stores/auth-store'

import type { GalleryIdentity } from '../types'

/**
 * Who the gallery is answering for. Everything it holds belongs to one signed
 * in session, so the identity is part of every request and cache key; a stable
 * object keeps those keys from changing on each render.
 */
export function useGalleryIdentity(): GalleryIdentity {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? null)
  return useMemo(() => ({ userId, sessionId }), [userId, sessionId])
}

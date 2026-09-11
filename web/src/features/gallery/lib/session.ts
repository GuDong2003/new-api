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
import { useAuthStore } from '@/stores/auth-store'

import type { GalleryIdentity } from '../types'

const requests = new Map<AbortController, GalleryIdentity>()

export function isGalleryIdentityCurrent(identity: GalleryIdentity): boolean {
  const auth = useAuthStore.getState().auth
  return (
    identity.userId !== null &&
    identity.sessionId !== null &&
    auth.user?.id === identity.userId &&
    auth.session?.sid === identity.sessionId
  )
}

export function assertGalleryIdentity(identity: GalleryIdentity): void {
  if (!isGalleryIdentityCurrent(identity)) {
    throw new DOMException('Gallery session changed', 'AbortError')
  }
}

export function galleryOwner(identity: GalleryIdentity): number {
  assertGalleryIdentity(identity)
  if (identity.userId === null) {
    throw new DOMException('Gallery session changed', 'AbortError')
  }
  return identity.userId
}

export function cancelGalleryRequests(
  userId: number | null,
  sessionId: string | null
): void {
  for (const [controller, identity] of requests) {
    if (identity.userId === userId && identity.sessionId === sessionId) {
      controller.abort()
    }
  }
}

// Synchronous Zustand subscription closes the gap before React effects and the
// shared axios client's asynchronous authentication interceptor run.
useAuthStore.subscribe((state, previous) => {
  if (
    state.auth.user?.id !== previous.auth.user?.id ||
    state.auth.session?.sid !== previous.auth.session?.sid
  ) {
    cancelGalleryRequests(
      previous.auth.user?.id ?? null,
      previous.auth.session?.sid ?? null
    )
  }
})

export function galleryRequestScope(
  identity: GalleryIdentity,
  signal?: AbortSignal
) {
  assertGalleryIdentity(identity)
  const controller = new AbortController()
  const abort = () => controller.abort()
  requests.set(controller, identity)
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      requests.delete(controller)
      signal?.removeEventListener('abort', abort)
    },
  }
}

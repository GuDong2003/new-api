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
import { t } from 'i18next'
import { toast } from 'sonner'

import { useAuthStore } from '@/stores/auth-store'

import { getGalleryUsage, saveGalleryImage } from '../api'
import type { GalleryIdentity, GalleryMetadata } from '../types'
import { galleryErrorMessage } from './errors'
import {
  assertGalleryIdentity,
  cancelGalleryRequests,
  galleryRequestScope,
  isGalleryIdentityCurrent,
} from './session'

type GallerySaveInput = GalleryIdentity & {
  src: string
  metadata: GalleryMetadata
}
type SaveJob = {
  input: GallerySaveInput
  resolve: () => void
  controller: AbortController
}
const queue: SaveJob[] = []
let active: SaveJob | undefined

useAuthStore.subscribe((state, previous) => {
  if (
    state.auth.user?.id !== previous.auth.user?.id ||
    state.auth.session?.sid !== previous.auth.session?.sid
  ) {
    cancelGallerySaves(
      previous.auth.user?.id ?? null,
      previous.auth.session?.sid ?? null
    )
  }
})

function reportSaveFailure(message: string): void {
  if (message === 'Gallery storage is disabled.') return
  const label =
    message === 'Gallery storage limit reached.'
      ? 'Gallery storage is full. This image was not saved to your gallery.'
      : 'This image could not be saved to your gallery. Canvas generation is unaffected.'
  toast.warning(t(label), { id: 'gallery-save-failure' })
}

async function drainQueue(): Promise<void> {
  if (active) return
  while (queue.length) {
    const job = queue.shift()
    if (!job) break
    active = job
    let scope: ReturnType<typeof galleryRequestScope> | undefined
    try {
      scope = galleryRequestScope(job.input, job.controller.signal)
      scope.signal.throwIfAborted()
      const usage = await getGalleryUsage(job.input, scope.signal)
      assertGalleryIdentity(job.input)
      scope.signal.throwIfAborted()
      if (!usage.enabled || !usage.can_save) {
        if (usage.enabled) reportSaveFailure(usage.reason)
        continue
      }
      const body = new FormData()
      body.append('metadata', JSON.stringify(job.input.metadata))
      if (job.input.src.startsWith('data:image/')) {
        const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(job.input.src)
        if (!match) throw new Error('The gallery image is invalid.')
        const encoded = job.input.src.slice(match[0].length)
        // Skip obviously over-quota bytes without making a decoded copy. The
        // server still accounts for original, thumbnail and metadata bytes.
        if (
          Math.floor((encoded.length * 3) / 4) >
          usage.max_bytes - usage.used_bytes
        ) {
          reportSaveFailure('Gallery storage limit reached.')
          continue
        }
        const chunks: Uint8Array<ArrayBuffer>[] = []
        for (let offset = 0; offset < encoded.length; offset += 32768) {
          const decoded = atob(encoded.slice(offset, offset + 32768))
          chunks.push(
            Uint8Array.from(decoded, (character) => character.charCodeAt(0))
          )
        }
        body.append('file', new Blob(chunks, { type: match[1] }), 'image')
      } else {
        // The backend fetches URLs with its strict public-network SSRF policy.
        body.append('url', job.input.src)
      }
      assertGalleryIdentity(job.input)
      scope.signal.throwIfAborted()
      await saveGalleryImage(job.input, body, scope.signal)
    } catch (error) {
      if (
        !job.controller.signal.aborted &&
        !scope?.signal.aborted &&
        isGalleryIdentityCurrent(job.input)
      ) {
        reportSaveFailure(galleryErrorMessage(error))
      }
    } finally {
      scope?.dispose()
      job.resolve()
      active = undefined
    }
  }
}

// Fire-and-forget callers never receive a rejected promise. Queue entries retain
// only references to existing final results, with one upload active at a time.
export function queueGallerySave(input: GallerySaveInput): Promise<void> {
  if (!isGalleryIdentityCurrent(input)) return Promise.resolve()
  if (queue.length >= 32) {
    reportSaveFailure('The gallery image could not be saved.')
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    queue.push({ input, resolve, controller: new AbortController() })
    void drainQueue()
  })
}

export function cancelGallerySaves(
  userId: number | null,
  sessionId: string | null
): void {
  cancelGalleryRequests(userId, sessionId)
  for (let index = queue.length - 1; index >= 0; index--) {
    const job = queue[index]
    if (job.input.userId === userId && job.input.sessionId === sessionId) {
      queue.splice(index, 1)
      job.controller.abort()
      job.resolve()
    }
  }
  if (active?.input.userId === userId && active.input.sessionId === sessionId) {
    active.controller.abort()
  }
}

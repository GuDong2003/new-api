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
import { createContext, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { deleteCanvasResource } from '../lib/canvas-deletion'
import {
  cancelEditorJobs,
  flushLocalEditors,
  getCanvasEditorState,
  sameIdentity,
  storeFor,
} from '../lib/canvas-editor'
import { canvasEditors } from '../lib/canvas-events'
import { assertGalleryIdentity } from '../lib/session'
import type { CanvasKind, GalleryIdentity } from '../types'

export const CanvasNodeDeletionContext = createContext<(ids: string[]) => void>(
  () => {
    throw new Error('Canvas deletion requires its confirmation provider.')
  }
)
export const useCanvasNodeDeletionRequest = () =>
  useContext(CanvasNodeDeletionContext)

export function captureCanvasTarget(kind: CanvasKind) {
  const auth = useAuthStore.getState().auth
  const identity = {
    userId: auth.user?.id ?? null,
    sessionId: auth.session?.sid ?? null,
  }
  const binding = canvasEditors.get(kind)
  return {
    identity,
    canvasId:
      binding && sameIdentity(binding.identity, identity)
        ? binding.canvasId
        : null,
  }
}
export function assertCanvasTarget(
  kind: CanvasKind,
  target: { identity: GalleryIdentity; canvasId: string | null }
): asserts target is { identity: GalleryIdentity; canvasId: string } {
  assertGalleryIdentity(target.identity)
  const binding = canvasEditors.get(kind)
  if (
    !target.canvasId ||
    binding?.canvasId !== target.canvasId ||
    !sameIdentity(binding.identity, target.identity)
  ) {
    throw new Error('The canvas changed. Please try again.')
  }
}

/** Used only after a business confirmation, including clear/import replacement. */
export async function deleteCanvasNodes(
  kind: CanvasKind,
  ids: string[],
  target = captureCanvasTarget(kind)
) {
  assertCanvasTarget(kind, target)
  cancelEditorJobs(kind, target.identity)
  await flushLocalEditors(target.identity)
  assertCanvasTarget(kind, target)
  if (getCanvasEditorState(kind)?.localStatus !== 'saved') {
    throw new Error('Save or export the current canvas before switching.')
  }
  const assets = [
    ...new Set(
      storeFor(kind)
        .getState()
        .nodes.filter((node) => ids.includes(node.id))
        .flatMap((node) => (node.data.asset ? [node.data.asset.id] : []))
    ),
  ]
  for (const id of assets) {
    assertCanvasTarget(kind, target)
    await deleteCanvasResource(target.identity, target.canvasId, id)
  }
  assertCanvasTarget(kind, target)
  storeFor(kind).getState().removeNodes(ids)
  if (kind === 'drawing') useDrawingStore.setState({ past: [], future: [] })
  else useNaiDrawingStore.setState({ past: [], future: [] })
}

export function useCanvasNodeDeletion(kind: CanvasKind) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<{
    ids: string[]
    target: ReturnType<typeof captureCanvasTarget>
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = (ids: string[]) => {
    setError(null)
    setPending({ ids, target: captureCanvasTarget(kind) })
  }
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setPending(null)
      }}
      title={t('Delete image')}
      desc={t('This image will be removed from the gallery and its canvas.')}
      destructive
      isLoading={busy}
      confirmText={t('Delete')}
      handleConfirm={() => {
        if (!pending) return
        setBusy(true)
        void deleteCanvasNodes(kind, pending.ids, pending.target)
          .then(() => setPending(null))
          .catch((error: unknown) =>
            setError(error instanceof Error ? error.message : 'Request failed')
          )
          .finally(() => setBusy(false))
      }}
    >
      {error ? <p role='alert'>{t(error)}</p> : null}
    </ConfirmDialog>
  )
  return { request, dialog }
}

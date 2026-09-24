/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { ReactFlowProvider } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { useCanvasRoute } from '@/features/gallery/hooks/use-canvas-route'
import { useGalleryIdentity } from '@/features/gallery/hooks/use-gallery-identity'
import {
  exportStoredCanvas,
  LEGACY_NAI_CANVAS_UNCONVERTIBLE,
} from '@/features/gallery/lib/canvas-projects'
import { useAuthStore } from '@/stores/auth-store'

import { CanvasLoadingState } from './components/CanvasLoadingState'
import { DrawingWorkspace } from './components/DrawingWorkspace'
import { downloadBlob } from './lib/image-assets'

export function Drawing(
  props: { canvasId?: string; focusAssetId?: string } = {}
) {
  const userId = useAuthStore((state) => state.auth.user?.id)
  if (!userId) return null
  return (
    <ReactFlowProvider key={userId}>
      <DrawingEntry userId={userId} {...props} />
    </ReactFlowProvider>
  )
}

function DrawingEntry(props: {
  userId: number
  canvasId?: string
  focusAssetId?: string
}) {
  const { t } = useTranslation()
  const identity = useGalleryIdentity()
  const route = useCanvasRoute('drawing', props.canvasId, props.focusAssetId)
  const canvasId = props.canvasId
  // A NAI canvas that cannot be converted stays as it was; it can still be
  // saved to a file.
  const exportOriginal =
    route.error === LEGACY_NAI_CANVAS_UNCONVERTIBLE && canvasId ? (
      <Button
        size='sm'
        onClick={async () => {
          try {
            downloadBlob(
              await exportStoredCanvas(identity, canvasId),
              `new-api-nai-canvas-${canvasId}.json`
            )
          } catch {
            toast.error(t('The canvas could not be exported.'))
          }
        }}
      >
        {t('Export original')}
      </Button>
    ) : undefined
  return (
    <>
      {route.error ? (
        <ErrorState
          description={t(route.error)}
          onRetry={route.retry}
          action={exportOriginal}
        />
      ) : null}
      {route.loading ? (
        <CanvasLoadingState progress={route.progress} />
      ) : (
        <DrawingWorkspace userId={props.userId} />
      )}
    </>
  )
}

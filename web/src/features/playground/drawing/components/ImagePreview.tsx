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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useCanvasNodeImage } from '@/features/gallery/hooks/use-canvas-node-image'
import { useDrawingStore } from '@/stores/drawing-store'

import { MaskOverlay } from './MaskOverlay'

export function ImagePreview() {
  const { t } = useTranslation()
  const id = useDrawingStore((state) => state.previewId)
  const node = useDrawingStore((state) =>
    state.nodes.find((item) => item.id === state.previewId)
  )
  const setPreview = useDrawingStore((state) => state.setPreview)
  const source = useCanvasNodeImage(node?.data.asset)
  const mask = useDrawingStore((state) =>
    state.mask?.referenceId === state.previewId ? state.mask.asset : undefined
  )
  const [hiddenMaskId, setHiddenMaskId] = useState<string | null>(null)
  const showMask = Boolean(mask && mask.id !== hiddenMaskId)
  if (!id || !node?.data.asset) return null
  return (
    <Dialog
      open
      title={t('Image preview')}
      description={node.data.prompt || node.data.asset.name}
      descriptionClassName='break-words'
      contentClassName='max-h-[95svh] sm:max-w-5xl'
      onOpenChange={(open) => {
        if (!open) setPreview(null)
      }}
    >
      <div className='space-y-3'>
        {mask && (
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <Switch
              id='image-preview-mask'
              checked={showMask}
              onCheckedChange={(checked) =>
                setHiddenMaskId(checked ? null : mask.id)
              }
            />
            <Label htmlFor='image-preview-mask'>{t('Show mask')}</Label>
            <span className='text-muted-foreground text-xs'>
              {t('Red areas will be edited.')}
            </span>
          </div>
        )}
        <div className='relative overflow-hidden rounded-lg'>
          <img
            src={source}
            alt={node.data.prompt || node.data.asset.name}
            className='block max-h-[70svh] w-full object-contain'
          />
          {showMask && mask && <MaskOverlay mask={mask} />}
        </div>
        {node.data.revisedPrompt && (
          <div className='space-y-1 text-sm'>
            <p className='font-medium'>{t('Revised prompt')}</p>
            <p className='text-muted-foreground break-words whitespace-pre-wrap'>
              {node.data.revisedPrompt}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  )
}

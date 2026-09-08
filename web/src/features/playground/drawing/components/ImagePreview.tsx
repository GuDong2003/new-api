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
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDrawingStore } from '@/stores/drawing-store'

export function ImagePreview() {
  const { t } = useTranslation()
  const id = useDrawingStore((state) => state.previewId)
  const node = useDrawingStore((state) =>
    state.nodes.find((item) => item.id === state.previewId)
  )
  const setPreview = useDrawingStore((state) => state.setPreview)
  if (!id || !node?.data.asset) return null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setPreview(null)
      }}
    >
      <DialogContent className='max-h-[95svh] overflow-y-auto sm:max-w-5xl'>
        <DialogHeader>
          <DialogTitle>{t('Image preview')}</DialogTitle>
          <DialogDescription className='break-words'>
            {node.data.prompt || node.data.asset.name}
          </DialogDescription>
        </DialogHeader>
        <img
          src={node.data.asset.src}
          alt={node.data.prompt || node.data.asset.name}
          className='max-h-[70svh] w-full rounded-lg object-contain'
        />
        {node.data.revisedPrompt && (
          <div className='space-y-1 text-sm'>
            <p className='font-medium'>{t('Revised prompt')}</p>
            <p className='text-muted-foreground break-words whitespace-pre-wrap'>
              {node.data.revisedPrompt}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

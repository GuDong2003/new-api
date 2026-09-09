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
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

export function NaiImagePreview() {
  const { t } = useTranslation()
  const id = useNaiDrawingStore((state) => state.previewId)
  const node = useNaiDrawingStore((state) =>
    state.nodes.find((item) => item.id === state.previewId)
  )
  const setPreview = useNaiDrawingStore((state) => state.setPreview)
  if (!id || !node?.data.asset) return null
  return (
    <Dialog open onOpenChange={(open) => !open && setPreview(null)}>
      <DialogContent className='max-h-[95svh] overflow-y-auto sm:max-w-5xl'>
        <DialogHeader>
          <DialogTitle>{t('NAI image preview')}</DialogTitle>
          <DialogDescription className='break-words'>
            {node.data.prompt}
          </DialogDescription>
        </DialogHeader>
        <img
          src={node.data.asset.src}
          alt={node.data.prompt}
          className='max-h-[70svh] w-full rounded-lg object-contain'
        />
      </DialogContent>
    </Dialog>
  )
}

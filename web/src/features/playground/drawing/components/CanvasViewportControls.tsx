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
import {
  Maximize01Icon,
  SearchAddIcon,
  SearchMinusIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Panel, useReactFlow, useViewport } from '@xyflow/react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

export function CanvasViewportControls() {
  const { t } = useTranslation()
  const flow = useReactFlow()
  const viewport = useViewport()
  return (
    <Panel position='bottom-left' className='!m-3'>
      <div
        className='bg-background flex items-center gap-1 rounded-xl border p-1 shadow-sm'
        role='group'
        aria-label={t('Canvas zoom')}
      >
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          title={t('Zoom out')}
          aria-label={t('Zoom out')}
          disabled={viewport.zoom <= 0.1}
          onClick={() => {
            void flow.zoomOut()
          }}
        >
          <HugeiconsIcon icon={SearchMinusIcon} size={16} aria-hidden='true' />
        </Button>
        <output
          className='min-w-12 text-center font-mono text-xs'
          aria-label={t('Zoom level')}
        >
          {Math.round(viewport.zoom * 100)}%
        </output>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          title={t('Zoom in')}
          aria-label={t('Zoom in')}
          disabled={viewport.zoom >= 4}
          onClick={() => {
            void flow.zoomIn()
          }}
        >
          <HugeiconsIcon icon={SearchAddIcon} size={16} aria-hidden='true' />
        </Button>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          title={t('Fit canvas')}
          aria-label={t('Fit canvas')}
          onClick={() => {
            void flow.fitView({ padding: 0.2, maxZoom: 1 })
          }}
        >
          <HugeiconsIcon icon={Maximize01Icon} size={16} aria-hidden='true' />
        </Button>
      </div>
    </Panel>
  )
}

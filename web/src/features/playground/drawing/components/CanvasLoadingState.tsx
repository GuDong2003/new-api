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

import { Spinner } from '@/components/ui/spinner'

// Opening a canvas used to replace the view with a bare panel, so arriving from
// a gallery image felt like a jump into nothing. Drawing the canvas surface
// itself keeps the destination recognisable while its images download, and the
// count says how much of the wait is left. React Flow is not mounted yet, so
// the grid is drawn here rather than with <CanvasBackground />; both use the
// same spacing and colour.
export function CanvasLoadingState(props: {
  progress?: { loaded: number; total: number }
}) {
  const { t } = useTranslation()
  const total = props.progress?.total ?? 0
  return (
    <div
      role='status'
      aria-live='polite'
      className='bg-muted/25 flex size-full items-center justify-center'
      style={{
        backgroundImage:
          'radial-gradient(color-mix(in oklch, var(--muted-foreground) 35%, transparent) 1.5px, transparent 1.5px)',
        backgroundSize: '20px 20px',
      }}
    >
      <div className='bg-background/90 flex items-center gap-2.5 rounded-xl border px-4 py-3 shadow-sm'>
        <Spinner className='size-4' aria-hidden='true' />
        <span className='text-sm'>{t('Loading canvas…')}</span>
        {total > 0 ? (
          <span className='text-muted-foreground font-mono text-xs'>
            {props.progress?.loaded ?? 0}/{total}
          </span>
        ) : null}
      </div>
    </div>
  )
}

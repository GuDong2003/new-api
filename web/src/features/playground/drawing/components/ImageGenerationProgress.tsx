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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ImageGenerationProgress as GenerationProgress } from '../types'

export function ImageGenerationProgress(props: {
  progress: GenerationProgress
}) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const seconds = Math.max(
    0,
    Math.floor((now - props.progress.startedAt) / 1000)
  )
  const status =
    props.progress.phase === 'decoding'
      ? t('Preparing image…')
      : t('Generating image…')
  return (
    <div className='w-full space-y-2'>
      <p role='status'>{status}</p>
      <div
        role='progressbar'
        aria-label={status}
        aria-valuetext={status}
        className='bg-primary/15 h-1.5 overflow-hidden rounded-full'
      >
        <div className='bg-primary h-full w-1/3 rounded-full motion-safe:animate-[drawing-generation-progress_1.5s_linear_infinite] motion-reduce:w-full motion-reduce:opacity-50' />
      </div>
      <p className='text-muted-foreground tabular-nums'>
        {t('Elapsed: {{seconds}}s', { seconds })}
      </p>
      {props.progress.previewCount > 0 && (
        <p>
          {t('Previews received: {{count}}', {
            count: props.progress.previewCount,
          })}
        </p>
      )}
    </div>
  )
}

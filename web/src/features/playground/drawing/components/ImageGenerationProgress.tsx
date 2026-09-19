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
import { useEffect, useState, type CSSProperties } from 'react'
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
  // The flare sweeps behind one word, so the label is split into letters that
  // light up in turn. Delays are derived from the word rather than fixed, so a
  // translation of any length still animates end to end.
  const word =
    props.progress.phase === 'decoding' ? t('Preparing') : t('Generating')
  // A word repeats letters, so each one is identified by its position, and its
  // delay is spread across the word rather than fixed: a translation of any
  // length still lights up end to end.
  const letters = [...word].map((letter, index, all) => ({
    id: `${index}-${letter}`,
    letter: letter === ' ' ? '\u00a0' : letter,
    delay: `${(0.1 + index / all.length).toFixed(3)}s`,
  }))
  return (
    <div className='w-full space-y-1.5'>
      <div
        role='status'
        aria-label={status}
        className='drawing-generation h-6 text-sm'
      >
        <span className='sr-only'>{status}</span>
        {letters.map((item) => (
          <span
            key={item.id}
            aria-hidden='true'
            className='drawing-generation-letter'
            style={
              { '--drawing-generation-delay': item.delay } as CSSProperties
            }
          >
            {item.letter}
          </span>
        ))}
        <span className='drawing-generation-flare' aria-hidden='true' />
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

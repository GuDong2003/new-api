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

/** When the first letter lights, and how long the wave takes to reach the last. */
const LETTER_START = 0.1
const LETTER_WAVE = 0.945

// Elapsed time sits in the card header, clear of the animation. It owns its own
// tick so a running generation does not re-render the whole node every second.
export function ImageGenerationElapsed(props: { startedAt: number }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - props.startedAt) / 1000))
  return (
    <span className='text-muted-foreground font-mono text-[10px] tabular-nums'>
      {t('Elapsed: {{seconds}}s', { seconds })}
    </span>
  )
}

export function ImageGenerationProgress(props: {
  progress: GenerationProgress
}) {
  const { t } = useTranslation()
  const status =
    props.progress.phase === 'decoding'
      ? t('Preparing image…')
      : t('Generating image…')
  const word =
    props.progress.phase === 'decoding' ? t('Preparing') : t('Generating')
  // The word lights up left to right over one span, which the colour behind it
  // is timed against. Holding the span rather than the step per letter is what
  // keeps the two together: a translation of another length spreads its letters
  // over the same time instead of racing ahead of the colour or trailing it.
  // Ten letters reproduce the original 0.105s stagger exactly.
  const characters = [...word]
  const step = characters.length > 1 ? LETTER_WAVE / (characters.length - 1) : 0
  const letters = characters.map((letter, index) => ({
    id: `${index}-${letter}`,
    letter: letter === ' ' ? '\u00a0' : letter,
    delay: `${(LETTER_START + index * step).toFixed(3)}s`,
  }))
  return (
    <div className='flex size-full min-h-0 flex-col justify-center gap-1'>
      <div role='status' aria-label={status} className='drawing-generation'>
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
      {props.progress.previewCount > 0 && (
        <p className='shrink-0'>
          {t('Previews received: {{count}}', {
            count: props.progress.previewCount,
          })}
        </p>
      )}
    </div>
  )
}

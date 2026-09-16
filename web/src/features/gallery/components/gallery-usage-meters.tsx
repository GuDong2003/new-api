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

import { LearnMore } from '@/components/learn-more'
import { cn } from '@/lib/utils'

import type { GalleryUsage } from '../types'

const BYTES_PER_MIB = 1048576
/** Above this share the quota is worth noticing; above the second it is urgent. */
const USAGE_WARNING = 70
const USAGE_DANGER = 90

function usageShare(used: number, max: number) {
  if (!(max > 0)) return 0
  return Math.min(100, Math.max(0, (used / max) * 100))
}

function usageFill(share: number) {
  if (share >= USAGE_DANGER) return 'bg-destructive'
  if (share >= USAGE_WARNING) return 'bg-warning'
  return 'bg-success'
}

/**
 * One quota line: label, bar and reading on a single row. The shared Progress
 * component renders its own track and indicator with no way to recolour the
 * fill, so these bars are built here to signal how full the quota is.
 */
function UsageMeter(props: {
  label: string
  used: number
  max: number
  text: string
}) {
  const share = usageShare(props.used, props.max)
  return (
    <div className='flex min-w-0 items-center gap-2'>
      <span className='text-muted-foreground w-12 shrink-0 truncate text-xs'>
        {props.label}
      </span>
      <div
        role='progressbar'
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={props.max}
        aria-valuenow={props.used}
        aria-valuetext={props.text}
        className='bg-muted h-2 min-w-16 flex-1 overflow-hidden rounded-full'
      >
        <div
          className={cn('h-full rounded-full transition-all', usageFill(share))}
          style={{ width: `${share}%` }}
        />
      </div>
      <span className='text-muted-foreground shrink-0 text-center text-xs tabular-nums sm:w-28'>
        {props.text}
      </span>
    </div>
  )
}

/**
 * Gallery quota, shown between the view switcher and the toolbar controls so it
 * costs no vertical space of its own. Both meters stack into the height the
 * switcher already occupies.
 */
export function GalleryUsageMeters(props: { usage: GalleryUsage }) {
  const { t } = useTranslation()
  const usedMiB = props.usage.used_bytes / BYTES_PER_MIB
  const maxMiB = props.usage.max_bytes / BYTES_PER_MIB
  return (
    <section
      aria-label={t('Gallery usage')}
      className='flex w-full items-center gap-2 sm:w-auto sm:max-w-md sm:min-w-0 sm:flex-1'
    >
      <div className='flex min-w-0 flex-1 flex-col gap-1'>
        <UsageMeter
          label={t('Images')}
          used={props.usage.used_images}
          max={props.usage.max_images}
          text={`${props.usage.used_images} / ${props.usage.max_images}`}
        />
        <UsageMeter
          label={t('Storage')}
          used={props.usage.used_bytes}
          max={props.usage.max_bytes}
          text={`${usedMiB.toFixed(1)} / ${maxMiB.toFixed(0)} MiB`}
        />
      </div>
      <LearnMore contentProps={{ className: 'text-xs' }}>
        <p>
          {t(
            'New images expire after {{days}} days. Originals, thumbnails and metadata all count toward storage.',
            { days: props.usage.retention_days }
          )}
        </p>
        <p className='mt-1'>
          {t(
            'References count as originals. Thumbnails, masks and canvas documents share the byte quota. Cloud expiry keeps local drafts.'
          )}
        </p>
      </LearnMore>
    </section>
  )
}

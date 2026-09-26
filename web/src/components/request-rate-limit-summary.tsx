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

import { toIntlLocale } from '@/i18n/languages'
import {
  describeRequestRateLimit,
  requestRateLimitSourceLabel,
  type UserRequestRateLimit,
} from '@/lib/request-rate-limit'
import { cn } from '@/lib/utils'

type RequestRateLimitSummaryProps = {
  limit: UserRequestRateLimit
  className?: string
}

/**
 * A user's request limit in two lines: the caps, then the period and where the
 * limit comes from.
 */
export function RequestRateLimitSummary(props: RequestRateLimitSummaryProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const text = describeRequestRateLimit(
    props.limit,
    props.limit.duration_minutes,
    t,
    locale
  )

  return (
    <div className={cn('min-w-0 space-y-0.5', props.className)}>
      <div className='truncate text-sm tabular-nums'>
        {text.requests} · {text.successes}
      </div>
      <div className='text-muted-foreground truncate text-xs'>
        {[text.period, requestRateLimitSourceLabel(props.limit.source, t)]
          .filter(Boolean)
          .join(' · ')}
        {props.limit.raised && (
          <>
            {' · '}
            <span className='text-success'>{t('Raised by subscription')}</span>
          </>
        )}
      </div>
    </div>
  )
}

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
import type { TFunction } from 'i18next'
import { z } from 'zod'

import { formatNumber } from '@/lib/format'

/** The largest cap the request limit inputs accept. */
export const REQUEST_RATE_LIMIT_MAX = 100_000_000

export const userRequestRateLimitSchema = z.object({
  count: z.number(),
  success_count: z.number(),
  duration_minutes: z.number(),
  source: z.enum(['user', 'group', 'default']),
  raised: z.boolean(),
})

/**
 * The request limit a user is held to in each rate limit period, as the server
 * describes it: `count` caps every request, failures included, and
 * `success_count` caps successful ones; 0 is no cap.
 */
export type UserRequestRateLimit = z.infer<typeof userRequestRateLimitSchema>

/** A request limit as the server stores it. Both caps at 0 is no limit. */
export type RequestRateLimitCaps = {
  count: number
  success_count: number
}

/** The request limit form fields: a switch, then the two caps while it is on. */
export const requestRateLimitFieldsSchema = z.object({
  enabled: z.boolean(),
  count: z.number().int().min(0).max(REQUEST_RATE_LIMIT_MAX),
  success_count: z.number().int().min(1).max(REQUEST_RATE_LIMIT_MAX),
})

export type RequestRateLimitFieldsValues = z.infer<
  typeof requestRateLimitFieldsSchema
>

/**
 * Fills the form fields from a stored limit. Without one the switch starts off
 * and the caps start from `fallback`, the limit that applies meanwhile.
 */
export function requestRateLimitFields(
  caps: RequestRateLimitCaps | null | undefined,
  fallback?: RequestRateLimitCaps
): RequestRateLimitFieldsValues {
  if (caps && caps.success_count > 0) {
    return {
      enabled: true,
      count: caps.count,
      success_count: caps.success_count,
    }
  }
  return {
    enabled: false,
    count: fallback?.count ?? 0,
    success_count: Math.max(fallback?.success_count ?? 1, 1),
  }
}

/** The limit to store for the form fields; the switch off stores none. */
export function requestRateLimitCaps(
  fields: RequestRateLimitFieldsValues
): RequestRateLimitCaps {
  if (!fields.enabled) return { count: 0, success_count: 0 }
  return { count: fields.count, success_count: fields.success_count }
}

const REQUEST_RATE_LIMIT_SOURCE_LABELS: Record<
  UserRequestRateLimit['source'],
  string
> = {
  user: 'Personal',
  group: 'Group',
  default: 'Default',
}

/** Names where a user's request limit comes from. */
export function requestRateLimitSourceLabel(
  source: UserRequestRateLimit['source'],
  t: TFunction
): string {
  return t(REQUEST_RATE_LIMIT_SOURCE_LABELS[source])
}

/**
 * The parts a request limit is shown in. The period is left out when it is
 * not known.
 */
export function describeRequestRateLimit(
  caps: RequestRateLimitCaps,
  durationMinutes: number | undefined,
  t: TFunction,
  locale?: string
) {
  return {
    requests:
      caps.count > 0
        ? t('{{value}} requests', { value: formatNumber(caps.count, locale) })
        : t('Unlimited requests'),
    successes:
      caps.success_count > 0
        ? t('{{value}} successful', {
            value: formatNumber(caps.success_count, locale),
          })
        : t('Unlimited successes'),
    period:
      durationMinutes && durationMinutes > 0
        ? t('Every {{minutes}} min', { minutes: durationMinutes })
        : undefined,
  }
}

/** A request limit in one line, such as the one a plan raises to. */
export function formatRequestRateLimit(
  caps: RequestRateLimitCaps,
  durationMinutes: number | undefined,
  t: TFunction,
  locale?: string
): string {
  const text = describeRequestRateLimit(caps, durationMinutes, t, locale)
  return [text.requests, text.successes, text.period]
    .filter(Boolean)
    .join(' · ')
}

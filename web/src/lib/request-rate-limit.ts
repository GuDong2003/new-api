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

import { formatNumber } from '@/lib/format'

/** The largest RPM the inputs accept. */
export const RPM_MAX = 100_000_000

/**
 * A request limit as the server stores it: a cap on every request, failures
 * included, and one on successful requests. A cap of 0 is off.
 */
export type RequestRateLimitCaps = {
  count: number
  success_count: number
}

/**
 * How many requests a stored limit admits each minute: the stricter of its
 * caps, or 0 when it caps neither.
 */
export function rpmOfCaps(caps: RequestRateLimitCaps): number {
  if (caps.count === 0) return caps.success_count
  if (caps.success_count === 0) return caps.count
  return Math.min(caps.count, caps.success_count)
}

/** The limit that admits `rpm` requests each minute; 0 is no limit. */
export function capsOfRpm(rpm: number): RequestRateLimitCaps {
  return { count: rpm, success_count: rpm }
}

/** Shows an RPM, or that there is no limit. */
export function formatRpm(rpm: number, t: TFunction, locale?: string): string {
  return rpm > 0 ? formatNumber(rpm, locale) : t('Unlimited')
}

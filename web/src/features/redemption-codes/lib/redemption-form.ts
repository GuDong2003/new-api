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

import { parseQuotaFromDollars, quotaUnitsToEditableAmount } from '@/lib/format'

import {
  REDEMPTION_VALIDATION,
  getRedemptionFormErrorMessages,
} from '../constants'
import type { RedemptionFormData, Redemption } from '../types'
import { isSharedRedemption } from './utils'

// ============================================================================
// Form Schema (use getRedemptionFormSchema(t) in components for i18n messages)
// ============================================================================

export function getRedemptionFormSchema(t: TFunction) {
  const msg = getRedemptionFormErrorMessages(t)
  return z
    .object({
      name: z
        .string()
        .min(REDEMPTION_VALIDATION.NAME_MIN_LENGTH, msg.NAME_LENGTH_INVALID)
        .max(REDEMPTION_VALIDATION.NAME_MAX_LENGTH, msg.NAME_LENGTH_INVALID),
      quota_dollars: z.number().min(0, t('Quota must be a positive number')),
      expired_time: z.date().optional(),
      // Checked below only for one-time codes; a shared code is one code
      count: z.number().optional(),
      kind: z.enum(['one_time', 'shared']),
      batch_one_per_user: z.boolean(),
      max_uses: z.number().int(),
      // Accounts that already redeemed the code; the limit cannot go lower
      used_count: z.number(),
    })
    .superRefine((data, ctx) => {
      if (data.kind === 'one_time') {
        const count = data.count ?? 1
        if (
          count < REDEMPTION_VALIDATION.COUNT_MIN ||
          count > REDEMPTION_VALIDATION.COUNT_MAX
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['count'],
            message: msg.COUNT_INVALID,
          })
        }
        return
      }
      const min = Math.max(
        REDEMPTION_VALIDATION.SHARED_MAX_USES_MIN,
        data.used_count
      )
      if (data.max_uses < min) {
        ctx.addIssue({
          code: 'custom',
          path: ['max_uses'],
          message: t('Enter at least {{min}}', { min }),
        })
      }
      if (data.max_uses > REDEMPTION_VALIDATION.SHARED_MAX_USES_MAX) {
        ctx.addIssue({
          code: 'custom',
          path: ['max_uses'],
          message: t('Enter at most {{max}}', {
            max: REDEMPTION_VALIDATION.SHARED_MAX_USES_MAX,
          }),
        })
      }
    })
}

// One-time codes work once each; a shared code serves several accounts
export type RedemptionKind = 'one_time' | 'shared'

export type RedemptionFormValues = {
  name: string
  quota_dollars: number
  expired_time?: Date
  count?: number
  kind: RedemptionKind
  batch_one_per_user: boolean
  max_uses: number
  used_count: number
}

// ============================================================================
// Form Defaults
// ============================================================================

export const REDEMPTION_FORM_DEFAULT_VALUES: RedemptionFormValues = {
  name: '',
  quota_dollars: 10,
  expired_time: undefined,
  count: 1,
  kind: 'one_time',
  batch_one_per_user: true,
  max_uses: 100,
  used_count: 0,
}

// ============================================================================
// Form Data Transformation
// ============================================================================

/**
 * Transform form data to the payload that creates codes
 */
export function transformFormDataToPayload(
  data: RedemptionFormValues
): RedemptionFormData {
  const shared = data.kind === 'shared'
  const count = shared ? 1 : data.count || 1
  return {
    name: data.name,
    quota: parseQuotaFromDollars(data.quota_dollars),
    expired_time: data.expired_time
      ? Math.floor(data.expired_time.getTime() / 1000)
      : 0,
    count,
    max_uses: shared ? data.max_uses : 1,
    // The batch rule means nothing for a batch of one code
    batch_one_per_user: !shared && count > 1 && data.batch_one_per_user,
  }
}

/**
 * Transform redemption data to form defaults
 */
export function transformRedemptionToFormDefaults(
  redemption: Redemption
): RedemptionFormValues {
  return {
    name: redemption.name,
    quota_dollars: quotaUnitsToEditableAmount(redemption.quota),
    expired_time:
      redemption.expired_time > 0
        ? new Date(redemption.expired_time * 1000)
        : undefined,
    count: 1,
    kind: isSharedRedemption(redemption) ? 'shared' : 'one_time',
    batch_one_per_user: redemption.batch_one_per_user,
    max_uses: redemption.max_uses,
    used_count: redemption.used_count,
  }
}

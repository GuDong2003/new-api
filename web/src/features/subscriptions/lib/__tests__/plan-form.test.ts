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
import i18next from 'i18next'
import { describe, expect, it } from 'vitest'

import type { SubscriptionPlan } from '../../types'
import {
  formValuesToPlanPayload,
  getPlanFormSchema,
  planToFormValues,
} from '../plan-form'

const plan: SubscriptionPlan = {
  id: 3,
  title: 'Pro',
  price_amount: 10,
  currency: 'USD',
  duration_unit: 'month',
  duration_value: 1,
  quota_reset_period: 'never',
  enabled: true,
  sort_order: 0,
  allow_balance_pay: true,
  allow_wallet_overflow: true,
  max_purchase_per_user: 0,
  total_amount: 0,
  rate_limit_count: 0,
  rate_limit_success_count: 0,
}

describe('plan form request limit raise', () => {
  it('turns on for a plan that raises the limit and sends its caps back', () => {
    const values = planToFormValues({
      ...plan,
      rate_limit_count: 60,
      rate_limit_success_count: 30,
    })
    expect(values.rate_limit).toEqual({
      enabled: true,
      count: 60,
      success_count: 30,
    })
    const payload = formValuesToPlanPayload(values)
    expect(payload.plan).toMatchObject({
      rate_limit_count: 60,
      rate_limit_success_count: 30,
    })
    expect(payload.plan).not.toHaveProperty('rate_limit')
  })

  it('sends no raise once switched off', () => {
    const values = planToFormValues(plan)
    expect(values.rate_limit.enabled).toBe(false)
    expect(formValuesToPlanPayload(values).plan).toMatchObject({
      rate_limit_count: 0,
      rate_limit_success_count: 0,
    })
  })

  it('rejects a raise without a success cap', () => {
    const result = getPlanFormSchema(i18next.t.bind(i18next)).safeParse({
      ...planToFormValues(plan),
      rate_limit: { enabled: true, count: 10, success_count: 0 },
    })
    expect(result.success).toBe(false)
  })
})

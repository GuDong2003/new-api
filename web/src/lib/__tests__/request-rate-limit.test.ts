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

import {
  formatRequestRateLimit,
  requestRateLimitCaps,
  requestRateLimitFields,
} from '../request-rate-limit'

const t = i18next.t.bind(i18next)

describe('request limit form fields', () => {
  it('start switched on with the caps of a stored limit', () => {
    expect(
      requestRateLimitFields(
        { count: 30, success_count: 20 },
        { count: 5, success_count: 5 }
      )
    ).toEqual({ enabled: true, count: 30, success_count: 20 })
  })

  it('start switched off from the limit that applies meanwhile when none is stored', () => {
    expect(
      requestRateLimitFields(
        { count: 0, success_count: 0 },
        { count: 5, success_count: 4 }
      )
    ).toEqual({ enabled: false, count: 5, success_count: 4 })
  })

  it('keep the success cap at least 1 when the limit meanwhile has none', () => {
    expect(
      requestRateLimitFields(null, { count: 0, success_count: 0 })
    ).toEqual({ enabled: false, count: 0, success_count: 1 })
  })

  it('store no limit while switched off and the caps while on', () => {
    expect(
      requestRateLimitCaps({ enabled: false, count: 30, success_count: 20 })
    ).toEqual({ count: 0, success_count: 0 })
    expect(
      requestRateLimitCaps({ enabled: true, count: 0, success_count: 20 })
    ).toEqual({ count: 0, success_count: 20 })
  })
})

describe('request limit text', () => {
  it('names an uncapped request count and the period', () => {
    expect(
      formatRequestRateLimit({ count: 0, success_count: 1000 }, 1, t, 'en')
    ).toBe('Unlimited requests · 1,000 successful · Every 1 min')
  })

  it('leaves the period out when it is not known', () => {
    expect(
      formatRequestRateLimit({ count: 60, success_count: 30 }, undefined, t)
    ).toBe('60 requests · 30 successful')
  })
})

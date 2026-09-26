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

import { capsOfRpm, formatRpm, rpmOfCaps } from '../request-rate-limit'

const t = i18next.t.bind(i18next)

describe('RPM of a stored limit', () => {
  it.each([
    [{ count: 5, success_count: 5 }, 5],
    [{ count: 0, success_count: 9999 }, 9999],
    [{ count: 20, success_count: 0 }, 20],
    [{ count: 30, success_count: 20 }, 20],
    [{ count: 0, success_count: 0 }, 0],
  ])('reads %j as RPM %i', (caps, rpm) => {
    expect(rpmOfCaps(caps)).toBe(rpm)
  })

  it('stores an RPM as both caps', () => {
    expect(capsOfRpm(15)).toEqual({ count: 15, success_count: 15 })
  })

  it('shows an RPM, or that there is no limit', () => {
    expect(formatRpm(9999, t, 'en')).toBe('9,999')
    expect(formatRpm(0, t, 'en')).toBe('Unlimited')
  })
})

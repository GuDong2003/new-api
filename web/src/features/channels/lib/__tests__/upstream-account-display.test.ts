/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { describe, expect, test } from 'vitest'

import { shouldShowChannelCheckinAction } from '../upstream-account-display'

describe('channel upstream account action visibility', () => {
  test('hides check-in when only automatic balance refresh is enabled', () => {
    expect(
      shouldShowChannelCheckinAction({
        enabled: true,
        id: 1,
        supports_checkin: true,
        auto_checkin: false,
        auto_balance: true,
      })
    ).toBe(false)
  })

  test('shows check-in when automatic check-in is enabled and supported', () => {
    expect(
      shouldShowChannelCheckinAction({
        enabled: true,
        id: 1,
        supports_checkin: true,
        auto_checkin: true,
        auto_balance: true,
      })
    ).toBe(true)
  })
})

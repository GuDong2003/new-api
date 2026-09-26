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
import { describe, expect, it } from 'vitest'

import type { User } from '../../types'
import {
  transformFormDataToPayload,
  transformUserToFormDefaults,
} from '../user-form'

const user: User = {
  id: 7,
  username: 'alice',
  display_name: 'Alice',
  quota: 0,
  used_quota: 0,
  request_count: 0,
  group: 'vip',
  status: 1,
  role: 1,
  request_rpm: 10,
}

describe('user form RPM', () => {
  it('turns on with the RPM an administrator set for the user', () => {
    const values = transformUserToFormDefaults({
      ...user,
      setting: JSON.stringify({
        language: 'en',
        rate_limit: { count: 30, success_count: 30 },
      }),
    })
    expect(values.rpm_limit).toEqual({ enabled: true, rpm: 30 })
  })

  it('starts off from the RPM in effect when none is set for the user', () => {
    const values = transformUserToFormDefaults({
      ...user,
      setting: '{"language":"en"}',
    })
    expect(values.rpm_limit).toEqual({ enabled: false, rpm: 10 })
  })

  it('sends the RPM as both caps on update and clears it once switched off', () => {
    const values = transformUserToFormDefaults(user)
    expect(
      transformFormDataToPayload(
        { ...values, rpm_limit: { enabled: true, rpm: 50 } },
        user.id
      ).rate_limit
    ).toEqual({ count: 50, success_count: 50 })
    expect(transformFormDataToPayload(values, user.id).rate_limit).toEqual({
      count: 0,
      success_count: 0,
    })
  })

  it('leaves the RPM out when creating a user', () => {
    const values = transformUserToFormDefaults(user)
    expect(transformFormDataToPayload(values).rate_limit).toBeUndefined()
  })
})

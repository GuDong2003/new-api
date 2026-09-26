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
  request_rate_limit: {
    count: 10,
    success_count: 10,
    duration_minutes: 1,
    source: 'group',
    raised: false,
  },
}

describe('user form request limit', () => {
  it('turns on with the limit an administrator set for the user', () => {
    const values = transformUserToFormDefaults({
      ...user,
      setting: JSON.stringify({
        language: 'en',
        rate_limit: { count: 30, success_count: 20 },
      }),
    })
    expect(values.rate_limit).toEqual({
      enabled: true,
      count: 30,
      success_count: 20,
    })
  })

  it('starts off from the limit in effect when none is set for the user', () => {
    const values = transformUserToFormDefaults({
      ...user,
      setting: '{"language":"en"}',
    })
    expect(values.rate_limit).toEqual({
      enabled: false,
      count: 10,
      success_count: 10,
    })
  })

  it('sends the caps on update and none once switched off', () => {
    const values = transformUserToFormDefaults(user)
    expect(
      transformFormDataToPayload(
        {
          ...values,
          rate_limit: { enabled: true, count: 0, success_count: 50 },
        },
        user.id
      ).rate_limit
    ).toEqual({ count: 0, success_count: 50 })
    expect(transformFormDataToPayload(values, user.id).rate_limit).toEqual({
      count: 0,
      success_count: 0,
    })
  })

  it('leaves the request limit out when creating a user', () => {
    const values = transformUserToFormDefaults(user)
    expect(transformFormDataToPayload(values).rate_limit).toBeUndefined()
  })
})

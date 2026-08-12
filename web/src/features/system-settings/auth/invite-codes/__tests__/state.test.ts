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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { getInviteCodeState } from '../invite-code-state.ts'
import type { InviteCode } from '../types.ts'

const baseInviteCode: InviteCode = {
  id: 1,
  code_prefix: 'NAPI-ABCD',
  name: '',
  status: 1,
  max_uses: 2,
  used_count: 0,
  created_by: 1,
  created_time: 1,
  updated_time: 1,
  expired_time: 0,
}

describe('invitation code status shown to administrators', () => {
  test('shows enabled while uses remain and the code has not expired', () => {
    assert.equal(getInviteCodeState(baseInviteCode, 100), 'Enabled')
  })

  test('shows exhausted when the configured usage limit is reached', () => {
    assert.equal(
      getInviteCodeState({ ...baseInviteCode, used_count: 2 }, 100),
      'Exhausted'
    )
  })

  test('shows expired at the exact expiration timestamp', () => {
    assert.equal(
      getInviteCodeState({ ...baseInviteCode, expired_time: 100 }, 100),
      'Expired'
    )
  })

  test('shows disabled before other computed states and for unknown states', () => {
    for (const status of [0, 2]) {
      assert.equal(
        getInviteCodeState(
          {
            ...baseInviteCode,
            status,
            used_count: 2,
            expired_time: 50,
          },
          100
        ),
        'Disabled'
      )
    }
  })
})

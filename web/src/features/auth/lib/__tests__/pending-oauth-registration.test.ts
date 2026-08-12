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

import { isPendingOAuthRegistration } from '../../types.ts'

describe('pending OAuth registration response', () => {
  test('accepts a complete one-time registration challenge', () => {
    assert.equal(
      isPendingOAuthRegistration({
        require_invite_code: true,
        registration_token: 'registration-token',
        expires_at: 123,
      }),
      true
    )
  })

  test('rejects incomplete or ordinary authentication payloads', () => {
    assert.equal(
      isPendingOAuthRegistration({
        require_invite_code: true,
        registration_token: '',
        expires_at: 123,
      }),
      false
    )
    assert.equal(isPendingOAuthRegistration({ user: {}, session: {} }), false)
  })
})

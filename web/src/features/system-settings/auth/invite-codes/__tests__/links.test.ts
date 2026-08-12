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

import {
  buildInviteRegistrationLink,
  buildInviteRegistrationLinks,
} from '../invite-code-links.ts'

describe('invitation registration links', () => {
  test('builds an absolute sign-up URL with an encoded invitation code', () => {
    assert.equal(
      buildInviteRegistrationLink(
        'https://api.gudong226.com/admin',
        'NAPI-ABCD-EFGH-JKLM-NPQR'
      ),
      'https://api.gudong226.com/sign-up?invite=NAPI-ABCD-EFGH-JKLM-NPQR'
    )
  })

  test('builds one link for every generated code', () => {
    assert.deepEqual(
      buildInviteRegistrationLinks('https://example.com', [
        'NAPI-ONE',
        'NAPI-TWO',
      ]),
      [
        'https://example.com/sign-up?invite=NAPI-ONE',
        'https://example.com/sign-up?invite=NAPI-TWO',
      ]
    )
  })
})

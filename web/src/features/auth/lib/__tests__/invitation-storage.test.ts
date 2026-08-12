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
import { afterEach, describe, test } from 'node:test'

import {
  clearInvitationCode,
  getInvitationCode,
  saveInvitationCode,
} from '../storage.ts'

function installWindowStorage() {
  const values = new Map<string, string>()
  const localStorage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  } satisfies Storage
  Object.defineProperty(globalThis, 'window', {
    value: { sessionStorage: localStorage },
    configurable: true,
  })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('invitation code storage', () => {
  test('trims and persists a code for password and OAuth registration', () => {
    installWindowStorage()

    saveInvitationCode('  NAPI-ABCD-EFGH-JKLM-NPQR  ')

    assert.equal(getInvitationCode(), 'NAPI-ABCD-EFGH-JKLM-NPQR')
  })

  test('empty input and successful authentication clear stale codes', () => {
    installWindowStorage()
    saveInvitationCode('NAPI-ABCD-EFGH-JKLM-NPQR')

    saveInvitationCode('  ')
    assert.equal(getInvitationCode(), '')

    saveInvitationCode('NAPI-ABCD-EFGH-JKLM-NPQR')
    clearInvitationCode()
    assert.equal(getInvitationCode(), '')
  })
})

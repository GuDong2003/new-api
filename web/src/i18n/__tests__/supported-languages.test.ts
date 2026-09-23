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
import { expect, it } from 'vitest'

import { resources } from '../config'
import {
  convertDetectedLanguage,
  INTERFACE_LANGUAGE_OPTIONS,
  normalizeInterfaceLanguage,
} from '../languages'

it('offers only Simplified Chinese and English in the interface', () => {
  expect(INTERFACE_LANGUAGE_OPTIONS).toEqual([
    { code: 'zhCN', label: '简体中文' },
    { code: 'en', label: 'English' },
  ])
  expect(Object.keys(resources).sort()).toEqual(['en', 'zhCN'])
})

it.each([
  ['zhTW', 'zhCN'],
  ['zh-TW', 'zhCN'],
  ['zh-Hant', 'zhCN'],
  ['zh', 'zhCN'],
  ['fr', 'en'],
  ['ja', 'en'],
])('normalizes legacy language %s to %s', (value, expected) => {
  expect(normalizeInterfaceLanguage(value)).toBe(expected)
})

it.each([
  ['zh-Hant', 'zhCN'],
  ['zh-TW', 'zhCN'],
  ['zh-CN', 'zhCN'],
  ['fr-FR', 'fr-FR'],
])('maps detected browser language %s to %s', (value, expected) => {
  expect(convertDetectedLanguage(value)).toBe(expected)
})

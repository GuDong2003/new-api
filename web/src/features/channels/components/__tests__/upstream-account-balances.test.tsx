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
import { act, render, screen } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { expect, test } from 'vitest'

import { UpstreamAccountBalances } from '../upstream-account-balances'

const QUOTA_ACCOUNT = {
  account_id: 1,
  account_name: '主号',
  balance: 1234567.891,
  unit: 'QUOTA',
  updated_time: 100,
  status: 'healthy',
}

test.each([
  ['zhCN', '1,234,567.891 QUOTA'],
  ['zhTW', '1,234,567.891 QUOTA'],
  ['en', '1,234,567.891 QUOTA'],
  ['fr', '1 234 567,891 QUOTA'],
  ['ru', '1 234 567,891 QUOTA'],
  ['ja', '1,234,567.891 QUOTA'],
  ['vi', '1.234.567,891 QUOTA'],
  [
    'invalid_locale',
    `${(1234567.891).toLocaleString().replaceAll(/\s/g, ' ')} QUOTA`,
  ],
])(
  'shows an upstream quota balance for %s and follows a language switch',
  async (language, balance) => {
    const translations = createInstance()
    await translations.init({
      lng: language,
      fallbackLng: 'en',
      resources: Object.fromEntries(
        ['en', 'vi', language].map((code) => [code, { translation: {} }])
      ),
    })
    render(
      <I18nextProvider i18n={translations}>
        <UpstreamAccountBalances accounts={[QUOTA_ACCOUNT]} />
      </I18nextProvider>
    )

    expect(screen.getByRole('listitem')).toHaveTextContent(`主号${balance}`)

    await act(() => translations.changeLanguage('vi'))

    expect(screen.getByRole('listitem')).toHaveTextContent(
      '主号1.234.567,891 QUOTA'
    )
  }
)

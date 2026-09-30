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
import i18next from 'i18next'
import { afterEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import zh from '@/i18n/locales/zh.json'

import type { SystemStatus } from '../../types'
import { LegalConsent } from '../legal-consent'
import { TermsFooter } from '../terms-footer'

afterEach(async () => {
  await i18next.changeLanguage('en')
})

test.each([
  {
    variant: 'sign-in' as const,
    expected: '点击登录即表示你同意《用户协议》和《隐私政策》。',
  },
  {
    variant: 'sign-up' as const,
    expected: '创建账号即表示你同意《用户协议》和《隐私政策》。',
  },
])(
  'the $variant legal footer is fully translated',
  async ({ variant, expected }) => {
    i18next.addResourceBundle('zhCN', 'translation', zh.translation, true, true)
    await i18next.changeLanguage('zhCN')
    const view = render(
      <TermsFooter
        variant={variant}
        status={
          {
            user_agreement_enabled: true,
            privacy_policy_enabled: true,
          } as SystemStatus
        }
      />
    )
    expect(view.container).toHaveTextContent(expected)
    expect(screen.getByRole('link', { name: '《用户协议》' })).toHaveAttribute(
      'href',
      '/user-agreement'
    )
    expect(screen.getByRole('link', { name: '《隐私政策》' })).toHaveAttribute(
      'href',
      '/privacy-policy'
    )
  }
)

test('Chinese consent contains translated links and switches completely to English', async () => {
  i18next.addResourceBundle('en', 'translation', en.translation, true, true)
  i18next.addResourceBundle('zhCN', 'translation', zh.translation, true, true)
  await i18next.changeLanguage('zhCN')
  render(
    <LegalConsent
      status={
        {
          user_agreement_enabled: true,
          privacy_policy_enabled: true,
        } as SystemStatus
      }
      checked={false}
      onCheckedChange={vi.fn()}
    />
  )
  expect(screen.getByRole('checkbox')).toHaveAccessibleName(
    '我已阅读并同意《用户协议》和《隐私政策》。'
  )
  expect(screen.getByRole('link', { name: '《用户协议》' })).toHaveAttribute(
    'href',
    '/user-agreement'
  )
  expect(screen.getByRole('link', { name: '《隐私政策》' })).toHaveAttribute(
    'href',
    '/privacy-policy'
  )
  await act(() => i18next.changeLanguage('en'))
  expect(screen.getByRole('checkbox')).toHaveAccessibleName(
    'I have read and agree to the User Agreement and the Privacy Policy.'
  )
})

test.each([
  {
    user_agreement_enabled: true,
    privacy_policy_enabled: false,
    name: '我已阅读并同意《用户协议》。',
    href: '/user-agreement',
  },
  {
    user_agreement_enabled: false,
    privacy_policy_enabled: true,
    name: '我已阅读并同意《隐私政策》。',
    href: '/privacy-policy',
  },
])(
  'only the enabled legal document appears in the consent sentence',
  async (status) => {
    i18next.addResourceBundle('zhCN', 'translation', zh.translation, true, true)
    await i18next.changeLanguage('zhCN')
    render(
      <LegalConsent
        status={status as SystemStatus}
        checked={false}
        onCheckedChange={vi.fn()}
      />
    )
    expect(screen.getByRole('checkbox')).toHaveAccessibleName(status.name)
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link')).toHaveAttribute('href', status.href)
  }
)

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

import type { Channel } from '../../types'
import {
  CHANNEL_FORM_DEFAULT_VALUES,
  channelFormSchema,
  EMPTY_UPSTREAM_ACCOUNT,
  transformChannelToFormDefaults,
  transformFormDataToCreatePayload,
  transformFormDataToUpdatePayload,
  type UpstreamAccountFormValues,
} from '../channel-form'
import {
  formatLastCheckinTime,
  getUpstreamAuthTypeLabel,
} from '../upstream-account-display'

function newAccount(
  overrides: Partial<UpstreamAccountFormValues> = {}
): UpstreamAccountFormValues {
  return { ...EMPTY_UPSTREAM_ACCOUNT, credential: 'pass-token', ...overrides }
}

function upstreamForm(overrides: Record<string, unknown> = {}) {
  return {
    ...CHANNEL_FORM_DEFAULT_VALUES,
    name: '渠道 A',
    type: 8,
    base_url: 'https://upstream.example.com',
    key: 'test-key',
    models: 'gpt-5',
    upstream_accounts: [newAccount()],
    ...overrides,
  }
}

function savedChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    type: 8,
    settings: '{}',
    channel_info: {
      is_multi_key: false,
      multi_key_size: 0,
      multi_key_polling_index: 0,
      multi_key_mode: 'random',
    },
    ...overrides,
  } as Channel
}

function issuePaths(values: Record<string, unknown>): string[] {
  const result = channelFormSchema.safeParse(values)
  if (result.success) return []
  return result.error.issues.map((issue) => issue.path.join('.'))
}

describe('channel check-in accounts form', () => {
  test('sends every account with the channel Base URL and site settings', () => {
    const result = transformFormDataToCreatePayload(
      upstreamForm({
        upstream_account_site_type: 'anyrouter',
        upstream_account_balance_interval: 30,
        upstream_accounts: [
          newAccount({ name: '主号', user_id: 226 }),
          newAccount({ credential: 'cookie-b', auth_type: 'cookie' }),
        ],
      })
    )
    const configs = result.channel.upstream_account_configs

    expect(configs).toHaveLength(2)
    expect(configs?.[0]).toMatchObject({
      name: '主号',
      user_id: 226,
      credential: 'pass-token',
      base_url: 'https://upstream.example.com',
      site_type: 'anyrouter',
      balance_interval: 30,
    })
    expect(configs?.[1]).toMatchObject({
      name: '',
      user_id: 0,
      auth_type: 'cookie',
      credential: 'cookie-b',
      site_type: 'anyrouter',
    })
  })

  test('leaves out the credential of a saved account left empty, so the saved one is kept', () => {
    const payload = transformFormDataToUpdatePayload(
      upstreamForm({
        upstream_accounts: [newAccount({ id: 7, credential: '  ' })],
      }),
      1
    )

    expect(payload.upstream_account_configs?.[0].id).toBe(7)
    expect(payload.upstream_account_configs?.[0]).not.toHaveProperty(
      'credential'
    )
  })

  test('leaves the accounts out of an update that does not touch check-in', () => {
    const loaded = upstreamForm({
      upstream_accounts: [newAccount({ id: 7, credential: '' })],
    })

    const payload = transformFormDataToUpdatePayload(
      { ...loaded, weight: 9 },
      1,
      loaded
    )

    expect(payload.upstream_account_configs).toBeUndefined()
    expect(payload.upstream_account_loaded_ids).toBeUndefined()
  })

  test('sends the accounts once check-in or the channel address changes', () => {
    const loaded = upstreamForm({
      upstream_accounts: [newAccount({ id: 7, credential: '' })],
    })
    for (const changed of [
      { upstream_accounts: [newAccount({ id: 7, credential: 'new-token' })] },
      { upstream_account_balance_interval: 30 },
      { redeem_url: 'https://upstream.example.com/redeem' },
      { base_url: 'https://moved.example.com' },
    ]) {
      const payload = transformFormDataToUpdatePayload(
        { ...loaded, ...changed },
        1,
        loaded
      )

      expect(payload.upstream_account_configs).toHaveLength(1)
      // The server refuses the list if the accounts changed since loading.
      expect(payload.upstream_account_loaded_ids).toEqual([7])
    }
  })

  test('sends an empty list when every account is removed', () => {
    const payload = transformFormDataToUpdatePayload(
      upstreamForm({ upstream_accounts: [] }),
      1
    )

    expect(payload.upstream_account_configs).toEqual([])
  })

  test('uses the provider default Base URL when the channel leaves it blank', () => {
    const result = transformFormDataToCreatePayload(
      upstreamForm({ type: 1, base_url: '' })
    )

    expect(result.channel.upstream_account_configs?.[0].base_url).toBe(
      'https://api.openai.com'
    )
  })

  test('restores every saved account for editing, without credentials', () => {
    const values = transformChannelToFormDefaults(
      savedChannel({
        upstream_account_configs: [
          {
            enabled: true,
            id: 7,
            name: '主号',
            user_id: 226,
            auth_type: 'token',
            auto_checkin: true,
            site_type: 'anyrouter',
            balance_interval: 30,
          },
          {
            enabled: true,
            id: 9,
            name: '备用号',
            auth_type: 'cookie',
            auto_checkin: false,
          },
        ],
      })
    )

    expect(values.upstream_accounts).toEqual([
      {
        id: 7,
        name: '主号',
        auth_type: 'token',
        user_id: 226,
        credential: '',
        auto_checkin: true,
      },
      {
        id: 9,
        name: '备用号',
        auth_type: 'cookie',
        user_id: undefined,
        credential: '',
        auto_checkin: false,
      },
    ])
    expect(values.upstream_account_site_type).toBe('anyrouter')
    expect(values.upstream_account_balance_interval).toBe(30)
  })

  test('requires a credential for a new account only', () => {
    expect(
      issuePaths(
        upstreamForm({
          upstream_accounts: [
            newAccount({ id: 7, credential: '' }),
            newAccount({ credential: ' ' }),
          ],
        })
      )
    ).toEqual(['upstream_accounts.1.credential'])
  })

  test('requires a channel Base URL when accounts check in and no provider default exists', () => {
    expect(issuePaths(upstreamForm({ base_url: '  ' }))).toContain('base_url')
  })
})

describe('channel check-in pages form', () => {
  test('keeps the check-in pages in the channel settings without any account', () => {
    const result = transformFormDataToCreatePayload(
      upstreamForm({
        upstream_accounts: [],
        external_checkin_url: ' https://upstream.example.com/checkin ',
        redeem_url: 'https://upstream.example.com/redeem',
        open_redeem_with_checkin: true,
      })
    )

    expect(JSON.parse(result.channel.settings ?? '{}')).toMatchObject({
      external_checkin_url: 'https://upstream.example.com/checkin',
      redeem_url: 'https://upstream.example.com/redeem',
      open_redeem_with_checkin: true,
    })
    expect(result.channel.upstream_account_configs).toEqual([])
  })

  test('drops cleared check-in pages from the channel settings', () => {
    const result = transformFormDataToCreatePayload(
      upstreamForm({
        settings: JSON.stringify({
          external_checkin_url: 'https://upstream.example.com/checkin',
          open_redeem_with_checkin: true,
        }),
        external_checkin_url: '',
        open_redeem_with_checkin: false,
      })
    )
    const settings = JSON.parse(result.channel.settings ?? '{}')

    expect(settings).not.toHaveProperty('external_checkin_url')
    expect(settings).not.toHaveProperty('open_redeem_with_checkin')
  })

  test('restores the check-in pages of a channel without accounts', () => {
    const values = transformChannelToFormDefaults(
      savedChannel({
        settings: JSON.stringify({
          external_checkin_url: 'https://upstream.example.com/checkin',
        }),
      })
    )

    expect(values.external_checkin_url).toBe(
      'https://upstream.example.com/checkin'
    )
    expect(values.upstream_accounts).toEqual([])
  })

  test('rejects a check-in page that is not a web address', () => {
    expect(
      issuePaths(
        upstreamForm({
          upstream_accounts: [],
          external_checkin_url: 'javascript:alert(1)',
          redeem_url: 'https://upstream.example.com/redeem',
        })
      )
    ).toEqual(['external_checkin_url'])
  })
})

describe('check-in display helpers', () => {
  test('does not render a last check-in value when no check-in has occurred', () => {
    expect(formatLastCheckinTime(undefined)).toBeNull()
    expect(formatLastCheckinTime(0)).toBeNull()
  })

  test('formats the last check-in time when a record exists', () => {
    expect(formatLastCheckinTime(1_704_067_200)).toContain('2024')
  })

  test('uses a translated label for the selected upstream authentication type', () => {
    const translate = (key: string) =>
      key === 'Browser Cookie' ? '浏览器 Cookie' : '通行令牌'

    expect(getUpstreamAuthTypeLabel('cookie', translate)).toBe('浏览器 Cookie')
    expect(getUpstreamAuthTypeLabel('token', translate)).toBe('通行令牌')
  })
})

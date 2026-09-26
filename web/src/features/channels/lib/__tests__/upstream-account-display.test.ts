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

import type { Channel, ChannelUpstreamAccountConfig } from '../../types'
import {
  getChannelCheckinAccounts,
  getChannelCheckinLinks,
  summarizeChannelCheckins,
} from '../upstream-account-display'

type CheckinChannel = Pick<Channel, 'settings' | 'upstream_account_configs'>

function account(
  overrides: Partial<ChannelUpstreamAccountConfig>
): ChannelUpstreamAccountConfig {
  return {
    enabled: true,
    id: 1,
    supports_checkin: true,
    auto_checkin: true,
    auto_balance: true,
    ...overrides,
  }
}

describe('channel check-in accounts', () => {
  test('lists only the accounts that check in on schedule', () => {
    const channel: CheckinChannel = {
      settings: '{}',
      upstream_account_configs: [
        account({ id: 1 }),
        account({ id: 2, auto_checkin: false }),
        account({ id: 3, supports_checkin: false }),
        account({ id: 4 }),
      ],
    }

    expect(
      getChannelCheckinAccounts(channel).map((checkin) => checkin.id)
    ).toEqual([1, 4])
  })

  test('counts the accounts whose latest check-in succeeded, with the latest time', () => {
    const summary = summarizeChannelCheckins({
      upstream_account_configs: [
        account({
          id: 1,
          last_checkin_status: 'healthy',
          last_checkin_time: 100,
        }),
        account({
          id: 2,
          last_checkin_status: 'failed',
          last_checkin_time: 300,
        }),
        account({
          id: 3,
          last_checkin_status: 'healthy',
          last_checkin_time: 200,
        }),
      ],
    })

    expect(summary).toEqual({ lastCheckinTime: 300, succeeded: 2, total: 3 })
  })
})

describe('channel check-in pages', () => {
  test('links a channel without accounts to the pages in its settings', () => {
    expect(
      getChannelCheckinLinks({
        settings: JSON.stringify({
          external_checkin_url: 'https://site.example/checkin',
          redeem_url: 'https://site.example/redeem',
          open_redeem_with_checkin: true,
        }),
      })
    ).toEqual({
      externalCheckinUrl: 'https://site.example/checkin',
      redeemUrl: 'https://site.example/redeem',
      openRedeemWithCheckin: true,
    })
  })

  test('prefers the channel settings to the pages an account carries', () => {
    const links = getChannelCheckinLinks({
      settings: JSON.stringify({ redeem_url: 'https://site.example/redeem' }),
      upstream_account_configs: [
        account({ external_checkin_url: 'https://old.example/checkin' }),
      ],
    })

    expect(links.externalCheckinUrl).toBe('')
    expect(links.redeemUrl).toBe('https://site.example/redeem')
  })

  test('falls back to the first account for a channel saved before it kept the pages', () => {
    const links = getChannelCheckinLinks({
      settings: '{}',
      upstream_account_configs: [
        account({
          external_checkin_url: 'https://old.example/checkin',
          open_redeem_with_checkin: true,
        }),
        account({ id: 2, external_checkin_url: 'https://other.example' }),
      ],
    })

    expect(links).toEqual({
      externalCheckinUrl: 'https://old.example/checkin',
      redeemUrl: '',
      openRedeemWithCheckin: true,
    })
  })

  test('links nothing when the settings cannot be read and no account is bound', () => {
    expect(getChannelCheckinLinks({ settings: '{broken' })).toEqual({
      externalCheckinUrl: '',
      redeemUrl: '',
      openRedeemWithCheckin: false,
    })
  })
})

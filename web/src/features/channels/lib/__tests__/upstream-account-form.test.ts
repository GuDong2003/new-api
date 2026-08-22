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
  transformChannelToFormDefaults,
  transformFormDataToCreatePayload,
} from '../channel-form'
import {
  formatLastCheckinTime,
  getUpstreamAuthTypeLabel,
} from '../upstream-account-display'

function upstreamForm(overrides: Record<string, unknown> = {}) {
  return {
    ...CHANNEL_FORM_DEFAULT_VALUES,
    name: '渠道 A',
    type: 8,
    base_url: 'https://upstream.example.com',
    key: 'test-key',
    models: 'gpt-5',
    upstream_account_enabled: true,
    upstream_account_credential: 'pass-token',
    ...overrides,
  }
}

describe('channel upstream account form', () => {
  test('uses the channel name and Base URL for the upstream account payload', () => {
    const result = transformFormDataToCreatePayload(upstreamForm())
    const config = result.channel.upstream_account_config

    expect(config?.name).toBe('渠道 A')
    expect(config?.base_url).toBe('https://upstream.example.com')
  })

  test('includes the configured upstream user ID in the payload', () => {
    const result = transformFormDataToCreatePayload(
      upstreamForm({ upstream_account_user_id: 226 })
    )

    expect(result.channel.upstream_account_config?.user_id).toBe(226)
  })

  test('submits zero when the upstream user ID is left empty', () => {
    const result = transformFormDataToCreatePayload(
      upstreamForm({ upstream_account_user_id: undefined })
    )

    expect(result.channel.upstream_account_config?.user_id).toBe(0)
  })

  test('restores the configured upstream user ID when editing a channel', () => {
    const values = transformChannelToFormDefaults({
      type: 8,
      settings: '{}',
      upstream_account_config: {
        enabled: true,
        user_id: 226,
      },
      channel_info: {
        is_multi_key: false,
        multi_key_size: 0,
        multi_key_polling_index: 0,
        multi_key_mode: 'random',
      },
    } as Channel)

    expect(values.upstream_account_user_id).toBe(226)
  })

  test('uses the provider default Base URL when the channel leaves it blank', () => {
    const result = transformFormDataToCreatePayload(
      upstreamForm({ type: 1, base_url: '' })
    )

    expect(result.channel.upstream_account_config?.base_url).toBe(
      'https://api.openai.com'
    )
  })

  test('requires a channel Base URL when no provider default exists', () => {
    const result = channelFormSchema.safeParse(upstreamForm({ base_url: '  ' }))

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path[0] === 'base_url' &&
            issue.message === 'Base URL is required for this channel type'
        )
      ).toBe(true)
    }
  })

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

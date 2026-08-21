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

import {
  CHANNEL_FORM_DEFAULT_VALUES,
  channelFormSchema,
  transformFormDataToCreatePayload,
} from '../channel-form'

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
})

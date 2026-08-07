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

import type { Channel } from '../../types'
import {
  CHANNEL_FORM_DEFAULT_VALUES,
  buildSettingsJSON,
  transformChannelToFormDefaults,
} from '../channel-form'

describe('channel client identity settings', () => {
  test('writes distinct Codex profiles without losing existing settings', () => {
    const legacy = JSON.parse(
      buildSettingsJSON({
        ...CHANNEL_FORM_DEFAULT_VALUES,
        type: 57,
        settings: JSON.stringify({ disable_store: true }),
        disable_store: true,
      })
    )
    const compatible = JSON.parse(
      buildSettingsJSON({
        ...CHANNEL_FORM_DEFAULT_VALUES,
        type: 61,
        client_identity_version: '1.2.3',
        client_identity_platform: 'linux-x64',
      })
    )

    assert.equal(legacy.client_identity.profile, 'codex_legacy')
    assert.equal(legacy.disable_store, true)
    assert.equal(compatible.client_identity.profile, 'codex_compatibility')
    assert.equal(compatible.client_identity.version, '1.2.3')
    assert.equal(compatible.client_identity.platform, 'linux-x64')
  })

  test('round-trips a persisted CodeBuddy identity and platform', () => {
    const values = transformChannelToFormDefaults({
      type: 63,
      settings: JSON.stringify({
        client_identity: {
          client_type: 'codebuddy',
          profile: 'codebuddy',
          version: '5.3.8.34705286',
          platform: 'windows-x64',
        },
      }),
      channel_info: {
        is_multi_key: false,
        multi_key_size: 0,
        multi_key_polling_index: 0,
        multi_key_mode: 'random',
      },
    } as Channel)

    assert.equal(values.client_identity_client_type, 'codebuddy')
    assert.equal(values.client_identity_profile, 'codebuddy')
    assert.equal(values.client_identity_version, '5.3.8.34705286')
    assert.equal(values.client_identity_platform, 'windows-x64')
  })

  test('removes client identity when a channel changes to an unrelated type', () => {
    const settings = JSON.parse(
      buildSettingsJSON({
        ...CHANNEL_FORM_DEFAULT_VALUES,
        type: 1,
        settings: JSON.stringify({
          client_identity: { profile: 'codex_legacy', version: '1.2.3' },
          disable_store: true,
        }),
        disable_store: true,
      })
    )

    assert.equal(settings.client_identity, undefined)
    assert.equal(settings.disable_store, true)
  })
})

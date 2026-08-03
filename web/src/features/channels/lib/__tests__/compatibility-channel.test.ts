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
  CHANNEL_TYPE_CLAUDE_CODE,
  CHANNEL_TYPE_CODE_BUDDY,
  CHANNEL_TYPE_CODEX,
  CHANNEL_TYPE_OPTIONS,
  CODE_BUDDY_BASE_URL_HELP,
  MODEL_FETCHABLE_TYPES,
} from '../../constants'
import { CHANNEL_FORM_DEFAULT_VALUES, channelFormSchema } from '../channel-form'
import { getChannelTypeConfig } from '../channel-type-config'
import { getChannelTypeIcon, getKeyPromptForType } from '../channel-utils'

function compatibilityForm(type: number) {
  return {
    ...CHANNEL_FORM_DEFAULT_VALUES,
    name: 'Compatibility upstream',
    type,
    base_url: '',
    key: 'test-key',
    models: 'test-model',
  }
}

describe('compatibility channels', () => {
  test('registers Codex, Code Buddy, and Claude Code as selectable API key channel types', () => {
    assert.deepEqual(
      CHANNEL_TYPE_OPTIONS.find((item) => item.value === CHANNEL_TYPE_CODEX),
      { value: CHANNEL_TYPE_CODEX, label: 'Codex' }
    )
    assert.deepEqual(
      CHANNEL_TYPE_OPTIONS.find(
        (item) => item.value === CHANNEL_TYPE_CODE_BUDDY
      ),
      { value: CHANNEL_TYPE_CODE_BUDDY, label: 'Code Buddy' }
    )
    assert.deepEqual(
      CHANNEL_TYPE_OPTIONS.find(
        (item) => item.value === CHANNEL_TYPE_CLAUDE_CODE
      ),
      { value: CHANNEL_TYPE_CLAUDE_CODE, label: 'Claude Code' }
    )
    assert.equal(
      CHANNEL_TYPE_OPTIONS.findIndex(
        (item) => item.value === CHANNEL_TYPE_CODE_BUDDY
      ),
      CHANNEL_TYPE_OPTIONS.findIndex(
        (item) => item.value === CHANNEL_TYPE_CODEX
      ) + 1
    )
    assert.equal(MODEL_FETCHABLE_TYPES.has(CHANNEL_TYPE_CODEX), true)
    assert.equal(MODEL_FETCHABLE_TYPES.has(CHANNEL_TYPE_CODE_BUDDY), true)
    assert.equal(MODEL_FETCHABLE_TYPES.has(CHANNEL_TYPE_CLAUDE_CODE), true)
    assert.equal(getChannelTypeIcon(CHANNEL_TYPE_CODEX), 'OpenAI')
    assert.equal(getChannelTypeIcon(CHANNEL_TYPE_CODE_BUDDY), 'OpenAI')
    assert.equal(getChannelTypeIcon(CHANNEL_TYPE_CLAUDE_CODE), 'Claude')
    assert.equal(getChannelTypeConfig(CHANNEL_TYPE_CODEX).icon, 'openai')
    assert.equal(getChannelTypeConfig(CHANNEL_TYPE_CODE_BUDDY).icon, 'openai')
    assert.equal(
      getChannelTypeConfig(CHANNEL_TYPE_CODE_BUDDY).hints?.baseUrl,
      CODE_BUDDY_BASE_URL_HELP
    )
    assert.equal(
      getKeyPromptForType(CHANNEL_TYPE_CODE_BUDDY),
      'Enter API key for this channel'
    )
    assert.equal(
      getChannelTypeConfig(CHANNEL_TYPE_CLAUDE_CODE).icon,
      'anthropic'
    )
  })

  test('requires an explicit base URL for all compatibility channel types', () => {
    for (const type of [
      CHANNEL_TYPE_CODEX,
      CHANNEL_TYPE_CODE_BUDDY,
      CHANNEL_TYPE_CLAUDE_CODE,
    ]) {
      const result = channelFormSchema.safeParse(compatibilityForm(type))

      assert.equal(result.success, false)
      if (!result.success) {
        assert.equal(
          result.error.issues.some(
            (issue) =>
              issue.path[0] === 'base_url' &&
              issue.message === 'Base URL is required for this channel type'
          ),
          true
        )
      }
    }
  })

  test('accepts a direct WorkBuddy upstream root URL for Code Buddy', () => {
    const configuredResult = channelFormSchema.safeParse({
      ...compatibilityForm(CHANNEL_TYPE_CODE_BUDDY),
      base_url: 'http://127.0.0.1:13100',
    })

    assert.equal(configuredResult.success, true)
  })
})

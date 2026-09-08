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
import { describe, expect, test } from 'vitest'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import type {
  Message,
  ParameterEnabled,
  PlaygroundConfig,
} from '../../../types'
import { buildChatCompletionPayload } from '../payload-builder'

const messages: Message[] = [
  { key: 'm1', from: 'user', versions: [{ id: 'v1', content: 'hello' }] },
]

function buildPayload(
  config: Partial<PlaygroundConfig> = {},
  enabled: Partial<ParameterEnabled> = {}
) {
  return buildChatCompletionPayload(
    messages,
    { ...DEFAULT_CONFIG, ...config },
    { ...DEFAULT_PARAMETER_ENABLED, ...enabled }
  )
}

describe('buildChatCompletionPayload reasoning effort', () => {
  test('omits reasoning_effort while the parameter is disabled', () => {
    const payload = buildPayload(
      { reasoning_effort: 'high' },
      { reasoning_effort: false }
    )

    expect(payload).not.toHaveProperty('reasoning_effort')
  })

  test('sends reasoning_effort once the parameter is enabled', () => {
    const payload = buildPayload(
      { reasoning_effort: 'high' },
      { reasoning_effort: true }
    )

    expect(payload.reasoning_effort).toBe('high')
  })

  test('sends a custom level that is not one of the suggestions', () => {
    const payload = buildPayload(
      { reasoning_effort: 'ultra' },
      { reasoning_effort: true }
    )

    expect(payload.reasoning_effort).toBe('ultra')
  })

  test('omits reasoning_effort when the enabled value is blank', () => {
    const payload = buildPayload(
      { reasoning_effort: '   ' },
      { reasoning_effort: true }
    )

    expect(payload).not.toHaveProperty('reasoning_effort')
  })

  test('trims surrounding whitespace off the sent level', () => {
    const payload = buildPayload(
      { reasoning_effort: '  medium  ' },
      { reasoning_effort: true }
    )

    expect(payload.reasoning_effort).toBe('medium')
  })

  test('leaves reasoning_effort out of the default payload', () => {
    expect(buildPayload()).not.toHaveProperty('reasoning_effort')
  })
})

describe('buildChatCompletionPayload parameter gating', () => {
  test('sends only the parameters that are enabled', () => {
    const payload = buildPayload(
      { max_tokens: 512, seed: 7 },
      {
        temperature: true,
        top_p: false,
        max_tokens: true,
        frequency_penalty: false,
        presence_penalty: false,
        seed: true,
      }
    )

    expect(payload.temperature).toBe(DEFAULT_CONFIG.temperature)
    expect(payload.max_tokens).toBe(512)
    expect(payload.seed).toBe(7)
    expect(payload).not.toHaveProperty('top_p')
    expect(payload).not.toHaveProperty('frequency_penalty')
    expect(payload).not.toHaveProperty('presence_penalty')
  })

  test('omits the seed when it is enabled but unset', () => {
    const payload = buildPayload({ seed: null }, { seed: true })

    expect(payload).not.toHaveProperty('seed')
  })
})

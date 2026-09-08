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

import type { Channel } from '../../types'
import { buildDetailedChannelTestPayload } from '../channel-actions'
import {
  CHANNEL_PROBES,
  CHANNEL_PROBE_REASONS,
  CHANNEL_PROBE_STATUS_LABELS,
  ChannelProbeQueue,
  getProbeConfigurationKey,
  getProbeEndpointHint,
  isProbeNotApplicable,
} from '../channel-test'
import { parseChannelTestPreview } from '../channel-test-preview'

function channel(overrides: Partial<Channel> = {}): Channel {
  return { id: 7, name: 'probe', type: 1, ...overrides } as Channel
}

describe('capability probe payload', () => {
  test('sends the requested test type to the server', () => {
    const payload = buildDetailedChannelTestPayload({
      testModel: 'gpt-4o',
      endpointType: '',
      stream: true,
      testType: 'tool_call',
    })

    expect(payload.test_type).toBe('tool_call')
    expect(payload.stream).toBe(true)
  })

  test('omits the test type for a legacy pass/fail test', () => {
    const payload = buildDetailedChannelTestPayload({
      testModel: 'gpt-4o',
      endpointType: '',
      stream: false,
    })

    expect(payload).not.toHaveProperty('test_type')
  })
})

describe('probe endpoint hint', () => {
  test('classifies an embedding model without an explicit endpoint', () => {
    expect(
      getProbeEndpointHint(channel(), 'text-embedding-3-small', 'auto')
    ).toBe('embeddings')
  })

  test('follows a model mapping alias to the upstream model', () => {
    const mapped = channel({
      model_mapping: JSON.stringify({ 'my-alias': 'gpt-image-1' }),
    })

    expect(getProbeEndpointHint(mapped, 'my-alias', 'auto')).toBe(
      'image-generation'
    )
  })

  test('terminates on a model mapping that loops back on itself', () => {
    const looping = channel({
      model_mapping: JSON.stringify({ a: 'b', b: 'a' }),
    })

    expect(getProbeEndpointHint(looping, 'a', 'auto')).toBe('auto')
  })

  test('keeps an explicitly chosen endpoint', () => {
    expect(
      getProbeEndpointHint(channel(), 'text-embedding-3-small', 'openai')
    ).toBe('openai')
  })

  test('falls back to auto when the model mapping is not valid JSON', () => {
    const broken = channel({ model_mapping: '{not json' })

    expect(getProbeEndpointHint(broken, 'gpt-4o', 'auto')).toBe('auto')
  })
})

describe('probe applicability', () => {
  test('marks tool probes as not applicable for image generation', () => {
    expect(isProbeNotApplicable('image-generation', 'tool')).toBe(true)
    expect(isProbeNotApplicable('image-generation', 'tool-stream')).toBe(true)
  })

  test('keeps the basic probe applicable for image generation', () => {
    expect(isProbeNotApplicable('image-generation', 'basic')).toBe(false)
  })

  test('allows only the non-streaming probe for embeddings and rerank', () => {
    for (const endpoint of ['embeddings', 'jina-rerank']) {
      expect(isProbeNotApplicable(endpoint, 'basic')).toBe(false)
      expect(isProbeNotApplicable(endpoint, 'stream')).toBe(true)
      expect(isProbeNotApplicable(endpoint, 'tool')).toBe(true)
    }
  })
})

describe('probe configuration key', () => {
  const job = {
    model: 'gpt-4o',
    probe: 'basic' as const,
    endpoint: 'openai',
    message: 'hello',
  }

  test('changes when the channel base url changes', () => {
    const before = getProbeConfigurationKey(
      channel({ base_url: 'https://a.test' }),
      job
    )
    const after = getProbeConfigurationKey(
      channel({ base_url: 'https://b.test' }),
      job
    )

    expect(before).not.toBe(after)
  })

  test('changes when the one-run test message changes', () => {
    const before = getProbeConfigurationKey(channel(), job)
    const after = getProbeConfigurationKey(channel(), {
      ...job,
      message: 'other',
    })

    expect(before).not.toBe(after)
  })

  test('ignores the message for a tool probe, which supplies its own', () => {
    const before = getProbeConfigurationKey(channel(), {
      ...job,
      probe: 'tool',
      message: 'hello',
    })
    const after = getProbeConfigurationKey(channel(), {
      ...job,
      probe: 'tool',
      message: 'something else',
    })

    expect(before).toBe(after)
  })
})

describe('probe queue', () => {
  test('runs at most five probes at a time', async () => {
    const queue = new ChannelProbeQueue()
    let active = 0
    let peak = 0
    const release: Array<() => void> = []

    const jobs = Array.from({ length: 9 }, () =>
      queue.schedule(
        async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise<void>((resolve) => release.push(resolve))
          active -= 1
        },
        () => false
      )
    )

    // Let the queue fill before releasing anything.
    await Promise.resolve()
    await Promise.resolve()
    expect(peak).toBe(5)

    while (release.length > 0) {
      release.shift()?.()
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all(jobs)
    expect(peak).toBe(5)
  })

  test('never starts a probe that was cancelled while queued', async () => {
    const queue = new ChannelProbeQueue()
    let started = 0
    let cancelled = false

    const blockers: Array<() => void> = []
    const running = Array.from({ length: 5 }, () =>
      queue.schedule(
        () => new Promise<void>((resolve) => blockers.push(resolve)),
        () => false
      )
    )
    const pending = queue.schedule(
      async () => {
        started += 1
      },
      () => cancelled
    )

    cancelled = true
    queue.flushCancelled()
    await pending
    blockers.forEach((resolve) => resolve())
    await Promise.all(running)

    expect(started).toBe(0)
  })
})

describe('probe reason and status catalogue', () => {
  test('every probe has a label', () => {
    for (const probe of CHANNEL_PROBES) {
      expect(probe.labelKey.length).toBeGreaterThan(0)
    }
  })

  test('the compatibility stream verdict explains the faked stream', () => {
    expect(CHANNEL_PROBE_REASONS.compatibility_stream).toContain('SSE')
    expect(CHANNEL_PROBE_STATUS_LABELS.degraded).toBe('Compatibility stream')
  })
})

describe('probe response preview', () => {
  test('extracts assistant text from a non-streaming chat response', () => {
    const preview = parseChannelTestPreview(
      JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
      'openai'
    )

    expect(preview.text).toContain('pong')
  })

  test('joins streamed deltas into one text body', () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"po"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"ng"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')

    const preview = parseChannelTestPreview(raw, 'openai')

    expect(preview.text).toContain('pong')
  })

  test('surfaces the tool call a tool probe asked for', () => {
    const preview = parseChannelTestPreview(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call-1',
                  function: {
                    name: 'channel_test_echo',
                    arguments: '{"message":"ping"}',
                  },
                },
              ],
            },
          },
        ],
      }),
      'openai'
    )

    expect(preview.tools).toHaveLength(1)
    expect(preview.tools[0].name).toBe('channel_test_echo')
    expect(preview.tools[0].arguments).toContain('ping')
  })

  test('reports nothing readable for an unparsable body', () => {
    const preview = parseChannelTestPreview(
      '<html>gateway error</html>',
      'openai'
    )

    expect(preview.text).toBe('')
    expect(preview.tools).toHaveLength(0)
    expect(preview.images).toHaveLength(0)
  })
})

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

import type { Channel, ChannelTestDiagnostics } from '../types'
import { CHANNEL_TYPE_ADVANCED_CUSTOM } from './advanced-custom'

export const CHANNEL_PROBES = [
  { id: 'basic', labelKey: 'Non-streaming', testType: 'basic', stream: false },
  { id: 'stream', labelKey: 'Streaming', testType: 'basic', stream: true },
  {
    id: 'tool',
    labelKey: 'Tools · non-streaming',
    testType: 'tool_call',
    stream: false,
  },
  {
    id: 'tool-stream',
    labelKey: 'Tools · streaming',
    testType: 'tool_call',
    stream: true,
  },
] as const

export type ChannelProbeId = (typeof CHANNEL_PROBES)[number]['id']
export const CHANNEL_PROBE_BY_ID = {
  basic: CHANNEL_PROBES[0],
  stream: CHANNEL_PROBES[1],
  tool: CHANNEL_PROBES[2],
  'tool-stream': CHANNEL_PROBES[3],
} as const
export type ChannelProbeStatus =
  | ChannelTestDiagnostics['status']
  | 'queued'
  | 'running'
  | 'cancelled'

export type ChannelProbeJob = {
  model: string
  probe: ChannelProbeId
  endpoint: string
  message: string
  configurationKey: string
}

export type ChannelProbeResult = ChannelProbeJob & {
  status: ChannelProbeStatus
  completedAt?: number
  diagnostics?: ChannelTestDiagnostics
  error?: string
  errorCode?: string
  preview?: string
}

export type ChannelProbeResults = Record<
  string,
  Partial<Record<ChannelProbeId, ChannelProbeResult>>
>

export const CHANNEL_TEST_ENDPOINTS = [
  { value: 'auto', labelKey: 'Auto detect (default)', path: '' },
  { value: 'openai', labelKey: 'OpenAI Chat', path: '/v1/chat/completions' },
  {
    value: 'openai-response',
    labelKey: 'OpenAI Responses',
    path: '/v1/responses',
  },
  { value: 'anthropic', labelKey: 'Anthropic', path: '/v1/messages' },
  {
    value: 'gemini',
    labelKey: 'Gemini',
    path: '/v1beta/models/{model}:generateContent',
  },
  {
    value: 'image-generation',
    labelKey: 'Image Generation',
    path: '/v1/images/generations',
  },
  { value: 'embeddings', labelKey: 'Embeddings', path: '/v1/embeddings' },
  { value: 'jina-rerank', labelKey: 'Rerank', path: '/v1/rerank' },
  {
    value: 'openai-response-compact',
    labelKey: 'Response compaction',
    path: '/v1/responses/compact',
  },
] as const

export const CHANNEL_PROBE_REASONS: Record<string, string> = {
  response_validated: 'Valid response received',
  tool_validated: 'Tool name and arguments verified',
  compatibility_stream:
    'The gateway converted a non-streaming upstream response into SSE.',
  not_applicable: 'This test does not apply to this endpoint.',
  request_failed: 'The test request failed.',
  invalid_endpoint: 'No suitable test endpoint was found.',
  empty_response: 'The response body is empty.',
  invalid_json: 'The response contains invalid JSON.',
  invalid_response: 'The response does not match the expected format.',
  empty_output: 'No usable model output was returned.',
  upstream_error: 'The upstream returned an error.',
  invalid_stream: 'No valid SSE output was received.',
  incomplete_stream: 'The stream ended without a completion event.',
  stream_interrupted: 'The stream was interrupted.',
  stream_timeout: 'The stream timed out.',
  output_incomplete: 'The model output is incomplete.',
  output_blocked: 'The model did not complete the output.',
  tool_not_called: 'The model did not call the test tool.',
  unexpected_tool: 'The model called an unexpected tool.',
  invalid_tool_arguments: 'Tool arguments must contain only message: "ping".',
  response_too_large: 'The tool response exceeded the validation limit.',
  diagnostics_unavailable: 'The server did not return capability diagnostics.',
}

export const CHANNEL_PROBE_STATUS_LABELS: Record<
  ChannelProbeStatus | 'idle',
  string
> = {
  idle: 'Not tested',
  queued: 'Queued',
  running: 'Testing',
  passed: 'Passed',
  failed: 'Failed',
  degraded: 'Compatibility stream',
  skipped: 'Not applicable',
  cancelled: 'Stopped',
}

export function getProbeConfigurationKey(
  channel: Channel,
  job: Omit<ChannelProbeJob, 'configurationKey'>
): string {
  return JSON.stringify([
    channel.id,
    channel.type,
    channel.base_url,
    channel.model_mapping,
    channel.setting,
    channel.settings,
    channel.param_override,
    channel.header_override,
    job.model,
    job.probe,
    job.endpoint,
    job.probe === 'tool' || job.probe === 'tool-stream'
      ? ''
      : job.message.trim(),
  ])
}

// This is only a display hint. The API remains authoritative and resolves custom
// routes, mapped models and the actual endpoint before sending a probe upstream.
export function getProbeEndpointHint(
  channel: Channel,
  model: string,
  endpoint: string
): string {
  if (endpoint !== 'auto') return endpoint
  if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM) return 'auto'
  let name = model
  try {
    const mapping = JSON.parse(channel.model_mapping || '{}') as Record<
      string,
      unknown
    >
    const seen = new Set<string>()
    while (!seen.has(name)) {
      const mapped = mapping[name]
      if (typeof mapped !== 'string' || !mapped) break
      seen.add(name)
      name = mapped
    }
  } catch {
    return 'auto'
  }
  name = name.toLowerCase()
  if (name.endsWith('-compact')) return 'openai-response-compact'
  if (name.includes('rerank')) return 'jina-rerank'
  if (
    name.includes('embed') ||
    name.startsWith('m3e') ||
    name.includes('bge-')
  ) {
    return 'embeddings'
  }
  if (/gpt-image-|dall-e-|imagen-|flux[.-]|seedream/.test(name)) {
    return 'image-generation'
  }
  return 'auto'
}

export function isProbeNotApplicable(
  endpoint: string,
  probe: ChannelProbeId
): boolean {
  if (
    ['embeddings', 'jina-rerank', 'openai-response-compact'].includes(endpoint)
  ) {
    return probe !== 'basic'
  }
  return (
    endpoint === 'image-generation' &&
    (probe === 'tool' || probe === 'tool-stream')
  )
}

export function canDeleteProbeModel(
  results: Partial<Record<ChannelProbeId, ChannelProbeResult>> | undefined,
  endpoint: string,
  currentKey: (probe: ChannelProbeId) => string
): boolean {
  const basicProbes: ChannelProbeId[] = ['basic', 'stream']
  const applicable = basicProbes.filter(
    (probe) => !isProbeNotApplicable(endpoint, probe)
  )
  return (
    applicable.length > 0 &&
    applicable.every((probe) => {
      const result = results?.[probe]
      return (
        result?.status === 'failed' &&
        result.configurationKey === currentKey(probe) &&
        result.errorCode !== 'model_price_error' &&
        result.diagnostics?.reason !== 'invalid_endpoint'
      )
    })
  )
}

type QueuedProbe = {
  work: () => Promise<void>
  cancelled: () => boolean
  resolve: () => void
  reject: (reason: unknown) => void
}

// Shared across dialog sessions, so reopening cannot exceed five upstream calls
// while requests from the previous session are still finishing.
export class ChannelProbeQueue {
  private active = 0
  private pending: QueuedProbe[] = []

  schedule(work: () => Promise<void>, cancelled: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ work, cancelled, resolve, reject })
      this.drain()
    })
  }

  flushCancelled(): void {
    this.pending = this.pending.filter((job) => {
      if (!job.cancelled()) return true
      job.resolve()
      return false
    })
  }

  private drain(): void {
    while (this.active < 5 && this.pending.length > 0) {
      const job = this.pending.shift()
      if (!job) break
      if (job.cancelled()) {
        job.resolve()
        continue
      }
      this.active += 1
      void Promise.resolve()
        .then(job.work)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }
}

export const channelProbeQueue = new ChannelProbeQueue()

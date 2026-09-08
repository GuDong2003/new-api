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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios'

import { api } from '@/lib/api'

import { ChannelsProvider } from '../components/channels-provider'
import type {
  Channel,
  ChannelTestDiagnostics,
  DetailedChannelTestRequest,
} from '../types'
import { TestDialogHarness } from './channel-test-harness'

export type PendingChannelProbe = {
  body: DetailedChannelTestRequest
  reply: (status?: ChannelTestDiagnostics['status'], preview?: string) => void
  answered: boolean
}

export function channelTestApiFixture() {
  const previous = api.defaults.adapter
  const requests: PendingChannelProbe[] = []
  const mutations: unknown[] = []
  const adapter: AxiosAdapter = (config: InternalAxiosRequestConfig) => {
    if (!config.url?.includes('/api/channel/test/')) {
      if (config.data) mutations.push(JSON.parse(String(config.data)))
      return Promise.resolve({
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: { success: true },
      })
    }
    const body = JSON.parse(String(config.data)) as DetailedChannelTestRequest
    return new Promise<AxiosResponse>((resolve) => {
      const request: PendingChannelProbe = {
        body,
        answered: false,
        reply: (status = 'passed', preview) => {
          request.answered = true
          resolve({
            config,
            status: 200,
            statusText: 'OK',
            headers: {},
            data: {
              success: status === 'passed' || status === 'degraded',
              time: 0.042,
              response_preview: preview,
              diagnostics: {
                status,
                reason:
                  status === 'failed'
                    ? 'tool_not_called'
                    : 'response_validated',
                endpoint_type: body.endpoint_type || 'openai',
                test_type: body.test_type,
                requested_stream: body.stream,
                upstream_stream: status !== 'degraded',
                duration_ms: 42,
                first_response_ms: 12,
                event_count: body.stream ? 2 : 0,
                tool_count:
                  body.test_type === 'tool_call' && status === 'passed' ? 1 : 0,
              },
            },
          })
        },
      }
      requests.push(request)
    })
  }
  api.defaults.adapter = adapter
  return {
    requests,
    mutations,
    async finish() {
      await act(async () => {
        requests
          .filter((request) => !request.answered)
          .forEach((request) => request.reply())
      })
    },
    restore() {
      api.defaults.adapter = previous
    },
  }
}

export function renderChannelTest(models = ['gpt-4o']) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const channel = {
    id: 23,
    type: 1,
    name: 'Channel probe fixture',
    models: models.join(','),
    test_model: models[0],
  } as Channel
  const rendered = render(
    <QueryClientProvider client={client}>
      <ChannelsProvider>
        <TestDialogHarness channel={channel} />
      </ChannelsProvider>
    </QueryClientProvider>
  )
  return { ...rendered, client }
}

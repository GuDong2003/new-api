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
import type { Row } from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import type { Channel, ChannelUpstreamAccountConfig } from '../../types'
import { ChannelRowActionsLayoutContext } from '../channel-row-actions-context'
import { ChannelsProvider } from '../channels-provider'
import { DataTableRowActions } from '../data-table-row-actions'

const queryClients: QueryClient[] = []

const boundUpstreamAccount: ChannelUpstreamAccountConfig = {
  enabled: true,
  id: 7,
  name: 'upstream account',
  supports_checkin: true,
  auto_checkin: true,
  external_checkin_url: 'https://upstream.example.com/checkin',
  redeem_url: 'https://upstream.example.com/redeem',
}

function makeChannel(upstream?: ChannelUpstreamAccountConfig): Channel {
  return {
    id: 1,
    type: 1,
    key: 'sk-test',
    status: 1,
    name: 'channel under test',
    created_time: 0,
    test_time: 0,
    response_time: 0,
    base_url: 'https://upstream.example.com',
    other: '',
    balance: 0,
    balance_updated_time: 0,
    balance_source: 'upstream',
    upstream_account_config: upstream,
    models: '',
    group: 'default',
    used_quota: 0,
    other_info: '',
    remark: '',
    max_input_tokens: 0,
    channel_info: {
      is_multi_key: false,
      multi_key_size: 0,
      multi_key_polling_index: 0,
      multi_key_mode: 'random',
    },
    settings: '{}',
  }
}

function renderTableRowActions(channel: Channel): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClients.push(queryClient)

  render(
    <QueryClientProvider client={queryClient}>
      <ChannelsProvider>
        <ChannelRowActionsLayoutContext.Provider value='table'>
          <DataTableRowActions row={{ original: channel } as Row<Channel>} />
        </ChannelRowActionsLayoutContext.Provider>
      </ChannelsProvider>
    </QueryClientProvider>
  )
}

afterEach(() => {
  for (const queryClient of queryClients) {
    queryClient.clear()
  }
  queryClients.length = 0
})

describe('channel row actions in table layout', () => {
  test('offers the upstream account actions when the channel is bound to an upstream account', () => {
    renderTableRowActions(makeChannel(boundUpstreamAccount))

    expect(screen.getByRole('button', { name: 'Check in' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'External check-in' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Recharge / redeem' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Go to site' })
    ).toBeInTheDocument()
  })

  test('omits the upstream account actions when no upstream account is bound', () => {
    renderTableRowActions(makeChannel())

    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'External check-in' })
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Recharge / redeem' })
    ).toBeNull()
  })
})

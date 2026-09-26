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
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  channelSchema,
  type Channel,
  type ChannelBalanceResponse,
} from '../../types'
import { BalanceCell } from '../channels-columns'
import { ChannelsProvider, useChannels } from '../channels-provider'

let client: QueryClient

const ACCOUNTS: NonNullable<Channel['upstream_balance_details']> = [
  {
    account_id: 1,
    account_name: '主号',
    balance: 10,
    unit: 'USD',
    updated_time: 100,
    status: 'healthy',
  },
  // Its latest refresh failed after an earlier one read the balance.
  {
    account_id: 2,
    account_name: '副号',
    balance: 5,
    unit: 'USD',
    updated_time: 90,
    status: 'failed',
  },
  // Added to the channel, but not read yet.
  {
    account_id: 3,
    account_name: '新号',
    balance: 0,
    unit: '',
    updated_time: 0,
    status: 'unknown',
  },
]

function upstreamChannel(accounts: typeof ACCOUNTS): Channel {
  return channelSchema.parse({
    id: 42,
    type: 1,
    key: '',
    name: 'Shared site',
    status: 1,
    created_time: 1,
    test_time: 0,
    response_time: 0,
    balance_updated_time: 0,
    balance_source: 'upstream',
    upstream_account_names: accounts.map((account) => account.account_name),
    upstream_balance: 15,
    upstream_balance_unit: 'USD',
    upstream_balance_details: accounts,
  })
}

function HideSensitiveValues() {
  const channels = useChannels()
  return (
    <button type='button' onClick={() => channels.setSensitiveVisible(false)}>
      Hide sensitive values
    </button>
  )
}

function renderBalance(channel = upstreamChannel(ACCOUNTS)) {
  render(
    <QueryClientProvider client={client}>
      <ChannelsProvider>
        <HideSensitiveValues />
        <BalanceCell channel={channel} />
      </ChannelsProvider>
    </QueryClientProvider>
  )
  // The remaining balance, which keeps its place once values are hidden.
  return screen.getByTitle('$15')
}

function answerBalanceRefresh(response: ChannelBalanceResponse) {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/channel/update_balance/42') {
      return { data: response }
    }
    return { data: { success: true, data: [] } }
  })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

test('hovering the balance of a channel with several accounts lists how each account stands', async () => {
  const user = userEvent.setup()
  const remaining = renderBalance()

  await user.hover(remaining)

  const accounts = within(await screen.findByRole('list')).getAllByRole(
    'listitem'
  )
  expect(accounts).toHaveLength(3)
  expect(accounts[0]).toHaveTextContent(/^主号\$10$/)
  expect(accounts[1]).toHaveTextContent(/^副号\$5Refresh failed$/)
  expect(accounts[2]).toHaveTextContent(/^新号Not fetched yet$/)
  // The listed accounts are not named after the total as well.
  expect(screen.getAllByText(/主号/)).toHaveLength(1)
})

test('hovering the balance of a channel with one account names it after the total', async () => {
  const user = userEvent.setup()
  const remaining = renderBalance(upstreamChannel(ACCOUNTS.slice(0, 1)))

  await user.hover(remaining)

  expect(await screen.findByText(/\$15 · 主号$/)).toBeInTheDocument()
  expect(screen.queryByRole('list')).toBeNull()
})

test('hovering a hidden balance does not list the accounts', async () => {
  const user = userEvent.setup()
  const remaining = renderBalance()
  await user.click(
    screen.getByRole('button', { name: 'Hide sensitive values' })
  )

  await user.hover(remaining)

  expect(await screen.findByText('Click to update balance')).toBeInTheDocument()
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.queryByText(/主号/)).toBeNull()
})

test('refreshing a balance that some accounts could not read warns which ones failed', async () => {
  answerBalanceRefresh({
    success: true,
    balance: 15,
    currency: 'USD',
    balance_source: 'upstream',
    account_count: 3,
    refresh_failed: 1,
    refresh_errors: ['副号: upstream answered HTTP 401'],
  })
  const warning = vi.spyOn(toast, 'warning')
  const success = vi.spyOn(toast, 'success')
  const user = userEvent.setup()
  const remaining = renderBalance()

  await user.click(remaining)

  await waitFor(() =>
    expect(warning).toHaveBeenCalledWith(
      'Balance updated: $15, but 1 account(s) could not be refreshed',
      { description: '副号: upstream answered HTTP 401' }
    )
  )
  expect(success).not.toHaveBeenCalled()
})

test('refreshing a balance that no account could read fails', async () => {
  answerBalanceRefresh({
    success: true,
    balance: 15,
    currency: 'USD',
    balance_source: 'upstream',
    account_count: 2,
    refresh_failed: 2,
    refresh_errors: ['主号: timeout', '副号: timeout'],
  })
  const error = vi.spyOn(toast, 'error')
  const user = userEvent.setup()
  const remaining = renderBalance(upstreamChannel(ACCOUNTS.slice(0, 2)))

  await user.click(remaining)

  await waitFor(() =>
    expect(error).toHaveBeenCalledWith('Failed to update balance', {
      description: '主号: timeout; 副号: timeout',
    })
  )
})

test('refreshing a hidden balance keeps the amount and the failed accounts out of the toast', async () => {
  answerBalanceRefresh({
    success: true,
    balance: 15,
    currency: 'USD',
    balance_source: 'upstream',
    account_count: 3,
    refresh_failed: 1,
    refresh_errors: ['副号: Get "https://upstream.example/api/user/self"'],
  })
  const warning = vi.spyOn(toast, 'warning')
  const user = userEvent.setup()
  const remaining = renderBalance()
  await user.click(
    screen.getByRole('button', { name: 'Hide sensitive values' })
  )

  await user.click(remaining)

  await waitFor(() =>
    expect(warning).toHaveBeenCalledWith(
      'Balance updated: ••••, but 1 account(s) could not be refreshed',
      { description: undefined }
    )
  )
})

test('refreshing a balance kept in upstream quota shows it in that unit', async () => {
  answerBalanceRefresh({
    success: true,
    balance: 1500.125,
    currency: 'QUOTA',
    balance_source: 'upstream',
    account_count: 3,
    refresh_failed: 0,
  })
  const success = vi.spyOn(toast, 'success')
  const user = userEvent.setup()
  const remaining = renderBalance()

  await user.click(remaining)

  await waitFor(() =>
    expect(success).toHaveBeenCalledWith('Balance updated: 1,500.125 QUOTA')
  )
})

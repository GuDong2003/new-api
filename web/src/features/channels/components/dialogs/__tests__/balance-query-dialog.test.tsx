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

import { channelSchema } from '../../../types'
import { ChannelsProvider, useChannels } from '../../channels-provider'
import { BalanceQueryDialog } from '../balance-query-dialog'

let client: QueryClient

const channel = channelSchema.parse({
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
  upstream_account_names: ['主号', '副号'],
  upstream_balance: 15,
  upstream_balance_unit: 'USD',
  upstream_balance_details: [
    {
      account_id: 1,
      account_name: '主号',
      balance: 10,
      unit: 'USD',
      updated_time: 100,
      status: 'healthy',
    },
    {
      account_id: 2,
      account_name: '副号',
      balance: 5,
      unit: 'USD',
      updated_time: 90,
      status: 'failed',
    },
  ],
})

function ChooseChannel() {
  const channels = useChannels()
  return (
    <button type='button' onClick={() => channels.setCurrentRow(channel)}>
      Query the balance
    </button>
  )
}

async function openBalanceDialog() {
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={client}>
      <ChannelsProvider>
        <ChooseChannel />
        <BalanceQueryDialog open onOpenChange={vi.fn()} />
      </ChannelsProvider>
    </QueryClientProvider>
  )
  await user.click(screen.getByRole('button', { name: 'Query the balance' }))
  return { user, dialog: await screen.findByRole('dialog') }
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

test('the balance dialog of a channel with several accounts lists how each account stands', async () => {
  const { dialog } = await openBalanceDialog()

  expect(within(dialog).getByText('Balance of each account')).toBeVisible()
  const accounts = within(within(dialog).getByRole('list')).getAllByRole(
    'listitem'
  )
  expect(accounts).toHaveLength(2)
  expect(accounts[0]).toHaveTextContent(/^主号\$10$/)
  expect(accounts[1]).toHaveTextContent(/^副号\$5Refresh failed$/)
})

test('refreshing the balance in the dialog warns which accounts failed', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/channel/update_balance/42') {
      return {
        data: {
          success: true,
          balance: 15,
          currency: 'USD',
          balance_source: 'upstream',
          account_count: 2,
          refresh_failed: 1,
          refresh_errors: ['副号: upstream answered HTTP 401'],
        },
      }
    }
    return { data: { success: true, data: [] } }
  })
  const warning = vi.spyOn(toast, 'warning')
  const { user, dialog } = await openBalanceDialog()

  await user.click(
    within(dialog).getByRole('button', { name: 'Update Balance' })
  )

  await waitFor(() =>
    expect(warning).toHaveBeenCalledWith(
      'Balance updated: $15, but 1 account(s) could not be refreshed',
      { description: '副号: upstream answered HTTP 401' }
    )
  )
})

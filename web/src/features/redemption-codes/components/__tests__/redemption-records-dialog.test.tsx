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
import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { formatQuota } from '@/lib/format'

import type { Redemption } from '../../types'
import { RedemptionRecordsDialog } from '../redemption-records-dialog'

const sharedCode: Redemption = {
  id: 7,
  user_id: 1,
  name: 'group gift',
  key: 'key-7',
  status: 1,
  quota: 500000,
  created_time: 1,
  redeemed_time: 1790000100,
  expired_time: 0,
  used_user_id: 12,
  batch_id: 'batch-7',
  batch_one_per_user: false,
  max_uses: 100,
  used_count: 2,
}
const clients: QueryClient[] = []

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <RedemptionRecordsDialog
        open
        onOpenChange={() => undefined}
        redemption={sharedCode}
      />
    </QueryClientProvider>
  )
}

afterEach(() => {
  for (const client of clients) client.clear()
  clients.length = 0
})

test('lists the accounts that redeemed a code with the quota and time', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        items: [
          {
            id: 2,
            redemption_id: 7,
            user_id: 12,
            batch_id: 'batch-7',
            quota: 500000,
            created_time: 1790000100,
            username: 'bob',
            display_name: 'Bob',
          },
          {
            id: 1,
            redemption_id: 7,
            user_id: 11,
            batch_id: 'batch-7',
            quota: 500000,
            created_time: 1790000000,
            username: '',
            display_name: '',
          },
        ],
        total: 2,
      },
    },
  })

  renderDialog()

  expect(await screen.findByText('bob')).toBeInTheDocument()
  expect(screen.getByText('Bob')).toBeInTheDocument()
  expect(screen.getByText('Deleted user')).toBeInTheDocument()
  expect(
    screen.getByText(dayjs(1790000100 * 1000).format('YYYY-MM-DD HH:mm'))
  ).toBeInTheDocument()
  expect(screen.getAllByText(formatQuota(500000))).toHaveLength(2)
  expect(screen.getByText('2 record(s)')).toBeInTheDocument()
  expect(get).toHaveBeenCalledWith('/api/redemption/7/records?p=1&page_size=20')
})

test('says so when nobody has redeemed the code', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: { items: [], total: 0 } },
  })

  renderDialog()

  expect(
    await screen.findByText('No redemption records found')
  ).toBeInTheDocument()
})

test('shows why the records could not be loaded', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: false, message: 'records are off limits' },
  })

  renderDialog()

  expect(await screen.findByText('records are off limits')).toBeInTheDocument()
  expect(
    screen.queryByText('No redemption records found')
  ).not.toBeInTheDocument()
})

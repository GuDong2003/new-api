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
import { flexRender } from '@tanstack/react-table'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { useDataTable } from '@/components/data-table'
import { api } from '@/lib/api'

import type { Redemption } from '../../types'
import { useRedemptionsColumns } from '../redemptions-columns'
import { RedemptionsDialogs } from '../redemptions-dialogs'
import { RedemptionsMobileList } from '../redemptions-mobile-list'
import { RedemptionsProvider } from '../redemptions-provider'

function code(overrides: Partial<Redemption>): Redemption {
  return {
    id: 1,
    user_id: 1,
    name: 'code',
    key: 'key-1',
    status: 1,
    quota: 100,
    created_time: 1,
    redeemed_time: 0,
    expired_time: 0,
    used_user_id: 0,
    batch_id: 'batch-1',
    batch_one_per_user: false,
    max_uses: 1,
    used_count: 0,
    ...overrides,
  }
}

const rows = [
  code({
    id: 1,
    name: 'group gift',
    key: 'key-1',
    max_uses: 100000,
    used_count: 1234,
    used_user_id: 9,
  }),
  code({ id: 2, name: 'giveaway', key: 'key-2', batch_one_per_user: true }),
  code({
    id: 3,
    name: 'sold',
    key: 'key-3',
    status: 3,
    used_user_id: 5,
    used_username: 'alice',
    used_count: 1,
    redeemed_time: 1790000000,
  }),
  code({
    id: 4,
    name: 'used up',
    key: 'key-4',
    status: 3,
    max_uses: 2,
    used_count: 2,
    used_user_id: 6,
  }),
  code({
    id: 5,
    name: 'orphan',
    key: 'key-5',
    status: 3,
    used_user_id: 8,
    used_count: 1,
  }),
]

function RedemptionRows(props: { mobile?: boolean }) {
  const columns = useRedemptionsColumns()
  const { table } = useDataTable({
    data: rows,
    columns,
    getRowId: (row) => String(row.id),
  })
  if (props.mobile) {
    return <RedemptionsMobileList table={table} isLoading={false} />
  }
  return (
    <table>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} aria-label={row.original.name}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function renderRows(mobile = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <RedemptionsProvider>
        <RedemptionRows mobile={mobile} />
        <RedemptionsDialogs />
      </RedemptionsProvider>
    </QueryClientProvider>
  )
}

test('a shared code shows how many accounts redeemed it out of its limit', () => {
  renderRows()

  const shared = screen.getByRole('row', { name: 'group gift' })
  expect(
    within(shared).getByText('Redeemed 1,234 / 100,000')
  ).toBeInTheDocument()
  expect(within(shared).queryByText('User 9')).not.toBeInTheDocument()
})

test('a redeemed one-time code names its redeemer by username', () => {
  renderRows()

  const sold = screen.getByRole('row', { name: 'sold' })
  expect(within(sold).getByText('alice')).toBeInTheDocument()
  expect(within(sold).queryByText('User 5')).not.toBeInTheDocument()
  const orphan = screen.getByRole('row', { name: 'orphan' })
  expect(within(orphan).getByText('User 8')).toBeInTheDocument()
})

test('the mobile list names the redeemer, the batch rule and the shared count', () => {
  renderRows(true)

  expect(screen.getByText('alice')).toBeInTheDocument()
  expect(screen.getByText('User 8')).toBeInTheDocument()
  expect(screen.getAllByText('One per account')).toHaveLength(1)
  expect(screen.getByText('Redeemed 1,234 / 100,000')).toBeInTheDocument()
})

test('only codes of a one-per-account batch carry the batch badge', () => {
  renderRows()

  expect(
    within(screen.getByRole('row', { name: 'giveaway' })).getByText(
      'One per account'
    )
  ).toBeInTheDocument()
  expect(
    within(screen.getByRole('row', { name: 'sold' })).queryByText(
      'One per account'
    )
  ).not.toBeInTheDocument()
})

test('a used-up shared code can still be edited to serve more accounts', () => {
  renderRows()

  expect(
    within(screen.getByRole('row', { name: 'used up' })).getByRole('button', {
      name: 'Edit',
    })
  ).toBeEnabled()
  expect(
    within(screen.getByRole('row', { name: 'sold' })).getByRole('button', {
      name: 'Edit',
    })
  ).toBeDisabled()
})

test('the row menu opens the redemption records of a code', async () => {
  const user = userEvent.setup()
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        items: [
          {
            id: 1,
            redemption_id: 1,
            user_id: 9,
            batch_id: 'batch-1',
            quota: 100,
            created_time: 1790000000,
            username: 'carol',
            display_name: '',
          },
        ],
        total: 1,
      },
    },
  })
  renderRows()

  await user.click(
    within(screen.getByRole('row', { name: 'group gift' })).getByRole(
      'button',
      { name: 'Open menu' }
    )
  )
  await user.click(
    await screen.findByRole('menuitem', { name: /Redemption records/ })
  )

  expect(
    await screen.findByRole('dialog', { name: 'Redemption records' })
  ).toBeInTheDocument()
  expect(await screen.findByText('carol')).toBeInTheDocument()
  expect(get).toHaveBeenCalledWith('/api/redemption/1/records?p=1&page_size=20')
})

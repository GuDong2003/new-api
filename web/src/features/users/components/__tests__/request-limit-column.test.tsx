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
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import type { User } from '../../types'
import { useUsersColumns } from '../users-columns'

const user: User = {
  id: 1,
  username: 'alice',
  display_name: '',
  role: 1,
  status: 1,
  quota: 0,
  used_quota: 0,
  request_count: 0,
  group: 'default',
  request_rate_limit: {
    count: 0,
    success_count: 30,
    duration_minutes: 1,
    source: 'default',
    raised: true,
  },
}

function RequestLimitTable() {
  const columns = useUsersColumns().filter(
    (column) => column.id === 'request_rate_limit'
  )
  const table = useReactTable({
    columns,
    data: [user],
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th key={header.id}>
                {flexRender(
                  header.column.columnDef.header,
                  header.getContext()
                )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
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

it('lists the request limit each user is held to', () => {
  render(<RequestLimitTable />)
  expect(
    screen.getByRole('columnheader', { name: 'Request Limit' })
  ).toBeInTheDocument()
  expect(
    screen.getByText('Unlimited requests · 30 successful')
  ).toBeInTheDocument()
  expect(
    screen.getByText('Raised by subscription').parentElement
  ).toHaveTextContent('Every 1 min · Default · Raised by subscription')
})

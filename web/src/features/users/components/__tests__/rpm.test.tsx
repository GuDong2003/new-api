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
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'

import { Form } from '@/components/ui/form'

import type { UserFormValues } from '../../lib'
import type { User } from '../../types'
import { UserRpmFields } from '../user-rpm-fields'
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
  request_rpm: 9999,
}

function RpmColumn(props: { user: User }) {
  const columns = useUsersColumns().filter(
    (column) => column.id === 'request_rpm'
  )
  const table = useReactTable({
    columns,
    data: [props.user],
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

function RpmFields(props: {
  rpmLimit: UserFormValues['rpm_limit']
  disabled?: boolean
}) {
  const form = useForm<UserFormValues>({
    defaultValues: { username: 'alice', rpm_limit: props.rpmLimit },
  })
  return (
    <Form {...form}>
      <UserRpmFields disabled={props.disabled} />
    </Form>
  )
}

describe('users RPM column', () => {
  it('shows the RPM each user is held to', () => {
    render(<RpmColumn user={user} />)
    expect(
      screen.getByRole('columnheader', { name: 'RPM' })
    ).toBeInTheDocument()
    expect(screen.getByText('9,999')).toBeInTheDocument()
  })

  it('shows a user without a limit as unlimited', () => {
    render(<RpmColumn user={{ ...user, request_rpm: 0 }} />)
    expect(screen.getByText('Unlimited')).toBeInTheDocument()
  })
})

describe('user drawer RPM', () => {
  it('shows the RPM input only once the personal RPM is switched on', async () => {
    const actor = userEvent.setup()
    render(<RpmFields rpmLimit={{ enabled: false, rpm: 10 }} />)
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()

    await actor.click(
      screen.getByRole('switch', { name: 'Set an RPM for this user' })
    )

    expect(screen.getByRole('spinbutton')).toHaveValue(10)
  })

  it('locks the switch and RPM for someone who cannot edit them', () => {
    render(<RpmFields rpmLimit={{ enabled: true, rpm: 10 }} disabled />)
    expect(
      screen.getByRole('switch', { name: 'Set an RPM for this user' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('spinbutton')).toBeDisabled()
  })
})

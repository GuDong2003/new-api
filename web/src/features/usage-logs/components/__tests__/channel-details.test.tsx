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
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router'
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'

import { usageLogSchema } from '../../data/schema'
import type { TaskLog } from '../../types'
import { createChannelColumn } from '../columns/column-helpers'
import { useCommonLogsColumns } from '../columns/common-logs-columns'
import { UsageLogsProvider, useUsageLogsContext } from '../usage-logs-provider'

const task = {
  id: 1,
  user_id: 2,
  platform: 'image',
  task_id: 'task_abc',
  action: 'generate',
  channel_id: 12,
  channel_name: 'alpha-image',
  group: 'default',
  quota: 0,
  submit_time: 0,
  status: 'SUCCESS',
} as TaskLog

const log = usageLogSchema.parse({
  id: 1,
  user_id: 2,
  created_at: 1788840000,
  type: 2,
  content: '',
  model_name: 'gpt-image-2',
  username: 'alice',
  channel: 30,
  channel_name: 'beta-image',
  token_name: 'default',
  quota: 100,
  other: JSON.stringify({ admin_info: { use_channel: [12, 30] } }),
})

function FirstCell<T>(props: { columns: ColumnDef<T>[]; row: T }) {
  const table = useReactTable({
    data: [props.row],
    columns: props.columns,
    getCoreRowModel: getCoreRowModel(),
  })
  const cell = table.getRowModel().rows[0].getVisibleCells()[0]
  return <>{flexRender(cell.column.columnDef.cell, cell.getContext())}</>
}

const taskChannelColumns = [
  createChannelColumn<TaskLog>({
    headerLabel: 'Channel',
    channelName: (row) => row.channel_name,
  }),
]

function UsageLogChannelCell() {
  const columns = useCommonLogsColumns(true, false).filter(
    (column) => column.id === 'channel'
  )
  return <FirstCell columns={columns} row={log} />
}

function HideSensitive() {
  const { setSensitiveVisible } = useUsageLogsContext()
  useEffect(() => setSensitiveVisible(false), [setSensitiveVisible])
  return null
}

function renderWithLogs(
  cell: React.ReactNode,
  options: { hideSensitive?: boolean } = {}
) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterContextProvider router={router}>
        <UsageLogsProvider>
          {options.hideSensitive && <HideSensitive />}
          {cell}
        </UsageLogsProvider>
      </RouterContextProvider>
    </QueryClientProvider>
  )
}

describe('task log channel', () => {
  it('shows the channel name with its ID', () => {
    renderWithLogs(<FirstCell columns={taskChannelColumns} row={task} />)
    expect(screen.getByText('#12')).toBeInTheDocument()
    expect(screen.getByText('alpha-image')).toBeInTheDocument()
  })

  it('opens a dialog that links to the channel on the channels page', async () => {
    const user = userEvent.setup()
    renderWithLogs(<FirstCell columns={taskChannelColumns} row={task} />)
    await user.click(screen.getByRole('button', { name: /#12/ }))

    const dialog = await screen.findByRole('dialog', { name: 'Channel' })
    expect(within(dialog).getByText('alpha-image #12')).toBeInTheDocument()
    expect(
      within(dialog).getByRole('link', { name: 'Open channel' })
    ).toHaveAttribute('href', '/channels?channel=12')
  })

  it('hides the channel name while sensitive values are hidden', async () => {
    const user = userEvent.setup()
    renderWithLogs(<FirstCell columns={taskChannelColumns} row={task} />, {
      hideSensitive: true,
    })
    expect(screen.queryByText('alpha-image')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /#12/ }))

    const dialog = await screen.findByRole('dialog', { name: 'Channel' })
    expect(within(dialog).getByText('#12')).toBeInTheDocument()
    expect(within(dialog).queryByText(/alpha-image/)).not.toBeInTheDocument()
  })
})

describe('usage log channel', () => {
  it('opens a dialog with the retry chain and a link to the channel', async () => {
    const user = userEvent.setup()
    renderWithLogs(<UsageLogChannelCell />)
    await user.click(screen.getByRole('button', { name: /#30/ }))

    const dialog = await screen.findByRole('dialog', { name: 'Channel' })
    expect(within(dialog).getByText('beta-image #30')).toBeInTheDocument()
    expect(within(dialog).getByText('12 → 30')).toBeInTheDocument()
    expect(
      within(dialog).getByRole('link', { name: 'Open channel' })
    ).toHaveAttribute('href', '/channels?channel=30')
  })
})

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
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { describe, expect, it } from 'vitest'

import type { TaskLog } from '../../types'
import { createChannelColumn } from '../columns/column-helpers'
import { UsageLogsProvider, useUsageLogsContext } from '../usage-logs-provider'

const task: TaskLog = {
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

function ChannelCell() {
  const [columns] = useState(() => [
    createChannelColumn<TaskLog>({
      headerLabel: 'Channel',
      channelName: (log) => log.channel_name,
    }),
  ])
  const table = useReactTable({
    data: [task],
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
  const cell = table.getRowModel().rows[0].getVisibleCells()[0]
  return <>{flexRender(cell.column.columnDef.cell, cell.getContext())}</>
}

function HideSensitive() {
  const { setSensitiveVisible } = useUsageLogsContext()
  useEffect(() => setSensitiveVisible(false), [setSensitiveVisible])
  return null
}

function renderChannelCell(options: { hideSensitive?: boolean } = {}) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <RouterContextProvider router={router}>
      <UsageLogsProvider>
        {options.hideSensitive && <HideSensitive />}
        <ChannelCell />
      </UsageLogsProvider>
    </RouterContextProvider>
  )
}

describe('task log channel cell', () => {
  it('shows the channel name with its ID', () => {
    renderChannelCell()
    expect(screen.getByText('#12')).toBeInTheDocument()
    expect(screen.getByText('alpha-image')).toBeInTheDocument()
  })

  it('opens the channel on the channels page from its details', async () => {
    const user = userEvent.setup()
    renderChannelCell()
    await user.click(screen.getByRole('button', { name: 'Channel details' }))
    expect(
      await screen.findByRole('link', { name: 'Open channel' })
    ).toHaveAttribute('href', '/channels?channel=12')
  })

  it('masks the channel name while sensitive values are hidden', () => {
    renderChannelCell({ hideSensitive: true })
    expect(screen.queryByText('alpha-image')).not.toBeInTheDocument()
    expect(screen.getByText('••••')).toBeInTheDocument()
  })
})

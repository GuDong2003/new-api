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
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, type AxiosResponse } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { UsageLogs } from '..'

const clients: QueryClient[] = []

async function renderTaskLogs(role: number, allowed: boolean) {
  useAuthStore.getState().auth.setUser({
    id: 2,
    username: 'viewer',
    role,
    permissions: { admin_permissions: { task: { read: allowed } } },
  })
  const root = createRootRoute()
  const authenticated = createRoute({
    getParentRoute: () => root,
    id: '_authenticated',
  })
  const logs = createRoute({
    getParentRoute: () => authenticated,
    path: 'usage-logs/$section',
    component: UsageLogs,
  })
  const router = createRouter({
    routeTree: root.addChildren([authenticated.addChildren([logs])]),
    history: createMemoryHistory({ initialEntries: ['/usage-logs/task'] }),
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return client
}

function taskResponse(reason: string, userId: number) {
  return {
    data: {
      success: true,
      data: {
        total: 1,
        items: [
          {
            id: userId,
            user_id: userId,
            username: `user-${userId}`,
            task_id: `task-${userId}`,
            platform: 'image',
            action: 'GENERATE',
            status: 'FAILURE',
            progress: '0%',
            submit_time: 1_700_000_000,
            fail_reason: reason,
            quota: 0,
            channel_id: 0,
            group: 'default',
          },
        ],
      },
    },
  }
}

beforeEach(() =>
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
)

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
  localStorage.clear()
})

it.each([
  [1, false],
  [1, true],
  [10, false],
])(
  'role %s with task permission %s sees only its own task logs',
  async (role, allowed) => {
    const get = vi
      .spyOn(api, 'get')
      .mockImplementation(async (url) =>
        taskResponse(
          url.split('?')[0] === '/api/task/self'
            ? 'Own task'
            : 'Another account task',
          2
        )
      )
    await renderTaskLogs(Number(role), Boolean(allowed))
    await screen.findByText('Own task')
    expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument()
    expect(
      get.mock.calls.some(([url]) => url.split('?')[0] === '/api/task')
    ).toBe(false)
  }
)

it.each([10, 100])(
  'role %s with task access can switch from all records to its own',
  async (role) => {
    vi.spyOn(api, 'get').mockImplementation(async (url) =>
      taskResponse(
        url.split('?')[0] === '/api/task/self'
          ? 'Own task'
          : 'Another account task',
        3
      )
    )
    await renderTaskLogs(role, role === 10)
    await screen.findByText('Another account task')
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Only Mine' }))
    await screen.findByText('Own task')
    expect(screen.queryByText('Another account task')).not.toBeInTheDocument()
  }
)

it('revoking task access removes global cached records, closes details and falls back to own logs', async () => {
  let revoked = false
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.split('?')[0] === '/api/task' && revoked) {
      throw new AxiosError(
        'Forbidden',
        'ERR_BAD_REQUEST',
        undefined,
        undefined,
        { status: 403 } as AxiosResponse
      )
    }
    if (url === '/api/user/self') {
      return {
        data: {
          success: true,
          data: {
            id: 2,
            role: 10,
            permissions: { admin_permissions: { task: { read: false } } },
          },
        },
      }
    }
    return taskResponse(
      url.split('?')[0] === '/api/task/self'
        ? 'Own task'
        : 'Another account task',
      3
    )
  })
  const client = await renderTaskLogs(10, true)
  await screen.findByText('Another account task')
  const details = screen.getByRole('button', { name: 'View details' })
  await userEvent.click(details)
  expect(await screen.findByRole('dialog')).toBeVisible()
  client.setQueryData(['usage-logs', 'task-artifacts', 'task-3'], {
    artifacts: [{ key: 'private-image' }],
  })
  revoked = true
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['logs', 'task'] })
  })
  await screen.findByText('Own task')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument()
  await waitFor(() =>
    expect(
      client.getQueriesData({ queryKey: ['logs', 'task', 'admin'] })
    ).toHaveLength(0)
  )
  expect(
    client.getQueriesData({ queryKey: ['usage-logs', 'task-artifacts'] })
  ).toHaveLength(0)
  expect(
    useAuthStore.getState().auth.user?.permissions?.admin_permissions?.task
      ?.read
  ).toBe(false)
})

it('updated profile permissions close global details and clear previously loaded records', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) =>
    taskResponse(
      url.split('?')[0] === '/api/task/self'
        ? 'Own task'
        : 'Another account task',
      3
    )
  )
  const client = await renderTaskLogs(10, true)
  await screen.findByText('Another account task')
  await userEvent.click(screen.getByRole('button', { name: 'View details' }))
  await screen.findByRole('dialog')
  act(() => {
    const user = useAuthStore.getState().auth.user
    if (!user) throw new Error('Expected the authenticated task viewer')
    useAuthStore.getState().auth.setUser({
      ...user,
      permissions: { admin_permissions: { task: { read: false } } },
    })
  })
  await screen.findByText('Own task')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() =>
    expect(
      client.getQueriesData({ queryKey: ['logs', 'task', 'admin'] })
    ).toHaveLength(0)
  )
})

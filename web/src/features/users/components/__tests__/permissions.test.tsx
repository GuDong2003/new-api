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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { User } from '../../types'
import { DataTableRowActions } from '../data-table-row-actions'
import { UsersMutateDrawer } from '../users-mutate-drawer'
import { UsersProvider, useUsers } from '../users-provider'

const target: User = {
  id: 2,
  username: 'managed-admin',
  display_name: 'Managed admin',
  role: 10,
  status: 1,
  quota: 0,
  used_quota: 0,
  request_count: 0,
  group: 'default',
}
const label = "View other accounts' audit logs"
const description =
  'View audit records from user and admin roles. Root records are always excluded.'

function PermissionEntry(props: { target: User }) {
  const { open, setOpen, currentRow } = useUsers()
  return (
    <>
      <DataTableRowActions row={{ original: props.target } as Row<User>} />
      <UsersMutateDrawer
        open={open === 'permissions'}
        onOpenChange={(value) => !value && setOpen(null)}
        currentRow={currentRow ?? undefined}
        permissionsOnly
      />
    </>
  )
}

function renderPermissions(
  viewerRole: number,
  allowed?: boolean,
  options: {
    entry?: boolean
    failDetails?: boolean
    failCatalog?: boolean
    target?: User
    taskAllowed?: boolean
    detailsPending?: Promise<void>
  } = {}
) {
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'operator', role: viewerRole })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/authz/catalog') {
      if (options.failCatalog) throw new Error('Catalog unavailable')
      return {
        data: {
          success: true,
          data: {
            resources: [
              {
                resource: 'audit',
                label_key: 'Audit Logs',
                actions: [
                  {
                    action: 'read',
                    label_key: label,
                    description_key: description,
                  },
                ],
              },
              {
                resource: 'task',
                label_key: 'Task Logs',
                actions: [
                  {
                    action: 'read',
                    label_key: "View other accounts' task logs",
                    description_key:
                      'View task records from user and admin roles. Root records are always excluded.',
                  },
                ],
              },
            ],
            roles: [
              {
                key: 'admin',
                grants: { audit: { read: false }, task: { read: false } },
              },
            ],
          },
        },
      }
    }
    if (url === '/api/group/') {
      return { data: { success: true, data: ['default'] } }
    }
    if (options.detailsPending) await options.detailsPending
    if (options.failDetails) throw new Error('Details unavailable')
    return {
      data: {
        success: true,
        data: {
          ...target,
          admin_permissions:
            allowed === undefined
              ? {}
              : {
                  audit: { read: allowed },
                  task: { read: options.taskAllowed ?? false },
                },
        },
      },
    }
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <UsersProvider>
        {options.entry ? (
          <PermissionEntry target={options.target ?? target} />
        ) : (
          <UsersMutateDrawer
            open
            onOpenChange={() => undefined}
            currentRow={target}
          />
        )}
      </UsersProvider>
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})

it.each([undefined, true])(
  'root can save an audit grant or revocation from the existing editor (previous=%s)',
  async (allowed) => {
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true } })
    renderPermissions(100, allowed)
    await screen.findByDisplayValue('Managed admin')
    const checkbox = await screen.findByRole('checkbox', {
      name: new RegExp(label),
    })
    await waitFor(() =>
      expect(checkbox).toHaveAttribute('aria-checked', String(!!allowed))
    )
    expect(screen.getByText(description)).toBeVisible()
    await userEvent.click(checkbox)
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/user/',
        expect.objectContaining({
          id: 2,
          admin_permissions: {
            audit: { read: !allowed },
            task: { read: false },
          },
        })
      )
    )
  }
)

it('admin cannot edit the audit permission even when the catalog is available', async () => {
  renderPermissions(10)
  await screen.findByDisplayValue('Managed admin')
  expect(
    screen.queryByRole('checkbox', { name: new RegExp(label) })
  ).not.toBeInTheDocument()
})

it.each([false, true])(
  'root opens feature permissions and saves only permission fields when task access was %s',
  async (taskAllowed) => {
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true } })
    renderPermissions(100, true, { entry: true, taskAllowed })
    const button = screen.getByRole('button', { name: 'Feature Permissions' })
    button.focus()
    await userEvent.keyboard('{Enter}')
    const checkbox = await screen.findByRole('checkbox', {
      name: /View other accounts' task logs/,
    })
    expect(
      screen.getByRole('heading', { name: 'Feature Permissions' })
    ).toBeVisible()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(checkbox).not.toHaveAttribute('aria-disabled', 'true')
    )
    expect(checkbox).toHaveAttribute('aria-checked', String(taskAllowed))
    await userEvent.click(checkbox)
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/user/', {
        id: 2,
        admin_permissions: {
          audit: { read: true },
          task: { read: !taskAllowed },
        },
      })
    )
  }
)

it('admin cannot open the feature permissions entry for another administrator', () => {
  renderPermissions(10, undefined, { entry: true })
  expect(
    screen.queryByRole('button', { name: 'Feature Permissions' })
  ).not.toBeInTheDocument()
})

it.each([1, 100])(
  'root does not see feature permissions for target role %s',
  (role) => {
    renderPermissions(100, undefined, {
      entry: true,
      target: { ...target, role },
    })
    expect(
      screen.queryByRole('button', { name: 'Feature Permissions' })
    ).not.toBeInTheDocument()
  }
)

it('failed administrator details keep feature permission saving disabled', async () => {
  const put = vi.spyOn(api, 'put')
  renderPermissions(100, undefined, { entry: true, failDetails: true })
  await userEvent.click(
    screen.getByRole('button', { name: 'Feature Permissions' })
  )
  await screen.findByText('Failed to load')
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  expect(put).not.toHaveBeenCalled()
})

it('failed permission catalog keeps feature permission saving disabled', async () => {
  renderPermissions(100, undefined, { entry: true, failCatalog: true })
  await userEvent.click(
    screen.getByRole('button', { name: 'Feature Permissions' })
  )
  await screen.findByText('Failed to load')
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
})

it.each(['failed', 'pending'] as const)(
  'saving profile fields keeps existing permissions when administrator details are %s',
  async (state) => {
    let finishDetails: () => void = () => undefined
    const detailsPending = new Promise<void>((resolve) => {
      finishDetails = resolve
    })
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true } })
    renderPermissions(100, true, {
      failDetails: state === 'failed',
      detailsPending: state === 'pending' ? detailsPending : undefined,
    })
    await screen.findByDisplayValue('Managed admin')
    const taskPermission = await screen.findByRole('checkbox', {
      name: /View other accounts' task logs/,
    })
    expect(taskPermission).toHaveAttribute('aria-disabled', 'true')
    const displayName = screen.getByLabelText('Display Name')
    await userEvent.clear(displayName)
    await userEvent.type(displayName, 'Updated admin')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][1]).toMatchObject({
      id: 2,
      display_name: 'Updated admin',
    })
    expect(put.mock.calls[0][1]).not.toHaveProperty('admin_permissions')
    finishDetails()
  }
)

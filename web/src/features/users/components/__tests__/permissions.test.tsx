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
    userPermissions?: Record<string, boolean>
  } = {}
) {
  useAuthStore.getState().auth.setUser({
    id: 1,
    username: 'operator',
    role: viewerRole,
    permissions: options.userPermissions
      ? { admin_permissions: { user: options.userPermissions } }
      : undefined,
  })
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
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
    if (url === '/api/verify/methods') {
      return {
        data: {
          success: true,
          data: {
            scope: 'admin.user.update',
            methods: [{ method: '2fa', available: true }],
            oauth_providers: [],
            password_encryption_enabled: false,
          },
        },
      }
    }
    if (options.detailsPending) await options.detailsPending
    if (options.failDetails) throw new Error('Details unavailable')
    return {
      data: {
        success: true,
        data: {
          ...(options.target ?? target),
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
  render(
    <QueryClientProvider client={client}>
      <UsersProvider>
        {options.entry ? (
          <PermissionEntry target={options.target ?? target} />
        ) : (
          <UsersMutateDrawer
            open
            onOpenChange={() => undefined}
            currentRow={options.target ?? target}
          />
        )}
      </UsersProvider>
    </QueryClientProvider>
  )
  return get
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})

it.each([undefined, true])(
  'root can save an audit grant or revocation after step-up verification (previous=%s)',
  async (allowed) => {
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true } })
    vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        success: true,
        data: {
          proof_token: 'update-proof',
          method: '2fa',
          scope: 'admin.user.update',
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
    })
    renderPermissions(100, allowed)
    await screen.findByDisplayValue('Managed admin')
    const toggle = await screen.findByRole('checkbox', {
      name: new RegExp(label),
    })
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-checked', String(!!allowed))
    )
    expect(screen.getByText(description)).toBeVisible()
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    // The permission matrix changed, so the save waits for verification.
    expect(put).not.toHaveBeenCalled()
    await userEvent.type(
      await screen.findByLabelText('Authenticator code or backup code'),
      '123456'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/user/',
        expect.objectContaining({
          id: 2,
          admin_permissions: {
            audit: { read: !allowed },
            task: { read: false },
          },
        }),
        expect.objectContaining({
          headers: { 'X-Security-Proof': 'update-proof' },
          singleUseAuthorization: true,
        })
      )
    )
  }
)

it('root saving an administrator without changing permissions or password does not verify', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const get = renderPermissions(100, true)
  const displayName = await screen.findByDisplayValue('Managed admin')
  await userEvent.clear(displayName)
  await userEvent.type(displayName, 'Renamed admin')
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith(
      '/api/user/',
      expect.objectContaining({ id: 2, display_name: 'Renamed admin' }),
      {}
    )
  )
  expect(put.mock.calls[0][1]).not.toHaveProperty('admin_permissions')
  expect(get).not.toHaveBeenCalledWith('/api/verify/methods', expect.anything())
})

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
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        success: true,
        data: {
          proof_token: 'permission-proof',
          method: '2fa',
          scope: 'admin.user.update',
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
    })
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
    expect(put).not.toHaveBeenCalled()
    await userEvent.type(
      await screen.findByLabelText('Authenticator code or backup code'),
      '123456'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/user/',
        {
          id: 2,
          admin_permissions: {
            audit: { read: true },
            task: { read: !taskAllowed },
          },
        },
        {
          headers: { 'X-Security-Proof': 'permission-proof' },
          singleUseAuthorization: true,
        }
      )
    )
    expect(put).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      '/api/verify',
      expect.objectContaining({
        scope: 'admin.user.update',
        context: { user_id: 2 },
      }),
      expect.anything()
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

it('cancelling a changed permission grant keeps the checkbox selection and sends no update', async () => {
  const put = vi.spyOn(api, 'put')
  const post = vi.spyOn(api, 'post')
  renderPermissions(100, false, { entry: true })
  await userEvent.click(
    screen.getByRole('button', { name: 'Feature Permissions' })
  )
  const checkbox = await screen.findByRole('checkbox', {
    name: new RegExp(label),
  })
  await waitFor(() =>
    expect(checkbox).not.toHaveAttribute('aria-disabled', 'true')
  )
  await userEvent.click(checkbox)
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByLabelText('Authenticator code or backup code')
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(checkbox).toHaveAttribute('aria-checked', 'true')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  )
  expect(put).not.toHaveBeenCalled()
  expect(post).not.toHaveBeenCalled()
})

it('a profile-only operator omits credentials and permissions without requesting verification', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const get = renderPermissions(10, undefined, {
    target: { ...target, role: 1 },
    userPermissions: { profile_write: true },
  })
  const displayName = await screen.findByDisplayValue('Managed admin')
  expect(screen.getByLabelText('Password')).toBeDisabled()
  await userEvent.clear(displayName)
  await userEvent.type(displayName, 'Renamed user')
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
  expect(put.mock.calls[0][1]).toMatchObject({
    id: 2,
    display_name: 'Renamed user',
  })
  expect(put.mock.calls[0][1]).not.toHaveProperty('password')
  expect(put.mock.calls[0][1]).not.toHaveProperty('admin_permissions')
  expect(put.mock.calls[0][2]).toEqual({})
  expect(get).not.toHaveBeenCalledWith('/api/verify/methods', expect.anything())
})

it('a security-only operator resets a password with proof and omits profile and RPM fields', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        proof_token: 'password-proof',
        method: '2fa',
        scope: 'admin.user.update',
        expires_at: Math.floor(Date.now() / 1000) + 60,
      },
    },
  })
  renderPermissions(10, undefined, {
    target: { ...target, role: 1 },
    userPermissions: { security_write: true },
  })
  await screen.findByDisplayValue('Managed admin')
  expect(screen.getByLabelText('Display Name')).toBeDisabled()
  expect(
    screen.getByRole('switch', { name: 'Set an RPM for this user' })
  ).toHaveAttribute('aria-disabled', 'true')
  await userEvent.type(screen.getByLabelText('Password'), 'new-password')
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(put).not.toHaveBeenCalled()
  await userEvent.type(
    await screen.findByLabelText('Authenticator code or backup code'),
    '123456'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith(
      '/api/user/',
      { id: 2, password: 'new-password' },
      {
        headers: { 'X-Security-Proof': 'password-proof' },
        singleUseAuthorization: true,
      }
    )
  )
  expect(put).toHaveBeenCalledTimes(1)
  expect(post).toHaveBeenCalledWith(
    '/api/verify',
    expect.objectContaining({
      scope: 'admin.user.update',
      context: { user_id: 2 },
    }),
    expect.anything()
  )
})

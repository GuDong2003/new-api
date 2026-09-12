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
import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { useSidebarView } from '@/hooks/use-sidebar-view'
import { Route as ContentAuditRoute } from '@/routes/_authenticated/content-audit/route'
import { useAuthStore } from '@/stores/auth-store'

import { ContentAuditAccessBoundary } from '../components/content-audit-access'
import { ContentAuditDeleteButton } from '../components/content-audit-delete'
import { ContentAuditDetailDialog } from '../components/content-audit-detail'
import { ContentAuditRecords } from '../components/content-audit-records'
import {
  auditDetail,
  auditId,
  auditQueryClient,
  AuditRouterProvider,
  auditSuccess,
  AuditTestProviders,
  installAuditTransport,
  requestBody,
  secondAuditId,
  signInAuditRoot,
  verificationReply,
} from './fixtures'

let transport: ReturnType<typeof installAuditTransport>
let client: ReturnType<typeof auditQueryClient>

function RecordsLayout() {
  return (
    <ContentAuditAccessBoundary>
      <ContentAuditRecords />
      <Outlet />
    </ContentAuditAccessBoundary>
  )
}
function RecordRoute() {
  const params = useParams({ strict: false })
  return (
    <ContentAuditDetailDialog
      key={params.id}
      id={params.id ?? auditId}
      onClose={() => undefined}
    />
  )
}
function renderRecords(path = '/content-audit') {
  const root = createRootRoute({ component: Outlet })
  const audit = createRoute({
    getParentRoute: () => root,
    path: 'content-audit',
    component: RecordsLayout,
    beforeLoad: () => (ContentAuditRoute.options.beforeLoad as () => void)(),
  })
  const detail = createRoute({
    getParentRoute: () => audit,
    path: '$id',
    component: RecordRoute,
  })
  const forbidden = createRoute({
    getParentRoute: () => root,
    path: '403',
    component: () => <p>Forbidden</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([audit.addChildren([detail]), forbidden]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

function NavigationFixture() {
  const view = useSidebarView()
  return (
    <nav>
      {view.navGroups.flatMap((group) =>
        group.items.map((item) => <span key={item.title}>{item.title}</span>)
      )}
    </nav>
  )
}

beforeEach(() => {
  signInAuditRoot()
  client = auditQueryClient()
})
afterEach(() => {
  cleanup()
  client.clear()
  transport?.restore()
  useAuthStore.getState().auth.reset()
})

it.each([1, 10])(
  'rejects direct detail-route access before fetching for role %s',
  async (role) => {
    signInAuditRoot(role)
    transport = installAuditTransport(() => {
      throw new Error('No content audit fetch expected')
    })
    renderRecords(`/content-audit/${auditId}`)
    expect(await screen.findByText('Forbidden')).toBeVisible()
    expect(transport.requests).toHaveLength(0)
  }
)

it('rejects a root identity without a dashboard session', async () => {
  useAuthStore.setState((state) => ({ auth: { ...state.auth, session: null } }))
  transport = installAuditTransport(() => {
    throw new Error('No content audit fetch expected')
  })
  renderRecords()
  expect(await screen.findByText('Forbidden')).toBeVisible()
  expect(transport.requests).toHaveLength(0)
})

it.each([1, 10, 100])(
  'only exposes root navigation to role 100, current role %s',
  async (role) => {
    signInAuditRoot(role)
    transport = installAuditTransport(() => ({ body: auditSuccess({}) }))
    render(
      <AuditRouterProvider client={client}>
        <NavigationFixture />
      </AuditRouterProvider>
    )
    await screen.findByRole('navigation')
    if (role === 100) expect(screen.getByText('Content audit')).toBeVisible()
    else expect(screen.queryByText('Content audit')).not.toBeInTheDocument()
  }
)

it('paginates metadata, applies typed exact filters from page one, and loads body only on detail navigation', async () => {
  const detail = auditDetail()
  detail.payload.images = []
  transport = installAuditTransport((config) => {
    if (config.url === '/api/content-audit/records') {
      return {
        body: auditSuccess({
          items: [detail.record],
          total: 60,
          page: config.params.page,
          page_size: config.params.page_size,
        }),
      }
    }
    return { body: auditSuccess(detail) }
  })
  const user = userEvent.setup()
  renderRecords()
  await screen.findByText('inference-user (#7)')
  expect(
    transport.requests.every(
      (request) => request.url === '/api/content-audit/records'
    )
  ).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Go to next page' }))
  await waitFor(() => expect(transport.requests.at(-1)?.params.page).toBe(2))
  await user.click(screen.getByRole('button', { name: 'Expand' }))
  await user.type(screen.getByRole('textbox', { name: 'User ID' }), '7')
  await user.type(screen.getByRole('textbox', { name: 'Channel ID' }), '3')
  await user.type(screen.getByRole('textbox', { name: 'Model' }), 'test-model')
  await user.type(
    screen.getByRole('textbox', { name: 'Request ID' }),
    'request-1'
  )
  await user.type(screen.getByRole('textbox', { name: 'HTTP status' }), '200')
  await user.click(screen.getByRole('combobox', { name: 'Content type' }))
  await user.click(screen.getByRole('option', { name: 'Text' }))
  await user.click(screen.getByRole('combobox', { name: 'Capture integrity' }))
  await user.click(screen.getByRole('option', { name: 'Partial' }))
  await user.click(screen.getByRole('button', { name: 'Search' }))
  await waitFor(() =>
    expect(transport.requests.at(-1)?.params).toMatchObject({
      page: 1,
      page_size: 25,
      user_id: 7,
      channel_id: 3,
      model: 'test-model',
      request_id: 'request-1',
      http_status: 200,
      kind: 'text',
      integrity: 'partial',
    })
  )
  expect(
    transport.requests.every(
      (request) => request.url === '/api/content-audit/records'
    )
  ).toBe(true)
  await user.click(screen.getByRole('link', { name: 'Details' }))
  expect(await screen.findByLabelText('Request content')).toBeVisible()
  expect(transport.requests.at(-1)?.url).toBe(
    `/api/content-audit/records/${auditId}`
  )
})

it('rejects a reversed or overlong date range before querying', async () => {
  transport = installAuditTransport((config) => ({
    body: auditSuccess({
      items: [],
      total: 0,
      page: config.params.page,
      page_size: config.params.page_size,
    }),
  }))
  const user = userEvent.setup()
  renderRecords()
  await screen.findByText('No content audit records')
  await user.click(
    within(screen.getByRole('group', { name: 'Date Range' })).getByRole(
      'button'
    )
  )
  fireEvent.change(screen.getByLabelText('Start Time'), {
    target: { value: '2026-01-01T00:00' },
  })
  fireEvent.change(screen.getByLabelText('End Time'), {
    target: { value: '2026-03-01T00:00' },
  })
  await user.click(screen.getByRole('button', { name: 'Confirm' }))
  await user.click(screen.getByRole('button', { name: 'Search' }))
  expect(
    await screen.findByText('Choose a valid time range of at most 31 days.')
  ).toBeVisible()
  expect(transport.requests).toHaveLength(1)
})

it('shows a controlled list error instead of displaying raw backend messages', async () => {
  transport = installAuditTransport(() => ({
    status: 503,
    body: {
      success: false,
      code: 'CONTENT_AUDIT_UNAVAILABLE',
      message: 'private mount path',
    },
  }))
  renderRecords()
  expect(
    await screen.findByText(
      'Content audit is unavailable. Refresh the status before trying again.'
    )
  ).toBeVisible()
  expect(screen.queryByText('private mount path')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Details' })
  ).not.toBeInTheDocument()
})

it('offers a per-record delete action and a reset action for saved content', async () => {
  const detail = auditDetail()
  transport = installAuditTransport((config) => {
    if (config.url === '/api/content-audit/records') {
      return {
        body: auditSuccess({
          items: [detail.record],
          total: 1,
          page: 1,
          page_size: 25,
        }),
      }
    }
    return { body: auditSuccess({}) }
  })
  renderRecords()
  await screen.findByText('inference-user (#7)')
  expect(screen.getByRole('button', { name: 'Delete record' })).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Clear saved content' })
  ).toBeVisible()
})

it('binds deletion to the confirmed sorted selection even if selection changes during verification', async () => {
  transport = installAuditTransport((config) => {
    if (config.url?.startsWith('/api/verify')) {
      return { body: verificationReply(config) }
    }
    return {
      status: 202,
      body: auditSuccess({
        operation_id: 'delete-operation',
        ids: requestBody(config).ids,
        status: 'deleting',
      }),
    }
  })
  const user = userEvent.setup()
  const view = render(
    <AuditTestProviders client={client}>
      <ContentAuditDeleteButton ids={[secondAuditId, auditId]} />
    </AuditTestProviders>
  )
  await user.click(screen.getByRole('button', { name: 'Request deletion' }))
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Request deletion',
    })
  )
  await screen.findByLabelText('Authenticator code or backup code')
  view.rerender(
    <AuditTestProviders client={client}>
      <ContentAuditDeleteButton ids={[secondAuditId]} />
    </AuditTestProviders>
  )
  await user.type(
    screen.getByLabelText('Authenticator code or backup code'),
    '123456'
  )
  await user.click(screen.getByRole('button', { name: 'Verify' }))
  await waitFor(() =>
    expect(
      transport.requests.some(
        (request) => request.url === '/api/content-audit/records/delete'
      )
    ).toBe(true)
  )
  const deletion = transport.requests.find(
    (request) => request.url === '/api/content-audit/records/delete'
  )
  const context = { ids: [auditId, secondAuditId] }
  expect(requestBody(deletion)).toEqual(context)
  expect(deletion?.headers.get('X-Security-Proof')).toBe('audit-one-use-proof')
  expect(
    requestBody(
      transport.requests.find((request) => request.url === '/api/verify')
    )
  ).toEqual({
    method: '2fa',
    code: '123456',
    scope: 'content_audit.delete',
    context,
  })
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state)
    )
  ).not.toContain('audit-one-use-proof')
})

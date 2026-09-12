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
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { SettingsPageProvider } from '@/features/system-settings/components/settings-page-context'
import { ContentAuditSettingsSection } from '@/features/system-settings/maintenance/content-audit-section'
import en from '@/i18n/locales/en.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ru from '@/i18n/locales/ru.json'
import viLocale from '@/i18n/locales/vi.json'
import zhTW from '@/i18n/locales/zh-TW.json'
import zh from '@/i18n/locales/zh.json'
import { useAuthStore } from '@/stores/auth-store'

import { ContentAuditStatusPanel } from '../components/content-audit-status'
import { contentAuditPauseMessage } from '../lib/labels'
import {
  auditQueryClient,
  AuditRouterProvider,
  auditStatus,
  auditSuccess,
  installAuditTransport,
  requestBody,
  signInAuditRoot,
  verificationReply,
} from './fixtures'

function SettingsHarness() {
  const [actions, setActions] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setActions} />
      <SettingsPageProvider actionsContainer={actions}>
        <ContentAuditSettingsSection />
      </SettingsPageProvider>
    </>
  )
}

let transport: ReturnType<typeof installAuditTransport>
const clients: ReturnType<typeof auditQueryClient>[] = []

function renderSettings() {
  const client = auditQueryClient()
  clients.push(client)
  return render(
    <AuditRouterProvider client={client}>
      <SettingsHarness />
    </AuditRouterProvider>
  )
}

beforeEach(() => signInAuditRoot())
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  transport?.restore()
  useAuthStore.getState().auth.reset()
  vi.useRealTimers()
})

async function confirmWithAuthenticator(
  user: ReturnType<typeof userEvent.setup>,
  confirmationButton = 'Confirm'
) {
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: confirmationButton,
    })
  )
  await user.type(
    await screen.findByLabelText('Authenticator code or backup code'),
    '123456'
  )
  await user.click(screen.getByRole('button', { name: 'Verify' }))
}

it.each([1, 10])(
  'does not fetch maintenance content for non-root role %s',
  async (role) => {
    signInAuditRoot(role)
    transport = installAuditTransport(() => {
      throw new Error('No audit request should be made')
    })
    renderSettings()
    await waitFor(() =>
      expect(
        screen.getByText(
          'Content audit requires a live root dashboard session.'
        )
      ).toBeVisible()
    )
    expect(transport.requests).toHaveLength(0)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  }
)

it('requires plaintext acknowledgment and an exact initialize proof before creating storage, without enabling capture', async () => {
  const status = auditStatus()
  status.stable_key_configured = false
  transport = installAuditTransport((config) => {
    if (config.url?.startsWith('/api/verify')) {
      return { body: verificationReply(config) }
    }
    if (config.url === '/api/content-audit/initialize') {
      status.state = {
        ...status.state,
        storage_id: 'initialized-store',
        config_version: 2,
        mode: 'plaintext',
        plaintext_acknowledged: true,
        pause_reason: 'reconciling',
        reconciling: true,
      }
    }
    return { body: auditSuccess(status) }
  })
  const user = userEvent.setup()
  renderSettings()
  const initialize = await screen.findByRole('button', {
    name: 'Initialize audit storage',
  })
  expect(initialize).toBeDisabled()
  expect(
    screen.getByRole('switch', { name: 'Collect content audit records' })
  ).toHaveAttribute('aria-disabled', 'true')
  await user.click(
    screen.getByRole('checkbox', {
      name: 'I acknowledge that audit content will be stored without encryption.',
    })
  )
  await user.click(initialize)
  expect(
    transport.requests.some(
      (request) => request.url === '/api/content-audit/initialize'
    )
  ).toBe(false)
  await confirmWithAuthenticator(user)
  await screen.findByText(
    'Audit content is stored without encryption. Protect the storage directory and retain the deployment configuration.'
  )
  const verify = transport.requests.find(
    (request) => request.url === '/api/verify'
  )
  const initializeRequest = transport.requests.find(
    (request) => request.url === '/api/content-audit/initialize'
  )
  const context = { expected_version: 1, plaintext_acknowledged: true }
  expect(requestBody(verify)).toEqual({
    method: '2fa',
    code: '123456',
    scope: 'content_audit.initialize',
    context,
  })
  expect(requestBody(initializeRequest)).toEqual(context)
  expect(initializeRequest?.headers.get('X-Security-Proof')).toBe(
    'audit-one-use-proof'
  )
  expect(initializeRequest?.headers.get('Authorization')).toBe(
    'Bearer audit-test-session-access'
  )
  expect(initializeRequest?.singleUseAuthorization).toBe(true)
  expect(
    screen.getByRole('switch', { name: 'Collect content audit records' })
  ).not.toBeChecked()
  expect(
    screen.getByRole('checkbox', {
      name: 'I acknowledge that audit content will be stored without encryption.',
    })
  ).toHaveAttribute('aria-disabled', 'true')
})

it('saves enabled settings when initialized local storage is ready without a preflight step', async () => {
  const status = auditStatus()
  status.state.storage_id = 'initialized-store'
  status.state.mode = 'aes-gcm'
  status.state.config_version = 2
  status.state.pause_reason = ''
  status.ready = true
  transport = installAuditTransport((config) => {
    if (config.url?.startsWith('/api/verify')) {
      return { body: verificationReply(config) }
    }
    if (config.method === 'put') {
      status.state = {
        ...status.state,
        ...requestBody(config),
        config_version: 3,
      }
    }
    return { body: auditSuccess(status) }
  })
  const user = userEvent.setup()
  renderSettings()
  const toggle = await screen.findByRole('switch', {
    name: 'Collect content audit records',
  })
  expect(toggle).not.toHaveAttribute('aria-disabled', 'true')
  expect(
    screen.queryByRole('button', { name: 'Run shared storage preflight' })
  ).not.toBeInTheDocument()
  expect(
    transport.requests.filter((request) => request.url === '/api/verify')
  ).toHaveLength(0)
  await user.click(toggle)
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await confirmWithAuthenticator(user)
  await screen.findByText('Collection enabled')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  )
  const update = transport.requests.find((request) => request.method === 'put')
  const context = {
    expected_version: 2,
    enabled: true,
    retention_days: 7,
    request_limit: 524288,
    response_limit: 1048576,
    capacity_bytes: 536870912,
    thumbnail_enabled: true,
    plaintext_acknowledged: false,
  }
  expect(requestBody(update)).toEqual(context)
  expect(
    requestBody(
      transport.requests.find((request) => request.url === '/api/verify')
    )
  ).toEqual({
    method: '2fa',
    code: '123456',
    scope: 'content_audit.settings.update',
    context,
  })
  expect(update?.headers.get('X-Security-Proof')).toBe('audit-one-use-proof')
})

it('offers clearing saved content from settings and requires reset verification', async () => {
  const status = auditStatus()
  status.state.storage_id = 'initialized-store'
  status.state.mode = 'aes-gcm'
  status.state.pause_reason = ''
  status.state.used_records = 3
  status.ready = true
  transport = installAuditTransport((config) => {
    if (config.url?.startsWith('/api/verify')) {
      return { body: verificationReply(config) }
    }
    if (config.url === '/api/content-audit/records/reset') {
      return {
        status: 202,
        body: auditSuccess({
          operation_id: 'reset-operation',
          count: 3,
          status: 'deleting',
        }),
      }
    }
    return { body: auditSuccess(status) }
  })
  const user = userEvent.setup()
  renderSettings()
  await user.click(
    await screen.findByRole('button', { name: 'Clear saved content' })
  )
  expect(
    await screen.findByText('Clear saved content audit records?')
  ).toBeVisible()
  await confirmWithAuthenticator(user, 'Clear saved content')
  await waitFor(() =>
    expect(
      transport.requests.some(
        (request) => request.url === '/api/content-audit/records/reset'
      )
    ).toBe(true)
  )
  const reset = transport.requests.find(
    (request) => request.url === '/api/content-audit/records/reset'
  )
  expect(requestBody(reset)).toEqual({})
  expect(reset?.headers.get('X-Security-Proof')).toBe('audit-one-use-proof')
  expect(
    requestBody(
      transport.requests.find((request) => request.url === '/api/verify')
    )
  ).toEqual({
    method: '2fa',
    code: '123456',
    scope: 'content_audit.reset',
    context: {},
  })
})

it('allows disabling an already enabled but paused audit without passing readiness', async () => {
  const status = auditStatus()
  status.state = {
    ...status.state,
    storage_id: 'initialized-store',
    enabled: true,
    pause_reason: 'storage_space',
  }
  transport = installAuditTransport((config) => {
    if (config.url?.startsWith('/api/verify')) {
      return { body: verificationReply(config) }
    }
    if (config.method === 'put') {
      status.state = { ...status.state, enabled: false, config_version: 2 }
    }
    return { body: auditSuccess(status) }
  })
  const user = userEvent.setup()
  renderSettings()
  const toggle = await screen.findByRole('switch', {
    name: 'Collect content audit records',
  })
  expect(toggle).not.toHaveAttribute('aria-disabled', 'true')
  await user.click(toggle)
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await confirmWithAuthenticator(user)
  await screen.findByText('Collection disabled')
  expect(
    requestBody(transport.requests.find((request) => request.method === 'put'))
      .enabled
  ).toBe(false)
})

it('rejects out-of-range protections before opening confirmation or requesting a proof', async () => {
  transport = installAuditTransport(() => ({
    body: auditSuccess(auditStatus()),
  }))
  const user = userEvent.setup()
  renderSettings()
  const retention = await screen.findByRole('spinbutton', {
    name: 'Retention (days)',
  })
  await user.clear(retention)
  await user.type(retention, '31')
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(
    await screen.findByText('Enter a whole number within the displayed limits.')
  ).toBeVisible()
  expect(retention).toHaveAttribute('aria-invalid', 'true')
  expect(retention).toHaveFocus()
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(transport.requests.every((request) => request.method === 'get')).toBe(
    true
  )
})

it.each([409, 503])(
  'refetches after a %s write failure and requires a new proof with the refreshed version',
  async (failure) => {
    const status = auditStatus()
    let writes = 0
    transport = installAuditTransport((config) => {
      if (config.url?.startsWith('/api/verify')) {
        return { body: verificationReply(config) }
      }
      if (config.method === 'put') {
        writes += 1
        status.state.config_version = 4
        if (writes === 1) {
          return {
            status: failure,
            body: {
              success: false,
              code:
                failure === 409
                  ? 'CONTENT_AUDIT_CONFLICT'
                  : 'CONTENT_AUDIT_UNAVAILABLE',
            },
          }
        }
        status.state = { ...status.state, retention_days: 9, config_version: 5 }
      }
      return { body: auditSuccess(status) }
    })
    const user = userEvent.setup()
    renderSettings()
    await user.clear(
      await screen.findByRole('spinbutton', { name: 'Retention (days)' })
    )
    await user.type(
      screen.getByRole('spinbutton', { name: 'Retention (days)' }),
      '8'
    )
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await confirmWithAuthenticator(user)
    await waitFor(() =>
      expect(
        screen.getByRole('spinbutton', { name: 'Retention (days)' })
      ).toHaveValue(8)
    )
    expect(writes).toBe(1)
    const writeIndex = transport.requests.findIndex(
      (request) => request.method === 'put'
    )
    await waitFor(() =>
      expect(
        transport.requests
          .slice(writeIndex + 1)
          .some((request) => request.url === '/api/content-audit/status')
      ).toBe(true)
    )
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await user.clear(
      screen.getByRole('spinbutton', { name: 'Retention (days)' })
    )
    await user.type(
      screen.getByRole('spinbutton', { name: 'Retention (days)' }),
      '9'
    )
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await confirmWithAuthenticator(user)
    await waitFor(() => expect(writes).toBe(2))
    const proofs = transport.requests.filter(
      (request) => request.url === '/api/verify'
    )
    expect(proofs).toHaveLength(2)
    expect(requestBody(proofs[1]).context).toMatchObject({
      expected_version: 4,
      retention_days: 9,
    })
  }
)

it('does not substitute a weaker factor when the enrolled authenticator is unavailable', async () => {
  transport = installAuditTransport((config) => {
    if (config.url === '/api/verify/methods') {
      return {
        body: auditSuccess({
          scope: config.params.scope,
          methods: [{ method: '2fa', available: false }],
          oauth_providers: [],
          password_encryption_enabled: false,
        }),
      }
    }
    return { body: auditSuccess(auditStatus()) }
  })
  const user = userEvent.setup()
  renderSettings()
  await user.clear(
    await screen.findByRole('spinbutton', { name: 'Retention (days)' })
  )
  await user.type(
    screen.getByRole('spinbutton', { name: 'Retention (days)' }),
    '8'
  )
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Confirm',
    })
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
  )
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  expect(transport.requests.some((request) => request.method !== 'get')).toBe(
    false
  )
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(transport.requests.some((request) => request.method === 'put')).toBe(
    false
  )
})

it('rejects an expired proof without sending a protected settings write', async () => {
  transport = installAuditTransport((config) => {
    if (config.url === '/api/verify') {
      return {
        body: auditSuccess({
          proof_token: 'expired-proof',
          scope: requestBody(config).scope,
          method: '2fa',
          expires_at: 1,
        }),
      }
    }
    if (config.url === '/api/verify/methods') {
      return { body: verificationReply(config) }
    }
    return { body: auditSuccess(auditStatus()) }
  })
  const user = userEvent.setup()
  renderSettings()
  await user.clear(
    await screen.findByRole('spinbutton', { name: 'Retention (days)' })
  )
  await user.type(
    screen.getByRole('spinbutton', { name: 'Retention (days)' }),
    '8'
  )
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await confirmWithAuthenticator(user)
  expect(
    await screen.findByText('Verification proof was not returned')
  ).toBeVisible()
  expect(transport.requests.some((request) => request.method === 'put')).toBe(
    false
  )
})

it('does not offer plaintext acknowledgment as a fallback for an encrypted namespace with a missing key', async () => {
  const status = auditStatus()
  status.state = {
    ...status.state,
    storage_id: 'encrypted-store',
    mode: 'aes-gcm',
    pause_reason: 'storage_or_key_mismatch',
  }
  status.stable_key_configured = false
  transport = installAuditTransport(() => ({ body: auditSuccess(status) }))
  renderSettings()
  await screen.findByRole('switch', { name: 'Collect content audit records' })
  expect(
    screen.queryByRole('checkbox', {
      name: 'I acknowledge that audit content will be stored without encryption.',
    })
  ).not.toBeInTheDocument()
  expect(
    screen.getAllByText('Storage or encryption key mismatch').length
  ).toBeGreaterThan(0)
})

it('shows compact local storage usage and saved records without node diagnostics', () => {
  const status = auditStatus()
  status.state = {
    ...status.state,
    used_bytes: 200 * 1024 ** 2,
    reserved_bytes: 300 * 1024 ** 2,
    quarantined_bytes: 100 * 1024 ** 2,
    used_records: 3,
    reserved_records: 2,
    capacity_paused: true,
    pause_reason: 'capacity',
  }
  status.ready = false
  render(<ContentAuditStatusPanel status={status} />)
  expect(
    screen.getByText(
      'Storage used (including in-flight): 500 MiB / 512 MiB (97.7%)'
    )
  ).toBeVisible()
  expect(screen.getByText('Saved records')).toBeVisible()
  expect(screen.getByText('3')).toBeVisible()
  expect(
    screen.getByText(
      'Originals, previews and content share the total storage quota. Free space, then refresh status.'
    )
  ).toBeVisible()
  expect(
    screen.queryByText(
      'Storage is at least 80% full. New records stop at 95%; collection resumes below 80%.'
    )
  ).not.toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.queryByText('Storage namespace')).not.toBeInTheDocument()
  expect(screen.queryByText('Reserved record slots')).not.toBeInTheDocument()
})

it('shows collection paused with an actionable message for a local storage error', () => {
  const status = auditStatus()
  status.ready = false
  status.state = {
    ...status.state,
    enabled: true,
    storage_id: 'initialized-store',
    mode: 'aes-gcm',
    pause_reason: 'storage_space',
  }
  render(<ContentAuditStatusPanel status={status} />)
  expect(screen.getByText('Collection paused')).toBeVisible()
  expect(
    screen.getByText('Free disk space or inodes, then refresh status.')
  ).toBeVisible()
})

it('shows disabled collection with initialization guidance without labeling collection paused', () => {
  render(<ContentAuditStatusPanel status={auditStatus()} />)
  expect(screen.getByText('Collection disabled')).toBeVisible()
  expect(screen.getByText('Initialize audit storage')).toBeVisible()
  expect(screen.queryByText('Content audit paused')).not.toBeInTheDocument()
})

it('refreshes the visible status every 60 seconds without resetting a draft', async () => {
  const status = auditStatus()
  transport = installAuditTransport(() => ({ body: auditSuccess(status) }))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const user = userEvent.setup()
  renderSettings()
  const retention = await screen.findByRole('spinbutton', {
    name: 'Retention (days)',
  })
  await user.clear(retention)
  await user.type(retention, '8')
  status.state.used_records = 2
  status.state.config_version = 2
  await act(() => vi.advanceTimersByTimeAsync(59_999))
  expect(screen.queryByText('2')).not.toBeInTheDocument()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(await screen.findByText('2')).toBeVisible()
  expect(retention).toHaveValue(8)
})

it('does not poll a hidden page and refreshes local status when visible again', async () => {
  const status = auditStatus()
  transport = installAuditTransport(() => ({ body: auditSuccess(status) }))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  renderSettings()
  await screen.findByText('Saved records')
  const visibility = vi.spyOn(document, 'visibilityState', 'get')
  visibility.mockReturnValue('hidden')
  act(() => window.dispatchEvent(new Event('visibilitychange')))
  status.state.used_records = 4
  const initialGets = transport.requests.length
  await act(() => vi.advanceTimersByTimeAsync(120_000))
  expect(transport.requests).toHaveLength(initialGets)
  expect(screen.queryByText('4')).not.toBeInTheDocument()
  visibility.mockReturnValue('visible')
  act(() => window.dispatchEvent(new Event('visibilitychange')))
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(await screen.findByText('4')).toBeVisible()
})

it('manually refreshes status without discarding unsaved settings', async () => {
  const status = auditStatus()
  transport = installAuditTransport(() => ({ body: auditSuccess(status) }))
  const user = userEvent.setup()
  renderSettings()
  const retention = await screen.findByRole('spinbutton', {
    name: 'Retention (days)',
  })
  await user.clear(retention)
  await user.type(retention, '8')
  status.state.used_records = 6
  status.state.config_version = 2
  await user.click(screen.getByRole('button', { name: 'Refresh status' }))
  expect(await screen.findByText('6')).toBeVisible()
  expect(retention).toHaveValue(8)
})

it('shows the latest cleanup when present and omits the empty cleanup field', () => {
  const status = auditStatus()
  const view = render(<ContentAuditStatusPanel status={status} />)
  expect(screen.queryByText('Last cleanup')).not.toBeInTheDocument()
  status.state.last_cleanup_at = 1_700_000_000
  view.rerender(<ContentAuditStatusPanel status={status} />)
  expect(screen.getByText('Last cleanup')).toBeVisible()
  expect(
    screen.getByText(new Date(1_700_000_000_000).toLocaleString())
  ).toBeVisible()
})

it.each([
  ['manual', 503],
  ['manual', 'network'],
  ['poll', 503],
  ['poll', 'network'],
] as const)(
  'preserves the draft and original version through a failed %s refresh (%s) and successful retry',
  async (refresh, failure) => {
    const status = auditStatus()
    status.state.storage_id = 'initialized-store'
    status.state.mode = 'aes-gcm'
    status.state.config_version = 2
    status.state.pause_reason = ''
    status.ready = true
    let failRefresh = false
    transport = installAuditTransport((config) => {
      if (config.url?.startsWith('/api/verify')) {
        return { body: verificationReply(config) }
      }
      if (failRefresh && config.url === '/api/content-audit/status') {
        if (failure === 'network') throw new Error('Network disconnected')
        return {
          status: failure,
          body: { success: false, code: 'CONTENT_AUDIT_UNAVAILABLE' },
        }
      }
      return { body: auditSuccess(status) }
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const user = userEvent.setup()
    renderSettings()
    const retention = await screen.findByRole('spinbutton', {
      name: 'Retention (days)',
    })
    await user.clear(retention)
    await user.type(retention, '8')
    status.state.config_version = 3
    status.state.retention_days = 9
    status.state.used_records = 5
    failRefresh = true
    if (refresh === 'poll') {
      await act(() => vi.advanceTimersByTimeAsync(60_000))
    } else {
      await user.click(screen.getByRole('button', { name: 'Refresh status' }))
    }
    expect(
      await screen.findByText(
        'Content audit is unavailable. Refresh the status before trying again.'
      )
    ).toBeVisible()
    expect(
      screen.getByRole('spinbutton', { name: 'Retention (days)' })
    ).toHaveValue(8)
    failRefresh = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('5')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Retry' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('spinbutton', { name: 'Retention (days)' })
    ).toHaveValue(8)
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await confirmWithAuthenticator(user)
    await waitFor(() =>
      expect(
        transport.requests.some((request) => request.method === 'put')
      ).toBe(true)
    )
    expect(
      requestBody(
        transport.requests.find((request) => request.method === 'put')
      )
    ).toMatchObject({ expected_version: 2, retention_days: 8 })
    expect(
      requestBody(
        transport.requests.find((request) => request.url === '/api/verify')
      ).context
    ).toMatchObject({ expected_version: 2, retention_days: 8 })
  }
)

it('shows only the initial-load error until a status retry succeeds', async () => {
  let failRefresh = true
  transport = installAuditTransport(() => {
    if (failRefresh) {
      return {
        status: 503,
        body: { success: false, code: 'CONTENT_AUDIT_UNAVAILABLE' },
      }
    }
    return { body: auditSuccess(auditStatus()) }
  })
  const user = userEvent.setup()
  renderSettings()
  await screen.findByText(
    'Content audit is unavailable. Refresh the status before trying again.'
  )
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  expect(screen.queryByText('Saved records')).not.toBeInTheDocument()
  failRefresh = false
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(
    await screen.findByRole('spinbutton', { name: 'Retention (days)' })
  ).toHaveValue(7)
})

it('removes the draft and cached status when a refresh revokes audit access', async () => {
  let revoked = false
  transport = installAuditTransport(() => {
    if (revoked) {
      return {
        status: 403,
        body: { success: false, code: 'CONTENT_AUDIT_SESSION_REQUIRED' },
      }
    }
    return { body: auditSuccess(auditStatus()) }
  })
  const user = userEvent.setup()
  renderSettings()
  const retention = await screen.findByRole('spinbutton', {
    name: 'Retention (days)',
  })
  await user.clear(retention)
  await user.type(retention, '8')
  revoked = true
  await user.click(screen.getByRole('button', { name: 'Refresh status' }))
  expect(
    await screen.findByText(
      'Content audit access ended. Sign in with a live root session to continue.'
    )
  ).toBeVisible()
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  expect(screen.queryByText('Saved records')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Save Changes' })
  ).not.toBeInTheDocument()
  await waitFor(() =>
    expect(
      clients
        .at(-1)
        ?.getQueryCache()
        .findAll({ queryKey: ['content-audit'] })
    ).toHaveLength(0)
  )
})

it('keeps a draft bound to its original version after a remote settings refresh', async () => {
  const status = auditStatus()
  status.state.storage_id = 'initialized-store'
  status.state.mode = 'aes-gcm'
  status.state.config_version = 2
  status.state.pause_reason = ''
  status.ready = true
  transport = installAuditTransport((config) => {
    if (config.url?.startsWith('/api/verify')) {
      return { body: verificationReply(config) }
    }
    return { body: auditSuccess(status) }
  })
  const user = userEvent.setup()
  renderSettings()
  const retention = await screen.findByRole('spinbutton', {
    name: 'Retention (days)',
  })
  await user.clear(retention)
  await user.type(retention, '8')
  status.state.config_version = 3
  status.state.thumbnail_enabled = false
  status.state.used_records = 5
  await user.click(screen.getByRole('button', { name: 'Refresh status' }))
  await screen.findByText('5')
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await confirmWithAuthenticator(user)
  await waitFor(() =>
    expect(transport.requests.some((request) => request.method === 'put')).toBe(
      true
    )
  )
  expect(
    requestBody(transport.requests.find((request) => request.method === 'put'))
  ).toMatchObject({ expected_version: 2, retention_days: 8 })
})

it.each([
  ['en', en],
  ['fr', fr],
  ['ja', ja],
  ['ru', ru],
  ['vi', viLocale],
  ['zh-TW', zhTW],
  ['zh', zh],
] as const)(
  'provides local status and actionable pause translations in %s without fallback',
  async (language, resource) => {
    const i18n = createInstance()
    await i18n.init({
      lng: language,
      fallbackLng: false,
      resources: { [language]: resource },
    })
    for (const key of [
      'Local content audit status',
      'Collection enabled',
      'Collection disabled',
      'Collection paused',
      'Content audit paused',
      'Saved records',
      'Last cleanup',
      'Storage used (including in-flight): {{used}} / {{limit}} ({{percent}}%)',
      'Originals, previews and content share the total storage quota. Free space, then refresh status.',
      'This switch only controls previews. Original results and content share the total storage quota.',
      'View original',
      'Download original',
      'Next images',
      'Original not saved',
      'Streaming downloads require a supported browser, such as desktop Chromium.',
      'Storage usage includes in-flight writes. Deleted and expired content releases space after cleanup.',
      'Initialize storage and wait for local checks to pass before enabling collection.',
      'Storage capacity (bytes)',
      'Local storage checks are incomplete. Refresh status and try again.',
      'Configure a stable CRYPTO_SECRET or SESSION_SECRET before initialization to use encryption. The encryption mode and key cannot be changed here.',
      'Set CONTENT_AUDIT_STORAGE_DIR to an existing private directory. The directory is not created automatically.',
      'Audit content is stored without encryption. Protect the storage directory and retain the deployment configuration.',
    ]) {
      expect(i18n.exists(key), `${language}: ${key}`).toBe(true)
    }
    for (const code of [
      'storage_space',
      'local_refresh_pending',
      'storage_not_configured',
      'storage_or_key_mismatch',
      'reconciling',
      'capacity',
      'recovery_unavailable',
      'not_initialized',
    ]) {
      const message = contentAuditPauseMessage(code, i18n.t)
      expect(message.length).toBeGreaterThan(0)
      if (language !== 'en') {
        expect(message).not.toBe(
          contentAuditPauseMessage(code, i18n.getFixedT('en'))
        )
      }
    }
    const status = auditStatus()
    status.state.enabled = true
    status.state.pause_reason = 'local_refresh_pending'
    render(
      <I18nextProvider i18n={i18n}>
        <ContentAuditStatusPanel status={status} />
      </I18nextProvider>
    )
    expect(screen.getByText(i18n.t('Collection paused'))).toBeVisible()
    if (language === 'zh') {
      expect(screen.getByText('请刷新状态，确认本地存储已就绪。')).toBeVisible()
      expect(
        screen.queryByText('Refresh status to confirm local readiness.')
      ).not.toBeInTheDocument()
    }
  }
)

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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { describe, expect, test, vi } from 'vitest'

import { Form } from '@/components/ui/form'

import type { UpstreamSiteTypeOption } from '../../../upstream-accounts/types'
import {
  CHANNEL_FORM_DEFAULT_VALUES,
  type ChannelFormValues,
  type UpstreamAccountFormValues,
} from '../../lib/channel-form'
import type { ChannelUpstreamAccountConfig } from '../../types'
import { ChannelUpstreamAccountFields } from '../drawers/sections/channel-upstream-account-fields'

const SITE_TYPES: UpstreamSiteTypeOption[] = [
  {
    value: 'new_api',
    label: 'New API',
    auth_types: ['token', 'cookie'],
    supports_checkin: true,
    supports_balance: true,
    external_only: false,
  },
  {
    value: 'sharedchat',
    label: 'SharedChat',
    auth_types: ['cookie'],
    supports_checkin: false,
    supports_balance: true,
    external_only: false,
  },
]

const SAVED_ACCOUNT: UpstreamAccountFormValues = {
  id: 7,
  name: '主号',
  auth_type: 'token',
  user_id: 226,
  credential: '',
  auto_checkin: true,
}

function AccountsForm(props: {
  accounts?: UpstreamAccountFormValues[]
  savedAccounts?: ChannelUpstreamAccountConfig[]
  onSave: (values: ChannelFormValues) => void
}) {
  const form = useForm<ChannelFormValues>({
    defaultValues: {
      ...CHANNEL_FORM_DEFAULT_VALUES,
      upstream_accounts: props.accounts ?? [],
    },
  })
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(props.onSave)}>
        <ChannelUpstreamAccountFields
          siteTypes={SITE_TYPES}
          savedAccounts={props.savedAccounts}
        />
        <button type='submit'>Save</button>
      </form>
    </Form>
  )
}

function savedValues(onSave: ReturnType<typeof vi.fn>): ChannelFormValues {
  expect(onSave).toHaveBeenCalledTimes(1)
  return onSave.mock.calls[0][0] as ChannelFormValues
}

describe('channel check-in fields', () => {
  test('saves the check-in pages of a channel without any account', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<AccountsForm onSave={onSave} />)

    expect(
      screen.getByText('No account checks in on this channel yet.')
    ).toBeInTheDocument()
    expect(screen.queryByText('Site type')).toBeNull()
    await user.type(
      screen.getByLabelText('External check-in URL'),
      'https://site.example/checkin'
    )
    await user.type(
      screen.getByLabelText('Recharge / redeem URL'),
      'https://site.example/redeem'
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const values = savedValues(onSave)
    expect(values.external_checkin_url).toBe('https://site.example/checkin')
    expect(values.redeem_url).toBe('https://site.example/redeem')
    expect(values.upstream_accounts).toEqual([])
  })

  test('adds an account that checks in automatically', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<AccountsForm accounts={[SAVED_ACCOUNT]} onSave={onSave} />)

    await user.click(screen.getByRole('button', { name: 'Add account' }))
    const added = screen.getByRole('group', { name: 'Account 2' })
    await user.type(within(added).getByLabelText('Upstream user ID'), '331')
    await user.type(within(added).getByLabelText('Pass token'), 'token-b')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(savedValues(onSave).upstream_accounts).toEqual([
      SAVED_ACCOUNT,
      {
        name: '',
        auth_type: 'token',
        user_id: 331,
        credential: 'token-b',
        auto_checkin: true,
      },
    ])
  })

  test('removes a new account right away', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<AccountsForm accounts={[SAVED_ACCOUNT]} onSave={onSave} />)

    await user.click(screen.getByRole('button', { name: 'Add account' }))
    await user.click(screen.getByRole('button', { name: 'Remove account 2' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Account 2' })).toBeNull()
  })

  test('removes a saved account only once the removal is confirmed', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<AccountsForm accounts={[SAVED_ACCOUNT]} onSave={onSave} />)

    await user.click(screen.getByRole('button', { name: 'Remove account 1' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/主号/)).toBeInTheDocument()
    // The dialog hides the page from assistive technology while it is open.
    expect(
      screen.getByRole('group', { name: 'Account 1', hidden: true })
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.queryByRole('group', { name: 'Account 1' })).toBeNull()
    expect(savedValues(onSave).upstream_accounts).toEqual([])
  })

  test('switches every account to what a newly chosen site supports', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<AccountsForm accounts={[SAVED_ACCOUNT]} onSave={onSave} />)

    await user.click(screen.getByRole('combobox', { name: 'Site type' }))
    await user.click(await screen.findByRole('option', { name: 'SharedChat' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const values = savedValues(onSave)
    expect(values.upstream_account_site_type).toBe('sharedchat')
    expect(values.upstream_accounts?.[0]).toMatchObject({
      auth_type: 'cookie',
      auto_checkin: false,
    })
  })

  test('adds an account the way the chosen site signs in', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<AccountsForm accounts={[SAVED_ACCOUNT]} onSave={onSave} />)

    await user.click(screen.getByRole('combobox', { name: 'Site type' }))
    await user.click(await screen.findByRole('option', { name: 'SharedChat' }))
    await user.click(screen.getByRole('button', { name: 'Add account' }))
    const added = screen.getByRole('group', { name: 'Account 2' })
    await user.type(within(added).getByLabelText('Browser Cookie'), 'cookie-b')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(savedValues(onSave).upstream_accounts?.[1]).toMatchObject({
      auth_type: 'cookie',
      credential: 'cookie-b',
      auto_checkin: false,
    })
  })

  test('keeps the id of a saved account while it is edited', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<AccountsForm accounts={[SAVED_ACCOUNT]} onSave={onSave} />)

    const account = screen.getByRole('group', { name: 'Account 1' })
    const name = within(account).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, '改名')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(savedValues(onSave).upstream_accounts).toEqual([
      { ...SAVED_ACCOUNT, name: '改名' },
    ])
  })

  test('shows how the latest check-in of a saved account went', () => {
    render(
      <AccountsForm
        accounts={[SAVED_ACCOUNT]}
        savedAccounts={[
          {
            enabled: true,
            id: 7,
            last_checkin_time: 1_704_067_200,
            last_checkin_status: 'healthy',
          },
        ]}
        onSave={vi.fn()}
      />
    )

    const account = screen.getByRole('group', { name: 'Account 1' })
    expect(within(account).getByText('Healthy')).toBeInTheDocument()
    expect(within(account).getByText(/Last check-in time/)).toBeInTheDocument()
    expect(within(account).getByLabelText('Pass token')).toHaveAttribute(
      'placeholder',
      'Already configured; leave empty to keep it'
    )
  })
})

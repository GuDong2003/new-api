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
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { RateLimitSection } from '../rate-limit-section'

const settings = {
  ModelRequestRateLimitEnabled: false,
  ModelRequestRateLimitCount: 0,
  ModelRequestRateLimitSuccessCount: 1000,
  ModelRequestRateLimitGroup: '{"vip":[10,10]}',
  ModelRequestRateLimitGlobalCount: 0,
  ModelRequestRateLimitGlobalSuccessCount: 200,
}

function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <RateLimitSection defaultValues={settings} />
      </SettingsPageProvider>
    </>
  )
}

async function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const router = createRouter({
    routeTree: createRootRoute({ component: Fixture }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return screen.findByRole('spinbutton', { name: 'Default RPM' })
}

function savedOptions() {
  return vi
    .mocked(api.put)
    .mock.calls.map(([, body]) => body as { key: string; value: unknown })
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rate limit settings', () => {
  it('reads a limit stored as two caps as one RPM', async () => {
    expect(await renderSection()).toHaveValue(1000)
    expect(screen.getByText('10')).toBeInTheDocument()
  })

  it('saves a changed RPM as both of its caps', async () => {
    const user = userEvent.setup()
    const defaultRpm = await renderSection()
    await user.clear(defaultRpm)
    await user.type(defaultRpm, '30')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(savedOptions()).toEqual([
        { key: 'ModelRequestRateLimitCount', value: 30 },
        { key: 'ModelRequestRateLimitSuccessCount', value: 30 },
      ])
    )
  })

  it('shows the site-wide RPM only while the site-wide limit is on and leaves untouched caps as they are', async () => {
    const user = userEvent.setup()
    await renderSection()
    expect(
      screen.queryByRole('spinbutton', { name: 'Site-wide RPM' })
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('switch', { name: 'Enable site-wide limit' })
    )
    expect(
      screen.getByRole('spinbutton', { name: 'Site-wide RPM' })
    ).toHaveValue(200)
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(savedOptions()).toEqual([
        { key: 'ModelRequestRateLimitEnabled', value: true },
      ])
    )
  })

  it('adds a group with one RPM', async () => {
    const user = userEvent.setup()
    await renderSection()
    await user.click(screen.getByRole('button', { name: 'Add group' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Add group rate limit',
    })
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Group Name' }),
      'image'
    )
    const rpm = within(dialog).getByRole('spinbutton', { name: 'RPM' })
    await user.clear(rpm)
    await user.type(rpm, '15')
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(savedOptions()).toHaveLength(1))
    const saved = savedOptions()[0]
    expect(saved.key).toBe('ModelRequestRateLimitGroup')
    expect(JSON.parse(String(saved.value))).toEqual({
      vip: [10, 10],
      image: [15, 15],
    })
  })
})

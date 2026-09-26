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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { RateLimitSection } from '../rate-limit-section'

function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <RateLimitSection
          defaultValues={{
            ModelRequestRateLimitEnabled: false,
            ModelRequestRateLimitDurationMinutes: 1,
            ModelRequestRateLimitCount: 0,
            ModelRequestRateLimitSuccessCount: 1000,
            ModelRequestRateLimitGroup: '',
            ModelRequestRateLimitGlobalCount: 0,
            ModelRequestRateLimitGlobalSuccessCount: 0,
          }}
        />
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
  return screen.findByRole('switch', { name: 'Enable site-wide limit' })
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rate limit settings', () => {
  it('shows the site-wide caps only while the site-wide limit is on', async () => {
    const user = userEvent.setup()
    const siteSwitch = await renderSection()
    expect(
      screen.getByText('Default max requests per period')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Site-wide max successful requests')
    ).not.toBeInTheDocument()

    await user.click(siteSwitch)

    expect(
      screen.getByText('Site-wide max successful requests')
    ).toBeInTheDocument()
  })

  it('saves the switch together with a site-wide cap', async () => {
    const user = userEvent.setup()
    await user.click(await renderSection())
    const successCap = screen.getAllByRole('spinbutton').at(-1)
    if (!successCap) throw new Error('missing site-wide success cap')
    await user.clear(successCap)
    await user.type(successCap, '500')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/option/', {
        key: 'ModelRequestRateLimitGlobalSuccessCount',
        value: 500,
      })
    )
    expect(api.put).toHaveBeenCalledWith('/api/option/', {
      key: 'ModelRequestRateLimitEnabled',
      value: true,
    })
  })
})

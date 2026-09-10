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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { parseHeaderNavModules, serializeHeaderNavModules } from '../config'
import { HeaderNavigationSection } from '../header-navigation-section'

const adapter = api.defaults.adapter
afterEach(() => {
  api.defaults.adapter = adapter
})

it('lets an administrator disable the canvas entry and reset its visibility to the default', async () => {
  const saved: { key: string; value: string }[] = []
  api.defaults.adapter = async (config) => {
    saved.push(JSON.parse(config.data))
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { success: true, message: '' },
    }
  }
  const client = new QueryClient()
  const config = parseHeaderNavModules('{"home":true}')
  const actions = document.createElement('div')
  document.body.append(actions)
  const view = render(
    <QueryClientProvider client={client}>
      <SettingsPageProvider actionsContainer={actions}>
        <HeaderNavigationSection
          config={config}
          initialSerialized={serializeHeaderNavModules(config)}
        />
      </SettingsPageProvider>
    </QueryClientProvider>
  )
  try {
    const toggle = screen.getByRole('switch', { name: 'Infinite Canvas' })
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    await userEvent.click(
      screen.getByRole('button', { name: 'Save navigation' })
    )
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].key).toBe('HeaderNavModules')
    expect(JSON.parse(saved[0].value)).toMatchObject({
      canvas: false,
      home: true,
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Reset to default' })
    )
    expect(toggle).toBeChecked()
  } finally {
    view.unmount()
    actions.remove()
    client.clear()
  }
})

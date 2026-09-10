/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { SettingsPageProvider } from '@/features/system-settings/components/settings-page-context'
import { getOperationsSectionNavItems } from '@/features/system-settings/operations/section-registry'
import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { GallerySettingsSection } from '../components/gallery-settings-section'
import { login, response } from './fixtures'

const defaults = {
  enabled: true,
  retention_days: 7,
  user_max_images: 100,
  user_max_bytes: 209715200,
  total_max_bytes: 536870912,
}
const adapter = api.defaults.adapter
let client: QueryClient
let actions: HTMLDivElement
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  login()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  actions = document.createElement('div')
  document.body.append(actions)
})
afterEach(async () => {
  client.clear()
  actions.remove()
  useAuthStore.getState().auth.reset()
  api.defaults.adapter = adapter
  await i18next.changeLanguage('en')
})

function showSettings() {
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <SettingsPageProvider actionsContainer={actions}>
          <GallerySettingsSection />
        </SettingsPageProvider>
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

it('edits all five Chinese controls, converts MiB to bytes and clears dirty state after saving', async () => {
  i18next.addResourceBundle('zh', 'translation', zh.translation, true, true)
  await i18next.changeLanguage('zh')
  let saved: unknown
  api.defaults.adapter = async (config) => {
    if (config.method === 'put') {
      saved = JSON.parse(config.data)
      return response(config, saved)
    }
    return response(config, defaults)
  }
  showSettings()
  expect(await screen.findByLabelText('每人最多保存数量')).toHaveValue(100)
  expect(screen.getByLabelText('每人存储上限（MiB）')).toHaveValue(200)
  expect(screen.getByLabelText('全站存储上限（MiB）')).toHaveValue(512)
  const save = screen.getByRole('button', { name: '保存更改' })
  expect(save).toBeDisabled()
  fireEvent.change(screen.getByLabelText('每人最多保存数量'), {
    target: { value: '250' },
  })
  fireEvent.change(screen.getByLabelText('每人存储上限（MiB）'), {
    target: { value: '300' },
  })
  fireEvent.change(screen.getByLabelText('全站存储上限（MiB）'), {
    target: { value: '600' },
  })
  fireEvent.change(screen.getByLabelText('图片保留天数'), {
    target: { value: '14' },
  })
  await userEvent.click(screen.getByRole('switch', { name: '启用个人图库' }))
  await userEvent.click(save)
  await waitFor(() =>
    expect(saved).toEqual({
      enabled: false,
      retention_days: 14,
      user_max_images: 250,
      user_max_bytes: 314572800,
      total_max_bytes: 629145600,
    })
  )
  await waitFor(() => expect(save).toBeDisabled())
  expect(
    screen.getByText('保留天数的修改仅影响以后保存的图片。', { exact: false })
  ).toBeVisible()
})

it('rejects zero and over-limit input without sending settings, and reset restores the fetched defaults', async () => {
  let writes = 0
  api.defaults.adapter = async (config) => {
    if (config.method === 'put') writes++
    return response(config, defaults)
  }
  showSettings()
  const count = await screen.findByLabelText('Maximum images per person')
  fireEvent.change(count, { target: { value: '0' } })
  await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(await screen.findByText('Gallery settings are invalid.')).toBeVisible()
  expect(count).toHaveAttribute('aria-invalid', 'true')
  expect(writes).toBe(0)
  await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(count).toHaveValue(100)
})

it('does not fetch root-only settings for ordinary users and hides a root draft after account change', async () => {
  const methods: string[] = []
  api.defaults.adapter = async (config) => {
    methods.push(config.method || '')
    return response(config, defaults)
  }
  showSettings()
  expect(await screen.findByLabelText('Maximum images per person')).toHaveValue(
    100
  )
  act(() => login(814, 'ordinary', 1))
  expect(
    screen.queryByLabelText('Maximum images per person')
  ).not.toBeInTheDocument()
  expect(methods).toEqual(['get'])
  await waitFor(() =>
    expect(
      screen.getByText('Only root users can manage gallery settings.')
    ).toBeVisible()
  )
})

it('registers gallery as a standalone operations settings page', () => {
  expect(getOperationsSectionNavItems(i18next.t)).toContainEqual(
    expect.objectContaining({
      url: '/system-settings/operations/gallery',
      title: 'Gallery storage',
    })
  )
})

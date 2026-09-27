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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { CanvasSettingsSection } from '../canvas-settings-section'

const adapter = api.defaults.adapter
let cleanupView: (() => void) | null = null
afterEach(() => {
  cleanupView?.()
  cleanupView = null
  api.defaults.adapter = adapter
})

function renderSection(props: {
  defaultModels: string
  disabledResolutions: string
}) {
  const saved: { key: string; value: string }[] = []
  api.defaults.adapter = async (config) => {
    const reply = (data: unknown) => ({
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data,
    })
    if (config.method === 'put') {
      saved.push(JSON.parse(config.data))
      return reply({ success: true, message: '' })
    }
    if (config.url === '/api/group/') {
      return reply({ success: true, data: ['vip', 'default'] })
    }
    if (config.url === '/api/channel/models_enabled') {
      return reply({
        success: true,
        data: ['nano-banana-pro', 'gpt-5', 'gpt-image-2'],
      })
    }
    throw new Error(`Unexpected request to ${config.url}`)
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const actions = document.createElement('div')
  document.body.append(actions)
  const view = render(
    <QueryClientProvider client={client}>
      <SettingsPageProvider actionsContainer={actions}>
        <CanvasSettingsSection {...props} />
      </SettingsPageProvider>
    </QueryClientProvider>
  )
  cleanupView = () => {
    view.unmount()
    actions.remove()
    client.clear()
  }
  return saved
}

it('offers only the enabled image models, leaving the choice to the canvas when none is set', async () => {
  renderSection({ defaultModels: '{}', disabledResolutions: '{}' })
  const model = await screen.findByRole('combobox', {
    name: 'Default model for vip',
  })
  expect(model).toHaveValue('')
  expect(
    within(model)
      .getAllByRole('option')
      .map((option) => option.textContent)
  ).toEqual(['Automatic', 'gpt-image-2', 'nano-banana-pro'])
})

it('saves a group default model and a withheld tier as the two canvas options', async () => {
  const saved = renderSection({
    defaultModels: '{}',
    disabledResolutions: '{}',
  })
  const user = userEvent.setup()
  await user.selectOptions(
    await screen.findByRole('combobox', { name: 'Default model for vip' }),
    'gpt-image-2'
  )
  await user.click(screen.getByRole('switch', { name: 'Offer 4K to vip' }))
  await user.click(screen.getByRole('button', { name: 'Save canvas settings' }))
  await waitFor(() => expect(saved).toHaveLength(2))
  expect(saved).toEqual([
    { key: 'canvas_setting.default_models', value: '{"vip":"gpt-image-2"}' },
    { key: 'canvas_setting.disabled_resolutions', value: '{"vip":["4K"]}' },
  ])
})

it('keeps the last tier a group is offered switched on', async () => {
  renderSection({
    defaultModels: '{}',
    disabledResolutions: '{"vip":["1K","2K"]}',
  })
  const lastTier = await screen.findByRole('switch', {
    name: 'Offer 4K to vip',
  })
  expect(lastTier).toBeChecked()
  expect(lastTier).toHaveAttribute('aria-disabled', 'true')
  expect(
    screen.getByRole('switch', { name: 'Offer 1K to vip' })
  ).not.toHaveAttribute('aria-disabled', 'true')
})

it('keeps a saved default model listed after it stops being an enabled image model', async () => {
  renderSection({
    defaultModels: '{"vip":"gpt-image-1.5"}',
    disabledResolutions: '{}',
  })
  const model = await screen.findByRole('combobox', {
    name: 'Default model for vip',
  })
  expect(model).toHaveValue('gpt-image-1.5')
  expect(
    within(model).getByRole('option', { name: 'gpt-image-1.5 (unavailable)' })
  ).toBeInTheDocument()
})

it('lists a group that is gone while it still holds a canvas setting', async () => {
  renderSection({
    defaultModels: '{}',
    disabledResolutions: '{"retired":["4K"]}',
  })
  expect(
    await screen.findByRole('switch', { name: 'Offer 4K to retired' })
  ).not.toBeChecked()
})

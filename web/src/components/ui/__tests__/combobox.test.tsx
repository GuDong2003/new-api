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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Combobox } from '../combobox'

const options = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google' },
  { value: 'disabled', label: 'Unavailable provider', disabled: true },
]

function Fixture() {
  const [value, setValue] = useState('openai')
  return (
    <>
      <Combobox
        options={options}
        value={value}
        onValueChange={(next) => setValue(next ?? '')}
        aria-label='Provider'
        emptyText='No matching provider'
      />
      <output>{value}</output>
    </>
  )
}

describe('searchable single selection', () => {
  it('searches labels and values without committing text, shows empty results, and restores the selection on Escape', async () => {
    render(<Fixture />)
    const user = userEvent.setup()
    const input = screen.getByRole('combobox', { name: 'Provider' })
    expect(input).toHaveValue('OpenAI')
    await user.click(input)
    await user.type(input, 'missing')
    expect(screen.getByText('No matching provider')).toBeVisible()
    expect(screen.getByText('openai')).toHaveTextContent('openai')
    await user.keyboard('{Escape}')
    expect(input).toHaveValue('OpenAI')
    await user.click(input)
    await user.type(input, 'gemini')
    expect(screen.getByRole('option', { name: 'Google' })).toBeVisible()
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(input).toHaveValue('Google'))
    expect(screen.getByText('gemini')).toHaveTextContent('gemini')
  })

  it('respects disabled controls and options', async () => {
    const change = vi.fn()
    const view = render(
      <Combobox
        options={options}
        value='openai'
        onValueChange={change}
        aria-label='Provider'
        disabled
      />
    )
    const user = userEvent.setup()
    expect(screen.getByRole('combobox', { name: 'Provider' })).toBeDisabled()
    view.rerender(
      <Combobox
        options={options}
        value='openai'
        onValueChange={change}
        aria-label='Provider'
      />
    )
    await user.click(screen.getByRole('combobox', { name: 'Provider' }))
    expect(
      screen.getByRole('option', { name: 'Unavailable provider' })
    ).toHaveAttribute('aria-disabled', 'true')
    await user.click(
      screen.getByRole('option', { name: 'Unavailable provider' })
    )
    expect(change).not.toHaveBeenCalled()
  })
})

const pluginOptions = [
  {
    value: 'alpha',
    label: 'Alpha plugin',
    icon: <img src='/api/plugin/task/alpha/icon' alt='' />,
  },
  {
    value: 'beta',
    label: 'Beta plugin',
    icon: <img src='/api/plugin/task/beta/icon' alt='' />,
  },
]

function PluginSelectionFixture() {
  const [value, setValue] = useState<string | null>('alpha')
  return (
    <Combobox
      options={pluginOptions}
      value={value}
      onValueChange={setValue}
      showSelectedIcon
      aria-label='Task plugin'
    />
  )
}

describe('selected option icons', () => {
  it('shows the selected plugin logo and updates it when choosing another plugin', async () => {
    render(<PluginSelectionFixture />)
    const user = userEvent.setup()
    const input = screen.getByRole('combobox', { name: 'Task plugin' })
    expect(screen.getByAltText('')).toHaveAttribute(
      'src',
      '/api/plugin/task/alpha/icon'
    )
    await user.click(input)
    const nextOption = screen.getByRole('option', { name: 'Beta plugin' })
    expect(nextOption.querySelector('img')).toHaveAttribute(
      'src',
      '/api/plugin/task/beta/icon'
    )
    await user.click(nextOption)
    await waitFor(() => expect(input).toHaveValue('Beta plugin'))
    expect(screen.getByAltText('')).toHaveAttribute(
      'src',
      '/api/plugin/task/beta/icon'
    )
  })

  it('removes the logo when the selection is cleared or no longer has an icon', () => {
    const view = render(
      <Combobox
        options={pluginOptions}
        value='alpha'
        showSelectedIcon
        aria-label='Task plugin'
      />
    )
    expect(screen.getByAltText('')).toBeInTheDocument()
    view.rerender(
      <Combobox
        options={pluginOptions}
        value={null}
        showSelectedIcon
        aria-label='Task plugin'
      />
    )
    expect(screen.queryByAltText('')).not.toBeInTheDocument()
    view.rerender(
      <Combobox
        options={[{ value: 'alpha', label: 'Alpha plugin' }]}
        value='alpha'
        showSelectedIcon
        aria-label='Task plugin'
      />
    )
    expect(screen.queryByAltText('')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Task plugin' })).toHaveValue(
      'Alpha plugin'
    )
  })

  it('preserves the existing text-only selected state unless icon display is requested', () => {
    render(
      <Combobox
        options={pluginOptions}
        value='alpha'
        aria-label='Task plugin'
      />
    )
    expect(screen.queryByAltText('')).not.toBeInTheDocument()
  })
})

describe('grouped options', () => {
  const models = [
    { value: 'gpt-image-2', label: 'gpt-image-2' },
    { value: 'dall-e-3', label: 'dall-e-3' },
    { value: 'nano-banana-pro', label: 'nano-banana-pro' },
    { value: 'grok-imagine-image-2.0', label: 'grok-imagine-image-2.0' },
  ]
  const vendorOf = (value: string) => {
    if (value.startsWith('gpt-') || value.startsWith('dall-e')) return 'OpenAI'
    if (value.startsWith('nano-banana')) return 'Gemini'
    return 'xAI'
  }

  it('labels each vendor and keeps its models together', async () => {
    render(
      <Combobox
        options={models}
        groupBy={(option) => vendorOf(option.value)}
        value=''
        onValueChange={vi.fn()}
        aria-label='Model'
      />
    )
    await userEvent
      .setup()
      .click(screen.getByRole('combobox', { name: 'Model' }))

    for (const vendor of ['OpenAI', 'Gemini', 'xAI']) {
      expect(screen.getByText(vendor)).toBeVisible()
    }
    const openai = screen
      .getByText('OpenAI')
      .closest('[data-slot="combobox-group"]')
    expect(openai).not.toBeNull()
    expect(within(openai as HTMLElement).getByText('gpt-image-2')).toBeVisible()
    expect(within(openai as HTMLElement).getByText('dall-e-3')).toBeVisible()
    expect(
      within(openai as HTMLElement).queryByText('nano-banana-pro')
    ).toBeNull()
  })

  it('still selects a model from inside a group', async () => {
    const onValueChange = vi.fn()
    render(
      <Combobox
        options={models}
        groupBy={(option) => vendorOf(option.value)}
        value=''
        onValueChange={onValueChange}
        aria-label='Model'
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getByRole('option', { name: 'nano-banana-pro' }))
    expect(onValueChange).toHaveBeenCalledWith('nano-banana-pro')
  })

  it('keeps the flat list when no grouping is requested', async () => {
    render(
      <Combobox
        options={models}
        value=''
        onValueChange={vi.fn()}
        aria-label='Model'
      />
    )
    await userEvent
      .setup()
      .click(screen.getByRole('combobox', { name: 'Model' }))
    expect(document.querySelector('[data-slot="combobox-group"]')).toBeNull()
    expect(screen.getByRole('option', { name: 'gpt-image-2' })).toBeVisible()
  })
})

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
import { describe, expect, it, vi } from 'vitest'

import { CHANNEL_PROBES } from '../../../lib/channel-test'
import { ChannelTestControls } from '../channel-test-controls'

function renderControls() {
  const onSelectedChange = vi.fn()
  const onEndpointChange = vi.fn()
  const onMessageChange = vi.fn()

  render(
    <ChannelTestControls
      selected={CHANNEL_PROBES.map((probe) => probe.id)}
      onSelectedChange={onSelectedChange}
      endpoint='auto'
      onEndpointChange={onEndpointChange}
      message=''
      onMessageChange={onMessageChange}
      disabled={false}
    />
  )

  return { onSelectedChange, onEndpointChange, onMessageChange }
}

describe('ChannelTestControls', () => {
  it('keeps the custom message inside collapsed advanced settings', async () => {
    const user = userEvent.setup()
    renderControls()

    const advanced = screen.getByRole('button', { name: 'Advanced settings' })
    expect(advanced).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('textbox', { name: 'Test message override' })
    ).toBeNull()

    await user.click(advanced)

    expect(advanced).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('textbox', { name: 'Test message override' })
    ).toBeInTheDocument()
  })

  it('renders four selectable capability checks and reports changes', async () => {
    const user = userEvent.setup()
    const { onSelectedChange } = renderControls()

    const capabilityGroup = screen.getByRole('group', {
      name: 'Test capabilities',
    })
    expect(within(capabilityGroup).getAllByRole('checkbox')).toHaveLength(4)

    await user.click(
      within(capabilityGroup).getByRole('checkbox', {
        name: 'Tools · non-streaming',
      })
    )

    expect(onSelectedChange).toHaveBeenCalledWith([
      'basic',
      'stream',
      'tool-stream',
    ])
  })
})

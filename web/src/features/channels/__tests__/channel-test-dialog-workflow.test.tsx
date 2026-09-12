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
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  channelTestApiFixture,
  renderChannelTest,
} from './channel-test-fixture'

let api: ReturnType<typeof channelTestApiFixture>
beforeEach(() => {
  api = channelTestApiFixture()
})
afterEach(async () => {
  cleanup()
  await api.finish()
  api.restore()
})

describe('channel test dialog workflow', () => {
  it('moves the custom message into advanced settings and starts the selected probes', async () => {
    const user = userEvent.setup()
    renderChannelTest()

    const advanced = screen.getByRole('button', { name: 'Advanced settings' })
    expect(advanced).toHaveAttribute('aria-expanded', 'false')
    await user.click(advanced)
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Test message override' }),
      { target: { value: 'Reply briefly.' } }
    )
    await user.click(screen.getByRole('button', { name: 'Start testing' }))

    await waitFor(() => expect(api.requests).toHaveLength(4))
    expect(api.requests.map((request) => request.body.test_type)).toEqual([
      'basic',
      'basic',
      'tool_call',
      'tool_call',
    ])
    expect(
      api.requests
        .filter((request) => request.body.test_type === 'basic')
        .every((request) => request.body.message === 'Reply briefly.')
    ).toBe(true)
    expect(
      api.requests
        .filter((request) => request.body.test_type === 'tool_call')
        .every((request) => request.body.message === undefined)
    ).toBe(true)
  })

  it('runs only the selected capabilities for selected models', async () => {
    const user = userEvent.setup()
    renderChannelTest(['gpt-4o', 'gpt-4.1'])
    const capabilities = screen.getByRole('group', {
      name: 'Test capabilities',
    })
    await user.click(
      within(capabilities).getByRole('checkbox', {
        name: 'Tools · non-streaming',
      })
    )
    const table = screen.getByRole('region', { name: 'Channel models' })
    await user.click(
      within(table).getByRole('checkbox', { name: 'Select model gpt-4o' })
    )
    await user.click(screen.getByRole('button', { name: 'Test selected (1)' }))

    await waitFor(() => expect(api.requests).toHaveLength(3))
    expect(api.requests.map((request) => request.body.model)).toEqual([
      'gpt-4o',
      'gpt-4o',
      'gpt-4o',
    ])
    expect(
      api.requests.some(
        (request) =>
          request.body.test_type === 'tool_call' &&
          request.body.stream === false
      )
    ).toBe(false)
    await act(async () => api.finish())
  })
})

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

import type {
  ChannelProbeId,
  ChannelProbeResults,
} from '../../../lib/channel-test'
import { ChannelTestMatrix } from '../channel-test-matrix'

describe('ChannelTestMatrix', () => {
  it('renders one status cell for every capability and exposes a model endpoint selector', () => {
    const results: ChannelProbeResults = {}
    render(
      <ChannelTestMatrix
        models={['gpt-4o']}
        results={results}
        selected={{}}
        onSelectedChange={vi.fn()}
        endpointOverrides={{}}
        onEndpointChange={vi.fn()}
        endpointForModel={() => 'openai'}
        configurationKey={() => 'current'}
        busy={false}
        defaultModel='gpt-4o'
        onRun={vi.fn()}
        onDetails={vi.fn()}
        emptyText='No models'
      />
    )

    const table = screen.getByRole('region', { name: 'Channel models' })
    expect(within(table).getAllByRole('columnheader')).toHaveLength(5)
    expect(
      within(table).getAllByRole('button', { name: /gpt-4o · .*Not tested/ })
    ).toHaveLength(4)
    expect(
      within(table).getByRole('combobox', { name: 'Endpoint for gpt-4o' })
    ).toBeInTheDocument()
  })

  it('runs an untested capability from its matrix cell', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn<(model: string, probe: ChannelProbeId) => void>()
    render(
      <ChannelTestMatrix
        models={['gpt-4o']}
        results={{}}
        selected={{}}
        onSelectedChange={vi.fn()}
        endpointOverrides={{}}
        onEndpointChange={vi.fn()}
        endpointForModel={() => 'openai'}
        configurationKey={() => 'current'}
        busy={false}
        onRun={onRun}
        onDetails={vi.fn()}
        emptyText='No models'
      />
    )

    const table = screen.getByRole('region', { name: 'Channel models' })
    await user.click(
      within(table).getByRole('button', {
        name: 'gpt-4o · Non-streaming: Not tested',
      })
    )

    expect(onRun).toHaveBeenCalledWith('gpt-4o', 'basic')
  })
})

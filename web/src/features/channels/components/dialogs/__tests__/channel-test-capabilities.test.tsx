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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import type {
  ChannelProbeId,
  ChannelProbeResult,
} from '../../../lib/channel-test'
import { ChannelCapabilitiesCell } from '../channel-test-capabilities'

const CURRENT_KEY = 'current-config'

const PASSED_DIAGNOSTICS = {
  status: 'passed',
  reason: 'response_validated',
  endpoint_type: 'openai',
  test_type: 'basic',
  requested_stream: false,
  duration_ms: 412,
  event_count: 0,
  tool_count: 0,
} as const satisfies ChannelProbeResult['diagnostics']

function passedResult(
  overrides: Partial<ChannelProbeResult> = {}
): ChannelProbeResult {
  return {
    model: 'gpt-4o',
    probe: 'basic',
    endpoint: 'openai',
    message: '',
    configurationKey: CURRENT_KEY,
    status: 'passed',
    completedAt: 1,
    diagnostics: PASSED_DIAGNOSTICS,
    ...overrides,
  }
}

function renderCell(
  options: {
    endpoint?: string
    results?: Partial<Record<ChannelProbeId, ChannelProbeResult>>
    busy?: boolean
  } = {}
) {
  const onRun = vi.fn()
  const onDetails = vi.fn()
  render(
    <ChannelCapabilitiesCell
      busy={options.busy ?? false}
      configurationKey={() => CURRENT_KEY}
      endpoint={options.endpoint ?? 'openai'}
      model='gpt-4o'
      onDetails={onDetails}
      onRun={onRun}
      results={options.results}
    />
  )
  return { onRun, onDetails }
}

describe('ChannelCapabilitiesCell', () => {
  test('offers one control per capability probe', () => {
    renderCell()

    expect(
      screen.getByRole('button', { name: /Non-streaming: Not tested/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /· Streaming: Not tested/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Tools · non-streaming: Not tested/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Tools · streaming: Not tested/ })
    ).toBeInTheDocument()
  })

  test('runs the probe when an untested capability is activated', async () => {
    const user = userEvent.setup()
    const { onRun, onDetails } = renderCell()

    await user.click(
      screen.getByRole('button', { name: /Non-streaming: Not tested/ })
    )

    expect(onRun).toHaveBeenCalledWith('basic')
    expect(onDetails).not.toHaveBeenCalled()
  })

  test('opens the details for a capability that already has a result', async () => {
    const user = userEvent.setup()
    const { onRun, onDetails } = renderCell({
      results: { basic: passedResult() },
    })

    await user.click(
      screen.getByRole('button', { name: /Non-streaming: Passed/ })
    )

    expect(onDetails).toHaveBeenCalledWith('basic', expect.anything())
    expect(onRun).not.toHaveBeenCalled()
  })

  test('reports a faked stream as a compatibility stream', () => {
    renderCell({
      results: {
        stream: passedResult({
          probe: 'stream',
          status: 'degraded',
          diagnostics: {
            ...PASSED_DIAGNOSTICS,
            status: 'degraded',
            reason: 'compatibility_stream',
            requested_stream: true,
            upstream_stream: false,
          },
        }),
      },
    })

    expect(
      screen.getByRole('button', { name: /Streaming: Compatibility stream/ })
    ).toBeInTheDocument()
  })

  test('disables a capability the endpoint cannot support', () => {
    renderCell({ endpoint: 'embeddings' })

    expect(
      screen.getByRole('button', { name: /· Streaming: Not applicable/ })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: /Non-streaming: Not tested/ })
    ).toBeEnabled()
  })

  test('blocks starting a new probe while a run is in progress', () => {
    renderCell({ busy: true })

    expect(
      screen.getByRole('button', { name: /Non-streaming: Not tested/ })
    ).toBeDisabled()
  })

  test('still opens details for an existing result while a run is in progress', async () => {
    const user = userEvent.setup()
    const { onDetails } = renderCell({
      busy: true,
      results: { basic: passedResult() },
    })

    await user.click(
      screen.getByRole('button', { name: /Non-streaming: Passed/ })
    )

    expect(onDetails).toHaveBeenCalledWith('basic', expect.anything())
  })

  test('marks a result captured under earlier settings as stale', async () => {
    const user = userEvent.setup()
    renderCell({
      results: { basic: passedResult({ configurationKey: 'older-config' }) },
    })

    await user.hover(
      screen.getByRole('button', { name: /Non-streaming: Passed/ })
    )

    expect(await screen.findByText(/Settings changed/)).toBeInTheDocument()
  })
})

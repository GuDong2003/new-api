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
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'

import { ReasoningEffortControl } from '../reasoning-effort-control'

function renderControl(
  overrides: Partial<React.ComponentProps<typeof ReasoningEffortControl>> = {}
) {
  const onValueChange = vi.fn()
  const onEnabledChange = vi.fn()
  render(
    <ReasoningEffortControl
      enabled
      onEnabledChange={onEnabledChange}
      onValueChange={onValueChange}
      value='medium'
      {...overrides}
    />
  )
  return { onValueChange, onEnabledChange }
}

/** Mirrors how the parameter panel owns the value in playground config state. */
function ControlledControl(props: { onValueChange: (value: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <ReasoningEffortControl
      enabled
      onEnabledChange={() => undefined}
      onValueChange={(next) => {
        setValue(next)
        props.onValueChange(next)
      }}
      value={value}
    />
  )
}

describe('ReasoningEffortControl', () => {
  test('shows the current effort in an input labelled for the parameter', () => {
    renderControl()

    expect(screen.getByLabelText('Reasoning Effort')).toHaveValue('medium')
  })

  test('reports the new state when the enable switch is turned off', async () => {
    const user = userEvent.setup()
    const { onEnabledChange } = renderControl()

    await user.click(
      screen.getByRole('switch', { name: 'Enable Reasoning Effort' })
    )

    expect(onEnabledChange).toHaveBeenCalledWith(false)
  })

  test('reports the new state when the enable switch is turned on', async () => {
    const user = userEvent.setup()
    const { onEnabledChange } = renderControl({ enabled: false })

    await user.click(
      screen.getByRole('switch', { name: 'Enable Reasoning Effort' })
    )

    expect(onEnabledChange).toHaveBeenCalledWith(true)
  })

  test('disables the effort input while the parameter is switched off', () => {
    renderControl({ enabled: false })

    expect(screen.getByLabelText('Reasoning Effort')).toBeDisabled()
  })

  test('disables both the input and the switch while the panel is disabled', () => {
    renderControl({ disabled: true })

    expect(screen.getByLabelText('Reasoning Effort')).toBeDisabled()
    expect(
      screen.getByRole('switch', { name: 'Enable Reasoning Effort' })
    ).toHaveAttribute('aria-disabled', 'true')
  })

  test('accepts a custom level that is not one of the suggestions', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<ControlledControl onValueChange={onValueChange} />)

    await user.type(screen.getByLabelText('Reasoning Effort'), 'ultra')

    expect(onValueChange).toHaveBeenLastCalledWith('ultra')
    expect(screen.getByLabelText('Reasoning Effort')).toHaveValue('ultra')
  })

  test('reports the picked level when a suggestion is chosen', async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderControl({ value: '' })

    await user.click(screen.getByLabelText('Reasoning Effort'))
    await user.click(await screen.findByRole('option', { name: 'xhigh' }))

    expect(onValueChange).toHaveBeenCalledWith('xhigh')
  })

  test('bounds the typed level to the length the config schema stores', () => {
    renderControl()

    expect(screen.getByLabelText('Reasoning Effort')).toHaveAttribute(
      'maxlength',
      '64'
    )
  })

  test('describes the input with the supported-levels hint', () => {
    renderControl()

    const input = screen.getByLabelText('Reasoning Effort')
    const describedBy = input.getAttribute('aria-describedby')

    expect(describedBy).toBeTruthy()
    expect(document.querySelector(`#${describedBy}`)?.textContent).toMatch(
      /Supported levels depend on the model/
    )
  })
})

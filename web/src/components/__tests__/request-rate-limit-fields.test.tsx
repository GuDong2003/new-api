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
import { useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'

import { Form } from '@/components/ui/form'
import type { RequestRateLimitFieldsValues } from '@/lib/request-rate-limit'

import { RequestRateLimitFields } from '../request-rate-limit-fields'

function Fields(props: {
  rateLimit: RequestRateLimitFieldsValues
  disabled?: boolean
}) {
  const form = useForm({ defaultValues: { rate_limit: props.rateLimit } })
  return (
    <Form {...form}>
      <RequestRateLimitFields
        label='Set a limit for this user'
        description='Follows the group while off'
        disabled={props.disabled}
      />
    </Form>
  )
}

describe('RequestRateLimitFields', () => {
  it('shows the two caps only once the limit is switched on', async () => {
    const user = userEvent.setup()
    render(
      <Fields rateLimit={{ enabled: false, count: 5, success_count: 3 }} />
    )
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0)

    await user.click(
      screen.getByRole('switch', { name: 'Set a limit for this user' })
    )

    const caps = screen.getAllByRole('spinbutton')
    expect(caps).toHaveLength(2)
    expect(caps[0]).toHaveValue(5)
    expect(caps[1]).toHaveValue(3)
  })

  it('locks the switch and caps for someone who cannot edit them', () => {
    render(
      <Fields
        rateLimit={{ enabled: true, count: 5, success_count: 3 }}
        disabled
      />
    )
    expect(
      screen.getByRole('switch', { name: 'Set a limit for this user' })
    ).toHaveAttribute('aria-disabled', 'true')
    for (const cap of screen.getAllByRole('spinbutton')) {
      expect(cap).toBeDisabled()
    }
  })
})

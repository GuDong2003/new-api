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
import { describe, expect, it } from 'vitest'

import { RequestRateLimitSummary } from '../request-rate-limit-summary'

describe('RequestRateLimitSummary', () => {
  it('shows the caps, the period and where a group limit comes from', () => {
    render(
      <RequestRateLimitSummary
        limit={{
          count: 10,
          success_count: 5,
          duration_minutes: 1,
          source: 'group',
          raised: false,
        }}
      />
    )
    expect(screen.getByText('10 requests · 5 successful')).toBeInTheDocument()
    expect(screen.getByText('Every 1 min · Group')).toBeInTheDocument()
    expect(screen.queryByText('Raised by subscription')).not.toBeInTheDocument()
  })

  it('marks a limit a subscription raised past its cap on requests', () => {
    render(
      <RequestRateLimitSummary
        limit={{
          count: 0,
          success_count: 30,
          duration_minutes: 5,
          source: 'user',
          raised: true,
        }}
      />
    )
    expect(
      screen.getByText('Unlimited requests · 30 successful')
    ).toBeInTheDocument()
    expect(screen.getByText('Raised by subscription')).toBeInTheDocument()
  })
})

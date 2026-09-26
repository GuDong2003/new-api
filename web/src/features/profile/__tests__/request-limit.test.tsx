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
import { describe, expect, it, vi } from 'vitest'

import { ProfileHeader } from '../components/profile-header'
import type { UserProfile } from '../types'

const profile: UserProfile = {
  id: 7,
  username: 'alice',
  display_name: 'Alice',
  role: 1,
  group: 'vip',
  quota: 0,
  used_quota: 0,
  request_count: 0,
  status: 1,
  aff_count: 0,
  aff_quota: 0,
  aff_history_quota: 0,
  created_time: 0,
}

describe('profile request limit', () => {
  it('shows the request limit the user is held to', () => {
    render(
      <ProfileHeader
        profile={{
          ...profile,
          request_rate_limit: {
            count: 5,
            success_count: 5,
            duration_minutes: 1,
            source: 'group',
            raised: false,
          },
        }}
        loading={false}
        onAvatarChanged={vi.fn()}
      />
    )
    expect(screen.getByText('Request Limit')).toBeInTheDocument()
    expect(screen.getByText('5 requests · 5 successful')).toBeInTheDocument()
    expect(screen.getByText('Every 1 min · Group')).toBeInTheDocument()
  })

  it('shows no request limit row when the server sends none', () => {
    render(
      <ProfileHeader
        profile={profile}
        loading={false}
        onAvatarChanged={vi.fn()}
      />
    )
    expect(screen.queryByText('Request Limit')).not.toBeInTheDocument()
  })
})

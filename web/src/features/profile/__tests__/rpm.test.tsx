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
  id: 1,
  username: 'GuDong226',
  display_name: 'Root User',
  role: 100,
  group: 'svip',
  quota: 0,
  used_quota: 0,
  request_count: 0,
  status: 1,
  aff_count: 0,
  aff_quota: 0,
  aff_history_quota: 0,
  created_time: 0,
}

describe('profile RPM', () => {
  it('shows the RPM next to the group under the name', () => {
    render(
      <ProfileHeader
        profile={{ ...profile, request_rpm: 9999 }}
        loading={false}
        onAvatarChanged={vi.fn()}
      />
    )
    const rpm = screen.getByText('RPM 9,999')
    expect(rpm.parentElement).toHaveTextContent('@GuDong226•svip•RPM 9,999')
  })

  it('says the RPM is unlimited when there is no limit', () => {
    render(
      <ProfileHeader
        profile={{ ...profile, request_rpm: 0 }}
        loading={false}
        onAvatarChanged={vi.fn()}
      />
    )
    expect(screen.getByText('RPM Unlimited')).toBeInTheDocument()
  })

  it('shows no RPM when the server sends none', () => {
    render(
      <ProfileHeader
        profile={profile}
        loading={false}
        onAvatarChanged={vi.fn()}
      />
    )
    expect(screen.queryByText(/^RPM/)).not.toBeInTheDocument()
  })
})

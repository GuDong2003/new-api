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
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, describe, expect, test } from 'vitest'

import { UserAvatarEditor } from '../../user-avatar-editor'

describe('user avatar editor', () => {
  beforeAll(() => {
    i18next.addResourceBundle('en', 'translation', {
      'Change Avatar': 'Change Avatar',
      'Change or remove avatar': 'Change or remove avatar',
      "{{name}}'s avatar": "{{name}}'s avatar",
    })
  })

  test('avatar editor trigger stays keyboard-accessible without a custom image', () => {
    render(
      <I18nextProvider i18n={i18next}>
        <UserAvatarEditor compact name='alice' />
      </I18nextProvider>
    )

    const trigger = screen.getByRole('button', { name: 'Change Avatar' })

    expect(trigger).toHaveAttribute('type', 'button')
    expect(trigger.querySelector('img')).toBeNull()
    expect(trigger).toHaveTextContent('A')
  })

  test('avatar editor exposes change and removal when an avatar URL exists', () => {
    render(
      <I18nextProvider i18n={i18next}>
        <UserAvatarEditor
          avatarUrl='/api/avatar/0123456789abcdef0123456789abcdef.svg'
          compact={false}
          name='alice'
        />
      </I18nextProvider>
    )

    expect(screen.getByText('Change or remove avatar')).toBeInTheDocument()
  })
})

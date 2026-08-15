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
import { fireEvent, render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, describe, expect, test } from 'vitest'

import { InviteCodeRowActions } from '../invite-code-row-actions'
import type { InviteCode } from '../types'

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    Delete: 'Delete',
    Edit: 'Edit',
    'Delete Invitation Code': 'Delete Invitation Code',
    'Used invitation codes cannot be deleted. Disable them instead.':
      'Used invitation codes cannot be deleted. Disable them instead.',
  })
})

const baseInviteCode: InviteCode = {
  id: 1,
  code_prefix: 'NAPI-ABCD',
  code: 'NAPI-ABCD-EFGH-JKLM-NPQR',
  code_available: true,
  name: 'early access',
  status: 1,
  max_uses: 1,
  used_count: 0,
  created_by: 1,
  created_time: 1,
  updated_time: 1,
  expired_time: 0,
}

function renderActions(inviteCode: InviteCode, onDelete: () => void) {
  return render(
    <I18nextProvider i18n={i18next}>
      <InviteCodeRowActions
        inviteCode={inviteCode}
        onEdit={() => undefined}
        onDelete={onDelete}
      />
    </I18nextProvider>
  )
}

function getDeleteButton(name: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name })
}

describe('invitation code row actions', () => {
  test('unused invitation code exposes an enabled destructive action', () => {
    let deleteCount = 0
    renderActions(baseInviteCode, () => {
      deleteCount += 1
    })
    const deleteButton = getDeleteButton(/^Delete Invitation Code$/)

    expect(deleteButton).toBeEnabled()
    expect(deleteButton).toHaveAttribute('aria-label', 'Delete Invitation Code')
    fireEvent.click(deleteButton)
    expect(deleteCount).toBe(1)
  })

  test('used invitation code keeps delete disabled and explains the fallback', () => {
    let deleteCount = 0
    renderActions({ ...baseInviteCode, used_count: 1 }, () => {
      deleteCount += 1
    })
    const deleteButton = getDeleteButton(
      /Used invitation codes cannot be deleted/i
    )

    expect(deleteButton).toBeDisabled()
    expect(deleteButton).toHaveAttribute(
      'aria-label',
      'Used invitation codes cannot be deleted. Disable them instead.'
    )
    fireEvent.click(deleteButton)
    expect(deleteCount).toBe(0)
  })
})

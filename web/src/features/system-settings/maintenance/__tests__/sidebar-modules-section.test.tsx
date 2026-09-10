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
*/
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  serializeSidebarModulesAdmin,
  type SidebarModulesAdminConfig,
} from '../config'
import { SidebarModulesSection } from '../sidebar-modules-section'

const mutateAsync = vi.fn()

vi.mock('../../hooks/use-update-option', () => ({
  useUpdateOption: () => ({
    isPending: false,
    mutateAsync,
  }),
}))

const config: SidebarModulesAdminConfig = {
  chat: {
    enabled: true,
    order: ['playground', 'chat'],
    playground: true,
    chat: true,
  },
}

function readModuleOrder() {
  return screen
    .getAllByRole('button', { name: /^Drag .* to reorder$/ })
    .map((button) => button.getAttribute('aria-label'))
}

describe('sidebar module ordering', () => {
  beforeEach(() => {
    mutateAsync.mockReset()
  })

  it('updates the module list immediately when an arrow reorders a module', async () => {
    render(
      <SidebarModulesSection
        config={config}
        initialSerialized={serializeSidebarModulesAdmin(config)}
      />
    )

    expect(readModuleOrder()).toEqual([
      'Drag Playground to reorder',
      'Drag Chat to reorder',
    ])

    fireEvent.click(
      screen.getByRole('button', { name: 'Move Playground down' })
    )

    await waitFor(() => {
      expect(readModuleOrder()).toEqual([
        'Drag Chat to reorder',
        'Drag Playground to reorder',
      ])
    })
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})

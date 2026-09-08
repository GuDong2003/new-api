/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Route } from '../route'

describe('Playground layout', () => {
  it('shows the active playground page without a duplicate top navigation bar', async () => {
    const root = createRootRoute({ component: Route.options.component })
    const page = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => <div>Active playground page</div>,
    })
    const router = createRouter({
      routeTree: root.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    await router.load()

    render(<RouterProvider router={router} />)

    expect(screen.getByText('Active playground page')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Playground' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Playground' })).toBeNull()
  })
})

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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  parseHeaderNavModules,
  serializeHeaderNavModules,
} from '@/features/system-settings/maintenance/config'
import { useAuthStore } from '@/stores/auth-store'

import { useTopNavLinks } from '../use-top-nav-links'

afterEach(() => useAuthStore.getState().auth.reset())

function navigation(config: object, authenticated = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  })
  client.setQueryData(['status'], { HeaderNavModules: JSON.stringify(config) })
  if (authenticated) {
    useAuthStore.getState().auth.setUser({ id: 1, username: 'alice', role: 1 })
  }
  return renderHook(useTopNavLinks, {
    wrapper: (props: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    ),
  })
}

describe('Infinite Canvas top navigation', () => {
  it('makes the workspace discoverable with login required in legacy configurations', () => {
    const { result } = navigation({ home: true, console: true })
    expect(result.current.find((link) => link.href === '/canvas')).toEqual({
      title: 'Infinite Canvas',
      href: '/canvas',
      requiresAuth: true,
    })
  })

  it('opens the workspace directly for authenticated users', () => {
    const { result } = navigation({}, true)
    expect(
      result.current.find((link) => link.href === '/canvas')?.requiresAuth
    ).toBe(false)
  })

  it('honors a saved disabled canvas entry without hiding the console', () => {
    const { result } = navigation({ canvas: false })
    expect(result.current.some((link) => link.href === '/canvas')).toBe(false)
    expect(result.current.some((link) => link.href === '/dashboard')).toBe(true)
  })

  it('defaults the settings switch on for old configurations and preserves disabling through save', () => {
    const config = parseHeaderNavModules('{"console":true}')
    expect(config.canvas).toBe(true)
    config.canvas = false
    expect(
      parseHeaderNavModules(serializeHeaderNavModules(config)).canvas
    ).toBe(false)
  })
})

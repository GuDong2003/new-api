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
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Playground } from '..'
import { usePlaygroundState } from '../hooks/use-playground-state'
import { loadMessages, saveMessages } from '../lib/storage/storage'
import type { Message } from '../types'

const accountA = { id: 101, username: 'A', role: 1 }
const accountB = { id: 102, username: 'B', role: 1 }
const messagesA: Message[] = [
  {
    key: 'a-message',
    from: 'user',
    versions: [{ id: 'a-version', content: 'Private conversation A' }],
  },
]
const messagesB: Message[] = [
  {
    key: 'b-message',
    from: 'user',
    versions: [{ id: 'b-version', content: 'Private conversation B' }],
  },
]

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.setUser(accountB)
  saveMessages(messagesB)
  useAuthStore.getState().auth.setUser(accountA)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAuthStore.getState().auth.reset()
  localStorage.clear()
})

test.each(['debounce', 'unmount'] as const)(
  'an account replacement during a pending %s save preserves both owners conversations',
  (flush) => {
    vi.useFakeTimers()
    const view = renderHook(usePlaygroundState)
    act(() => vi.advanceTimersByTime(0))
    act(() => view.result.current.updateMessages(messagesA))

    act(() => useAuthStore.getState().auth.setUser(accountB))
    if (flush === 'unmount') view.unmount()
    else act(() => vi.advanceTimersByTime(500))

    expect(loadMessages()).toEqual(messagesB)
    useAuthStore.getState().auth.setUser(accountA)
    expect(loadMessages()).toEqual(messagesA)
  }
)

test('replacing the account on an open playground shows only the new owners conversation and logout hides it', async () => {
  saveMessages(messagesA)
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: {} } })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  render(
    <QueryClientProvider client={client}>
      <Playground />
    </QueryClientProvider>
  )
  expect(await screen.findByText('Private conversation A')).toBeVisible()

  act(() => useAuthStore.getState().auth.setUser(accountB))
  expect(await screen.findByText('Private conversation B')).toBeVisible()
  expect(screen.queryByText('Private conversation A')).not.toBeInTheDocument()

  act(() => useAuthStore.getState().auth.reset())
  expect(screen.queryByText('Private conversation B')).not.toBeInTheDocument()
  client.clear()
})

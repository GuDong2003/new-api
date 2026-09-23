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
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useInView } from '../use-in-view'

type Callback = (entries: { isIntersecting: boolean }[]) => void

function stubObserver() {
  const observed: Element[] = []
  const disconnect = vi.fn()
  let notify: Callback = () => undefined
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: Callback) {
        notify = callback
      }
      observe(node: Element) {
        observed.push(node)
      }
      disconnect = disconnect
      unobserve = vi.fn()
      takeRecords = vi.fn()
    }
  )
  return {
    observed,
    disconnect,
    notify: (value: boolean) => notify([{ isIntersecting: value }]),
  }
}

afterEach(() => vi.unstubAllGlobals())

it('holds a picture back until it comes into view', () => {
  const observer = stubObserver()
  const view = renderHook(() => useInView<HTMLDivElement>())

  act(() => view.result.current.ref(document.createElement('div')))
  expect(view.result.current.inView).toBe(false)
  expect(observer.observed).toHaveLength(1)

  act(() => observer.notify(true))
  expect(view.result.current.inView).toBe(true)
})

// Scrolling a card away and back must not make its picture load twice, so the
// answer only ever goes one way.
it('keeps a picture once it has been seen', () => {
  const observer = stubObserver()
  const view = renderHook(() => useInView<HTMLDivElement>())

  act(() => view.result.current.ref(document.createElement('div')))
  act(() => observer.notify(true))
  act(() => observer.notify(false))

  expect(view.result.current.inView).toBe(true)
})

// A browser with no observer to ask shows every picture rather than none.
it('shows everything when the viewport cannot be observed', () => {
  const view = renderHook(() => useInView<HTMLDivElement>())

  expect(view.result.current.inView).toBe(true)
})

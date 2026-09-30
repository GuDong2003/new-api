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
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, assert, beforeEach, expect, test, vi } from 'vitest'

let Turnstile: typeof import('../turnstile').Turnstile

beforeEach(async () => {
  vi.resetModules()
  Turnstile = (await import('../turnstile')).Turnstile
})

afterEach(async () => {
  cleanup()
  document.querySelector('#cf-turnstile')?.dispatchEvent(new Event('error'))
  await act(async () => {})
  document.querySelector('#cf-turnstile')?.remove()
  delete window.turnstile
  vi.useRealTimers()
})

test('a page mounted while the script is loading renders after the original page unmounts', async () => {
  const first = render(<Turnstile siteKey='test-site' onVerify={vi.fn()} />)
  const script = document.querySelector<HTMLScriptElement>('#cf-turnstile')
  assert(script)
  first.unmount()
  const second = render(<Turnstile siteKey='test-site' onVerify={vi.fn()} />)
  const sdk = {
    render: vi.fn((_element: HTMLElement) => 'widget'),
    remove: vi.fn(),
  }
  window.turnstile = sdk
  fireEvent.load(script)
  await waitFor(() => expect(sdk.render).toHaveBeenCalledTimes(1))
  expect(second.container.contains(sdk.render.mock.calls[0][0])).toBe(true)
  expect(document.querySelectorAll('#cf-turnstile')).toHaveLength(1)
})

test('a failed script shows an error and retry can load a fresh widget without verifying the user', async () => {
  const onVerify = vi.fn()
  const onSubmit = vi.fn()
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Turnstile siteKey='test-site' onVerify={onVerify} />
    </form>
  )
  const first = document.querySelector<HTMLScriptElement>('#cf-turnstile')
  assert(first)
  fireEvent.error(first)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Human verification could not load'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  const second = document.querySelector<HTMLScriptElement>('#cf-turnstile')
  assert(second)
  expect(second).not.toBe(first)
  const sdk = { render: vi.fn(() => 'widget'), remove: vi.fn() }
  window.turnstile = sdk
  fireEvent.load(second)
  await waitFor(() => expect(sdk.render).toHaveBeenCalledTimes(1))
  expect(onVerify).not.toHaveBeenCalled()
  expect(onSubmit).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('two mounted widgets share one pending script and both render after it loads', async () => {
  render(
    <>
      <Turnstile siteKey='first-site' onVerify={vi.fn()} />
      <Turnstile siteKey='second-site' onVerify={vi.fn()} />
    </>
  )
  expect(document.querySelectorAll('#cf-turnstile')).toHaveLength(1)
  const sdk = {
    render: vi.fn(
      (_element: HTMLElement, _options: Record<string, unknown>) => 'widget'
    ),
    remove: vi.fn(),
  }
  window.turnstile = sdk
  const script = document.querySelector('#cf-turnstile')
  assert(script)
  fireEvent.load(script)
  await waitFor(() => expect(sdk.render).toHaveBeenCalledTimes(2))
  expect(sdk.render.mock.calls.map((call) => call[1].sitekey)).toEqual([
    'first-site',
    'second-site',
  ])
})

test('an unresponsive script shows a recoverable timeout rather than staying blank', async () => {
  vi.useFakeTimers()
  const onVerify = vi.fn()
  render(<Turnstile siteKey='test-site' onVerify={onVerify} />)
  await act(() => vi.advanceTimersByTimeAsync(20_000))
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Human verification could not load'
  )
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  expect(onVerify).not.toHaveBeenCalled()
})

test('rerendering callbacks keeps one widget and verification calls the latest owner', async () => {
  const sdk = {
    render: vi.fn(
      (_element: HTMLElement, _options: Record<string, unknown>) => 'widget'
    ),
    remove: vi.fn(),
  }
  window.turnstile = sdk
  const first = vi.fn()
  const next = vi.fn()
  const view = render(
    <Turnstile siteKey='test-site' onVerify={first} onExpire={() => {}} />
  )
  await waitFor(() => expect(sdk.render).toHaveBeenCalledTimes(1))
  view.rerender(
    <Turnstile siteKey='test-site' onVerify={next} onExpire={() => {}} />
  )
  const callback = sdk.render.mock.calls[0][1].callback as (
    token: string
  ) => void
  act(() => callback('verified-fixture'))
  expect(next).toHaveBeenCalledWith('verified-fixture')
  expect(first).not.toHaveBeenCalled()
  expect(sdk.render).toHaveBeenCalledTimes(1)
})

test('expiry clears verification and removed widgets cannot deliver late tokens', async () => {
  const sdk = {
    render: vi.fn(
      (_element: HTMLElement, _options: Record<string, unknown>) => 'widget'
    ),
    remove: vi.fn(),
  }
  window.turnstile = sdk
  const onVerify = vi.fn()
  const onExpire = vi.fn()
  const view = render(
    <Turnstile siteKey='test-site' onVerify={onVerify} onExpire={onExpire} />
  )
  await waitFor(() => expect(sdk.render).toHaveBeenCalledTimes(1))
  const options = sdk.render.mock.calls[0][1]
  act(() => (options.callback as (token: string) => void)('verified-fixture'))
  act(() => (options['expired-callback'] as () => void)())
  expect(onExpire).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(sdk.remove).toHaveBeenCalledWith('widget')
  act(() => (options.callback as (token: string) => void)('late-fixture'))
  expect(onVerify).toHaveBeenCalledTimes(1)
})

test('widget network errors show a code and retry replaces the failed instance', async () => {
  const sdk = {
    render: vi.fn(
      (_element: HTMLElement, _options: Record<string, unknown>) => 'widget'
    ),
    remove: vi.fn(),
  }
  window.turnstile = sdk
  const onVerify = vi.fn()
  render(<Turnstile siteKey='test-site' onVerify={onVerify} />)
  await waitFor(() => expect(sdk.render).toHaveBeenCalledTimes(1))
  act(() =>
    (sdk.render.mock.calls[0][1]['error-callback'] as (code: string) => void)(
      '200500'
    )
  )
  expect(screen.getByRole('alert')).toHaveTextContent('200500')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(sdk.render).toHaveBeenCalledTimes(2))
  expect(sdk.remove).toHaveBeenCalledWith('widget')
  expect(onVerify).not.toHaveBeenCalled()
})

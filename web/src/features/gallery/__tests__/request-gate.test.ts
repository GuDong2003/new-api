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
import { expect, it } from 'vitest'

import { createRequestGate } from '../lib/request-gate'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

it('runs no more tasks at once than the configured limit', async () => {
  const run = createRequestGate(2)
  const blockers = [deferred<string>(), deferred<string>(), deferred<string>()]
  let started = 0

  const results = blockers.map((blocker) =>
    run(() => {
      started++
      return blocker.promise
    })
  )

  await Promise.resolve()
  expect(started).toBe(2)

  blockers[0].resolve('first')
  await results[0]
  expect(started).toBe(3)

  blockers[1].resolve('second')
  blockers[2].resolve('third')
  await expect(Promise.all(results)).resolves.toEqual([
    'first',
    'second',
    'third',
  ])
})

it('resumes the next waiter when the woken waiter has been aborted', async () => {
  const run = createRequestGate(1)
  const blocker = deferred<string>()
  const controller = new AbortController()
  let queuedStarted = false

  const active = run(() => blocker.promise)
  const aborted = run(async () => 'aborted', controller.signal)
  const queued = run(async () => {
    queuedStarted = true
    return 'queued'
  })

  await Promise.resolve()
  controller.abort()
  blocker.resolve('active')

  await expect(active).resolves.toBe('active')
  await expect(aborted).rejects.toThrow()
  await expect(queued).resolves.toBe('queued')
  expect(queuedStarted).toBe(true)
})

it('releases the slot when a task throws', async () => {
  const run = createRequestGate(1)
  await expect(
    run(async () => {
      throw new Error('Request failed.')
    })
  ).rejects.toThrow('Request failed.')

  await expect(run(async () => 'next')).resolves.toBe('next')
})

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

/**
 * Bound how many gallery file requests run at once so a full grid cannot flood
 * the gateway, while still letting every queued caller through in turn.
 */
export function createRequestGate(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    while (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve))
      if (signal?.aborted) {
        // This waiter was handed the free slot. Abandoning it without passing
        // the turn on would strand every caller still queued behind it, and a
        // scrolling grid aborts woken waiters constantly.
        waiting.shift()?.()
        signal.throwIfAborted()
      }
    }
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

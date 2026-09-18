import { describe, expect, it, vi } from 'vitest'

import { enqueueCanvasMutation } from '../lib/canvas-mutation-queue'

describe('canvas mutation queue', () => {
  it('serializes writes for the same canvas while allowing each result through', async () => {
    const identity = { userId: 813, sessionId: 'gallery-session' }
    const order: string[] = []
    let release!: () => void
    const first = enqueueCanvasMutation(identity, 'canvas-1', async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push('first:end')
      return 'first'
    })
    const second = enqueueCanvasMutation(identity, 'canvas-1', async () => {
      order.push('second')
      return 'second'
    })

    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    expect(order).toEqual(['first:start'])
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })
})

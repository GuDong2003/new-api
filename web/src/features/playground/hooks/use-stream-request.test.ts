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
import { describe, expect, test, vi } from 'vitest'

import { ERROR_MESSAGES } from '../constants'
import type { ChatCompletionRequest } from '../types'
import { createStreamRequestController } from './use-stream-request'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

type FakeStreamEvent = Event & {
  data?: string
  readyState?: number
  responseCode?: number
  headers?: Record<string, string[]>
}

class FakeStreamSource {
  readyState = 0
  closed = false
  streamed = false
  private listeners = new Map<string, Array<(event: FakeStreamEvent) => void>>()

  addEventListener(type: string, listener: (event: FakeStreamEvent) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close() {
    this.closed = true
  }

  stream() {
    this.streamed = true
  }

  emit(type: string, data?: string, extra: Partial<FakeStreamEvent> = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({
        data,
        readyState: this.readyState,
        ...extra,
      } as FakeStreamEvent)
    }
  }
}

const payload: ChatCompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
}

const noopCallbacks = {
  onUpdate: () => undefined,
  onComplete: () => undefined,
  onError: () => undefined,
}

describe('latest-wins stream request coordination', () => {
  test('only creates a stream for the latest header request', async () => {
    const firstHeaders = deferred<Record<string, string>>()
    const secondHeaders = deferred<Record<string, string>>()
    let headerRequest = 0
    const sources: FakeStreamSource[] = []
    const controller = createStreamRequestController({
      getHeaders: () => {
        headerRequest += 1
        return headerRequest === 1
          ? firstHeaders.promise
          : secondHeaders.promise
      },
      createSource: () => {
        const source = new FakeStreamSource()
        sources.push(source)
        return source
      },
      setStreaming: () => undefined,
    })

    const first = controller.send(payload, noopCallbacks)
    const second = controller.send(payload, noopCallbacks)
    firstHeaders.resolve({ Authorization: 'Bearer stale' })
    await first
    expect(sources.length).toBe(0)

    secondHeaders.resolve({ Authorization: 'Bearer current' })
    await second
    expect(sources.length).toBe(1)
    expect(sources[0]?.streamed).toBe(true)
  })

  test('stop cancels a request that is still waiting for headers', async () => {
    const headers = deferred<Record<string, string>>()
    let sourceCount = 0
    const controller = createStreamRequestController({
      getHeaders: () => headers.promise,
      createSource: () => {
        sourceCount += 1
        return new FakeStreamSource()
      },
      setStreaming: () => undefined,
    })

    const request = controller.send(payload, noopCallbacks)
    controller.stop()
    headers.resolve({ Authorization: 'Bearer ignored' })
    await request

    expect(sourceCount).toBe(0)
  })

  test('dispose cancels a pending header request without a state update', async () => {
    const headers = deferred<Record<string, string>>()
    const streamingStates: boolean[] = []
    let sourceCount = 0
    const controller = createStreamRequestController({
      getHeaders: () => headers.promise,
      createSource: () => {
        sourceCount += 1
        return new FakeStreamSource()
      },
      setStreaming: (streaming) => streamingStates.push(streaming),
    })

    const request = controller.send(payload, noopCallbacks)
    controller.dispose()
    headers.resolve({ Authorization: 'Bearer ignored' })
    await request

    expect(sourceCount).toBe(0)
    expect(streamingStates).toEqual([false])
  })

  test('closes the previous source and ignores all of its later events', async () => {
    const nextHeaders = deferred<Record<string, string>>()
    let headerRequest = 0
    const sources: FakeStreamSource[] = []
    const updates: string[] = []
    const controller = createStreamRequestController({
      getHeaders: () => {
        headerRequest += 1
        if (headerRequest === 1) {
          return Promise.resolve({ Authorization: 'Bearer first' })
        }
        return nextHeaders.promise
      },
      createSource: () => {
        const source = new FakeStreamSource()
        sources.push(source)
        return source
      },
      setStreaming: () => undefined,
    })
    const callbacks = {
      onUpdate: (_type: 'reasoning' | 'content', chunk: string) =>
        updates.push(chunk),
      onComplete: () => undefined,
      onError: () => undefined,
    }

    await controller.send(payload, callbacks)
    const second = controller.send(payload, callbacks)
    expect(sources[0]?.closed).toBe(true)
    sources[0]?.emit(
      'message',
      JSON.stringify({ choices: [{ delta: { content: 'stale' } }] })
    )

    nextHeaders.resolve({ Authorization: 'Bearer second' })
    await second
    sources[1]?.emit(
      'message',
      JSON.stringify({ choices: [{ delta: { content: 'current' } }] })
    )

    expect(updates).toEqual(['current'])
  })
})

describe('stream failure reporting', () => {
  function startStream() {
    const sources: FakeStreamSource[] = []
    const onError = vi.fn()
    const onComplete = vi.fn()
    const controller = createStreamRequestController({
      getHeaders: () => Promise.resolve({}),
      createSource: () => {
        const source = new FakeStreamSource()
        sources.push(source)
        return source
      },
      setStreaming: () => undefined,
    })
    return {
      onError,
      onComplete,
      sources,
      send: () =>
        controller.send(payload, {
          onUpdate: () => undefined,
          onComplete,
          onError,
        }),
    }
  }

  test('reports a gateway error when the proxy answers with an HTML page', async () => {
    const stream = startStream()
    await stream.send()

    stream.sources[0]?.emit('open', undefined, {
      responseCode: 502,
      headers: { 'content-type': ['text/html; charset=utf-8'] },
    })

    expect(stream.onError).toHaveBeenCalledWith(
      ERROR_MESSAGES.BAD_GATEWAY,
      'http_502'
    )
  })

  test('keeps streaming when the response is served as an event stream', async () => {
    const stream = startStream()
    await stream.send()

    stream.sources[0]?.emit('open', undefined, {
      responseCode: 200,
      headers: { 'content-type': ['text/event-stream'] },
    })

    expect(stream.onError).not.toHaveBeenCalled()
  })

  test('surfaces the upstream message when a frame carries an error instead of a delta', async () => {
    const stream = startStream()
    await stream.send()

    stream.sources[0]?.emit(
      'message',
      JSON.stringify({
        error: { message: 'upstream channel disabled', code: 'channel_off' },
      })
    )

    expect(stream.onError).toHaveBeenCalledWith(
      'upstream channel disabled',
      'channel_off'
    )
  })

  test('reports a parse error for a frame that is not valid JSON', async () => {
    const stream = startStream()
    await stream.send()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    stream.sources[0]?.emit('message', 'not-json')

    expect(stream.onError).toHaveBeenCalledWith(
      ERROR_MESSAGES.PARSE_ERROR,
      undefined
    )
  })

  test('reports an interruption when the stream closes before the done frame', async () => {
    const stream = startStream()
    await stream.send()

    const source = stream.sources[0]
    if (source) source.readyState = 2
    source?.emit('readystatechange')

    expect(stream.onError).toHaveBeenCalledWith(
      ERROR_MESSAGES.INTERRUPTED,
      undefined
    )
  })

  test('stays silent when the stream closes after the done frame', async () => {
    const stream = startStream()
    await stream.send()

    const source = stream.sources[0]
    source?.emit('message', '[DONE]')
    if (source) source.readyState = 2
    source?.emit('readystatechange')

    expect(stream.onComplete).toHaveBeenCalledTimes(1)
    expect(stream.onError).not.toHaveBeenCalled()
  })

  test('keeps the status visible when a close has no dedicated gateway message', async () => {
    const stream = startStream()
    await stream.send()

    const source = stream.sources[0]
    source?.emit('open', undefined, { responseCode: 429 })
    if (source) source.readyState = 2
    source?.emit('readystatechange')

    expect(stream.onError).toHaveBeenCalledWith(
      `HTTP 429: ${ERROR_MESSAGES.CONNECTION_CLOSED}`,
      'http_429'
    )
  })

  test('reports only the first failure for a single stream', async () => {
    const stream = startStream()
    await stream.send()

    const source = stream.sources[0]
    source?.emit('error', undefined, { responseCode: 503 })
    source?.emit('error', undefined, { responseCode: 503 })

    expect(stream.onError).toHaveBeenCalledTimes(1)
    expect(stream.onError).toHaveBeenCalledWith(
      ERROR_MESSAGES.SERVICE_UNAVAILABLE,
      'http_503'
    )
  })
})

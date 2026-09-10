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
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import {
  ContentAuditError,
  getContentAuditThumbnail,
  getContentAuditOriginal,
  getContentAuditImages,
  updateContentAuditSettings,
} from '../api'
import {
  contentAuditFilterSchema,
  contentAuditSettingsSchema,
  defaultContentAuditFilters,
} from '../lib/schema'
import {
  auditId,
  auditStatus,
  installAuditTransport,
  installAuditOriginalTransport,
  signInAuditRoot,
} from './fixtures'

let transport: ReturnType<typeof installAuditTransport>
let originals: ReturnType<typeof installAuditOriginalTransport> | undefined
beforeEach(() => signInAuditRoot())
afterEach(() => {
  transport?.restore()
  originals?.restore()
  originals = undefined
  useAuthStore.getState().auth.reset()
})

it('reads cursor pages including an initial -1 cursor without an image count ceiling', async () => {
  transport = installAuditTransport(() => ({
    body: {
      success: true,
      data: {
        items: [{ index: 105, status: 'ready', original_status: 'ready' }],
        next_after: 105,
        total: 150,
      },
    },
  }))
  const result = await getContentAuditImages(
    auditId,
    -1,
    new AbortController().signal
  )
  expect(result.next_after).toBe(105)
  expect(result.items[0].index).toBe(105)
  expect(transport.requests[0].params).toEqual({ after: -1, limit: 20 })
})

it('streams original bytes above the thumbnail limit with bearer auth and no query token', async () => {
  const bytes = new Uint8Array(310 * 1024).fill(7)
  originals = installAuditOriginalTransport(
    () => new Response(bytes, { headers: { 'Content-Type': 'image/webp' } })
  )
  const original = await getContentAuditOriginal(
    auditId,
    105,
    new AbortController().signal
  )
  expect(original.mime).toBe('image/webp')
  expect(
    new Uint8Array(await new Response(original.stream).arrayBuffer())
  ).toEqual(bytes)
  expect(originals.requests[0].url).toBe(
    `http://localhost/api/content-audit/records/${auditId}/originals/105`
  )
  expect(originals.requests[0].headers.get('Authorization')).toBe(
    'Bearer audit-test-session-access'
  )
  expect(originals.requests[0].headers.get('Cache-Control')).toContain(
    'no-store'
  )
})

it.each(['success', 'cancel pending retry'] as const)(
  'refreshes an expired access token through the shared client and cleans up pending 401 bodies on %s',
  async (outcome) => {
    const auth = useAuthStore.getState().auth
    const now = Math.floor(Date.now() / 1000)
    if (!auth.user || !auth.session) throw new Error('Root fixture is required')
    const bundle = {
      user: auth.user,
      session: auth.session,
      access_token: 'audit-rotated-access',
      token_type: 'Bearer',
      access_expires_at: now + 3600,
    }
    auth.setBundle({
      ...bundle,
      access_token: 'audit-expired-access',
      access_expires_at: now - 1,
    })
    // Stub only the private refresh client's XHR network boundary. The shared
    // interceptor, refresh runner, bundle validation and store rotation stay real.
    const refreshOpen = vi.spyOn(XMLHttpRequest.prototype, 'open')
    const refreshSend = vi
      .spyOn(XMLHttpRequest.prototype, 'send')
      .mockImplementation(function (this: XMLHttpRequest) {
        Object.defineProperties(this, {
          status: { value: 200 },
          responseText: {
            value: JSON.stringify({ success: true, data: bundle }),
          },
          readyState: { value: 4 },
        })
        this.dispatchEvent(new ProgressEvent('loadend'))
      })
    vi.spyOn(XMLHttpRequest.prototype, 'getAllResponseHeaders').mockReturnValue(
      'Content-Type: application/json\r\n'
    )
    let attempts = 0
    const caller = new AbortController()
    const cancelled401 = vi.fn(() => {
      if (outcome === 'cancel pending retry' && attempts === 2) caller.abort()
    })
    originals = installAuditOriginalTransport(() => {
      attempts += 1
      if (attempts === 1 || outcome === 'cancel pending retry') {
        return new Response(new ReadableStream({ cancel: cancelled401 }), {
          status: 401,
        })
      }
      return new Response(new Uint8Array([7, 8, 9]), {
        headers: { 'Content-Type': 'image/png' },
      })
    })
    const result = getContentAuditOriginal(auditId, 5, caller.signal)
    if (outcome === 'success') {
      const original = await result
      expect(
        new Uint8Array(await new Response(original.stream).arrayBuffer())
      ).toEqual(new Uint8Array([7, 8, 9]))
      expect(cancelled401).toHaveBeenCalledOnce()
    } else {
      await expect(result).rejects.toMatchObject({ name: 'AbortError' })
      expect(cancelled401).toHaveBeenCalledTimes(2)
      expect(caller.signal.aborted).toBe(true)
    }
    expect(refreshOpen).toHaveBeenCalledWith(
      'POST',
      '/api/user/auth/refresh',
      true
    )
    expect(refreshSend).toHaveBeenCalledOnce()
    expect(
      originals.requests.map((request) => request.headers.get('Authorization'))
    ).toEqual(['Bearer audit-expired-access', 'Bearer audit-rotated-access'])
    expect(useAuthStore.getState().auth.accessToken).toBe(
      'audit-rotated-access'
    )
    expect(useAuthStore.getState().auth.session?.sid).toBe('audit-test-session')
  }
)

it('bounds stream error reads and does not retain raw credentials or upstream messages', async () => {
  originals = installAuditOriginalTransport(
    (request) =>
      new Response(
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(new Uint8Array(20000))
            request.signal.addEventListener(
              'abort',
              () => controller.error(request.signal.reason),
              { once: true }
            )
          },
        }),
        { status: 403 }
      )
  )
  const error = await getContentAuditOriginal(
    auditId,
    5,
    new AbortController().signal
  ).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(ContentAuditError)
  expect(error).toMatchObject({ status: 403, accessDenied: true })
  expect(error).not.toHaveProperty('config')
  expect(error).not.toHaveProperty('cause')
  expect(originals.requests[0].signal.aborted).toBe(true)
})

it('decodes a bounded original error envelope without exposing its raw message', async () => {
  originals = installAuditOriginalTransport(
    () =>
      new Response(
        JSON.stringify({
          code: 'CONTENT_AUDIT_EXPIRED',
          message: 'private upstream token',
        }),
        { status: 410 }
      )
  )
  const error = await getContentAuditOriginal(
    auditId,
    5,
    new AbortController().signal
  ).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'CONTENT_AUDIT_EXPIRED', status: 410 })
  expect(JSON.stringify(error)).not.toContain('private upstream token')
})

it('rejects and cancels non-image original bodies before display or writing', async () => {
  originals = installAuditOriginalTransport(
    (request) =>
      new Response(
        new ReadableStream({
          start: (controller) =>
            request.signal.addEventListener(
              'abort',
              () => controller.error(request.signal.reason),
              { once: true }
            ),
        }),
        { headers: { 'Content-Type': 'image/svg+xml' } }
      )
  )
  await expect(
    getContentAuditOriginal(auditId, 0, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'CONTENT_AUDIT_UNAVAILABLE' })
  expect(originals.requests[0].signal.aborted).toBe(true)
})

it('never refreshes and replays a spent proof after HTTP 401, and exposes no raw Axios credentials in its error', async () => {
  transport = installAuditTransport(() => ({
    status: 401,
    body: {
      success: false,
      code: 'CONTENT_AUDIT_SESSION_REQUIRED',
      message: 'raw private detail',
    },
  }))
  const context = {
    ...contentAuditSettingsSchema.parse(auditStatus().state),
    expected_version: 1,
  }
  const error = await updateContentAuditSettings(
    context,
    'one-use-sensitive-proof',
    new AbortController().signal
  ).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(ContentAuditError)
  expect(error).toMatchObject({
    code: 'CONTENT_AUDIT_SESSION_REQUIRED',
    status: 401,
    accessDenied: true,
  })
  expect(transport.requests).toHaveLength(1)
  expect(transport.requests[0].skipAuthRefresh).toBe(true)
  expect(JSON.stringify(error)).not.toContain('one-use-sensitive-proof')
  expect(JSON.stringify(error)).not.toContain('audit-test-session-access')
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('config')
})

it.each([
  new Blob(['<svg onload="alert(1)"></svg>'], { type: 'image/svg+xml' }),
  new Blob([new Uint8Array(300 * 1024 + 1)], { type: 'image/jpeg' }),
  new Blob([], { type: 'image/jpeg' }),
])(
  'rejects non-JPEG, empty or oversized thumbnail responses before display',
  async (blob) => {
    transport = installAuditTransport(() => ({ body: blob }))
    await expect(
      getContentAuditThumbnail(auditId, 0, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'CONTENT_AUDIT_UNAVAILABLE' })
  }
)

it.each([
  ['retention_days', 0],
  ['retention_days', 31],
  ['request_limit', 65535],
  ['request_limit', 2097153],
  ['response_limit', 4194305],
  ['capacity_bytes', 10737418241],
  ['capacity_bytes', 1.5],
] as const)(
  'rejects invalid %s value %s in the settings form contract',
  (field, value) => {
    const settings = auditStatus().state
    expect(
      contentAuditSettingsSchema.safeParse({ ...settings, [field]: value })
        .success
    ).toBe(false)
  }
)

it('validates UTF-8 filter byte lengths rather than JavaScript character count', () => {
  const defaults = defaultContentAuditFilters()
  expect(
    contentAuditFilterSchema.safeParse({ ...defaults, model: '界'.repeat(43) })
      .success
  ).toBe(false)
  expect(
    contentAuditFilterSchema.safeParse({
      ...defaults,
      request_id: '界'.repeat(22),
    }).success
  ).toBe(false)
  expect(
    contentAuditFilterSchema.safeParse({
      ...defaults,
      model: '界'.repeat(42),
      request_id: '界'.repeat(21),
    }).success
  ).toBe(true)
})

it('rejects reversed date ranges and invalid HTTP or numeric identity filters', () => {
  const defaults = defaultContentAuditFilters()
  expect(
    contentAuditFilterSchema.safeParse({
      ...defaults,
      range: { start: new Date(2000), end: new Date(1000) },
    }).success
  ).toBe(false)
  expect(
    contentAuditFilterSchema.safeParse({ ...defaults, http_status: '600' })
      .success
  ).toBe(false)
  expect(
    contentAuditFilterSchema.safeParse({ ...defaults, user_id: '-1' }).success
  ).toBe(false)
  expect(
    contentAuditFilterSchema.safeParse({ ...defaults, channel_id: '1.5' })
      .success
  ).toBe(false)
})

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
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { ContentAuditAccessBoundary } from '../components/content-audit-access'
import { ContentAuditDetailDialog } from '../components/content-audit-detail'
import { ContentAuditRecords } from '../components/content-audit-records'
import { useContentAuditExpiry } from '../hooks/use-content-audit-expiry'
import {
  auditDetail,
  auditId,
  auditQueryClient,
  AuditRouterProvider,
  auditSuccess,
  AuditTestProviders,
  installAuditTransport,
  installAuditOriginalTransport,
  secondAuditId,
  signInAuditRoot,
  verificationReply,
} from './fixtures'

let transport: ReturnType<typeof installAuditTransport>
let client: ReturnType<typeof auditQueryClient>
let originals: ReturnType<typeof installAuditOriginalTransport> | undefined
const createURL = vi.fn<(blob: Blob) => string>()
const revokeURL = vi.fn<(url: string) => void>()
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

function DetailFixture(props: { id?: string }) {
  return (
    <AuditTestProviders client={client}>
      <ContentAuditDetailDialog
        key={props.id ?? auditId}
        id={props.id ?? auditId}
        onClose={() => undefined}
      />
    </AuditTestProviders>
  )
}

beforeEach(() => {
  signInAuditRoot()
  client = auditQueryClient()
  createURL.mockReset().mockReturnValue('blob:audit-preview')
  revokeURL.mockReset()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeURL,
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  transport?.restore()
  originals?.restore()
  originals = undefined
  vi.unstubAllGlobals()
  useAuthStore.getState().auth.reset()
  vi.useRealTimers()
  if (originalCreate) {
    Object.defineProperty(URL, 'createObjectURL', originalCreate)
  } else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevoke) {
    Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
  } else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

it('renders hostile protocol content as inert code, supports explicit copy, and fetches thumbnails with bearer auth only', async () => {
  const detail = auditDetail()
  const thumbnail = new Blob(['bounded-jpeg'], { type: 'image/jpeg' })
  transport = installAuditTransport((config) => ({
    body: config.responseType === 'blob' ? thumbnail : auditSuccess(detail),
  }))
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const localWrite = vi.spyOn(globalThis.localStorage, 'setItem')
  const sessionWrite = vi.spyOn(globalThis.sessionStorage, 'setItem')
  const databaseOpen = vi.spyOn(indexedDB, 'open')
  const view = render(
    <StrictMode>
      <DetailFixture />
    </StrictMode>
  )
  const image = await screen.findByRole('img', { name: 'Audit thumbnail 1' })
  expect(image).toHaveAttribute('src', 'blob:audit-preview')
  const request = screen.getByLabelText('Request content')
  expect(request.textContent).toBe(
    JSON.stringify(detail.payload.request, null, 2)
  )
  expect(screen.getByLabelText('Response content').textContent).toBe(
    JSON.stringify(detail.payload.response, null, 2)
  )
  expect(view.container.querySelector('script')).toBeNull()
  expect(document.querySelector('img[src^="https:"]')).toBeNull()
  expect(
    document.querySelector('a[href^="https://external.invalid"]')
  ).toBeNull()
  expect(screen.getByText('Request content was truncated')).toBeVisible()
  expect(screen.getByText('Response content was truncated')).toBeVisible()
  expect(screen.getByText('Incomplete stream')).toBeVisible()
  expect(
    screen.getByText(
      'Response text view was truncated; inspect the protocol response for available structure.'
    )
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Copy Request content' }))
  expect(copy).toHaveBeenCalledWith(
    JSON.stringify(detail.payload.request, null, 2)
  )
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible()
  const imageRequest = transport.requests.find(
    (entry) => entry.responseType === 'blob'
  )
  expect(imageRequest?.url).toBe(
    `/api/content-audit/records/${auditId}/thumbnails/0`
  )
  expect(imageRequest?.headers.get('Authorization')).toBe(
    'Bearer audit-test-session-access'
  )
  expect(imageRequest?.headers.get('Cache-Control')).toContain('no-store')
  expect(imageRequest?.disableDuplicate).toBe(true)
  expect(imageRequest?.url).not.toContain('?')
  expect(
    localWrite.mock.calls.some(
      ([, value]) =>
        String(value).includes('untrusted') ||
        String(value).includes('external.invalid')
    )
  ).toBe(false)
  expect(
    sessionWrite.mock.calls.some(
      ([, value]) =>
        String(value).includes('untrusted') ||
        String(value).includes('external.invalid')
    )
  ).toBe(false)
  expect(databaseOpen).not.toHaveBeenCalled()
})

it('replaces image pages using the returned cursor and only reads the sixth original on demand', async () => {
  const detail = auditDetail()
  detail.payload.image_next_after = 4
  detail.payload.image_total = 6
  detail.payload.images = [
    { index: 0, status: 'thumbnail_disabled', original_status: 'not_saved' },
  ]
  transport = installAuditTransport((config) => ({
    body: config.url?.endsWith('/images')
      ? auditSuccess({
          items: [
            {
              index: 5,
              status: 'thumbnail_disabled',
              original_status: 'ready',
              original_mime: 'image/png',
              original_bytes: 8,
            },
          ],
          next_after: null,
          total: 6,
        })
      : auditSuccess(detail),
  }))
  originals = installAuditOriginalTransport(
    () => new Response('original', { headers: { 'Content-Type': 'image/png' } })
  )
  const picker = vi.fn()
  vi.stubGlobal('showSaveFilePicker', picker)
  const user = userEvent.setup()
  render(<DetailFixture />)
  await screen.findByText('Image 1')
  expect(screen.getByText('Original not saved')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Next images' }))
  expect(await screen.findByText('Image 6')).toBeVisible()
  expect(screen.queryByText('Image 1')).not.toBeInTheDocument()
  expect(
    transport.requests.find((request) => request.url?.endsWith('/images'))
      ?.params
  ).toEqual({ after: 4, limit: 20 })
  expect(originals.requests).toHaveLength(0)
  expect(picker).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Next images' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'View original' }))
  expect(
    await screen.findByRole('img', { name: 'Original image 6' })
  ).toHaveAttribute('src', 'blob:audit-preview')
  expect(originals.requests[0].url).toBe(
    `http://localhost/api/content-audit/records/${auditId}/originals/5`
  )
  await user.click(screen.getByRole('button', { name: 'Close original' }))
  expect(revokeURL).toHaveBeenCalledWith('blob:audit-preview')
  await user.click(screen.getByRole('button', { name: 'Previous images' }))
  expect(await screen.findByText('Image 1')).toBeVisible()
})

it.each([
  'close',
  'role loss',
  'expiry',
  'cancel',
  'page change',
  'record change',
] as const)(
  'aborts an in-progress original file stream on %s',
  async (change) => {
    const detail = auditDetail()
    detail.payload.images = [
      { index: 5, status: 'thumbnail_disabled', original_status: 'ready' },
    ]
    detail.payload.image_next_after = 5
    transport = installAuditTransport((config) => ({
      body: config.url?.endsWith('/images')
        ? auditSuccess({ items: [], next_after: null, total: 6 })
        : auditSuccess(detail),
    }))
    const writes: Uint8Array[] = []
    const abort = vi.fn()
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        writes.push(chunk)
      },
      abort,
    })
    originals = installAuditOriginalTransport(
      (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new Uint8Array([1, 2, 3]))
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                { once: true }
              )
            },
          }),
          { headers: { 'Content-Type': 'image/png' } }
        )
    )
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn().mockResolvedValue({ createWritable: async () => writable })
    )
    const user = userEvent.setup()
    const view = render(<DetailFixture />)
    await user.click(
      await screen.findByRole('button', { name: 'Download original' })
    )
    await waitFor(() => expect(writes).toHaveLength(1))
    const signal = originals.requests[0].signal
    if (change === 'role loss') {
      await act(() =>
        useAuthStore
          .getState()
          .auth.setUser({ id: 1, username: 'former-root', role: 10 })
      )
    } else if (change === 'expiry') {
      await act(() => {
        for (const query of client.getQueryCache().getAll()) {
          if (query.queryKey.includes('detail')) {
            client.setQueryData(query.queryKey, {
              ...detail,
              record: { ...detail.record, expires_at: 1 },
            })
          }
        }
      })
    } else if (change === 'page change') {
      await user.click(screen.getByRole('button', { name: 'Next images' }))
    } else if (change === 'record change') {
      view.rerender(<DetailFixture id={secondAuditId} />)
    } else {
      await user.click(
        screen.getAllByRole('button', {
          name: change === 'cancel' ? 'Cancel download' : 'Close',
        })[0]
      )
    }
    await waitFor(() => expect(abort).toHaveBeenCalledOnce())
    expect(signal.aborted).toBe(true)
    expect(writes).toHaveLength(1)
    expect(createURL).not.toHaveBeenCalled()
  }
)

it.each(['role loss', 'expiry', 'record change'] as const)(
  'releases a viewed original URL on %s',
  async (change) => {
    const detail = auditDetail()
    detail.payload.images = [
      { index: 5, status: 'thumbnail_disabled', original_status: 'ready' },
    ]
    transport = installAuditTransport(() => ({ body: auditSuccess(detail) }))
    originals = installAuditOriginalTransport(
      () => new Response('png', { headers: { 'Content-Type': 'image/png' } })
    )
    const user = userEvent.setup()
    const view = render(<DetailFixture />)
    await user.click(
      await screen.findByRole('button', { name: 'View original' })
    )
    await screen.findByRole('img', { name: 'Original image 6' })
    if (change === 'role loss') {
      await act(() =>
        useAuthStore
          .getState()
          .auth.setUser({ id: 1, username: 'former-root', role: 10 })
      )
    } else if (change === 'record change') {
      view.rerender(<DetailFixture id={secondAuditId} />)
    } else {
      await act(() => {
        for (const query of client.getQueryCache().getAll()) {
          if (query.queryKey.includes('detail')) {
            client.setQueryData(query.queryKey, {
              ...detail,
              record: { ...detail.record, expires_at: 1 },
            })
          }
        }
      })
    }
    await waitFor(() =>
      expect(revokeURL).toHaveBeenCalledWith('blob:audit-preview')
    )
    expect(
      screen.queryByRole('img', { name: 'Original image 6' })
    ).not.toBeInTheDocument()
  }
)

it('closes disclosed content when the original endpoint rejects root access', async () => {
  const detail = auditDetail()
  detail.payload.images = [
    { index: 0, status: 'thumbnail_disabled', original_status: 'ready' },
  ]
  transport = installAuditTransport(() => ({ body: auditSuccess(detail) }))
  originals = installAuditOriginalTransport(
    () =>
      new Response(JSON.stringify({ code: 'CONTENT_AUDIT_SESSION_REQUIRED' }), {
        status: 403,
      })
  )
  const user = userEvent.setup()
  render(<DetailFixture />)
  await user.click(await screen.findByRole('button', { name: 'View original' }))
  expect(
    await screen.findByText(
      'Content audit access ended. Sign in with a live root session to continue.'
    )
  ).toBeVisible()
  expect(screen.queryByLabelText('Request content')).not.toBeInTheDocument()
  expect(createURL).not.toHaveBeenCalled()
})

it.each(['success', 'picker cancel', 'file denied'] as const)(
  'handles original download %s without a Blob fallback',
  async (result) => {
    const detail = auditDetail()
    detail.payload.images = [
      {
        index: 0,
        status: 'thumbnail_disabled',
        original_status: 'ready',
        original_mime: 'image/webp',
      },
    ]
    transport = installAuditTransport(() => ({ body: auditSuccess(detail) }))
    originals = installAuditOriginalTransport(
      () =>
        new Response(new Uint8Array([7, 8, 9]), {
          headers: { 'Content-Type': 'image/webp' },
        })
    )
    const written: Uint8Array[] = []
    const closed = vi.fn()
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        written.push(chunk)
      },
      close: closed,
    })
    vi.stubGlobal(
      'showSaveFilePicker',
      result === 'picker cancel'
        ? vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'))
        : vi.fn().mockResolvedValue({
            createWritable: () =>
              result === 'file denied'
                ? Promise.reject(new DOMException('denied', 'NotAllowedError'))
                : Promise.resolve(writable),
          })
    )
    const user = userEvent.setup()
    render(<DetailFixture />)
    await user.click(
      await screen.findByRole('button', { name: 'Download original' })
    )
    if (result === 'success') {
      expect(await screen.findByText('Original downloaded')).toBeVisible()
      expect(written).toEqual([new Uint8Array([7, 8, 9])])
      expect(closed).toHaveBeenCalledOnce()
    } else {
      await waitFor(() =>
        expect(
          screen.queryByText('Downloading original…')
        ).not.toBeInTheDocument()
      )
      expect(originals.requests).toHaveLength(0)
      if (result === 'file denied') {
        expect(
          screen.getByText(
            'Original download failed. Check file permissions and try again.'
          )
        ).toBeVisible()
      }
    }
    expect(createURL).not.toHaveBeenCalled()
  }
)

it('explains unsupported streaming downloads without fetching or creating a Blob fallback', async () => {
  const detail = auditDetail()
  detail.payload.images = [
    { index: 0, status: 'preview_unavailable', original_status: 'ready' },
  ]
  transport = installAuditTransport(() => ({ body: auditSuccess(detail) }))
  originals = installAuditOriginalTransport(() => new Response('unexpected'))
  vi.stubGlobal('showSaveFilePicker', undefined)
  const user = userEvent.setup()
  render(<DetailFixture />)
  await user.click(
    await screen.findByRole('button', { name: 'Download original' })
  )
  expect(
    await screen.findByText(
      'Streaming downloads require a supported browser, such as desktop Chromium.'
    )
  ).toBeVisible()
  expect(originals.requests).toHaveLength(0)
  expect(createURL).not.toHaveBeenCalled()
})

it.each(['unmount', 'logout', 'role loss'] as const)(
  'clears payload queries and revokes Blob URLs on %s',
  async (change) => {
    transport = installAuditTransport((config) => ({
      body:
        config.responseType === 'blob'
          ? new Blob(['jpeg'], { type: 'image/jpeg' })
          : auditSuccess(auditDetail()),
    }))
    const view = render(<DetailFixture />)
    await screen.findByRole('img', { name: 'Audit thumbnail 1' })
    expect(
      client
        .getQueryCache()
        .findAll({ queryKey: ['content-audit'] })
        .some((query) => query.state.data)
    ).toBe(true)
    if (change === 'unmount') view.unmount()
    else {
      await act(async () => {
        const auth = useAuthStore.getState().auth
        if (change === 'logout') auth.reset()
        else auth.setUser({ id: 1, username: 'former-root', role: 10 })
      })
    }
    await waitFor(() =>
      expect(revokeURL).toHaveBeenCalledWith('blob:audit-preview')
    )
    expect(screen.queryByLabelText('Request content')).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(
      client.getQueryCache().findAll({ queryKey: ['content-audit'] })
    ).toHaveLength(0)
  }
)

it.each([202, 503])(
  'clears disclosed content after deletion returns %s while metadata refresh and navigation remain pending',
  async (status) => {
    const detail = auditDetail()
    detail.payload.images = (detail.payload.images ?? []).map((image) => ({
      ...image,
      original_status: 'ready',
    }))
    const abortFile = vi.fn()
    const writes: Uint8Array[] = []
    originals = installAuditOriginalTransport(
      (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new Uint8Array([1]))
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                { once: true }
              )
            },
          }),
          { headers: { 'Content-Type': 'image/png' } }
        )
    )
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn().mockResolvedValue({
        createWritable: async () =>
          new WritableStream<Uint8Array>({
            write: (chunk) => {
              writes.push(chunk)
            },
            abort: abortFile,
          }),
      })
    )
    const records = auditSuccess({
      items: [detail.record],
      total: 1,
      page: 1,
      page_size: 25,
    })
    let releaseRefresh!: (reply: { body: unknown }) => void
    const refresh = new Promise<{ body: unknown }>((resolve) => {
      releaseRefresh = resolve
    })
    let deletionAttempted = false
    transport = installAuditTransport((config) => {
      if (config.url?.startsWith('/api/verify')) {
        return { body: verificationReply(config) }
      }
      if (config.url === '/api/content-audit/records/delete') {
        deletionAttempted = true
        return {
          status,
          body:
            status === 202
              ? auditSuccess({
                  operation_id: 'delete-operation',
                  ids: [auditId],
                  status: 'deleting',
                })
              : { success: false, code: 'CONTENT_AUDIT_UNAVAILABLE' },
        }
      }
      if (config.url === '/api/content-audit/records') {
        return deletionAttempted ? refresh : { body: records }
      }
      return {
        body:
          config.responseType === 'blob'
            ? new Blob(['jpeg'], { type: 'image/jpeg' })
            : auditSuccess(detail),
      }
    })
    const user = userEvent.setup()
    const close = vi.fn()
    render(
      <AuditRouterProvider client={client}>
        <ContentAuditAccessBoundary>
          <ContentAuditRecords />
          <ContentAuditDetailDialog id={auditId} onClose={close} />
        </ContentAuditAccessBoundary>
      </AuditRouterProvider>
    )
    try {
      await screen.findByRole('img', { name: 'Audit thumbnail 1' })
      await user.click(
        screen.getByRole('button', { name: 'Download original' })
      )
      await waitFor(() => expect(writes).toHaveLength(1))
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Request deletion',
        })
      )
      await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', {
          name: 'Request deletion',
        })
      )
      await user.type(
        await screen.findByLabelText('Authenticator code or backup code'),
        '123456'
      )
      await user.click(screen.getByRole('button', { name: 'Verify' }))
      await waitFor(() =>
        expect(
          transport.requests.filter(
            (request) => request.url === '/api/content-audit/records'
          )
        ).toHaveLength(2)
      )
      await waitFor(() =>
        expect(
          screen.queryByLabelText('Request content')
        ).not.toBeInTheDocument()
      )
      expect(
        screen.queryByLabelText('Response content')
      ).not.toBeInTheDocument()
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
      expect(revokeURL).toHaveBeenCalledWith('blob:audit-preview')
      expect(close).toHaveBeenCalledOnce()
      await waitFor(() => expect(abortFile).toHaveBeenCalledOnce())
      expect(originals.requests[0].signal.aborted).toBe(true)
      expect(
        client
          .getQueryCache()
          .getAll()
          .some((query) => query.queryKey.includes(auditId))
      ).toBe(false)
    } finally {
      await act(async () => {
        releaseRefresh({ body: records })
        await refresh
      })
    }
  }
)

it('does not trigger obsolete detail navigation when the user leaves during a deletion request', async () => {
  let finishDeletion!: (reply: { body: unknown; status: number }) => void
  const deletion = new Promise<{ body: unknown; status: number }>((resolve) => {
    finishDeletion = resolve
  })
  transport = installAuditTransport((config) => {
    if (config.url?.startsWith('/api/verify')) {
      return { body: verificationReply(config) }
    }
    if (config.url === '/api/content-audit/records/delete') return deletion
    return {
      body:
        config.responseType === 'blob'
          ? new Blob(['jpeg'], { type: 'image/jpeg' })
          : auditSuccess(auditDetail()),
    }
  })
  const user = userEvent.setup()
  const close = vi.fn()
  const view = render(
    <AuditTestProviders client={client}>
      <ContentAuditDetailDialog id={auditId} onClose={close} />
    </AuditTestProviders>
  )
  await screen.findByRole('img')
  await user.click(screen.getByRole('button', { name: 'Request deletion' }))
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Request deletion',
    })
  )
  await user.type(
    await screen.findByLabelText('Authenticator code or backup code'),
    '123456'
  )
  await user.click(screen.getByRole('button', { name: 'Verify' }))
  await waitFor(() =>
    expect(
      transport.requests.some(
        (request) => request.url === '/api/content-audit/records/delete'
      )
    ).toBe(true)
  )
  view.rerender(
    <AuditTestProviders client={client}>
      <p>Settings page</p>
    </AuditTestProviders>
  )
  await act(async () => {
    finishDeletion({
      status: 202,
      body: auditSuccess({
        operation_id: 'delete-operation',
        ids: [auditId],
        status: 'deleting',
      }),
    })
    await deletion
  })
  await waitFor(() => expect(client.isMutating()).toBe(0))
  expect(screen.getByText('Settings page')).toBeVisible()
  expect(close).not.toHaveBeenCalled()
  expect(revokeURL).toHaveBeenCalledWith('blob:audit-preview')
})

it('drops an outstanding old-record response after switching records and does not re-cache its prompt', async () => {
  let resolve!: (reply: { body: unknown }) => void
  const promise = new Promise<{ body: unknown }>((finish) => {
    resolve = finish
  })
  const second = auditDetail(secondAuditId)
  second.payload.request = { prompt: 'second record only' }
  second.payload.images = []
  transport = installAuditTransport((config) =>
    config.url?.endsWith(auditId) ? promise : { body: auditSuccess(second) }
  )
  const view = render(<DetailFixture />)
  await waitFor(() => expect(transport.requests).toHaveLength(1))
  const oldRequest = transport.requests[0]
  view.rerender(<DetailFixture id={secondAuditId} />)
  expect(await screen.findByLabelText('Request content')).toHaveTextContent(
    'second record only'
  )
  await act(async () => {
    resolve({ body: auditSuccess(auditDetail()) })
    await promise
  })
  expect(oldRequest.signal?.aborted).toBe(true)
  expect(screen.getByLabelText('Request content')).not.toHaveTextContent(
    'external.invalid'
  )
  expect(
    client
      .getQueryCache()
      .getAll()
      .some((query) => query.queryKey.includes(auditId))
  ).toBe(false)
})

it('revokes the old thumbnail when switching between already loaded records', async () => {
  createURL.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
  transport = installAuditTransport((config) => ({
    body:
      config.responseType === 'blob'
        ? new Blob(['jpeg'], { type: 'image/jpeg' })
        : auditSuccess(
            auditDetail(
              config.url?.endsWith(secondAuditId) ? secondAuditId : auditId
            )
          ),
  }))
  const view = render(<DetailFixture />)
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:first')
  view.rerender(<DetailFixture id={secondAuditId} />)
  await waitFor(() =>
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:second')
  )
  expect(revokeURL).toHaveBeenCalledWith('blob:first')
  expect(
    client
      .getQueryCache()
      .getAll()
      .some((query) => query.queryKey.includes(auditId))
  ).toBe(false)
})

it('closes all sensitive content when a thumbnail response reveals live root access was revoked', async () => {
  transport = installAuditTransport((config) => {
    if (config.responseType === 'blob') {
      return {
        status: 403,
        body: { success: false, code: 'CONTENT_AUDIT_SESSION_REQUIRED' },
      }
    }
    return { body: auditSuccess(auditDetail()) }
  })
  render(<DetailFixture />)
  await waitFor(() =>
    expect(
      screen.getByText(
        'Content audit access ended. Sign in with a live root session to continue.'
      )
    ).toBeVisible()
  )
  expect(screen.queryByLabelText('Request content')).not.toBeInTheDocument()
  expect(createURL).not.toHaveBeenCalled()
  expect(
    client.getQueryCache().findAll({ queryKey: ['content-audit'] })
  ).toHaveLength(0)
})

it('shows an unavailable thumbnail without remote-image fallback and can retry an authenticated read', async () => {
  let imageReads = 0
  transport = installAuditTransport((config) => {
    if (config.responseType !== 'blob') {
      return { body: auditSuccess(auditDetail()) }
    }
    imageReads += 1
    if (imageReads === 1) {
      return {
        status: 503,
        body: {
          success: false,
          code: 'CONTENT_AUDIT_UNAVAILABLE',
          message: 'sensitive backend path',
        },
      }
    }
    return { body: new Blob(['jpeg'], { type: 'image/jpeg' }) }
  })
  const user = userEvent.setup()
  render(<DetailFixture />)
  await screen.findByText(
    'Content audit is unavailable. Refresh the status before trying again.'
  )
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.queryByText('sensitive backend path')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  const image = await screen.findByRole('img')
  expect(image).toHaveAttribute('src', 'blob:audit-preview')
  fireEvent.error(image)
  expect(await screen.findByText('Thumbnail unavailable')).toBeVisible()
  expect(revokeURL).toHaveBeenCalledWith('blob:audit-preview')
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it.each([
  [
    404,
    'CONTENT_AUDIT_NOT_FOUND',
    'This content audit record no longer exists.',
  ],
  [
    410,
    'CONTENT_AUDIT_EXPIRED',
    'This content audit record has expired and is no longer readable.',
  ],
] as const)(
  'does not disclose content after a %s response',
  async (status, code, message) => {
    transport = installAuditTransport(() => ({
      status,
      body: {
        success: false,
        code,
        message: 'do not display server internals',
      },
    }))
    render(<DetailFixture />)
    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.queryByLabelText('Request content')).not.toBeInTheDocument()
    expect(
      screen.queryByText('do not display server internals')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Request deletion' })
    ).toBeDisabled()
  }
)

it('waits the full thirty-day TTL instead of overflowing the browser timer', async () => {
  vi.useFakeTimers()
  const now = Date.now()
  const expired = vi.fn()
  renderHook(() =>
    useContentAuditExpiry(Math.floor(now / 1000) + 30 * 86400, expired)
  )
  await act(() => vi.advanceTimersByTimeAsync(25 * 86400 * 1000))
  expect(expired).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(5 * 86400 * 1000))
  expect(expired).toHaveBeenCalledTimes(1)
})

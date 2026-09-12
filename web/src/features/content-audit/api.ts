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
import { AxiosError, isAxiosError } from 'axios'

import { api } from '@/lib/api'
import { authRequestOptions } from '@/lib/secure-verification'

import type {
  ContentAuditDeletion,
  ContentAuditDeleteRequest,
  ContentAuditDetail,
  ContentAuditFilters,
  ContentAuditInitializeRequest,
  ContentAuditList,
  ContentAuditImagePage,
  ContentAuditOriginal,
  ContentAuditResetRequest,
  ContentAuditResetResult,
  ContentAuditSettingsUpdate,
  ContentAuditStatus,
} from './types'

export class ContentAuditError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0
  ) {
    // Never retain an Axios error/cause: it can contain a proof or a payload.
    super(code)
    this.name = 'ContentAuditError'
  }

  get accessDenied(): boolean {
    return (
      this.status === 401 ||
      (this.status === 403 &&
        !this.code.startsWith('SECURITY_PROOF_') &&
        this.code !== 'SECURITY_METHOD_UNAVAILABLE')
    )
  }
}

const requestOptions = {
  ...authRequestOptions,
  disableDuplicate: true,
  headers: { 'Cache-Control': 'no-cache, no-store' },
}

async function auditFailure(
  error: unknown,
  cancelStream?: () => void
): Promise<ContentAuditError> {
  if (error instanceof ContentAuditError) return error
  let code = 'CONTENT_AUDIT_UNAVAILABLE'
  let status = 0
  if (isAxiosError(error)) {
    status = error.response?.status ?? 0
    let body: unknown = error.response?.data
    if (body instanceof ReadableStream) {
      const reader = body.getReader()
      const chunks: BlobPart[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 16384) break
          chunks.push(new Uint8Array(chunk.value))
        }
        body =
          bytes <= 16384
            ? (JSON.parse(await new Blob(chunks).text()) as unknown)
            : undefined
      } catch {
        body = undefined
      } finally {
        cancelStream?.()
        void reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    }
    if (body instanceof Blob && body.size <= 16384) {
      try {
        body = JSON.parse(await body.text()) as unknown
      } catch {
        body = undefined
      }
    }
    if (body && typeof body === 'object' && 'code' in body) {
      if (
        typeof body.code === 'string' &&
        /^[A-Z_0-9]{1,80}$/.test(body.code)
      ) {
        code = body.code
      }
    }
  }
  return new ContentAuditError(code, status)
}

async function auditResult<T>(
  request: Promise<{ data: { success: boolean; data?: T; code?: string } }>,
  signal: AbortSignal
): Promise<T> {
  try {
    const response = await request
    signal.throwIfAborted()
    if (!response.data.success || response.data.data === undefined) {
      throw new ContentAuditError('CONTENT_AUDIT_UNAVAILABLE')
    }
    return response.data.data
  } catch (error) {
    signal.throwIfAborted()
    throw await auditFailure(error)
  }
}

export function getContentAuditStatus(
  signal: AbortSignal
): Promise<ContentAuditStatus> {
  return auditResult(
    api.get('/api/content-audit/status', { ...requestOptions, signal }),
    signal
  )
}

export function initializeContentAudit(
  context: ContentAuditInitializeRequest,
  proof: string,
  signal: AbortSignal
): Promise<ContentAuditStatus> {
  return auditResult(
    api.post('/api/content-audit/initialize', context, {
      ...requestOptions,
      headers: { ...requestOptions.headers, 'X-Security-Proof': proof },
      singleUseAuthorization: true,
      signal,
    }),
    signal
  )
}

export function updateContentAuditSettings(
  context: ContentAuditSettingsUpdate,
  proof: string,
  signal: AbortSignal
): Promise<ContentAuditStatus> {
  return auditResult(
    api.put('/api/content-audit/settings', context, {
      ...requestOptions,
      headers: { ...requestOptions.headers, 'X-Security-Proof': proof },
      singleUseAuthorization: true,
      signal,
    }),
    signal
  )
}

export function listContentAudits(
  filters: ContentAuditFilters,
  signal: AbortSignal
): Promise<ContentAuditList> {
  return auditResult(
    api.get('/api/content-audit/records', {
      ...requestOptions,
      params: filters,
      signal,
    }),
    signal
  )
}

export function getContentAuditDetail(
  id: string,
  signal: AbortSignal
): Promise<ContentAuditDetail> {
  return auditResult(
    api.get(`/api/content-audit/records/${encodeURIComponent(id)}`, {
      ...requestOptions,
      signal,
    }),
    signal
  )
}

export async function getContentAuditThumbnail(
  id: string,
  index: number,
  signal: AbortSignal
): Promise<Blob> {
  try {
    const response = await api.get<Blob>(
      `/api/content-audit/records/${encodeURIComponent(id)}/thumbnails/${index}`,
      {
        ...requestOptions,
        responseType: 'blob',
        signal,
      }
    )
    signal.throwIfAborted()
    if (
      !(response.data instanceof Blob) ||
      response.data.type !== 'image/jpeg' ||
      response.data.size === 0 ||
      response.data.size > 300 * 1024
    ) {
      throw new ContentAuditError('CONTENT_AUDIT_UNAVAILABLE')
    }
    return response.data
  } catch (error) {
    signal.throwIfAborted()
    throw await auditFailure(error)
  }
}

export function getContentAuditImages(
  id: string,
  after: number,
  signal: AbortSignal
): Promise<ContentAuditImagePage> {
  return auditResult(
    api.get(`/api/content-audit/records/${encodeURIComponent(id)}/images`, {
      ...requestOptions,
      params: { after, limit: 20 },
      signal,
    }),
    signal
  )
}

export async function getContentAuditOriginal(
  id: string,
  index: number,
  signal: AbortSignal
): Promise<ContentAuditOriginal> {
  const controller = new AbortController()
  const fetchOriginal = api.defaults.env?.fetch ?? globalThis.fetch
  try {
    const response = await api.get<ReadableStream<Uint8Array>>(
      `/api/content-audit/records/${encodeURIComponent(id)}/originals/${index}`,
      {
        ...requestOptions,
        adapter: 'fetch',
        responseType: 'stream',
        signal: AbortSignal.any([signal, controller.signal]),
        env: {
          ...api.defaults.env,
          fetch: async (input, init) => {
            const response = await fetchOriginal(input, init)
            if (response.status !== 401) return response
            // Dispose the raw body before Axios wraps it in a tracked stream
            // and detaches its abort listener on rejection. 401 needs no body
            // parsing: renewal must proceed even if the server never sends it.
            void response.body?.cancel().catch(() => undefined)
            return new Response(null, { status: 401 })
          },
        },
        // Let the shared client refresh/retry 401s. Other error streams retain
        // the fetch abort listener until their bounded body read is finished.
        validateStatus: (status) => status !== 401,
      }
    )
    signal.throwIfAborted()
    if (response.status < 200 || response.status >= 300) {
      throw new AxiosError(
        'Content audit response failed',
        undefined,
        undefined,
        undefined,
        response
      )
    }
    const mime = String(response.headers['content-type']).split(';')[0].trim()
    if (
      !(response.data instanceof ReadableStream) ||
      (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp')
    ) {
      controller.abort()
      void response.data?.cancel?.().catch(() => undefined)
      throw new ContentAuditError('CONTENT_AUDIT_UNAVAILABLE')
    }
    return { stream: response.data, mime }
  } catch (error) {
    signal.throwIfAborted()
    const failure = await auditFailure(error, () => controller.abort())
    controller.abort()
    signal.throwIfAborted()
    throw failure
  }
}

export function deleteContentAudits(
  context: ContentAuditDeleteRequest,
  proof: string,
  signal: AbortSignal
): Promise<ContentAuditDeletion> {
  return auditResult(
    api.post('/api/content-audit/records/delete', context, {
      ...requestOptions,
      headers: { ...requestOptions.headers, 'X-Security-Proof': proof },
      singleUseAuthorization: true,
      signal,
    }),
    signal
  )
}

export function resetContentAudits(
  context: ContentAuditResetRequest,
  proof: string,
  signal: AbortSignal
): Promise<ContentAuditResetResult> {
  return auditResult(
    api.post('/api/content-audit/records/reset', context, {
      ...requestOptions,
      headers: { ...requestOptions.headers, 'X-Security-Proof': proof },
      singleUseAuthorization: true,
      signal,
    }),
    signal
  )
}

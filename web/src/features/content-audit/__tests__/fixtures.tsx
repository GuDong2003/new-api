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
/* oxlint-disable react/only-export-components -- Test fixtures include providers and factories. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import type { ReactNode } from 'react'

import { api } from '@/lib/api'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { ContentAuditAccessBoundary } from '../components/content-audit-access'
import type { ContentAuditDetail, ContentAuditStatus } from '../types'

export const auditId = '0123456789abcdef0123456789abcdef'
export const secondAuditId = 'abcdef0123456789abcdef0123456789'

export function signInAuditRoot(role: number = ROLE.SUPER_ADMIN) {
  const now = Math.floor(Date.now() / 1000)
  useAuthStore.getState().auth.setBundle({
    user: { id: 1, username: 'root', role },
    access_token: 'audit-test-session-access',
    token_type: 'Bearer',
    access_expires_at: now + 3600,
    session: {
      sid: 'audit-test-session',
      current: true,
      login_method: 'password',
      ip: '',
      user_agent: '',
      created_at: now,
      last_active_at: now,
      expires_at: now + 86400,
    },
  })
}

export function auditStatus(): ContentAuditStatus {
  return {
    state: {
      enabled: false,
      retention_days: 7,
      request_limit: 524288,
      response_limit: 1048576,
      capacity_bytes: 536870912,
      thumbnail_enabled: true,
      plaintext_acknowledged: false,
      storage_id: '',
      config_version: 1,
      epoch: 1,
      mode: '',
      key_id: '',
      used_bytes: 0,
      reserved_bytes: 0,
      used_records: 0,
      reserved_records: 0,
      quarantined_bytes: 0,
      pause_reason: 'not_initialized',
      capacity_paused: false,
      healthy_until: 0,
      reconciling: false,
      last_reconciled_at: 0,
      last_cleanup_at: 0,
    },
    ready: false,
    stable_key_configured: true,
    storage_configured: true,
    earliest_expiry: null,
  }
}

export function auditDetail(id = auditId): ContentAuditDetail {
  const now = Math.floor(Date.now() / 1000)
  return {
    record: {
      id,
      created_at: now - 60,
      expires_at: now + 86400,
      completed_at: now - 59,
      user_id: 7,
      username: 'inference-user',
      channel_id: 3,
      channel_name: 'upstream',
      model: 'test-model',
      group: 'default',
      request_id: 'request-1',
      upstream_request_id: 'upstream-request',
      path: '/v1/chat/completions',
      protocol: 'openai',
      kind: 'text',
      is_stream: true,
      http_status: 200,
      duration_ms: 1000,
      completion_reason: 'stream_incomplete',
      retry_count: 0,
      request_observed: 120,
      response_observed: 240,
      request_saved: 100,
      response_saved: 200,
      request_truncated: true,
      response_truncated: true,
      omitted_images: 1,
      integrity: 'partial',
      redaction_version: 1,
      format_version: 1,
      mode: 'aes-gcm',
      key_id: 'test-key-id',
      status: 'ready',
      error_code: '',
      file_bytes: 400,
    },
    payload: {
      request: {
        messages: [
          {
            role: 'user',
            content:
              '<img src="https://external.invalid/original.png" onerror="alert(1)">',
          },
        ],
      },
      response: {
        events: [
          {
            event: 'message',
            data: { content: '<script>untrusted()</script>' },
          },
        ],
      },
      response_text: 'partial answer',
      text_view_truncated: true,
      images: [
        {
          index: 0,
          status: 'ready',
          original_status: 'not_saved',
          mime: 'image/jpeg',
          address: 'https://external.invalid/redacted',
          width: 64,
          height: 64,
        },
      ],
      image_next_after: null,
      image_total: 1,
    },
  }
}

export function auditSuccess(data: unknown) {
  return { success: true, message: '', data }
}

export function requestBody(
  config: InternalAxiosRequestConfig | undefined
): Record<string, unknown> {
  return typeof config?.data === 'string'
    ? (JSON.parse(config.data) as Record<string, unknown>)
    : {}
}

export function installAuditTransport(
  handler: (
    config: InternalAxiosRequestConfig
  ) =>
    | { body: unknown; status?: number }
    | Promise<{ body: unknown; status?: number }>
) {
  const original = api.defaults.adapter
  const requests: InternalAxiosRequestConfig[] = []
  api.defaults.adapter = async (config) => {
    requests.push(config)
    const result = await handler(config)
    const response = {
      config,
      data:
        result.body instanceof Blob
          ? result.body
          : structuredClone(result.body),
      status: result.status ?? 200,
      statusText: '',
      headers: { 'Cache-Control': 'no-store' },
    }
    if (response.status >= 400) {
      throw new AxiosError(
        'HTTP failure',
        undefined,
        config,
        undefined,
        response
      )
    }
    return response
  }
  return {
    requests,
    restore: () => {
      api.defaults.adapter = original
    },
  }
}

export function installAuditOriginalTransport(
  handler: (request: Request) => Response | Promise<Response>
) {
  const originalEnv = api.defaults.env
  const originalBaseURL = api.defaults.baseURL
  const requests: Request[] = []
  api.defaults.baseURL = 'http://localhost'
  api.defaults.env = {
    ...originalEnv,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return handler(request)
    },
  }
  return {
    requests,
    restore: () => {
      api.defaults.env = originalEnv
      api.defaults.baseURL = originalBaseURL
    },
  }
}

export function verificationReply(config: InternalAxiosRequestConfig) {
  if (config.url === '/api/verify/methods') {
    return auditSuccess({
      scope: config.params.scope,
      methods: [{ method: '2fa', available: true }],
      oauth_providers: [],
      password_encryption_enabled: false,
    })
  }
  const body = requestBody(config)
  return auditSuccess({
    proof_token: 'audit-one-use-proof',
    scope: body.scope,
    method: '2fa',
    expires_at: Math.floor(Date.now() / 1000) + 60,
  })
}

export function auditQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

export function AuditTestProviders(props: {
  client: QueryClient
  children: ReactNode
}) {
  return (
    <QueryClientProvider client={props.client}>
      <ContentAuditAccessBoundary>{props.children}</ContentAuditAccessBoundary>
    </QueryClientProvider>
  )
}

export function auditTestRouter(element: ReactNode) {
  const root = createRootRoute({ component: () => element })
  return createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

export function AuditRouterProvider(props: {
  client: QueryClient
  children: ReactNode
}) {
  const router = auditTestRouter(props.children)
  return (
    <QueryClientProvider client={props.client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

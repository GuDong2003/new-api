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
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'

import { useAuthStore } from '@/stores/auth-store'

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Expected fixture value.')
  }
  return value
}

export function login(userId = 813, sessionId = 'gallery-session', role = 100) {
  useAuthStore.getState().auth.setBundle({
    access_token: `token-${userId}-${sessionId}`,
    token_type: 'Bearer',
    access_expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, username: 'gallery-user', role },
    session: {
      sid: sessionId,
      current: true,
      login_method: 'password',
      ip: '',
      user_agent: '',
      created_at: 1,
      last_active_at: 1,
      expires_at: 9999999999,
    },
  })
}

export const usage = {
  enabled: true,
  retention_days: 7,
  max_images: 100,
  max_bytes: 209715200,
  used_images: 2,
  used_bytes: 1048576,
  can_save: true,
  reason: '',
}

export const galleryImage = {
  id: 'image-1',
  source_id: 'job-1:0',
  source: 'drawing' as const,
  model: 'gpt-image-1',
  prompt: 'A quiet forest',
  negative_prompt: '',
  parameters: { quality: 'high' },
  width: 1024,
  height: 1024,
  mime_type: 'image/png',
  bytes: 2048,
  created_at: 1700000000,
  expires_at: 9999999999,
  has_thumbnail: true,
}

export function response(
  config: InternalAxiosRequestConfig,
  data: unknown
): AxiosResponse {
  return {
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: { success: true, message: '', data },
  }
}

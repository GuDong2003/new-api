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
import { api } from '@/lib/api'

import type {
  APIResponse,
  BalanceSource,
  UpstreamAccount,
  UpstreamAccountInput,
  UpstreamAccountLog,
  UpstreamChannelOption,
  UpstreamOperationResult,
  UpstreamSiteTypeOption,
} from './types'

export async function listUpstreamSiteTypes() {
  const response = await api.get<APIResponse<UpstreamSiteTypeOption[]>>(
    '/api/upstream-account/site-types'
  )
  if (!response.data.success) {
    throw new Error(
      response.data.message || 'Failed to load upstream site types'
    )
  }
  return response.data.data ?? []
}

export async function listUpstreamAccounts() {
  const response = await api.get<APIResponse<UpstreamAccount[]>>(
    '/api/upstream-account/'
  )
  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to load upstream accounts')
  }
  return response.data.data ?? []
}

export async function createUpstreamAccount(input: UpstreamAccountInput) {
  const response = await api.post<APIResponse<UpstreamAccount>>(
    '/api/upstream-account/',
    input
  )
  if (!response.data.success || !response.data.data) {
    throw new Error(
      response.data.message || 'Failed to create upstream account'
    )
  }
  return response.data.data
}

export async function updateUpstreamAccount(
  id: number,
  input: UpstreamAccountInput
) {
  const response = await api.put<APIResponse<UpstreamAccount>>(
    `/api/upstream-account/${id}`,
    input
  )
  if (!response.data.success || !response.data.data) {
    throw new Error(
      response.data.message || 'Failed to update upstream account'
    )
  }
  return response.data.data
}

export async function deleteUpstreamAccount(id: number) {
  const response = await api.delete<APIResponse<null>>(
    `/api/upstream-account/${id}`
  )
  if (!response.data.success) {
    throw new Error(
      response.data.message || 'Failed to delete upstream account'
    )
  }
}

export async function replaceUpstreamAccountChannels(
  id: number,
  channelIds: number[]
) {
  const response = await api.put<APIResponse<null>>(
    `/api/upstream-account/${id}/channels`,
    { channel_ids: channelIds }
  )
  if (!response.data.success) {
    throw new Error(
      response.data.message || 'Failed to update channel bindings'
    )
  }
}

async function runOperation(
  id: number,
  operation: 'checkin' | 'balance' | 'health'
) {
  const response = await api.post<APIResponse<UpstreamOperationResult>>(
    `/api/upstream-account/${id}/${operation}`
  )
  if (!response.data.success) {
    throw new Error(response.data.message || 'Upstream operation failed')
  }
  return response.data.data
}

export const checkinUpstreamAccount = (id: number) =>
  runOperation(id, 'checkin')
export const refreshUpstreamAccountBalance = (id: number) =>
  runOperation(id, 'balance')
export const healthCheckUpstreamAccount = (id: number) =>
  runOperation(id, 'health')

export async function listUpstreamAccountLogs(limit = 100) {
  const response = await api.get<APIResponse<UpstreamAccountLog[]>>(
    '/api/upstream-account/logs',
    { params: { limit } }
  )
  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to load operation logs')
  }
  return response.data.data ?? []
}

export async function listUpstreamChannelOptions() {
  const response = await api.get<APIResponse<UpstreamChannelOption[]>>(
    '/api/upstream-account/channels'
  )
  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to load channels')
  }
  return response.data.data ?? []
}

export async function updateChannelBalanceSource(
  id: number,
  source: BalanceSource
) {
  const response = await api.put<APIResponse<null>>(
    `/api/channel/${id}/balance_source`,
    { source }
  )
  if (!response.data.success) {
    throw new Error(response.data.message || 'Failed to update balance source')
  }
}

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
export type UpstreamStatus =
  | 'unknown'
  | 'healthy'
  | 'failed'
  | 'manual_required'

export type UpstreamAccount = {
  id: number
  name: string
  base_url: string
  site_type: 'new_api'
  auth_type: 'token' | 'cookie'
  user_id: number
  credential_configured: boolean
  auto_checkin: boolean
  auto_balance: boolean
  balance_interval: number
  balance: number
  balance_unit: string
  raw_quota: number
  quota_per_unit: number
  balance_updated_time: number
  balance_status: UpstreamStatus
  last_checkin_time: number
  last_checkin_status: UpstreamStatus
  last_checkin_message: string
  last_health_time: number
  health_status: UpstreamStatus
  last_error: string
  next_checkin_time: number
  next_balance_time: number
  created_time: number
  updated_time: number
  channel_ids: number[]
}

export type UpstreamAccountInput = {
  name: string
  base_url: string
  site_type: 'new_api'
  auth_type: 'token' | 'cookie'
  user_id: number
  credential?: string
  auto_checkin: boolean
  auto_balance: boolean
  balance_interval: number
  channel_ids?: number[]
}

export type UpstreamOperationResult = {
  status: UpstreamStatus
  message: string
  reward?: number
  balance?: number
  unit?: string
  http_status?: number
  duration_ms: number
}

export type UpstreamAccountLog = {
  id: number
  account_id: number
  type: 'checkin' | 'balance' | 'health'
  trigger: 'manual' | 'scheduled'
  status: UpstreamStatus
  message: string
  reward: number
  balance: number
  unit: string
  http_status: number
  duration_ms: number
  created_at: number
}

export type BalanceSource = 'channel' | 'upstream' | 'none'

export type UpstreamChannelOption = {
  id: number
  name: string
  base_url: string | null
  status: number
  balance_source: BalanceSource
  upstream_account_id?: number
  upstream_account_name?: string
  upstream_balance?: number
  upstream_balance_unit?: string
  upstream_balance_updated_time?: number
  upstream_balance_status?: UpstreamStatus
}

export type APIResponse<T> = {
  success: boolean
  message?: string
  data?: T
}

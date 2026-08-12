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

export type InviteCode = {
  id: number
  code_prefix: string
  code: string
  code_available: boolean
  name: string
  status: number
  max_uses: number
  used_count: number
  created_by: number
  created_time: number
  updated_time: number
  expired_time: number
}

export type GeneratedInviteCode = {
  code: string
  invite_code: InviteCode
}

export type InviteCodeInput = {
  name: string
  max_uses: number
  expired_time: number
}

export type InviteCodeCreateInput = InviteCodeInput & {
  count: number
}

export const INVITE_CODE_STATUS_FILTER_VALUES = [
  'all',
  'enabled',
  'disabled',
  'exhausted',
  'expired',
] as const

export const INVITE_CODE_USAGE_FILTER_VALUES = [
  'all',
  'unused',
  'used',
] as const

export const INVITE_CODE_EXPIRATION_FILTER_VALUES = [
  'all',
  'never',
  'scheduled',
] as const

export const INVITE_CODE_SORT_VALUES = [
  'newest',
  'oldest',
  'remaining',
  'expiring',
] as const

export type InviteCodeStatusFilter =
  (typeof INVITE_CODE_STATUS_FILTER_VALUES)[number]
export type InviteCodeUsageFilter =
  (typeof INVITE_CODE_USAGE_FILTER_VALUES)[number]
export type InviteCodeExpirationFilter =
  (typeof INVITE_CODE_EXPIRATION_FILTER_VALUES)[number]
export type InviteCodeSort = (typeof INVITE_CODE_SORT_VALUES)[number]

export type InviteCodeListParams = {
  page: number
  pageSize: number
  keyword: string
  status: InviteCodeStatusFilter
  usage: InviteCodeUsageFilter
  expiration: InviteCodeExpirationFilter
  sort: InviteCodeSort
}

export type InviteCodeUsage = {
  id: number
  invite_code_id: number
  user_id: number
  username: string
  display_name: string
  used_time: number
  registration_method: string
}

export type ApiResponse<T> = {
  success: boolean
  message?: string
  data?: T
}

export type InviteCodePageResponse = ApiResponse<{
  items: InviteCode[]
  total: number
  page: number
  page_size: number
}>

export type InviteCodeUsagePageResponse = ApiResponse<{
  items: InviteCodeUsage[]
  total: number
  page: number
  page_size: number
}>

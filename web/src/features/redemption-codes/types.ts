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
import { z } from 'zod'

// ============================================================================
// Redemption Schema & Types
// ============================================================================

export const redemptionSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  name: z.string(),
  key: z.string(),
  status: z.number(), // 1: enabled, 2: disabled, 3: used
  quota: z.number(),
  created_time: z.number(),
  redeemed_time: z.number(),
  expired_time: z.number(), // 0 for never expires
  used_user_id: z.number(), // the latest account to redeem it
  used_username: z.string().optional(), // in lists, the name of that account
  batch_id: z.string(),
  batch_one_per_user: z.boolean(),
  max_uses: z.number(), // above 1 for a shared code
  used_count: z.number(),
  batch_size: z.number().optional(), // only when one code is loaded
})

export type Redemption = z.infer<typeof redemptionSchema>

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
}

export interface GetRedemptionsParams {
  p?: number
  page_size?: number
}

export interface GetRedemptionsResponse {
  success: boolean
  message?: string
  data?: {
    items: Redemption[]
    total: number
    page: number
    page_size: number
  }
}

export interface SearchRedemptionsParams {
  keyword?: string
  status?: string
  p?: number
  page_size?: number
}

export interface RedemptionFormData {
  id?: number
  name: string
  quota: number
  expired_time: number
  count?: number // Only for create
  status?: number // Only for status update
  max_uses?: number
  batch_one_per_user?: boolean
}

// ============================================================================
// Dialog Types
// ============================================================================

export type RedemptionsDialogType =
  | 'create'
  | 'update'
  | 'delete'
  | 'view'
  | 'records'

export interface RedemptionRecord {
  id: number
  redemption_id: number
  user_id: number
  batch_id: string
  quota: number
  created_time: number
  username: string
  display_name: string
}

export interface GetRedemptionRecordsResponse {
  success: boolean
  message?: string
  data?: {
    items: RedemptionRecord[]
    total: number
    page: number
    page_size: number
  }
}

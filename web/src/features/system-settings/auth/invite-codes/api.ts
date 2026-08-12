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
  ApiResponse,
  GeneratedInviteCode,
  InviteCode,
  InviteCodeInput,
  InviteCodePageResponse,
} from './types'

export async function getInviteCodes(params: {
  page: number
  pageSize: number
  keyword: string
}): Promise<InviteCodePageResponse> {
  const response = await api.get('/api/invite_code/', {
    params: {
      p: params.page,
      page_size: params.pageSize,
      keyword: params.keyword || undefined,
    },
  })
  return response.data
}

export async function createInviteCode(
  input: InviteCodeInput
): Promise<ApiResponse<GeneratedInviteCode[]>> {
  const response = await api.post('/api/invite_code/', {
    ...input,
    count: 1,
  })
  return response.data
}

export async function updateInviteCode(
  id: number,
  input: InviteCodeInput & { status: number }
): Promise<ApiResponse<InviteCode>> {
  const response = await api.put('/api/invite_code/', { id, ...input })
  return response.data
}

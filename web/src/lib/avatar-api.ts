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

export interface AvatarMutationResponse {
  success: boolean
  message?: string
  data?: {
    avatar_url: string
  }
}

function avatarEndpoint(userId?: number): string {
  return userId === undefined
    ? '/api/user/avatar'
    : `/api/user/${userId}/avatar`
}

export async function uploadAvatar(
  file: File,
  userId?: number
): Promise<AvatarMutationResponse> {
  const formData = new FormData()
  formData.append('file', file)
  const response = await api.post(avatarEndpoint(userId), formData)
  return response.data
}

export async function importAvatarFromURL(
  url: string,
  userId?: number
): Promise<AvatarMutationResponse> {
  const response = await api.post(avatarEndpoint(userId), { url })
  return response.data
}

export async function removeAvatar(
  userId?: number
): Promise<AvatarMutationResponse> {
  const response = await api.delete(avatarEndpoint(userId))
  return response.data
}

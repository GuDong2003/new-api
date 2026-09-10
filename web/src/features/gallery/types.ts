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
export type GalleryIdentity = {
  userId: number | null
  sessionId: string | null
}
export type GallerySource = 'drawing' | 'nai'
export type GalleryMetadata = {
  source_id: string
  source: GallerySource
  model: string
  prompt: string
  negative_prompt: string
  parameters: Record<string, unknown>
}
export type GalleryImage = GalleryMetadata & {
  id: string
  width: number
  height: number
  mime_type: string
  bytes: number
  created_at: number
  expires_at: number
  has_thumbnail: boolean
}
export type GalleryUsage = {
  enabled: boolean
  retention_days: number
  max_images: number
  max_bytes: number
  used_images: number
  used_bytes: number
  can_save: boolean
  reason: string
}
export type GallerySettings = {
  enabled: boolean
  retention_days: number
  user_max_images: number
  user_max_bytes: number
  total_max_bytes: number
}
export type GalleryPage = {
  items: GalleryImage[]
  total: number
  page: number
  page_size: number
}

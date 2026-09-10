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
export type ContentAuditSettings = {
  enabled: boolean
  retention_days: number
  request_limit: number
  response_limit: number
  capacity_bytes: number
  thumbnail_enabled: boolean
  plaintext_acknowledged: boolean
}

export type ContentAuditSettingsUpdate = ContentAuditSettings & {
  expected_version: number
}

export type ContentAuditInitializeRequest = {
  expected_version: number
  plaintext_acknowledged: boolean
}

export type ContentAuditDeleteRequest = { ids: string[] }

export type ContentAuditDeletion = ContentAuditDeleteRequest & {
  operation_id: string
  status: 'deleting'
}

export type ContentAuditStatus = {
  state: ContentAuditSettings & {
    storage_id: string
    config_version: number
    epoch: number
    mode: '' | 'aes-gcm' | 'plaintext'
    key_id: string
    used_bytes: number
    reserved_bytes: number
    used_records: number
    reserved_records: number
    quarantined_bytes: number
    pause_reason: string
    capacity_paused: boolean
    healthy_until: number
    reconciling: boolean
    last_reconciled_at: number
    last_cleanup_at: number
  }
  ready: boolean
  stable_key_configured: boolean
  storage_configured: boolean
  earliest_expiry: number | null
}

export type ContentAuditRecord = {
  id: string
  created_at: number
  expires_at: number
  completed_at: number
  user_id: number
  username: string
  channel_id: number
  channel_name: string
  model: string
  group: string
  request_id: string
  upstream_request_id: string
  path: string
  protocol: string
  kind: 'text' | 'image'
  is_stream: boolean
  http_status: number
  duration_ms: number
  completion_reason: string
  retry_count: number
  request_observed: number
  response_observed: number
  request_saved: number
  response_saved: number
  request_truncated: boolean
  response_truncated: boolean
  omitted_images: number
  integrity: 'complete' | 'partial'
  redaction_version: number
  format_version: number
  mode: 'aes-gcm' | 'plaintext'
  key_id: string
  status: 'pending' | 'ready' | 'failed' | 'deleting'
  error_code: string
  file_bytes: number
}

export type ContentAuditImage = {
  index: number
  address?: string
  status: string
  mime?: 'image/jpeg'
  width?: number
  height?: number
  original_status: string
  original_mime?: 'image/png' | 'image/jpeg' | 'image/webp'
  original_bytes?: number
}

export type ContentAuditImagePage = {
  items: ContentAuditImage[]
  next_after: number | null
  total: number
}

export type ContentAuditOriginal = {
  stream: ReadableStream<Uint8Array>
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
}

export type ContentAuditDetail = {
  record: ContentAuditRecord
  payload: {
    request: unknown
    response: unknown
    images: ContentAuditImage[] | null
    image_next_after: number | null
    image_total: number
    response_text?: string
    text_view_truncated?: boolean
  }
}

export type ContentAuditFilters = {
  start: number
  end: number
  page: number
  page_size: number
  user_id?: number
  channel_id?: number
  model?: string
  request_id?: string
  kind?: 'text' | 'image'
  integrity?: 'complete' | 'partial'
  http_status?: number
}

export type ContentAuditList = {
  items: ContentAuditRecord[]
  total: number
  page: number
  page_size: number
}

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
  ConfirmPaymentComplianceResponse,
  BackupManifestResponse,
  BackupRevisionResponse,
  BackupSettingsResponse,
  BackupTask,
  BackupTaskResponse,
  FetchUpstreamRatiosRequest,
  LogCleanupTask,
  SystemOptionsResponse,
  SystemTaskListResponse,
  SystemTaskResponse,
  UpdateOptionRequest,
  UpdateOptionResponse,
  UpstreamChannelsResponse,
  UpstreamRatiosResponse,
} from './types'

export async function getSystemOptions() {
  const res = await api.get<SystemOptionsResponse>('/api/option/')
  return res.data
}

export async function updateSystemOption(request: UpdateOptionRequest) {
  const res = await api.put<UpdateOptionResponse>('/api/option/', request)
  return res.data
}

export type UpdateBackupSettingsRequest = {
  enabled?: boolean
  interval_hours?: number
  gist_id?: string
  gist_description?: string
  github_token?: string
  age_identity?: string
  clear_github_token?: boolean
  clear_age_identity?: boolean
}

export async function getBackupSettings() {
  const res = await api.get<BackupSettingsResponse>(
    '/api/system-backup/settings'
  )
  return res.data
}

export async function updateBackupSettings(
  request: UpdateBackupSettingsRequest
) {
  const res = await api.put<BackupSettingsResponse>(
    '/api/system-backup/settings',
    request
  )
  return res.data
}

export async function testBackupConnection() {
  const res = await api.post('/api/system-backup/test')
  return res.data as {
    success: boolean
    message: string
    data?: Record<string, unknown>
  }
}

export async function startBackup() {
  const res = await api.post<BackupTaskResponse>('/api/system-backup/run')
  return res.data
}

export async function getCurrentBackupTask() {
  const res = await api.get<SystemTaskResponse<BackupTask | null>>(
    '/api/system-task/current',
    { params: { type: 'database_backup' } }
  )
  return res.data
}

export async function getCurrentBackupRestoreTask() {
  const res = await api.get<SystemTaskResponse<BackupTask | null>>(
    '/api/system-task/current',
    { params: { type: 'database_backup_restore' } }
  )
  return res.data
}

export async function startBackupRestore(revision: string) {
  const res = await api.post<BackupTaskResponse>('/api/system-backup/restore', {
    revision,
    confirmation: 'RESTORE',
  })
  return res.data
}

export async function listBackupRevisions() {
  const res = await api.get<BackupRevisionResponse>(
    '/api/system-backup/revisions'
  )
  return res.data
}

export async function verifyBackup(revision?: string) {
  const res = await api.post<BackupManifestResponse>(
    '/api/system-backup/verify',
    null,
    { params: revision ? { revision } : undefined }
  )
  return res.data
}

export async function downloadBackup(revision?: string) {
  return api.get<Blob>('/api/system-backup/download', {
    params: revision ? { revision } : undefined,
    responseType: 'blob',
  })
}

export async function confirmPaymentCompliance() {
  const res = await api.post<ConfirmPaymentComplianceResponse>(
    '/api/option/payment_compliance',
    { confirmed: true }
  )
  return res.data
}

export async function startLogCleanupTask(targetTimestamp: number) {
  const res = await api.post<SystemTaskResponse<LogCleanupTask>>(
    '/api/system-task/log-cleanup',
    null,
    {
      params: { target_timestamp: targetTimestamp },
    }
  )
  return res.data
}

export async function getCurrentLogCleanupTask() {
  const res = await api.get<SystemTaskResponse<LogCleanupTask | null>>(
    '/api/system-task/current',
    {
      params: { type: 'log_cleanup' },
    }
  )
  return res.data
}

export async function getSystemTask<TTask = LogCleanupTask>(taskId: string) {
  const res = await api.get<SystemTaskResponse<TTask>>(
    `/api/system-task/${taskId}`
  )
  return res.data
}

export async function listSystemTasks(limit = 20) {
  const res = await api.get<SystemTaskListResponse>('/api/system-task/list', {
    params: { limit },
  })
  return res.data
}

export async function resetModelRatios() {
  const res = await api.post<UpdateOptionResponse>(
    '/api/option/rest_model_ratio'
  )
  return res.data
}

export async function getUpstreamChannels() {
  const res = await api.get<UpstreamChannelsResponse>(
    '/api/ratio_sync/channels'
  )
  return res.data
}

export async function fetchUpstreamRatios(request: FetchUpstreamRatiosRequest) {
  const res = await api.post<UpstreamRatiosResponse>(
    '/api/ratio_sync/fetch',
    request
  )
  return res.data
}

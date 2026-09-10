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
import type { TFunction } from 'i18next'

import { getServerErrorMessageKey } from '@/lib/server-error-message'

import { ContentAuditError } from '../api'

export function contentAuditErrorMessage(error: unknown, t: TFunction): string {
  const code = error instanceof ContentAuditError ? error.code : undefined
  const messageKey = getServerErrorMessageKey({ code })
  if (messageKey) return t(messageKey)
  switch (code) {
    case 'CONTENT_AUDIT_CONFLICT':
      return t('Content audit settings changed. Refresh and verify again.')
    case 'CONTENT_AUDIT_WRITER_ACTIVE':
      return t(
        'An audit writer is still active. Refresh before requesting deletion again.'
      )
    case 'CONTENT_AUDIT_EXPIRED':
      return t(
        'This content audit record has expired and is no longer readable.'
      )
    case 'CONTENT_AUDIT_NOT_FOUND':
      return t('This content audit record no longer exists.')
    case 'CONTENT_AUDIT_INVALID':
      return t(
        'Invalid content audit parameters. Check the limits and try again.'
      )
    case 'CONTENT_AUDIT_SESSION_REQUIRED':
      return t('Content audit requires a live root dashboard session.')
    default:
      return t(
        'Content audit is unavailable. Refresh the status before trying again.'
      )
  }
}

export function contentAuditCodeLabel(code: string, t: TFunction): string {
  switch (code) {
    case '':
      return t('Ready')
    case 'not_initialized':
      return t('Initialize audit storage')
    case 'storage_not_configured':
      return t(
        'Configure the local audit storage directory, then refresh status.'
      )
    case 'storage_or_key_mismatch':
      return t('Storage or encryption key mismatch')
    case 'storage_space':
      return t('Free disk space or inodes, then refresh status.')
    case 'database_unavailable':
      return t('Database unavailable')
    case 'reconciling':
      return t('Storage reconciliation in progress')
    case 'local_refresh_pending':
      return t('Refresh status to confirm local readiness.')
    case 'nodes_unready':
    case 'preflight_unavailable':
    case 'preflight_write':
    case 'preflight_peers':
    case 'cleanup_node_missing':
    case 'duplicate_node_name':
    case 'node_upgrade_required':
      return t(
        'Local storage checks are incomplete. Refresh status and try again.'
      )
    case 'capacity':
      return t(
        'Originals, previews and content share the total storage quota. Free space, then refresh status.'
      )
    case 'writer_unconfirmed':
    case 'orphan_writer_unconfirmed':
      return t('Writer termination is unconfirmed; reservations remain held')
    case 'completed':
      return t('Completed')
    case 'upstream_error':
      return t('Upstream error')
    case 'timeout':
      return t('Timeout')
    case 'client_disconnected':
      return t('Client disconnected')
    case 'stream_incomplete':
      return t('Incomplete stream')
    case 'ready':
      return t('Ready')
    case 'pending':
      return t('Pending')
    case 'failed':
      return t('Failed')
    case 'deleting':
      return t('Awaiting physical deletion')
    case 'complete':
      return t('Complete')
    case 'partial':
      return t('Partial')
    case 'thumbnail_disabled':
      return t('Thumbnails disabled')
    case 'image_budget':
      return t('Thumbnail resource limit reached')
    case 'image_base64':
    case 'image_url':
    case 'preview_unavailable':
      return t('Thumbnail unavailable')
    case 'image_unavailable':
      return t('Image unavailable')
    case 'resource_busy':
      return t('Image processing busy')
    case 'protocol_invalid':
      return t('Invalid image data')
    case 'not_saved':
      return t('Original not saved')
    default:
      return t('Audit status: {{code}}', { code: code.slice(0, 80) })
  }
}

export function contentAuditPauseMessage(code: string, t: TFunction): string {
  switch (code) {
    case 'storage_space':
      return t('Free disk space or inodes, then refresh status.')
    case 'local_refresh_pending':
      return t('Refresh status to confirm local readiness.')
    case 'storage_not_configured':
      return t(
        'Configure the local audit storage directory, then refresh status.'
      )
    case 'storage_or_key_mismatch':
      return t('Restore the configured encryption key, then refresh status.')
    case 'reconciling':
      return t('Storage reconciliation is in progress. Refresh status shortly.')
    case 'capacity':
      return t(
        'Originals, previews and content share the total storage quota. Free space, then refresh status.'
      )
    case 'recovery_unavailable':
      return t('Restart the local audit storage safely, then refresh status.')
    default:
      return contentAuditCodeLabel(code, t)
  }
}

export function formatAuditBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index =
    bytes > 0
      ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
      : 0
  return `${(bytes / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[index]}`
}

export function formatAuditTime(seconds: number | null): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : '—'
}

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
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { SettingsCard } from '@/features/system-settings/components/settings-card'

import {
  contentAuditPauseMessage,
  formatAuditBytes,
  formatAuditTime,
} from '../lib/labels'
import type { ContentAuditStatus as AuditStatus } from '../types'

export function ContentAuditStatusPanel(props: { status: AuditStatus }) {
  const { t } = useTranslation()
  const state = props.status.state
  const occupancy = state.used_bytes + state.reserved_bytes
  const percentage =
    state.capacity_bytes > 0 ? (occupancy / state.capacity_bytes) * 100 : 0
  let collectionLabel = t('Collection disabled')
  if (state.enabled) {
    collectionLabel = props.status.ready
      ? t('Collection enabled')
      : t('Collection paused')
  }
  const facts = [[t('Saved records'), state.used_records.toLocaleString()]]
  if (state.last_cleanup_at) {
    facts.push([t('Last cleanup'), formatAuditTime(state.last_cleanup_at)])
  }
  let pauseReason = state.pause_reason
  if (!pauseReason && state.reconciling) pauseReason = 'reconciling'
  if (!pauseReason && state.capacity_paused) pauseReason = 'capacity'
  if (!pauseReason && state.enabled && !props.status.ready) {
    pauseReason = 'local_refresh_pending'
  }
  return (
    <SettingsCard title={t('Local content audit status')}>
      <div className='flex flex-col gap-4'>
        <Badge
          className='self-start'
          variant={
            state.enabled && !props.status.ready ? 'destructive' : 'secondary'
          }
        >
          {collectionLabel}
        </Badge>
        <p className='text-sm tabular-nums'>
          {t(
            'Storage used (including in-flight): {{used}} / {{limit}} ({{percent}}%)',
            {
              used: formatAuditBytes(occupancy),
              limit: formatAuditBytes(state.capacity_bytes),
              percent: percentage.toFixed(1),
            }
          )}
        </p>
        {pauseReason && (
          <Alert variant='destructive'>
            <AlertTitle>
              {state.enabled
                ? t('Content audit paused')
                : t('Content audit protection')}
            </AlertTitle>
            <AlertDescription>
              {contentAuditPauseMessage(pauseReason, t)}
            </AlertDescription>
          </Alert>
        )}
        <dl className='grid min-w-0 gap-3 text-sm sm:grid-cols-2'>
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className='text-muted-foreground'>{label}</dt>
              <dd className='font-medium break-all'>{value}</dd>
            </div>
          ))}
        </dl>
        <p className='text-muted-foreground text-xs'>
          {t(
            'Storage usage includes in-flight writes. Deleted and expired content releases space after cleanup.'
          )}
        </p>
      </div>
    </SettingsCard>
  )
}

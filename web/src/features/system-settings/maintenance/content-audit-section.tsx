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
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { getContentAuditStatus } from '@/features/content-audit/api'
import { ContentAuditAccessBoundary } from '@/features/content-audit/components/content-audit-access'
import { ContentAuditResetButton } from '@/features/content-audit/components/content-audit-delete'
import { ContentAuditSettingsForm } from '@/features/content-audit/components/content-audit-settings-form'
import { ContentAuditStatusPanel } from '@/features/content-audit/components/content-audit-status'
import {
  contentAuditQueryOptions,
  useContentAuditAccess,
} from '@/features/content-audit/hooks/use-content-audit-access'
import { contentAuditErrorMessage } from '@/features/content-audit/lib/labels'

import { SettingsSection } from '../components/settings-section'

export function ContentAuditSettingsSection() {
  return (
    <ContentAuditAccessBoundary>
      <ContentAuditSettingsContent />
    </ContentAuditAccessBoundary>
  )
}

function ContentAuditSettingsContent() {
  const { t } = useTranslation()
  const access = useContentAuditAccess()
  const query = useQuery({
    ...contentAuditQueryOptions,
    queryKey: [...access.queryKey, 'status'],
    queryFn: ({ signal }) => access.run(getContentAuditStatus, signal),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })
  if (query.isPending) return <LoadingState />
  if (query.data === undefined) {
    return (
      <ErrorState
        description={contentAuditErrorMessage(query.error, t)}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const status = query.data
  return (
    <SettingsSection title={t('Content audit')}>
      {query.isError && (
        <ErrorState
          className='min-h-0'
          description={contentAuditErrorMessage(query.error, t)}
          onRetry={() => void query.refetch()}
        />
      )}
      <Alert>
        <AlertDescription>
          {t(
            'Content audit is separate from usage and security logs. It is best-effort, does not backfill earlier requests, and is not a billing record. Only live root dashboard sessions can read content.'
          )}
        </AlertDescription>
      </Alert>
      {!status.storage_configured && (
        <Alert variant='destructive'>
          <AlertDescription>
            {t(
              'Set CONTENT_AUDIT_STORAGE_DIR to an existing private directory. The directory is not created automatically.'
            )}
          </AlertDescription>
        </Alert>
      )}
      {status.state.mode === 'aes-gcm' && !status.stable_key_configured && (
        <Alert variant='destructive'>
          <AlertDescription>
            {t('Storage or encryption key mismatch')}
          </AlertDescription>
        </Alert>
      )}
      {status.state.mode === 'plaintext' && (
        <Alert variant='destructive'>
          <AlertDescription>
            {t(
              'Audit content is stored without encryption. Protect the storage directory and retain the deployment configuration.'
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className='flex flex-wrap gap-2'>
        <Button
          type='button'
          variant='outline'
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('Refresh status')}
        </Button>
        <Link
          to='/content-audit'
          preload={false}
          className={buttonVariants({ variant: 'outline' })}
        >
          {t('View content audit records')}
        </Link>
        <ContentAuditResetButton
          disabled={
            query.isFetching || query.isError || !status.state.storage_id
          }
        />
      </div>
      <ContentAuditSettingsForm status={status} />
      <ContentAuditStatusPanel status={status} />
    </SettingsSection>
  )
}

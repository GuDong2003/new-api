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
import { Delete02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { SecureVerificationDialog } from '@/features/auth/secure-verification'

import { useContentAuditAction } from '../hooks/use-content-audit-action'

export function ContentAuditDeleteButton(props: {
  ids: string[]
  disabled?: boolean
  onRequested?: () => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<string[] | null>(null)
  const action = useContentAuditAction({
    onDeletionSettled: props.onRequested,
  })
  return (
    <>
      <Button
        type='button'
        variant={props.compact ? 'ghost' : 'destructive'}
        size={props.compact ? 'icon-sm' : 'sm'}
        aria-label={props.compact ? t('Delete record') : undefined}
        title={props.compact ? t('Delete record') : undefined}
        disabled={
          props.disabled ||
          props.ids.length === 0 ||
          props.ids.length > 100 ||
          action.mutation.isPending
        }
        onClick={() => setSelection([...new Set(props.ids)].sort())}
      >
        {props.compact ? (
          <HugeiconsIcon icon={Delete02Icon} size={16} aria-hidden='true' />
        ) : (
          t('Request deletion')
        )}
      </Button>
      <ConfirmDialog
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null)
        }}
        title={t('Delete selected content audit records?')}
        desc={t(
          'Request deletion of {{count}} records. Content becomes unreadable first; physical deletion and capacity release happen asynchronously. This cannot be undone.',
          { count: selection?.length ?? 0 }
        )}
        destructive
        confirmText={t('Request deletion')}
        handleConfirm={() => {
          if (!selection) return
          const ids = selection
          setSelection(null)
          action.mutation.mutate({
            scope: 'content_audit.delete',
            context: { ids },
          })
        }}
      />
      <SecureVerificationDialog {...action.verification.dialogProps} />
    </>
  )
}

export function ContentAuditResetButton(props: {
  disabled?: boolean
  onRequested?: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const action = useContentAuditAction({
    onDeletionSettled: props.onRequested,
  })
  return (
    <>
      <Button
        type='button'
        variant='outline'
        size='sm'
        disabled={props.disabled || action.mutation.isPending}
        onClick={() => setOpen(true)}
      >
        {t('Clear saved content')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('Clear saved content audit records?')}
        desc={t(
          'Clear all completed content audit records. Records that are still being written will be left alone. Physical deletion and capacity release happen asynchronously. This cannot be undone.'
        )}
        destructive
        isLoading={action.mutation.isPending}
        confirmText={t('Clear saved content')}
        handleConfirm={() => {
          setOpen(false)
          action.mutation.mutate({
            scope: 'content_audit.reset',
            context: {},
          })
        }}
      />
      <SecureVerificationDialog {...action.verification.dialogProps} />
    </>
  )
}

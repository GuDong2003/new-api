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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useSecureVerification } from '@/features/auth/secure-verification'
import type { ContentAuditOperation } from '@/features/auth/secure-verification/types'

import {
  deleteContentAudits,
  initializeContentAudit,
  resetContentAudits,
  updateContentAuditSettings,
} from '../api'
import { contentAuditErrorMessage } from '../lib/labels'
import type {
  ContentAuditDeletion,
  ContentAuditResetResult,
  ContentAuditStatus,
} from '../types'
import { useContentAuditAccess } from './use-content-audit-access'

export function useContentAuditAction(options?: {
  onDeletionSettled?: () => void
}) {
  const { t } = useTranslation()
  const access = useContentAuditAccess()
  const client = useQueryClient()
  const verification = useSecureVerification()
  const cancel = verification.cancel
  const current = useRef<AbortController | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      current.current?.abort()
      current.current = null
      cancel()
    }
  }, [cancel])

  const mutation = useMutation({
    mutationKey: [...access.queryKey, 'action'],
    retry: false,
    gcTime: 0,
    mutationFn: async (operation: ContentAuditOperation) => {
      if (current.current) return null
      const controller = new AbortController()
      current.current = controller
      try {
        // Proofs live only in this invocation, never in query/mutation variables.
        const proof = await verification.requestVerification({
          ...operation,
          title: t('Verify content audit operation'),
        })
        if (!proof || controller.signal.aborted) return null
        return await access.run<
          ContentAuditStatus | ContentAuditDeletion | ContentAuditResetResult
        >((signal) => {
          switch (operation.scope) {
            case 'content_audit.initialize':
              return initializeContentAudit(
                operation.context,
                proof.proof_token,
                signal
              )
            case 'content_audit.settings.update':
              return updateContentAuditSettings(
                operation.context,
                proof.proof_token,
                signal
              )
            case 'content_audit.delete':
              return deleteContentAudits(
                operation.context,
                proof.proof_token,
                signal
              )
            case 'content_audit.reset':
              return resetContentAudits(
                operation.context,
                proof.proof_token,
                signal
              )
          }
        }, controller.signal)
      } finally {
        if (current.current === controller) current.current = null
      }
    },
    onSuccess: (result, operation) => {
      if (!result) return
      if (operation.scope === 'content_audit.delete') {
        toast.success(
          t('Deletion requested. Physical cleanup is still pending.')
        )
      } else if (operation.scope === 'content_audit.reset') {
        toast.success(
          t('Content audit reset requested. Physical cleanup is still pending.')
        )
      } else {
        client.setQueryData([...access.queryKey, 'status'], result)
        toast.success(t('Content audit settings saved'))
      }
    },
    onError: (error) => {
      toast.error(contentAuditErrorMessage(error, t))
    },
    // Even a failed write can have committed. Refetch before accepting another
    // operation; a retry always obtains a fresh, context-bound proof.
    onSettled: async (result, error, operation) => {
      const destructive =
        operation.scope === 'content_audit.delete' ||
        operation.scope === 'content_audit.reset'
      if (destructive && (result || error)) {
        // Mounted observers retain their data after removeQueries. Hide the
        // disclosure before waiting for any metadata refresh or navigation.
        if (mounted.current) options?.onDeletionSettled?.()
        await client.cancelQueries({ queryKey: [...access.queryKey, 'record'] })
        client.removeQueries({ queryKey: [...access.queryKey, 'record'] })
      }
      await client.invalidateQueries({
        queryKey: [...access.queryKey, 'status'],
      })
      await client.invalidateQueries({
        queryKey: [...access.queryKey, 'records'],
      })
    },
  })

  return { mutation, verification }
}

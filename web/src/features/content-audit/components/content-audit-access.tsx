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
import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { ContentAuditError } from '../api'
import { ContentAuditAccessContext } from '../hooks/use-content-audit-access'
import { useContentAuditExpiry } from '../hooks/use-content-audit-expiry'

export function ContentAuditAccessBoundary(props: { children: ReactNode }) {
  const { t } = useTranslation()
  const userId = useAuthStore((s) => s.auth.user?.id)
  const role = useAuthStore((s) => s.auth.user?.role)
  const sid = useAuthStore((s) => s.auth.session?.sid)
  const authenticated = useAuthStore((s) => Boolean(s.auth.accessToken))
  if (role !== ROLE.SUPER_ADMIN || !sid || !userId || !authenticated) {
    return (
      <ErrorState
        description={t('Content audit requires a live root dashboard session.')}
      />
    )
  }
  return (
    <ContentAuditSession key={`${userId}:${sid}`} userId={userId} sid={sid}>
      {props.children}
    </ContentAuditSession>
  )
}

function ContentAuditSession(props: {
  userId: number
  sid: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const scope = useId()
  const queryKey = useMemo(() => ['content-audit', scope] as const, [scope])
  const requests = useRef(new Set<AbortController>())
  const [denied, setDenied] = useState(false)
  const expiresAt = useAuthStore((s) => s.auth.session?.expires_at)

  useEffect(() => {
    const activeRequests = requests.current
    return () => {
      for (const controller of activeRequests) controller.abort()
      activeRequests.clear()
      void client.cancelQueries({ queryKey })
      client.removeQueries({ queryKey })
      for (const mutation of client
        .getMutationCache()
        .findAll({ mutationKey: queryKey })) {
        client.getMutationCache().remove(mutation)
      }
    }
  }, [client, queryKey, denied])

  useContentAuditExpiry(expiresAt, () => setDenied(true))
  useEffect(() => {
    const clearOnPageHide = () => setDenied(true)
    window.addEventListener('pagehide', clearOnPageHide)
    return () => window.removeEventListener('pagehide', clearOnPageHide)
  }, [])

  const userId = props.userId
  const sid = props.sid
  const run = useCallback(
    async <T,>(
      request: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal
    ): Promise<T> => {
      const controller = new AbortController()
      requests.current.add(controller)
      const requestSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal
      try {
        const auth = useAuthStore.getState().auth
        if (
          denied ||
          auth.user?.id !== userId ||
          auth.user.role !== ROLE.SUPER_ADMIN ||
          auth.session?.sid !== sid ||
          auth.session.expires_at * 1000 <= Date.now() ||
          !auth.accessToken
        ) {
          throw new ContentAuditError('CONTENT_AUDIT_SESSION_REQUIRED', 403)
        }
        const result = await request(requestSignal)
        requestSignal.throwIfAborted()
        const current = useAuthStore.getState().auth
        if (
          current.user?.id !== userId ||
          current.user.role !== ROLE.SUPER_ADMIN ||
          current.session?.sid !== sid ||
          current.session.expires_at * 1000 <= Date.now() ||
          !current.accessToken
        ) {
          throw new ContentAuditError('CONTENT_AUDIT_SESSION_REQUIRED', 403)
        }
        return result
      } catch (error) {
        if (
          !requestSignal.aborted &&
          error instanceof ContentAuditError &&
          error.accessDenied
        ) {
          setDenied(true)
        }
        throw error
      } finally {
        requests.current.delete(controller)
      }
    },
    [denied, sid, userId]
  )
  const access = useMemo(() => ({ queryKey, run }), [queryKey, run])

  if (denied) {
    return (
      <ErrorState
        description={t(
          'Content audit access ended. Sign in with a live root session to continue.'
        )}
      />
    )
  }
  return (
    <ContentAuditAccessContext.Provider value={access}>
      {props.children}
    </ContentAuditAccessContext.Provider>
  )
}

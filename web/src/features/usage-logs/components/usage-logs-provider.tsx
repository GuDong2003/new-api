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
/* eslint-disable react-refresh/only-export-components */
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

import { getUserProfile } from '@/features/profile/api'
import {
  ADMIN_PERMISSION_ACTIONS,
  ADMIN_PERMISSION_RESOURCES,
  hasPermission,
} from '@/lib/admin-permissions'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import type { ChannelAffinityInfo, LogCategory } from '../types'

export type LogsViewScope = 'all' | 'self'
export type LogsViewAccess = 'self' | 'admin' | 'root'

export function resolveLogsViewAccess(
  role: number,
  viewScope: LogsViewScope
): LogsViewAccess {
  if (viewScope !== 'all' || role < ROLE.ADMIN) return 'self'
  return role === ROLE.SUPER_ADMIN ? 'root' : 'admin'
}

interface UsageLogsContextValue {
  selectedUserId: number | null
  setSelectedUserId: (userId: number | null) => void
  userInfoDialogOpen: boolean
  setUserInfoDialogOpen: (open: boolean) => void
  affinityTarget: ChannelAffinityInfo | null
  setAffinityTarget: (target: ChannelAffinityInfo | null) => void
  affinityDialogOpen: boolean
  setAffinityDialogOpen: (open: boolean) => void
  sensitiveVisible: boolean
  setSensitiveVisible: (visible: boolean) => void
  viewScope: LogsViewScope
  setViewScope: (scope: LogsViewScope) => void
  logCategory: LogCategory
  taskAccessRevoked: boolean
  handleTaskAccessDenied: () => Promise<void>
}

const UsageLogsContext = createContext<UsageLogsContextValue | undefined>(
  undefined
)

async function clearTaskAdminCache(
  queryClient: QueryClient,
  userId: number | undefined
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: ['logs', 'task', 'admin', userId] }),
    queryClient.cancelQueries({ queryKey: ['logs', 'task', 'root', userId] }),
    queryClient.cancelQueries({ queryKey: ['usage-logs', 'task-artifacts'] }),
  ])
  queryClient.removeQueries({ queryKey: ['logs', 'task', 'admin', userId] })
  queryClient.removeQueries({ queryKey: ['logs', 'task', 'root', userId] })
  queryClient.removeQueries({ queryKey: ['usage-logs', 'task-artifacts'] })
}

export function UsageLogsProvider(props: {
  children: ReactNode
  logCategory?: LogCategory
}) {
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.auth.user)
  const userId = user?.id
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [userInfoDialogOpen, setUserInfoDialogOpen] = useState(false)
  const [affinityTarget, setAffinityTarget] =
    useState<ChannelAffinityInfo | null>(null)
  const [affinityDialogOpen, setAffinityDialogOpen] = useState(false)
  const [sensitiveVisible, setSensitiveVisible] = useState(true)
  const [viewScope, setViewScope] = useState<LogsViewScope>('all')
  const [taskAccessRevoked, setTaskAccessRevoked] = useState(false)
  const canReadAllTasks =
    (user?.role ?? ROLE.GUEST) >= ROLE.ADMIN &&
    hasPermission(
      user,
      ADMIN_PERMISSION_RESOURCES.TASK,
      ADMIN_PERMISSION_ACTIONS.READ
    )
  useEffect(() => {
    if (
      props.logCategory === 'task' &&
      !canReadAllTasks &&
      !taskAccessRevoked
    ) {
      void clearTaskAdminCache(queryClient, userId)
    }
  }, [
    props.logCategory,
    canReadAllTasks,
    taskAccessRevoked,
    queryClient,
    userId,
  ])
  const handleTaskAccessDenied = useCallback(async () => {
    setTaskAccessRevoked(true)
    setViewScope('self')
    setUserInfoDialogOpen(false)
    setAffinityDialogOpen(false)
    const current = useAuthStore.getState().auth.user
    if (current && current.id === userId) {
      useAuthStore.getState().auth.setUser({
        ...current,
        permissions: {
          ...current.permissions,
          admin_permissions: {
            ...current.permissions?.admin_permissions,
            task: { read: false },
          },
        },
      })
    }
    await clearTaskAdminCache(queryClient, userId)
    try {
      const profile = await getUserProfile()
      const latest = useAuthStore.getState().auth.user
      if (
        profile.success &&
        profile.data &&
        latest &&
        profile.data.id === userId &&
        latest.id === userId
      ) {
        useAuthStore.getState().auth.setUser({
          ...latest,
          role: profile.data.role,
          permissions: profile.data.permissions,
        })
      }
    } catch {
      // Keep the denied scope closed if refreshing permissions fails.
    }
  }, [queryClient, userId])

  return (
    <UsageLogsContext.Provider
      value={{
        selectedUserId,
        setSelectedUserId,
        userInfoDialogOpen,
        setUserInfoDialogOpen,
        affinityTarget,
        setAffinityTarget,
        affinityDialogOpen,
        setAffinityDialogOpen,
        sensitiveVisible,
        setSensitiveVisible,
        viewScope,
        setViewScope,
        logCategory: props.logCategory ?? 'common',
        taskAccessRevoked,
        handleTaskAccessDenied,
      }}
    >
      {props.children}
    </UsageLogsContext.Provider>
  )
}

export function useUsageLogsContext() {
  const context = useContext(UsageLogsContext)
  if (!context) {
    throw new Error('useUsageLogsContext must be used within UsageLogsProvider')
  }
  return context
}

/**
 * Resolves the effective admin scope for usage logs: whether the current
 * user is allowed to view all users' logs (`canManageScope`), and whether
 * their current view preference (`viewScope`) has that scope active
 * (`isAdminView`). Data fetching and admin-only UI should key off
 * `isAdminView` rather than raw role, so an admin who switches to "only
 * mine" is treated exactly like a regular user for that view.
 */
export function useLogsViewScope() {
  const user = useAuthStore((state) => state.auth.user)
  const role = user?.role ?? ROLE.GUEST
  const {
    viewScope: requestedScope,
    setViewScope,
    logCategory,
    taskAccessRevoked,
    handleTaskAccessDenied,
  } = useUsageLogsContext()
  const canManageScope =
    role >= ROLE.ADMIN &&
    (logCategory !== 'task' ||
      (!taskAccessRevoked &&
        hasPermission(
          user,
          ADMIN_PERMISSION_RESOURCES.TASK,
          ADMIN_PERMISSION_ACTIONS.READ
        )))
  const viewScope = canManageScope ? requestedScope : 'self'
  const viewAccess = resolveLogsViewAccess(role, viewScope)
  const isAdminView = viewAccess !== 'self'
  const isRootView = viewAccess === 'root'

  return {
    canManageScope,
    viewScope,
    setViewScope,
    isAdminView,
    isRootView,
    viewAccess,
    taskAccessRevoked,
    handleTaskAccessDenied,
  }
}

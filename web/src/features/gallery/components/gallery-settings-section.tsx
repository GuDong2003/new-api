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
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { SettingsSection } from '@/features/system-settings/components/settings-section'
import { useAuthStore } from '@/stores/auth-store'

import { getGallerySettings } from '../api'
import type { GalleryIdentity } from '../types'
import { GallerySettingsForm } from './gallery-settings-form'

export function GallerySettingsSection() {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? null)
  const role = useAuthStore((state) => state.auth.user?.role ?? 0)
  if (role !== 100 || userId === null || sessionId === null) {
    return (
      <ErrorState
        description={t('Only root users can manage gallery settings.')}
      />
    )
  }
  return (
    <GallerySettingsContent
      key={`${userId}:${sessionId}`}
      identity={{ userId, sessionId }}
    />
  )
}

function GallerySettingsContent(props: { identity: GalleryIdentity }) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: [
      'gallery',
      props.identity.userId,
      props.identity.sessionId,
      'settings',
    ],
    queryFn: ({ signal }) => getGallerySettings(props.identity, signal),
    retry: false,
  })
  if (query.isPending) return <LoadingState />
  if (!query.data) return <ErrorState onRetry={() => void query.refetch()} />
  return (
    <SettingsSection title={t('Gallery storage')}>
      <GallerySettingsForm settings={query.data} identity={props.identity} />
    </SettingsSection>
  )
}

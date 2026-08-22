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

import type { ChannelUpstreamAccountConfig } from '../types'

export function shouldShowChannelCheckinAction(
  config: ChannelUpstreamAccountConfig | undefined
): boolean {
  return Boolean(
    config?.enabled &&
    config.id &&
    config.supports_checkin &&
    config.auto_checkin
  )
}

export function formatLastCheckinTime(timestamp: unknown): string | null {
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return null

  return new Date(seconds * 1000).toLocaleString()
}

export function getUpstreamAuthTypeLabel(
  authType: string | undefined,
  translate: (key: string) => string
): string {
  return translate(authType === 'cookie' ? 'Browser Cookie' : 'Pass token')
}

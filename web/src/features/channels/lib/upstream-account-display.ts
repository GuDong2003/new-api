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

import type {
  Channel,
  ChannelOtherSettings,
  ChannelUpstreamAccountConfig,
} from '../types'

/** The accounts that check in on a channel on schedule, oldest first. */
export function getChannelCheckinAccounts(
  channel: Pick<Channel, 'upstream_account_configs'>
): ChannelUpstreamAccountConfig[] {
  return (channel.upstream_account_configs ?? []).filter((account) =>
    Boolean(account.id && account.supports_checkin && account.auto_checkin)
  )
}

export type ChannelCheckinLinks = {
  externalCheckinUrl: string
  redeemUrl: string
  openRedeemWithCheckin: boolean
}

/**
 * The upstream site's own check-in and recharge pages a channel links to,
 * with or without accounts. A channel saved before it kept these links still
 * finds them on its first account.
 */
export function getChannelCheckinLinks(
  channel: Pick<Channel, 'settings' | 'upstream_account_configs'>
): ChannelCheckinLinks {
  let settings: ChannelOtherSettings = {}
  try {
    settings = JSON.parse(channel.settings || '{}') ?? {}
  } catch {
    // Unreadable settings link to nothing of their own.
  }
  if (settings.external_checkin_url || settings.redeem_url) {
    return {
      externalCheckinUrl: settings.external_checkin_url ?? '',
      redeemUrl: settings.redeem_url ?? '',
      openRedeemWithCheckin: settings.open_redeem_with_checkin === true,
    }
  }
  const account = channel.upstream_account_configs?.[0]
  return {
    externalCheckinUrl: account?.external_checkin_url ?? '',
    redeemUrl: account?.redeem_url ?? '',
    openRedeemWithCheckin: account?.open_redeem_with_checkin === true,
  }
}

export type ChannelCheckinSummary = {
  /** Unix seconds of the latest check-in of any account, 0 when none ran. */
  lastCheckinTime: number
  succeeded: number
  total: number
}

/** How the accounts checking in on a channel did on their latest check-in. */
export function summarizeChannelCheckins(
  channel: Pick<Channel, 'upstream_account_configs'>
): ChannelCheckinSummary {
  let lastCheckinTime = 0
  for (const account of channel.upstream_account_configs ?? []) {
    lastCheckinTime = Math.max(lastCheckinTime, account.last_checkin_time ?? 0)
  }
  const accounts = getChannelCheckinAccounts(channel)
  return {
    lastCheckinTime,
    succeeded: accounts.filter(
      (account) => account.last_checkin_status === 'healthy'
    ).length,
    total: accounts.length,
  }
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

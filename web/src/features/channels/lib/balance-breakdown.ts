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
import type { Channel } from '../types'

/**
 * One of the balances a channel's total adds up. `unit` is empty until the
 * balance is first read, and `status` is how its latest refresh went.
 */
export type BalanceBreakdownRow =
  | {
      kind: 'account'
      id: number
      name: string
      balance: number
      unit: string
      status: string
    }
  | {
      /** A key of a multi-key channel, named by its position from 0 in `id`. */
      kind: 'key'
      id: number
      balance: number
      unit: string
      status: string
      /** Whether the key is enabled, or manually or automatically disabled. */
      keyStatus: number
    }

/**
 * The balances a channel's total adds up: one per upstream account for a
 * channel that takes its balance from them, otherwise one per key of a
 * multi-key channel.
 */
export function getBalanceBreakdown(
  channel: Pick<
    Channel,
    'balance_source' | 'upstream_balance_details' | 'key_balance_details'
  >
): BalanceBreakdownRow[] {
  if (channel.balance_source === 'upstream') {
    return (channel.upstream_balance_details ?? []).map((account) => ({
      kind: 'account',
      id: account.account_id,
      name: account.account_name,
      balance: account.balance,
      unit: account.unit.trim(),
      status: account.status,
    }))
  }
  if (channel.balance_source === 'none') {
    return []
  }
  return (channel.key_balance_details ?? []).map((key) => ({
    kind: 'key',
    id: key.index,
    balance: key.balance,
    unit: key.updated_time > 0 ? 'USD' : '',
    status: key.status,
    keyStatus: key.key_status,
  }))
}

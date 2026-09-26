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

import { toIntlLocale } from '@/i18n/languages'
import { cn } from '@/lib/utils'

import { formatUpstreamBalance } from '../lib/upstream-account-display'
import type { Channel } from '../types'

type UpstreamAccountBalancesProps = {
  accounts: NonNullable<Channel['upstream_balance_details']>
  className?: string
}

/** The balance each account of a channel last reported, one per line. */
export function UpstreamAccountBalances(props: UpstreamAccountBalancesProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)

  return (
    <ul className={cn('flex flex-col gap-1', props.className)}>
      {props.accounts.map((account) => {
        // A balance is always read with its unit, so one without a unit has
        // not been read yet.
        let balance = t('Not fetched yet')
        if (account.unit.trim()) {
          balance = formatUpstreamBalance(account.balance, account.unit, locale)
        }
        let problem = ''
        if (account.status === 'failed') {
          problem = t('Refresh failed')
        } else if (account.status === 'manual_required') {
          problem = t('Manual verification required')
        }
        return (
          <li
            key={account.account_id}
            className='flex items-center justify-between gap-4'
          >
            <span className='min-w-0 truncate' title={account.account_name}>
              {account.account_name}
            </span>
            <span className='shrink-0 font-medium'>
              {balance}
              {problem && (
                <span className='ml-1.5 font-normal opacity-70'>{problem}</span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

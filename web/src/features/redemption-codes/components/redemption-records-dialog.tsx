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

import { PagedRecordsDialog } from '@/components/paged-records-dialog'
import { toIntlLocale } from '@/i18n/languages'
import dayjs from '@/lib/dayjs'
import { formatNumber, formatQuota } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getRedemptionRecords } from '../api'
import type { Redemption, RedemptionRecord } from '../types'

type RedemptionRecordsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  redemption?: Redemption
}

export function RedemptionRecordsDialog(props: RedemptionRecordsDialogProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const redemptionId = props.redemption?.id

  return (
    <PagedRecordsDialog<RedemptionRecord>
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Redemption records')}
      description={props.redemption?.name}
      queryKey={['redemption-records', redemptionId]}
      enabled={redemptionId !== undefined}
      fetchPage={async (page, pageSize) => {
        const response = requireServerSuccess(
          await getRedemptionRecords({
            redemptionId: redemptionId ?? 0,
            page,
            pageSize,
          })
        )
        return {
          items: response.data?.items ?? [],
          total: response.data?.total ?? 0,
        }
      }}
      columns={[
        {
          id: 'user',
          header: t('User'),
          cell: (record) => (
            <>
              <div className='font-medium'>
                {record.username || t('Deleted user')}
              </div>
              {record.display_name ? (
                <div className='text-muted-foreground text-xs'>
                  {record.display_name}
                </div>
              ) : null}
            </>
          ),
        },
        {
          id: 'user_id',
          header: t('User ID'),
          cell: (record) => record.user_id,
        },
        {
          id: 'quota',
          header: t('Quota'),
          cell: (record) => formatQuota(record.quota),
          className: 'tabular-nums',
        },
        {
          id: 'redeemed_at',
          header: t('Redeemed at'),
          cell: (record) =>
            dayjs(record.created_time * 1000).format('YYYY-MM-DD HH:mm'),
        },
      ]}
      getRowKey={(record) => record.id}
      emptyText={t('No redemption records found')}
      totalText={(total) =>
        t('{{count}} record(s)', { count: formatNumber(total, locale) })
      }
    />
  )
}

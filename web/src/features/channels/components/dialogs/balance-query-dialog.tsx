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
import { Loader2, RefreshCw, DollarSign } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { formatCurrencyFromUSD } from '@/lib/currency'
import { formatTimestampToDate } from '@/lib/format'

import { getCodexUsage, updateChannelBalance } from '../../api'
import { channelsQueryKeys } from '../../lib'
import { useChannels } from '../channels-provider'
import {
  CodexUsageDialog,
  type CodexUsageDialogData,
} from './codex-usage-dialog'

type BalanceQueryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BalanceQueryDialog({
  open,
  onOpenChange,
}: BalanceQueryDialogProps) {
  const { t } = useTranslation()
  const { currentRow, setCurrentRow } = useChannels()
  const queryClient = useQueryClient()
  const [isQuerying, setIsQuerying] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [balanceUpdatedTime, setBalanceUpdatedTime] = useState<number | null>(
    null
  )
  const [balanceCurrency, setBalanceCurrency] = useState<string | null>(null)
  const [codexUsageResponse, setCodexUsageResponse] =
    useState<CodexUsageDialogData | null>(null)

  const isCodex = currentRow?.type === 57

  const handleQueryCodexUsage = async () => {
    const row = currentRow
    if (!row) return
    setIsQuerying(true)
    try {
      const res = await getCodexUsage(row.id)
      if (!res.success) {
        throw new Error(res.message || t('Failed to fetch usage'))
      }
      setCodexUsageResponse(res)
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : t('Failed to fetch usage')
      )
    } finally {
      setIsQuerying(false)
    }
  }

  useEffect(() => {
    if (!isCodex) return
    if (!open) return
    handleQueryCodexUsage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isCodex])

  if (!currentRow) return null

  const handleQueryBalance = async () => {
    setIsQuerying(true)
    try {
      const response = await updateChannelBalance(currentRow.id)
      if (response.success && response.balance !== undefined) {
        const newBalance = response.balance
        const now =
          response.balance_updated_time ?? Math.floor(Date.now() / 1000)

        setBalance(newBalance)
        setBalanceCurrency(response.currency || 'USD')
        setBalanceUpdatedTime(now)
        toast.success(t('Balance updated successfully'))

        // Update currentRow immediately with new balance and timestamp
        setCurrentRow(
          response.balance_source === 'upstream'
            ? {
                ...currentRow,
                upstream_balance: newBalance,
                upstream_balance_unit: response.currency || 'QUOTA',
                upstream_balance_updated_time: now,
                upstream_account_count:
                  response.account_count ?? currentRow.upstream_account_count,
                upstream_balance_details:
                  response.account_balances ??
                  currentRow.upstream_balance_details,
                upstream_account_ids: response.account_balances?.map(
                  (item) => item.account_id
                ),
                upstream_account_names: response.account_balances?.map(
                  (item) => item.account_name
                ),
              }
            : {
                ...currentRow,
                balance: newBalance,
                balance_updated_time: now,
              }
        )

        // Invalidate queries to refresh the table
        await queryClient.invalidateQueries({
          queryKey: channelsQueryKeys.lists(),
        })
      } else {
        toast.error(response.message || t('Failed to query balance'))
      }
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : t('Failed to query balance')
      )
    } finally {
      setIsQuerying(false)
    }
  }

  const handleClose = () => {
    setBalance(null)
    setBalanceUpdatedTime(null)
    setBalanceCurrency(null)
    setCodexUsageResponse(null)
    onOpenChange(false)
  }

  const formatBalance = (bal: number, currency = 'USD') =>
    currency === 'USD'
      ? formatCurrencyFromUSD(bal, {
          digitsLarge: 2,
          digitsSmall: 4,
          abbreviate: false,
        })
      : `${bal.toLocaleString()} ${currency}`

  const formatDate = (timestamp: number) => {
    if (!timestamp) return 'Never'
    return formatTimestampToDate(timestamp)
  }

  let displayedBalance = formatBalance(currentRow.balance)
  if (balance !== null) {
    displayedBalance = formatBalance(balance, balanceCurrency || 'USD')
  } else if (currentRow.balance_source === 'upstream') {
    displayedBalance = formatBalance(
      currentRow.upstream_balance ?? 0,
      currentRow.upstream_balance_unit || 'QUOTA'
    )
  } else if (currentRow.balance_source === 'none') {
    displayedBalance = '不查询'
  }
  const displayedUpdatedTime =
    balanceUpdatedTime ??
    (currentRow.balance_source === 'upstream'
      ? currentRow.upstream_balance_updated_time
      : currentRow.balance_updated_time) ??
    0
  const upstreamDetails =
    currentRow.balance_source === 'upstream'
      ? currentRow.upstream_balance_details ?? []
      : []
  let queryButtonLabel = t('Update Balance')
  if (currentRow.balance_source === 'none') {
    queryButtonLabel = '余额查询已关闭'
  } else if (isQuerying) {
    queryButtonLabel = t('Querying...')
  }

  if (isCodex) {
    return (
      <CodexUsageDialog
        open={open}
        onOpenChange={(v) => {
          if (!v) handleClose()
        }}
        channelName={currentRow.name}
        channelId={currentRow.id}
        response={codexUsageResponse}
        onRefresh={handleQueryCodexUsage}
        isRefreshing={isQuerying}
      />
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleClose}
      title={t('Query Balance')}
      description={
        <>
          {t('Update balance for:')}
          <strong>{currentRow.name}</strong>
        </>
      }
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={
        <Button variant='outline' onClick={handleClose} disabled={isQuerying}>
          {t('Close')}
        </Button>
      }
    >
      <div className='space-y-4 py-4'>
        {/* Current Balance Display */}
        <div className='bg-muted/50 rounded-lg border p-4'>
          <div className='text-muted-foreground mb-2 flex items-center gap-2 text-sm'>
            <IconBadge tone='success' size='xs'>
              <DollarSign />
            </IconBadge>
            <span>{t('Current Balance')}</span>
          </div>
          <div className='text-2xl font-bold'>{displayedBalance}</div>
          <div className='text-muted-foreground mt-2 text-xs'>
            {t('Last updated:')} {formatDate(displayedUpdatedTime)}
          </div>
          {upstreamDetails.length > 1 && (
            <div className='mt-3 space-y-1 border-t pt-3 text-xs'>
              <div className='text-muted-foreground'>各账号余额</div>
              {upstreamDetails.map((item) => (
                <div
                  key={item.account_id}
                  className='flex items-center justify-between gap-3'
                >
                  <span className='min-w-0 truncate'>{item.account_name}</span>
                  <span className='shrink-0 font-medium'>
                    {formatBalance(item.balance, item.unit || 'QUOTA')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Balance Update Button */}
        <Button
          className='w-full'
          onClick={handleQueryBalance}
          disabled={isQuerying || currentRow.balance_source === 'none'}
        >
          {isQuerying && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
          {!isQuerying && <RefreshCw className='mr-2 h-4 w-4' />}
          {queryButtonLabel}
        </Button>
      </div>
    </Dialog>
  )
}

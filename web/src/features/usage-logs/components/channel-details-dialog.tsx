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
import { Link } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { Button, buttonVariants } from '@/components/ui/button'

import type { UsageLog } from '../data/schema'
import { parseLogOther } from '../lib/format'
import { useUsageLogsContext } from './usage-logs-provider'

/** A log field's dialog, which phones show as a bottom sheet. */
export const logFieldDialogClassName =
  'max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[85dvh] max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] [&_[data-slot=dialog-close]]:size-11'

type ChannelDetailsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  channelId: number
  /**
   * What the dialog shows and copies: the channel's name and ID, or only the
   * ID while sensitive values are hidden.
   */
  value: string
  /** Further details shown under the value. */
  children?: ReactNode
}

/**
 * A log's channel: its name and ID, further details, and a link that opens
 * the channel on the channels page.
 */
export function ChannelDetailsDialog(props: ChannelDetailsDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Channel')}
      contentClassName={logFieldDialogClassName}
      footer={
        <CopyButton
          value={props.value}
          variant='default'
          size='default'
          className='min-h-11 w-full'
        >
          {t('Copy')}
        </CopyButton>
      }
    >
      <div className='space-y-4'>
        <p className='bg-muted rounded-lg p-4 text-base [overflow-wrap:anywhere] whitespace-pre-wrap'>
          {props.value}
        </p>
        {props.children}
        <Link
          className={buttonVariants({
            variant: 'outline',
            className: 'min-h-11 w-full',
          })}
          to='/channels'
          search={{ channel: props.channelId }}
        >
          <ArrowUpRight data-icon='inline-start' aria-hidden='true' />
          {t('Open channel')}
        </Link>
      </div>
    </Dialog>
  )
}

/**
 * What a usage log records about its channel: the retry chain, the key of a
 * multi-key channel, and the affinity rule that chose it.
 */
export function UsageLogChannelDetails(props: { log: UsageLog }) {
  const { t } = useTranslation()
  const { sensitiveVisible, setAffinityTarget, setAffinityDialogOpen } =
    useUsageLogsContext()
  const adminInfo = parseLogOther(props.log.other)?.admin_info
  const useChannel = Array.isArray(adminInfo?.use_channel)
    ? adminInfo.use_channel.map(String).filter(Boolean)
    : []
  const chain = useChannel.length > 1 ? useChannel.join(' → ') : undefined
  const keyIndex = adminInfo?.multi_key_index
  const showKeyIndex =
    adminInfo?.is_multi_key === true &&
    typeof keyIndex === 'number' &&
    Number.isFinite(keyIndex)
  const affinity = adminInfo?.channel_affinity

  if (!chain && !showKeyIndex && !affinity) return null

  return (
    <dl className='grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-sm'>
      {chain && (
        <>
          <dt className='text-muted-foreground'>{t('Retry Chain')}</dt>
          <dd className='font-mono [overflow-wrap:anywhere]'>{chain}</dd>
        </>
      )}
      {showKeyIndex && (
        <>
          <dt className='text-muted-foreground'>{t('Key')}</dt>
          <dd className='font-mono'>{keyIndex}</dd>
        </>
      )}
      {affinity && (
        <>
          <dt className='text-muted-foreground'>{t('Channel Affinity')}</dt>
          <dd className='space-y-1'>
            <p>
              {t('Rule')}: {affinity.rule_name || '-'}
            </p>
            <p>
              {t('Group')}:{' '}
              {sensitiveVisible
                ? affinity.using_group || affinity.selected_group || '-'
                : '••••'}
            </p>
            <Button
              variant='link'
              size='sm'
              className='h-auto px-0'
              onClick={() => {
                setAffinityTarget({
                  rule_name: affinity.rule_name || '',
                  using_group:
                    affinity.using_group || affinity.selected_group || '',
                  key_hint: affinity.key_hint || '',
                  key_fp: affinity.key_fp || '',
                })
                setAffinityDialogOpen(true)
              }}
            >
              {t('View details')}
            </Button>
          </dd>
        </>
      )}
    </dl>
  )
}

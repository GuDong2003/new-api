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
import { buttonVariants } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type ChannelDetailsPopoverProps = {
  channelId: number
  /** The channel's name, or a mask while sensitive values are hidden. */
  channelName?: string
  /** What the cell shows. Hovering or pressing it opens the details. */
  children: ReactNode
  /** Further details shown under the channel. */
  details?: ReactNode
  className?: string
}

/**
 * A log's channel cell that shows the channel's details on hover or press,
 * with a button that opens the channel on the channels page.
 */
export function ChannelDetailsPopover(props: ChannelDetailsPopoverProps) {
  const { t } = useTranslation()

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={300}
        closeDelay={150}
        nativeButton={false}
        aria-label={t('Channel details')}
        render={
          <div
            className={cn(
              'flex max-w-[180px] cursor-pointer flex-col gap-0.5 text-left',
              props.className
            )}
          />
        }
      >
        {props.children}
      </PopoverTrigger>
      <PopoverContent side='top' align='start' className='w-72 text-xs'>
        <div className='flex items-start justify-between gap-2'>
          <div className='min-w-0 space-y-0.5'>
            <p className='truncate text-sm font-medium'>
              {props.channelName || t('Channel')}
            </p>
            <p className='text-muted-foreground font-mono'>
              #{props.channelId}
            </p>
          </div>
          <CopyButton
            value={String(props.channelId)}
            tooltip={t('Copy channel ID')}
            className='size-7 shrink-0'
          />
        </div>
        {props.details}
        <Link
          className={buttonVariants({
            variant: 'outline',
            size: 'sm',
            className: 'w-full',
          })}
          to='/channels'
          search={{ channel: props.channelId }}
        >
          <ArrowUpRight data-icon='inline-start' aria-hidden='true' />
          {t('Open channel')}
        </Link>
      </PopoverContent>
    </Popover>
  )
}

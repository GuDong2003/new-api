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
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import dayjs from '@/lib/dayjs'

import { getInviteCodeUsages } from './api'
import type { InviteCode } from './types'

const usagePageSize = 20

type InviteCodeUsagesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  inviteCode?: InviteCode
}

export function InviteCodeUsagesDialog({
  open,
  onOpenChange,
  inviteCode,
}: InviteCodeUsagesDialogProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)

  useEffect(() => {
    if (open) setPage(1)
  }, [open, inviteCode?.id])

  const query = useQuery({
    queryKey: ['invite-code-usages', inviteCode?.id, page],
    queryFn: () =>
      getInviteCodeUsages({
        inviteCodeId: inviteCode?.id ?? 0,
        page,
        pageSize: usagePageSize,
      }),
    enabled: open && Boolean(inviteCode),
    placeholderData: (previousData) => previousData,
  })
  const usages = query.data?.data?.items ?? []
  const total = query.data?.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / usagePageSize))

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('Invitation Code Usage Records')}
      description={inviteCode?.code || inviteCode?.code_prefix}
      contentClassName='sm:max-w-3xl'
      footer={
        <Button variant='outline' onClick={() => onOpenChange(false)}>
          {t('Close')}
        </Button>
      }
    >
      <div className='space-y-3'>
        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('User')}</TableHead>
                <TableHead>{t('User ID')}</TableHead>
                <TableHead>{t('Registration Method')}</TableHead>
                <TableHead>{t('Used Time')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className='h-24 text-center'>
                    <Loader2
                      aria-hidden='true'
                      className='mx-auto h-5 w-5 animate-spin'
                    />
                    <span className='sr-only'>{t('Loading...')}</span>
                  </TableCell>
                </TableRow>
              ) : null}
              {!query.isLoading && usages.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className='text-muted-foreground h-24 text-center'
                  >
                    {t('No usage records found')}
                  </TableCell>
                </TableRow>
              ) : null}
              {usages.map((usage) => (
                <TableRow key={usage.id}>
                  <TableCell>
                    <div className='font-medium'>
                      {usage.username || t('Deleted user')}
                    </div>
                    {usage.display_name ? (
                      <div className='text-muted-foreground text-xs'>
                        {usage.display_name}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{usage.user_id}</TableCell>
                  <TableCell>{usage.registration_method || '—'}</TableCell>
                  <TableCell>
                    {dayjs(usage.used_time * 1000).format('YYYY-MM-DD HH:mm')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className='flex items-center justify-between gap-3'>
          <p className='text-muted-foreground text-sm'>
            {t('{{count}} usage record(s)', { count: total })}
          </p>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={page <= 1 || query.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {t('Previous')}
            </Button>
            <span className='text-muted-foreground text-sm'>
              {page} / {totalPages}
            </span>
            <Button
              variant='outline'
              size='sm'
              disabled={page >= totalPages || query.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              {t('Next')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

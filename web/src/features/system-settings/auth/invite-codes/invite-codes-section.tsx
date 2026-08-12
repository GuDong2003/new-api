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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import dayjs from '@/lib/dayjs'

import { SettingsSection } from '../../components/settings-section'
import { getInviteCodes } from './api'
import { InviteCodeDialog } from './invite-code-dialog'
import { getInviteCodeState } from './invite-code-state'
import type { InviteCode } from './types'

const pageSize = 20

export function InviteCodesSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingInviteCode, setEditingInviteCode] = useState<InviteCode>()
  const query = useQuery({
    queryKey: ['invite-codes', page, keyword],
    queryFn: () => getInviteCodes({ page, pageSize, keyword }),
    placeholderData: (previousData) => previousData,
  })
  const inviteCodes = query.data?.data?.items ?? []
  const total = query.data?.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['invite-codes'] })
  }

  const openCreateDialog = () => {
    setEditingInviteCode(undefined)
    setDialogOpen(true)
  }

  const openEditDialog = (inviteCode: InviteCode) => {
    setEditingInviteCode(inviteCode)
    setDialogOpen(true)
  }

  return (
    <SettingsSection title={t('Invitation Codes')}>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <div className='relative w-full sm:max-w-sm'>
          <Search
            aria-hidden='true'
            className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2'
          />
          <Input
            aria-label={t('Search by name, prefix, or ID')}
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value)
              setPage(1)
            }}
            className='pl-9'
            placeholder={t('Search by name, prefix, or ID')}
          />
        </div>
        <Button onClick={openCreateDialog} className='gap-2'>
          <Plus aria-hidden='true' className='h-4 w-4' />
          {t('Create Invitation Code')}
        </Button>
      </div>

      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Code')}</TableHead>
              <TableHead>{t('Name')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead>{t('Usage')}</TableHead>
              <TableHead>{t('Expiration Time')}</TableHead>
              <TableHead className='text-right'>{t('Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className='h-28 text-center'>
                  <Loader2
                    aria-hidden='true'
                    className='mx-auto h-5 w-5 animate-spin'
                  />
                  <span className='sr-only'>{t('Loading...')}</span>
                </TableCell>
              </TableRow>
            ) : null}
            {!query.isLoading && inviteCodes.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className='text-muted-foreground h-28 text-center'
                >
                  {t('No invitation codes found')}
                </TableCell>
              </TableRow>
            ) : null}
            {inviteCodes.map((inviteCode) => {
              const state = getInviteCodeState(
                inviteCode,
                Math.floor(Date.now() / 1000)
              )
              let badgeVariant: 'default' | 'secondary' | 'warning' = 'default'
              if (state === 'Disabled' || state === 'Exhausted') {
                badgeVariant = 'secondary'
              } else if (state === 'Expired') {
                badgeVariant = 'warning'
              }
              return (
                <TableRow key={inviteCode.id}>
                  <TableCell className='font-mono'>
                    {inviteCode.code_prefix}-••••-••••-••••
                  </TableCell>
                  <TableCell>{inviteCode.name || '—'}</TableCell>
                  <TableCell>
                    <Badge variant={badgeVariant}>{t(state)}</Badge>
                  </TableCell>
                  <TableCell>
                    {inviteCode.used_count} / {inviteCode.max_uses}
                  </TableCell>
                  <TableCell>
                    {inviteCode.expired_time
                      ? dayjs(inviteCode.expired_time * 1000).format(
                          'YYYY-MM-DD HH:mm'
                        )
                      : t('Never')}
                  </TableCell>
                  <TableCell className='text-right'>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => openEditDialog(inviteCode)}
                    >
                      {t('Edit')}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div className='flex items-center justify-between gap-3'>
        <p className='text-muted-foreground text-sm'>
          {t('{{count}} invitation code(s)', { count: total })}
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

      <InviteCodeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        inviteCode={editingInviteCode}
        onSaved={refresh}
      />
    </SettingsSection>
  )
}

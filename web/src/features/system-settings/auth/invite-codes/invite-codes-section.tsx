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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import {
  Copy,
  Link2,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import dayjs from '@/lib/dayjs'

import { deleteInviteCode, getInviteCodes } from './api'
import { InviteCodeDialog } from './invite-code-dialog'
import { buildInviteRegistrationLink } from './invite-code-links'
import { InviteCodeRowActions } from './invite-code-row-actions'
import { getInviteCodeState } from './invite-code-state'
import { InviteCodeUsagesDialog } from './invite-code-usages-dialog'
import type {
  InviteCode,
  InviteCodeExpirationFilter,
  InviteCodeSort,
  InviteCodeStatusFilter,
  InviteCodeUsageFilter,
} from './types'

const pageSize = 20
const route = getRouteApi('/_authenticated/invite-codes/')

type InviteCodeSearchPatch = {
  keyword?: string
  status?: InviteCodeStatusFilter
  usage?: InviteCodeUsageFilter
  expiration?: InviteCodeExpirationFilter
  sort?: InviteCodeSort
}

export function InviteCodesSection() {
  const { t } = useTranslation()
  const { copyToClipboard } = useCopyToClipboard()
  const queryClient = useQueryClient()
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const page = search.page ?? 1
  const keyword = search.keyword ?? ''
  const status = search.status ?? 'all'
  const usage = search.usage ?? 'all'
  const expiration = search.expiration ?? 'all'
  const sort = search.sort ?? 'newest'
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingInviteCode, setEditingInviteCode] = useState<InviteCode>()
  const [usageInviteCode, setUsageInviteCode] = useState<InviteCode>()
  const [deleteInviteCodeTarget, setDeleteInviteCodeTarget] =
    useState<InviteCode>()

  const updateSearch = (patch: InviteCodeSearchPatch) => {
    navigate({
      search: (previous) => ({
        ...previous,
        page: undefined,
        ...patch,
      }),
      replace: true,
    })
  }

  const updatePage = (nextPage: number) => {
    navigate({
      search: (previous) => ({
        ...previous,
        page: nextPage <= 1 ? undefined : nextPage,
      }),
      replace: true,
    })
  }

  const resetFilters = () => {
    navigate({
      search: (previous) => ({
        ...previous,
        page: undefined,
        keyword: undefined,
        status: undefined,
        usage: undefined,
        expiration: undefined,
        sort: undefined,
      }),
      replace: true,
    })
  }

  const hasActiveFilters =
    keyword !== '' ||
    status !== 'all' ||
    usage !== 'all' ||
    expiration !== 'all' ||
    sort !== 'newest'

  const statusItems = [
    { value: 'all', label: t('All Status') },
    { value: 'enabled', label: t('Available') },
    { value: 'disabled', label: t('Disabled') },
    { value: 'exhausted', label: t('Exhausted') },
    { value: 'expired', label: t('Expired') },
  ]
  const usageItems = [
    { value: 'all', label: t('All Usage') },
    { value: 'unused', label: t('Unused') },
    { value: 'used', label: t('Used') },
  ]
  const expirationItems = [
    { value: 'all', label: t('All Expiration') },
    { value: 'never', label: t('Never expires') },
    { value: 'scheduled', label: t('Has Expiration') },
  ]
  const sortItems = [
    { value: 'newest', label: t('Newest First') },
    { value: 'oldest', label: t('Oldest First') },
    { value: 'remaining', label: t('Most Remaining') },
    { value: 'expiring', label: t('Expiring Soon') },
  ]

  const query = useQuery({
    queryKey: [
      'invite-codes',
      page,
      keyword,
      status,
      usage,
      expiration,
      sort,
    ],
    queryFn: () =>
      getInviteCodes({
        page,
        pageSize,
        keyword,
        status,
        usage,
        expiration,
        sort,
      }),
    placeholderData: (previousData) => previousData,
  })
  const inviteCodes = query.data?.data?.items ?? []
  const total = query.data?.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['invite-codes'] })
  }

  const deleteMutation = useMutation({
    mutationFn: deleteInviteCode,
    onSuccess: (response) => {
      if (!response.success) {
        toast.error(response.message || t('Failed to delete invitation code'))
        return
      }
      toast.success(t('Invitation code deleted'))
      setDeleteInviteCodeTarget(undefined)
      if (inviteCodes.length === 1 && page > 1) {
        updatePage(page - 1)
      }
      refresh()
    },
    onError: (error: Error) => {
      toast.error(error.message || t('Failed to delete invitation code'))
    },
  })

  const openCreateDialog = () => {
    setEditingInviteCode(undefined)
    setDialogOpen(true)
  }

  const openEditDialog = (inviteCode: InviteCode) => {
    setEditingInviteCode(inviteCode)
    setDialogOpen(true)
  }

  return (
    <>
      <SectionPageLayout>
        <SectionPageLayout.Title>
          {t('Invitation Codes')}
        </SectionPageLayout.Title>
        <SectionPageLayout.Actions>
          <Button onClick={openCreateDialog} className='gap-2'>
            <Plus aria-hidden='true' className='h-4 w-4' />
            {t('Create Invitation Code')}
          </Button>
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          <div className='space-y-4'>
            <div className='flex flex-col gap-3 xl:flex-row xl:items-center'>
              <div className='relative w-full xl:max-w-sm'>
                <Search
                  aria-hidden='true'
                  className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2'
                />
                <Input
                  aria-label={t('Search by code, name, or ID')}
                  value={keyword}
                  onChange={(event) =>
                    updateSearch({
                      keyword: event.target.value || undefined,
                    })
                  }
                  className='pl-9'
                  placeholder={t('Search by code, name, or ID')}
                />
              </div>

              <div className='flex flex-wrap items-center gap-2'>
                <Select
                  items={statusItems}
                  value={status}
                  onValueChange={(value) =>
                    value !== null &&
                    updateSearch({
                      status:
                        value === 'all'
                          ? undefined
                          : (value as InviteCodeStatusFilter),
                    })
                  }
                >
                  <SelectTrigger
                    className='min-w-32'
                    aria-label={t('Status')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {statusItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Select
                  items={usageItems}
                  value={usage}
                  onValueChange={(value) =>
                    value !== null &&
                    updateSearch({
                      usage:
                        value === 'all'
                          ? undefined
                          : (value as InviteCodeUsageFilter),
                    })
                  }
                >
                  <SelectTrigger
                    className='min-w-28'
                    aria-label={t('Usage')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {usageItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Select
                  items={expirationItems}
                  value={expiration}
                  onValueChange={(value) =>
                    value !== null &&
                    updateSearch({
                      expiration:
                        value === 'all'
                          ? undefined
                          : (value as InviteCodeExpirationFilter),
                    })
                  }
                >
                  <SelectTrigger
                    className='min-w-32'
                    aria-label={t('Expiration Time')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {expirationItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Select
                  items={sortItems}
                  value={sort}
                  onValueChange={(value) =>
                    value !== null &&
                    updateSearch({
                      sort:
                        value === 'newest'
                          ? undefined
                          : (value as InviteCodeSort),
                    })
                  }
                >
                  <SelectTrigger className='min-w-32' aria-label={t('Sort')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {sortItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Button
                  variant='ghost'
                  size='sm'
                  className='gap-2'
                  disabled={!hasActiveFilters}
                  onClick={resetFilters}
                >
                  <RotateCcw aria-hidden='true' className='h-4 w-4' />
                  {t('Reset Filters')}
                </Button>
              </div>
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
                    let badgeVariant: 'default' | 'secondary' | 'warning' =
                      'default'
                    if (state === 'Disabled' || state === 'Exhausted') {
                      badgeVariant = 'secondary'
                    } else if (state === 'Expired') {
                      badgeVariant = 'warning'
                    }
                    return (
                      <TableRow key={inviteCode.id}>
                        <TableCell>
                          <div className='flex items-center gap-1'>
                            <Button
                              variant='ghost'
                              size='sm'
                              className='h-auto gap-2 px-2 py-1 font-mono font-medium'
                              disabled={!inviteCode.code_available}
                              title={
                                inviteCode.code_available
                                  ? t('Click to copy')
                                  : t('Full invitation code unavailable')
                              }
                              onClick={() =>
                                void copyToClipboard(inviteCode.code)
                              }
                            >
                              {inviteCode.code || inviteCode.code_prefix}
                              {inviteCode.code_available ? (
                                <Copy
                                  aria-hidden='true'
                                  className='h-3.5 w-3.5'
                                />
                              ) : null}
                            </Button>
                            <Button
                              variant='ghost'
                              size='icon-sm'
                              disabled={!inviteCode.code_available}
                              aria-label={t('Copy Registration Link')}
                              title={t('Copy Registration Link')}
                              onClick={() =>
                                void copyToClipboard(
                                  buildInviteRegistrationLink(
                                    window.location.origin,
                                    inviteCode.code
                                  )
                                )
                              }
                            >
                              <Link2 aria-hidden='true' />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell>{inviteCode.name || '—'}</TableCell>
                        <TableCell>
                          <Badge variant={badgeVariant}>{t(state)}</Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant='ghost'
                            size='sm'
                            className='gap-1.5 px-2'
                            onClick={() => setUsageInviteCode(inviteCode)}
                            title={t('View usage records')}
                          >
                            <Users aria-hidden='true' className='h-3.5 w-3.5' />
                            {inviteCode.used_count} / {inviteCode.max_uses}
                          </Button>
                        </TableCell>
                        <TableCell>
                          {inviteCode.expired_time
                            ? dayjs(inviteCode.expired_time * 1000).format(
                                'YYYY-MM-DD HH:mm'
                              )
                            : t('Never')}
                        </TableCell>
                        <TableCell className='text-right'>
                          <InviteCodeRowActions
                            inviteCode={inviteCode}
                            onEdit={openEditDialog}
                            onDelete={setDeleteInviteCodeTarget}
                          />
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
                  onClick={() => updatePage(page - 1)}
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
                  onClick={() => updatePage(page + 1)}
                >
                  {t('Next')}
                </Button>
              </div>
            </div>
          </div>
        </SectionPageLayout.Content>
      </SectionPageLayout>

      <InviteCodeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        inviteCode={editingInviteCode}
        onSaved={refresh}
      />
      <InviteCodeUsagesDialog
        open={Boolean(usageInviteCode)}
        onOpenChange={(open) => {
          if (!open) setUsageInviteCode(undefined)
        }}
        inviteCode={usageInviteCode}
      />
      <ConfirmDialog
        open={Boolean(deleteInviteCodeTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteInviteCodeTarget(undefined)
        }}
        title={t('Delete Invitation Code')}
        desc={t(
          'Delete invitation code "{{code}}"? This action cannot be undone.',
          {
            code:
              deleteInviteCodeTarget?.code ||
              deleteInviteCodeTarget?.code_prefix ||
              '',
          }
        )}
        confirmText={t('Delete')}
        destructive
        handleConfirm={() => {
          if (deleteInviteCodeTarget) {
            deleteMutation.mutate(deleteInviteCodeTarget.id)
          }
        }}
        isLoading={deleteMutation.isPending}
      />
    </>
  )
}

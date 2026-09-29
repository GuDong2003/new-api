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
import { type ReactNode, useEffect, useState } from 'react'
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
import { getServerErrorMessage } from '@/lib/server-error-message'

export type PagedRecords<T> = {
  items: T[]
  total: number
}

export type PagedRecordsColumn<T> = {
  id: string
  header: ReactNode
  cell: (record: T) => ReactNode
  className?: string
}

type PagedRecordsDialogProps<T> = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Names whose records these are; another subject's rows never show. */
  queryKey: readonly unknown[]
  enabled: boolean
  /** Loads one page, and throws when the server refuses. */
  fetchPage: (page: number, pageSize: number) => Promise<PagedRecords<T>>
  columns: PagedRecordsColumn<T>[]
  getRowKey: (record: T) => string | number
  emptyText: ReactNode
  totalText: (total: number) => ReactNode
  pageSize?: number
}

/**
 * A dialog that pages through the records of one subject, such as the
 * accounts that used an invitation code or redeemed a redemption code.
 */
export function PagedRecordsDialog<T>(props: PagedRecordsDialogProps<T>) {
  const { t } = useTranslation()
  const pageSize = props.pageSize ?? 20
  const subject = JSON.stringify(props.queryKey)
  const [paging, setPaging] = useState({ subject, page: 1 })
  const page = paging.subject === subject ? paging.page : 1

  useEffect(() => {
    if (!props.open) setPaging({ subject: '', page: 1 })
  }, [props.open])

  const query = useQuery({
    queryKey: [...props.queryKey, page],
    queryFn: () => props.fetchPage(page, pageSize),
    enabled: props.open && props.enabled,
    // Keep the previous page on screen while the next loads, but never the
    // records of another subject.
    placeholderData: (previousData, previousQuery) =>
      previousQuery &&
      JSON.stringify(previousQuery.queryKey.slice(0, -1)) === subject
        ? previousData
        : undefined,
  })
  const records = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const columnCount = props.columns.length

  let status: ReactNode = null
  if (query.isPending && props.enabled) {
    status = (
      <>
        <Loader2 aria-hidden='true' className='mx-auto h-5 w-5 animate-spin' />
        <span className='sr-only'>{t('Loading...')}</span>
      </>
    )
  } else if (query.isError) {
    status = (
      <span className='text-destructive'>
        {getServerErrorMessage(query.error, t('Failed to load'))}
      </span>
    )
  } else if (records.length === 0) {
    status = <span className='text-muted-foreground'>{props.emptyText}</span>
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
      contentClassName='sm:max-w-3xl'
      footer={
        <Button variant='outline' onClick={() => props.onOpenChange(false)}>
          {t('Close')}
        </Button>
      }
    >
      <div className='space-y-3'>
        <div className='rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                {props.columns.map((column) => (
                  <TableHead key={column.id}>{column.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {status ? (
                <TableRow>
                  <TableCell colSpan={columnCount} className='h-24 text-center'>
                    {status}
                  </TableCell>
                </TableRow>
              ) : (
                records.map((record) => (
                  <TableRow key={props.getRowKey(record)}>
                    {props.columns.map((column) => (
                      <TableCell key={column.id} className={column.className}>
                        {column.cell(record)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className='flex items-center justify-between gap-3'>
          <p className='text-muted-foreground text-sm'>
            {props.totalText(total)}
          </p>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={page <= 1 || query.isFetching}
              onClick={() =>
                setPaging({ subject, page: Math.max(1, page - 1) })
              }
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
              onClick={() => setPaging({ subject, page: page + 1 })}
            >
              {t('Next')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

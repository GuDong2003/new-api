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
import { Link } from '@tanstack/react-router'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DataTableBulkActions,
  DataTablePage,
  useDataTable,
} from '@/components/data-table'
import { ErrorState } from '@/components/error-state'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

import { listContentAudits } from '../api'
import {
  contentAuditQueryOptions,
  useContentAuditAccess,
} from '../hooks/use-content-audit-access'
import {
  contentAuditCodeLabel,
  contentAuditErrorMessage,
  formatAuditTime,
} from '../lib/labels'
import {
  defaultContentAuditFilters,
  type ContentAuditFilterValues,
} from '../lib/schema'
import type { ContentAuditFilters, ContentAuditRecord } from '../types'
import { ContentAuditDeleteButton } from './content-audit-delete'
import { ContentAuditFilterBar } from './content-audit-filters'

const emptyRecords: ContentAuditRecord[] = []

export function ContentAuditRecords() {
  const { t } = useTranslation()
  const access = useContentAuditAccess()
  const [initialValues] = useState(defaultContentAuditFilters)
  const [filters, setFilters] = useState<ContentAuditFilters>(() => ({
    start: Math.floor(initialValues.range.start.getTime() / 1000),
    end: Math.floor(initialValues.range.end.getTime() / 1000),
    page: 1,
    page_size: 25,
  }))
  const [selection, setSelection] = useState<RowSelectionState>({})
  const query = useQuery({
    ...contentAuditQueryOptions,
    queryKey: [...access.queryKey, 'records', filters],
    queryFn: ({ signal }) =>
      access.run(
        (requestSignal) => listContentAudits(filters, requestSignal),
        signal
      ),
    refetchInterval: (current) =>
      current.state.data?.items.some(
        (record) => record.status === 'pending' || record.status === 'deleting'
      )
        ? 5000
        : false,
  })
  const columns = useMemo<ColumnDef<ContentAuditRecord, unknown>[]>(
    () => [
      {
        id: 'select',
        size: 40,
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            aria-label={t('Select all')}
            checked={table.getIsAllPageRowsSelected()}
            indeterminate={table.getIsSomePageRowsSelected()}
            onCheckedChange={(checked) =>
              table.toggleAllPageRowsSelected(checked === true)
            }
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={t('Select record {{id}}', { id: row.original.id })}
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onCheckedChange={(checked) => row.toggleSelected(checked === true)}
          />
        ),
      },
      {
        accessorKey: 'created_at',
        header: t('Time'),
        cell: ({ row }) => formatAuditTime(row.original.created_at),
      },
      {
        accessorKey: 'username',
        header: t('User'),
        cell: ({ row }) => (
          <span>
            {row.original.username} (#{row.original.user_id})
          </span>
        ),
      },
      {
        accessorKey: 'channel_name',
        header: t('Channel'),
        cell: ({ row }) => (
          <span>
            {row.original.channel_name} (#{row.original.channel_id})
          </span>
        ),
      },
      { accessorKey: 'model', header: t('Model') },
      { accessorKey: 'request_id', header: t('Request ID') },
      {
        accessorKey: 'kind',
        header: t('Content type'),
        cell: ({ row }) =>
          row.original.kind === 'image' ? t('Image') : t('Text'),
      },
      { accessorKey: 'http_status', header: t('HTTP status') },
      {
        accessorKey: 'integrity',
        header: t('Capture integrity'),
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.integrity === 'partial' ? 'outline' : 'secondary'
            }
          >
            {contentAuditCodeLabel(row.original.integrity, t)}
          </Badge>
        ),
      },
      {
        accessorKey: 'status',
        header: t('Status'),
        cell: ({ row }) => (
          <div>
            <p>{contentAuditCodeLabel(row.original.status, t)}</p>
            {row.original.error_code && (
              <p className='text-destructive text-xs'>
                {contentAuditCodeLabel(row.original.error_code, t)}
              </p>
            )}
          </div>
        ),
      },
      {
        id: 'actions',
        header: t('Details'),
        cell: ({ row }) => (
          <Link
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            to='/content-audit/$id'
            params={{ id: row.original.id }}
            preload={false}
          >
            {t('Details')}
          </Link>
        ),
      },
    ],
    [t]
  )
  const { table } = useDataTable({
    columns,
    data: query.isError ? emptyRecords : (query.data?.items ?? emptyRecords),
    totalCount: query.isError ? 0 : (query.data?.total ?? 0),
    pageCount: Math.min(
      10000,
      Math.ceil((query.data?.total ?? 0) / filters.page_size)
    ),
    getRowId: (record) => record.id,
    enableRowSelection: (row) =>
      row.original.status !== 'pending' && row.original.status !== 'deleting',
    rowSelection: selection,
    onRowSelectionChange: setSelection,
    enableSorting: false,
    manualPagination: true,
    manualFiltering: true,
    columnFilters: [],
    globalFilter: '',
    columnVisibilityStorageKey: false,
    columnSizingStorageKey: false,
    pagination: { pageIndex: filters.page - 1, pageSize: filters.page_size },
    onPaginationChange: (updater) => {
      if (query.isFetching || query.isError) return
      const old = { pageIndex: filters.page - 1, pageSize: filters.page_size }
      const next = typeof updater === 'function' ? updater(old) : updater
      if (next.pageIndex >= 10000 || next.pageSize > 100) return
      setSelection({})
      setFilters((previous) => ({
        ...previous,
        page: next.pageSize === previous.page_size ? next.pageIndex + 1 : 1,
        page_size: next.pageSize,
      }))
    },
  })
  const apply = (values: ContentAuditFilterValues) => {
    if (!values.range.start || !values.range.end) return
    setSelection({})
    const next = {
      start: Math.floor(values.range.start.getTime() / 1000),
      end: Math.floor(values.range.end.getTime() / 1000),
      user_id: values.user_id ? Number(values.user_id) : undefined,
      channel_id: values.channel_id ? Number(values.channel_id) : undefined,
      model: values.model || undefined,
      request_id: values.request_id || undefined,
      kind: values.kind || undefined,
      integrity: values.integrity || undefined,
      http_status: values.http_status ? Number(values.http_status) : undefined,
      page: 1,
      page_size: filters.page_size,
    }
    if (JSON.stringify(next) === JSON.stringify(filters)) void query.refetch()
    else setFilters(next)
  }
  return (
    <div className='flex h-full min-h-0 flex-col gap-3'>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Metadata only. Open a record to load its content. Partial captures and HTTP 200 streams may be incomplete.'
        )}
      </p>
      <DataTablePage
        table={table}
        columns={columns}
        isLoading={query.isPending}
        isFetching={query.isFetching}
        emptyTitle={
          query.isError
            ? t('Content audit unavailable')
            : t('No content audit records')
        }
        className='h-auto min-h-0 flex-1'
        paginationInFooter={false}
        showMobileBulkActions
        mobileProps={{ enableRowSelection: true }}
        toolbar={
          <div className='space-y-3'>
            <ContentAuditFilterBar
              table={table}
              initialValues={initialValues}
              onApply={apply}
              isFetching={query.isFetching}
            />
            {query.isError && (
              <ErrorState
                description={contentAuditErrorMessage(query.error, t)}
                onRetry={() => void query.refetch()}
                className='min-h-24'
              />
            )}
          </div>
        }
        bulkActions={
          <DataTableBulkActions
            table={table}
            placement='inline'
            entityName={t('records')}
          >
            <ContentAuditDeleteButton
              ids={table
                .getFilteredSelectedRowModel()
                .rows.map((row) => row.original.id)}
              disabled={query.isFetching || query.isError}
              onRequested={() => setSelection({})}
            />
          </DataTableBulkActions>
        }
      />
    </div>
  )
}

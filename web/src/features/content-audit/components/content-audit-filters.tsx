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
import { zodResolver } from '@hookform/resolvers/zod'
import type { Table } from '@tanstack/react-table'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { DataTableToolbar } from '@/components/data-table'
import { Combobox } from '@/components/ui/combobox'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { CompactDateTimeRangePicker } from '@/features/usage-logs/components/compact-date-time-range-picker'

import {
  contentAuditFilterSchema,
  defaultContentAuditFilters,
  type ContentAuditFilterValues,
} from '../lib/schema'
import type { ContentAuditRecord } from '../types'

export function ContentAuditFilterBar(props: {
  table: Table<ContentAuditRecord>
  initialValues: ContentAuditFilterValues
  onApply: (values: ContentAuditFilterValues) => void
  isFetching: boolean
}) {
  const { t } = useTranslation()
  const form = useForm<ContentAuditFilterValues>({
    resolver: zodResolver(contentAuditFilterSchema),
    defaultValues: props.initialValues,
  })
  const submit = form.handleSubmit(props.onApply)
  const inputs = [
    { name: 'user_id', label: t('User ID'), numeric: true },
    { name: 'channel_id', label: t('Channel ID'), numeric: true },
    { name: 'model', label: t('Model'), numeric: false },
    { name: 'request_id', label: t('Request ID'), numeric: false },
    { name: 'http_status', label: t('HTTP status'), numeric: true },
  ] as const
  const selects = [
    {
      name: 'kind',
      label: t('Content type'),
      options: [
        { value: '', label: t('All') },
        { value: 'text', label: t('Text') },
        { value: 'image', label: t('Image') },
      ],
    },
    {
      name: 'integrity',
      label: t('Capture integrity'),
      options: [
        { value: '', label: t('All') },
        { value: 'complete', label: t('Complete') },
        { value: 'partial', label: t('Partial') },
      ],
    },
  ] as const
  return (
    <Form {...form}>
      <form onSubmit={submit} noValidate autoComplete='off'>
        <DataTableToolbar
          table={props.table}
          hideViewOptions
          hasAdditionalFilters
          onSearch={() => void submit()}
          searchLoading={props.isFetching}
          onReset={() => {
            const defaults = defaultContentAuditFilters()
            form.reset(defaults)
            props.onApply(defaults)
          }}
          customSearch={
            <FormField
              control={form.control}
              name='range'
              render={({ field }) => (
                <FormItem className='w-full sm:w-96'>
                  <FormLabel>{t('Date Range')}</FormLabel>
                  <FormControl>
                    <div
                      role='group'
                      aria-label={t('Date Range')}
                      tabIndex={-1}
                    >
                      <CompactDateTimeRangePicker
                        start={field.value.start}
                        end={field.value.end}
                        onChange={field.onChange}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          }
          additionalSearch={selects.map((item) => (
            <FormField
              key={item.name}
              control={form.control}
              name={item.name}
              render={({ field }) => (
                <FormItem className='w-full sm:w-40'>
                  <FormLabel>{item.label}</FormLabel>
                  <FormControl>
                    <Combobox
                      options={[...item.options]}
                      value={field.value}
                      onValueChange={(value: string | null) =>
                        field.onChange(value ?? '')
                      }
                      aria-label={item.label}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
          expandable={inputs.map((item) => (
            <FormField
              key={item.name}
              control={form.control}
              name={item.name}
              render={({ field }) => (
                <FormItem className='w-full sm:w-44'>
                  <FormLabel>{item.label}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      inputMode={item.numeric ? 'numeric' : 'text'}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
          hasExpandedActiveFilters={inputs.some((item) =>
            Boolean(form.watch(item.name))
          )}
        />
      </form>
    </Form>
  )
}

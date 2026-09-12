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
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DataTablePagination,
  DataTableView,
  useDataTable,
} from '@/components/data-table'
import { StatusBadge } from '@/components/status-badge'
import { Checkbox } from '@/components/ui/checkbox'
import { TableCell, TableRow } from '@/components/ui/table'

import {
  CHANNEL_PROBES,
  isProbeNotApplicable,
  type ChannelProbeId,
  type ChannelProbeResults,
} from '../../lib/channel-test'
import { ChannelProbeEndpointSelect } from './channel-test-controls'
import { ChannelProbeCell } from './channel-test-result'

type ModelRow = { model: string }

export function ChannelTestMatrix(props: {
  models: string[]
  results: ChannelProbeResults
  selected: RowSelectionState
  onSelectedChange: (
    value:
      | RowSelectionState
      | ((previous: RowSelectionState) => RowSelectionState)
  ) => void
  endpointOverrides: Record<string, string>
  onEndpointChange: (model: string, endpoint: string) => void
  endpointForModel: (model: string) => string
  configurationKey: (model: string, probe: ChannelProbeId) => string
  busy: boolean
  defaultModel?: string
  onRun: (model: string, probe: ChannelProbeId) => void
  onDetails: (
    model: string,
    probe: ChannelProbeId,
    trigger: HTMLElement
  ) => void
  emptyText: string
}) {
  const { t } = useTranslation()
  const data = useMemo(
    () => props.models.map((model) => ({ model })),
    [props.models]
  )
  const columns = useMemo<ColumnDef<ModelRow>[]>(
    () => [
      {
        id: 'model',
        header: ({ table }) => (
          <div className='flex items-center gap-3'>
            <Checkbox
              checked={table.getIsAllPageRowsSelected()}
              indeterminate={
                table.getIsSomePageRowsSelected() &&
                !table.getIsAllPageRowsSelected()
              }
              onCheckedChange={(value) =>
                table.toggleAllPageRowsSelected(Boolean(value))
              }
              aria-label={t('Select this page')}
            />
            <span>{t('Model / test endpoint')}</span>
          </div>
        ),
      },
      ...CHANNEL_PROBES.map<ColumnDef<ModelRow>>((probe) => ({
        id: probe.id,
        header: () => (
          <span className='leading-snug whitespace-normal'>
            {t(probe.labelKey)}
          </span>
        ),
      })),
    ],
    [t]
  )
  const { table } = useDataTable({
    data,
    columns,
    getRowId: (row) => row.model,
    enableSorting: false,
    enableColumnResizing: false,
    rowSelection: props.selected,
    onRowSelectionChange: props.onSelectedChange,
    initialPagination: { pageIndex: 0, pageSize: 30 },
  })
  const rows = table.getRowModel().rows

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3 px-4 pb-3 sm:px-6'>
      <DataTableView
        table={table}
        splitHeader
        colgroup={
          <colgroup>
            <col className='w-[36%]' />
            {CHANNEL_PROBES.map((probe) => (
              <col key={probe.id} className='w-[16%]' />
            ))}
          </colgroup>
        }
        containerProps={{ role: 'region', 'aria-label': t('Channel models') }}
        containerClassName='min-h-0 flex-1 max-md:hidden'
        tableClassName='table-fixed'
        getColumnClassName={(columnId) =>
          columnId === 'model' ? 'min-w-0 pl-4' : 'min-w-0 px-2'
        }
        tableHeaderClassName='bg-muted/60'
        emptyContent={
          <p className='text-muted-foreground p-8 text-center'>
            {props.emptyText}
          </p>
        }
        renderRow={(row) => {
          const model = row.original.model
          return (
            <TableRow
              key={row.id}
              data-state={row.getIsSelected() ? 'selected' : undefined}
            >
              <TableCell className='min-w-0 pl-4'>
                <div className='flex min-w-0 items-start gap-3 py-2'>
                  <Checkbox
                    className='mt-1'
                    checked={row.getIsSelected()}
                    onCheckedChange={(value) =>
                      row.toggleSelected(Boolean(value))
                    }
                    aria-label={t('Select model {{model}}', { model })}
                  />
                  <ChannelModelEndpoint
                    model={model}
                    value={props.endpointOverrides[model] ?? 'inherit'}
                    onChange={(endpoint) =>
                      props.onEndpointChange(model, endpoint)
                    }
                    busy={props.busy}
                    isDefault={model === props.defaultModel}
                  />
                </div>
              </TableCell>
              {CHANNEL_PROBES.map((probe) => {
                const result = props.results[model]?.[probe.id]
                return (
                  <TableCell key={probe.id} className='min-w-0 px-2'>
                    <ChannelProbeCell
                      model={model}
                      probe={probe.id}
                      result={result}
                      stale={Boolean(
                        result &&
                        result.configurationKey !==
                          props.configurationKey(model, probe.id)
                      )}
                      notApplicable={isProbeNotApplicable(
                        props.endpointForModel(model),
                        probe.id
                      )}
                      busy={props.busy}
                      onRun={() => props.onRun(model, probe.id)}
                      onDetails={(trigger) =>
                        props.onDetails(model, probe.id, trigger)
                      }
                    />
                  </TableCell>
                )
              })}
            </TableRow>
          )
        }}
      />
      <div
        data-slot='mobile-channel-model-list'
        className='min-h-0 flex-1 overflow-y-auto md:hidden'
        aria-label={t('Channel models')}
      >
        {rows.length > 0 && (
          <label className='text-muted-foreground mb-3 flex items-center gap-2 text-xs'>
            <Checkbox
              checked={table.getIsAllPageRowsSelected()}
              indeterminate={
                table.getIsSomePageRowsSelected() &&
                !table.getIsAllPageRowsSelected()
              }
              onCheckedChange={(value) =>
                table.toggleAllPageRowsSelected(Boolean(value))
              }
              aria-label={t('Select this page')}
            />
            {t('Select this page')}
          </label>
        )}
        <div className='flex flex-col gap-3'>
          {rows.map((row) => {
            const model = row.original.model
            return (
              <article
                key={row.id}
                data-slot='mobile-channel-model-card'
                className='min-w-0 rounded-lg border'
              >
                <div className='flex items-start gap-3 border-b p-3'>
                  <Checkbox
                    className='mt-1'
                    checked={row.getIsSelected()}
                    onCheckedChange={(value) =>
                      row.toggleSelected(Boolean(value))
                    }
                    aria-label={t('Select model {{model}}', { model })}
                  />
                  <ChannelModelEndpoint
                    model={model}
                    value={props.endpointOverrides[model] ?? 'inherit'}
                    onChange={(endpoint) =>
                      props.onEndpointChange(model, endpoint)
                    }
                    busy={props.busy}
                    isDefault={model === props.defaultModel}
                  />
                </div>
                <div className='grid grid-cols-2 gap-x-2 gap-y-3 p-3'>
                  {CHANNEL_PROBES.map((probe) => {
                    const result = props.results[model]?.[probe.id]
                    return (
                      <div key={probe.id} className='min-w-0'>
                        <p className='text-muted-foreground px-2 text-[11px] font-medium'>
                          {t(probe.labelKey)}
                        </p>
                        <ChannelProbeCell
                          model={model}
                          probe={probe.id}
                          result={result}
                          stale={Boolean(
                            result &&
                            result.configurationKey !==
                              props.configurationKey(model, probe.id)
                          )}
                          notApplicable={isProbeNotApplicable(
                            props.endpointForModel(model),
                            probe.id
                          )}
                          busy={props.busy}
                          onRun={() => props.onRun(model, probe.id)}
                          onDetails={(trigger) =>
                            props.onDetails(model, probe.id, trigger)
                          }
                        />
                      </div>
                    )
                  })}
                </div>
              </article>
            )
          })}
          {rows.length === 0 && (
            <p className='text-muted-foreground rounded-lg border p-8 text-center text-sm'>
              {props.emptyText}
            </p>
          )}
        </div>
      </div>
      <div className='shrink-0'>
        <DataTablePagination table={table} />
      </div>
    </div>
  )
}

function ChannelModelEndpoint(props: {
  model: string
  value: string
  onChange: (endpoint: string) => void
  busy: boolean
  isDefault: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className='min-w-0 flex-1'>
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <span className='min-w-0 font-mono text-sm font-medium break-all'>
          {props.model}
        </span>
        {props.isDefault && (
          <StatusBadge
            label={t('Default')}
            variant='neutral'
            size='sm'
            copyable={false}
          />
        )}
      </div>
      <ChannelProbeEndpointSelect
        value={props.value}
        onChange={props.onChange}
        label={t('Endpoint for {{model}}', { model: props.model })}
        compact
        inherited
        disabled={props.busy}
      />
    </div>
  )
}

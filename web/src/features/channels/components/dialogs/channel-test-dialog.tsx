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
import {
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  Copy01Icon,
  PlayIcon,
  Search01Icon,
  StopIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { RowSelectionState } from '@tanstack/react-table'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

import { updateChannel } from '../../api'
import {
  type ChannelProbeRunPatch,
  useChannelProbes,
} from '../../hooks/use-channel-probes'
import { channelsQueryKeys } from '../../lib/channel-actions'
import {
  CHANNEL_PROBES,
  canDeleteProbeModel,
  getProbeConfigurationKey,
  getProbeEndpointHint,
  isProbeNotApplicable,
  type ChannelProbeId,
  type ChannelProbeJob,
} from '../../lib/channel-test'
import type {
  Channel,
  GetChannelsResponse,
  SearchChannelsResponse,
} from '../../types'
import { useChannels } from '../channels-provider'
import { ChannelTestControls } from './channel-test-controls'
import { ChannelTestMatrix } from './channel-test-matrix'
import { ChannelProbeDetails } from './channel-test-result'

type ChannelTestDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChannelTestDialog(props: ChannelTestDialogProps) {
  const { currentRow } = useChannels()
  // Each opening is a new session. The shared queue still accounts for in-flight
  // requests from the previous opening, but no previous UI result is reused.
  if (!props.open || !currentRow) return null
  return (
    <ChannelTestDialogContent
      key={currentRow.id}
      channel={currentRow}
      onOpenChange={props.onOpenChange}
    />
  )
}

function ChannelTestDialogContent(props: {
  channel: Channel
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { copyToClipboard } = useCopyToClipboard()
  const [selectedProbes, setSelectedProbes] = useState<ChannelProbeId[]>(() =>
    CHANNEL_PROBES.map((probe) => probe.id)
  )
  const [endpoint, setEndpoint] = useState('auto')
  const [endpointOverrides, setEndpointOverrides] = useState<
    Record<string, string>
  >({})
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<RowSelectionState>({})
  const [removed, setRemoved] = useState<Set<string>>(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [detail, setDetail] = useState<{
    model: string
    probe: ChannelProbeId
  } | null>(null)
  const detailTrigger = useRef<HTMLElement | null>(null)

  const refreshChannelLists = useCallback(
    (patch?: ChannelProbeRunPatch) => {
      if (patch) {
        queryClient.setQueriesData<
          GetChannelsResponse | SearchChannelsResponse
        >({ queryKey: channelsQueryKeys.lists() }, (previous) => {
          if (!previous?.data?.items) return previous
          return {
            ...previous,
            data: {
              ...previous.data,
              items: previous.data.items.map((item) =>
                item.id === props.channel.id
                  ? {
                      ...item,
                      response_time: patch.responseTime,
                      test_time: patch.testTime,
                    }
                  : item
              ),
            },
          }
        })
      }
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKeys.lists(),
      })
    },
    [props.channel.id, queryClient]
  )

  const probes = useChannelProbes(props.channel.id, refreshChannelLists)
  const startProbes = probes.start
  const busy = probes.isRunning || deleting

  const models = useMemo(
    () =>
      [
        ...new Set(
          props.channel.models
            .split(',')
            .map((model) => model.trim())
            .filter(Boolean)
        ),
      ].filter((model) => !removed.has(model)),
    [props.channel.models, removed]
  )

  const createJob = useCallback(
    (model: string, probe: ChannelProbeId): ChannelProbeJob => {
      const configuration = {
        model,
        probe,
        endpoint: endpointOverrides[model] ?? endpoint,
        message: message.trim(),
      }
      return {
        ...configuration,
        configurationKey: getProbeConfigurationKey(
          props.channel,
          configuration
        ),
      }
    },
    [endpoint, endpointOverrides, message, props.channel]
  )

  const configurationKey = useCallback(
    (model: string, probe: ChannelProbeId) =>
      createJob(model, probe).configurationKey,
    [createJob]
  )

  const endpointForModel = useCallback(
    (model: string) => {
      for (const probe of CHANNEL_PROBES) {
        const result = probes.results[model]?.[probe.id]
        if (
          result?.diagnostics &&
          result.configurationKey === configurationKey(model, probe.id)
        ) {
          return result.diagnostics.endpoint_type
        }
      }
      return getProbeEndpointHint(
        props.channel,
        model,
        endpointOverrides[model] ?? endpoint
      )
    },
    [
      configurationKey,
      endpoint,
      endpointOverrides,
      probes.results,
      props.channel,
    ]
  )

  const filteredModels = useMemo(
    () =>
      models.filter((model) => {
        if (!model.toLowerCase().includes(search.trim().toLowerCase())) {
          return false
        }
        if (filter === 'all') return true
        const results = CHANNEL_PROBES.map(
          (probe) => probes.results[model]?.[probe.id]
        ).filter((result) => result !== undefined)
        if (filter === 'stale') {
          return results.some(
            (result) =>
              result.configurationKey !== configurationKey(model, result.probe)
          )
        }
        const current = results.filter(
          (result) =>
            result.configurationKey === configurationKey(model, result.probe)
        )
        if (filter === 'idle') return current.length === 0
        return current.some((result) => result.status === filter)
      }),
    [configurationKey, filter, models, probes.results, search]
  )

  const selectedModels = models.filter((model) => selected[model])
  const targetModels =
    selectedModels.length > 0 ? selectedModels : filteredModels
  const jobsForModels = useCallback(
    (scope: string[]) =>
      scope.flatMap((model) =>
        selectedProbes
          .filter(
            (probe) => !isProbeNotApplicable(endpointForModel(model), probe)
          )
          .map((probe) => createJob(model, probe))
      ),
    [createJob, endpointForModel, selectedProbes]
  )
  const targetJobs = jobsForModels(targetModels)
  const retryJobs = targetModels.flatMap((model) =>
    selectedProbes
      .filter((probe) => {
        const result = probes.results[model]?.[probe]
        return (
          result?.status === 'failed' &&
          result.configurationKey === configurationKey(model, probe) &&
          !isProbeNotApplicable(endpointForModel(model), probe)
        )
      })
      .map((probe) => createJob(model, probe))
  )
  const failedModels = models.filter((model) =>
    canDeleteProbeModel(
      probes.results[model],
      endpointForModel(model),
      (probe) => configurationKey(model, probe)
    )
  )
  const successfulModels = models.filter((model) =>
    CHANNEL_PROBES.filter(
      (probe) =>
        probe.testType === 'basic' &&
        !isProbeNotApplicable(endpointForModel(model), probe.id)
    ).every((probe) => {
      const result = probes.results[model]?.[probe.id]
      return (
        result &&
        (result.status === 'passed' || result.status === 'degraded') &&
        result.configurationKey === configurationKey(model, probe.id)
      )
    })
  )
  const filterItems = [
    { value: 'all', label: t('All results') },
    { value: 'idle', label: t('Not tested') },
    { value: 'passed', label: t('Passed') },
    { value: 'failed', label: t('Failed') },
    { value: 'degraded', label: t('Compatibility stream') },
    { value: 'stale', label: t('Settings changed') },
  ]

  const runSingle = useCallback(
    (model: string, probe: ChannelProbeId) => {
      void startProbes([createJob(model, probe)])
    },
    [createJob, startProbes]
  )

  const deleteFailed = async () => {
    if (busy || failedModels.length === 0) return
    setDeleting(true)
    try {
      const failed = new Set(failedModels)
      const response = await updateChannel(props.channel.id, {
        models: models.filter((model) => !failed.has(model)).join(','),
      })
      if (!response.success) {
        toast.error(response.message || t('Failed to delete failed models'))
        return
      }
      setRemoved((previous) => new Set([...previous, ...failed]))
      setSelected((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([model]) => !failed.has(model))
        )
      )
      setConfirmDelete(false)
      toast.success(
        t('Deleted {{count}} failed models', { count: failed.size })
      )
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKeys.lists(),
      })
    } catch (error: unknown) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('Failed to delete failed models')
      )
    } finally {
      setDeleting(false)
    }
  }

  const detailResult = detail
    ? probes.results[detail.model]?.[detail.probe]
    : undefined
  const detailStale = Boolean(
    detail &&
      detailResult &&
      detailResult.configurationKey !==
        configurationKey(detail.model, detail.probe)
  )
  const progress = probes.progress
  const finished = progress.completed + progress.cancelled
  const summary = t(
    '{{passed}} passed · {{failed}} failed · {{degraded}} compatibility',
    {
      passed: progress.passed,
      failed: progress.failed,
      degraded: progress.degraded,
    }
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) probes.close()
        props.onOpenChange(open)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className='flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-none md:h-[min(860px,90dvh)] md:max-h-[90dvh] md:w-[calc(100vw-3rem)] md:max-w-[1280px] md:rounded-xl'
      >
        <DialogHeader className='shrink-0 px-4 pt-5 pr-14 pb-4 sm:px-6 sm:pr-16'>
          <DialogTitle className='flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-lg'>
            <span>{t('Test Channel Connection')}</span>
            <span className='text-muted-foreground' aria-hidden='true'>
              ·
            </span>
            <span className='min-w-0 truncate'>{props.channel.name}</span>
          </DialogTitle>
          <DialogDescription>
            {t(
              'Compare model responses, streaming and tool calls in one place.'
            )}
          </DialogDescription>
          <DialogClose
            render={
              <Button
                variant='ghost'
                size='icon-sm'
                className='absolute top-4 right-4'
                aria-label={t('Close')}
              />
            }
          >
            <HugeiconsIcon icon={Cancel01Icon} aria-hidden='true' />
          </DialogClose>
        </DialogHeader>
        <ChannelTestControls
          selected={selectedProbes}
          onSelectedChange={setSelectedProbes}
          endpoint={endpoint}
          onEndpointChange={setEndpoint}
          message={message}
          onMessageChange={setMessage}
          disabled={busy}
        />
        <div className='flex shrink-0 flex-wrap items-center gap-2 px-4 py-3 sm:px-6'>
          <div className='relative min-w-36 flex-1 sm:max-w-sm'>
            <HugeiconsIcon
              icon={Search01Icon}
              className='text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2'
              aria-hidden='true'
            />
            <Input
              className='pl-9'
              aria-label={t('Filter models...')}
              placeholder={t('Filter models...')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select
            items={filterItems}
            value={filter}
            onValueChange={(value) => {
              if (value) setFilter(value)
            }}
          >
            <SelectTrigger
              className='w-40 max-sm:w-32'
              aria-label={t('Filter test results')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {filterItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className='text-muted-foreground ml-auto flex items-center gap-2 text-xs'>
            <span className='tabular-nums'>
              {t('{{count}} models selected', { count: selectedModels.length })}
            </span>
            {selectedModels.length > 0 && (
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label={t('Copy selected models')}
                onClick={() => void copyToClipboard(selectedModels.join(','))}
              >
                <HugeiconsIcon icon={Copy01Icon} aria-hidden='true' />
              </Button>
            )}
            {selectedModels.length > 0 && (
              <Button variant='ghost' size='sm' onClick={() => setSelected({})}>
                {t('Clear selection')}
              </Button>
            )}
          </div>
        </div>
        <ChannelTestMatrix
          models={filteredModels}
          results={probes.results}
          selected={selected}
          onSelectedChange={setSelected}
          endpointOverrides={endpointOverrides}
          onEndpointChange={(model, value) =>
            setEndpointOverrides((previous) => {
              const next = { ...previous }
              if (value === 'inherit') delete next[model]
              else next[model] = value
              return next
            })
          }
          endpointForModel={endpointForModel}
          configurationKey={configurationKey}
          busy={busy}
          defaultModel={props.channel.test_model ?? undefined}
          onRun={runSingle}
          onDetails={(model, probe, trigger) => {
            detailTrigger.current = trigger
            setDetail({ model, probe })
          }}
          emptyText={
            models.length === 0
              ? t('This channel has no configured models.')
              : t('No models matched your search.')
          }
        />
        <DialogFooter className='bg-muted/25 mx-0 mb-0 shrink-0 flex-col gap-3 rounded-none px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:px-6'>
          <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
            <div
              className='mr-auto min-w-0 flex-1 text-xs'
              role='status'
              aria-live='polite'
            >
              {progress.total > 0 ? (
                <div className='flex flex-col gap-1.5'>
                  <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                    <span className='font-medium tabular-nums'>
                      {t('{{completed}}/{{total}} completed', {
                        completed: progress.completed,
                        total: progress.total,
                      })}
                    </span>
                    <span className='text-muted-foreground'>{summary}</span>
                    {progress.cancelled > 0 && (
                      <span className='text-muted-foreground'>
                        {t('{{count}} stopped', { count: progress.cancelled })}
                      </span>
                    )}
                  </div>
                  <progress
                    aria-label={t('Test progress')}
                    value={finished}
                    max={progress.total}
                    className='[&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary h-1 w-full overflow-hidden rounded-full'
                  />
                </div>
              ) : (
                <span className='text-muted-foreground'>
                  {t('Select capabilities and models, then start testing.')}
                </span>
              )}
            </div>
            <span className='text-muted-foreground text-xs tabular-nums'>
              {t('Estimated requests: {{count}}', { count: targetJobs.length })}
            </span>
          </div>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='flex flex-wrap gap-1'>
              {successfulModels.length > 0 && (
                <Button
                  variant='ghost'
                  size='sm'
                  disabled={busy}
                  onClick={() =>
                    setSelected(
                      Object.fromEntries(
                        successfulModels.map((model) => [model, true])
                      )
                    )
                  }
                >
                  {t('Select successful models ({{count}})', {
                    count: successfulModels.length,
                  })}
                </Button>
              )}
              {failedModels.length > 0 && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-destructive'
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  {t('Delete failed models ({{count}})', {
                    count: failedModels.length,
                  })}
                </Button>
              )}
            </div>
            <div className='flex flex-wrap items-center justify-end gap-2 max-sm:w-full'>
              {probes.isRunning ? (
                <Button
                  variant='outline'
                  onClick={probes.stop}
                  disabled={probes.isStopping}
                >
                  <HugeiconsIcon icon={StopIcon} aria-hidden='true' />
                  {probes.isStopping
                    ? t('Finishing active tests...')
                    : t('Stop testing')}
                </Button>
              ) : (
                <>
                  {selectedModels.length > 0 && (
                    <Button
                      variant='ghost'
                      size='sm'
                      disabled={
                        busy || jobsForModels(filteredModels).length === 0
                      }
                      onClick={() =>
                        void probes.start(jobsForModels(filteredModels))
                      }
                    >
                      {t('Test filtered models ({{count}})', {
                        count: filteredModels.length,
                      })}
                    </Button>
                  )}
                  <Button
                    variant='outline'
                    disabled={busy || retryJobs.length === 0}
                    onClick={() => void probes.start(retryJobs)}
                  >
                    <HugeiconsIcon
                      icon={ArrowReloadHorizontalIcon}
                      aria-hidden='true'
                    />
                    {t('Retest failures')}
                  </Button>
                  <Button
                    disabled={busy || targetJobs.length === 0}
                    onClick={() => void probes.start(targetJobs)}
                  >
                    <HugeiconsIcon icon={PlayIcon} aria-hidden='true' />
                    {selectedModels.length > 0
                      ? t('Test selected ({{count}})', {
                          count: selectedModels.length,
                        })
                      : t('Start testing')}
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
      <ChannelProbeDetails
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
        model={detail?.model ?? ''}
        probe={detail?.probe ?? 'basic'}
        result={detailResult}
        stale={detailStale}
        busy={busy}
        onRetry={() => {
          if (detail) runSingle(detail.model, detail.probe)
        }}
        returnFocus={detailTrigger}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('Delete failed models')}
        desc={t(
          'Delete {{count}} models whose applicable basic tests all failed? Tool failures and compatibility streams are excluded.',
          { count: failedModels.length }
        )}
        confirmText={t('Delete')}
        handleConfirm={() => void deleteFailed()}
        destructive
        isLoading={deleting}
        disabled={busy || failedModels.length === 0}
      />
    </Dialog>
  )
}

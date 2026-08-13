/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Flame,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import {
  getChannelQueueConfig,
  getChannelQueueStatus,
  listChannelQueueWarmupLogs,
  removeChannelQueueConfig,
  runChannelQueueWarmup,
  updateChannelQueueConfig,
} from './api'
import type {
  ChannelQueueConfig,
  ChannelQueueSettings,
  ChannelQueueStatus,
  QueueWarmupTask,
} from './types'

const DEFAULT_BUSY_CODES = [429, 503]

function makeQueueDraft(item: ChannelQueueConfig): ChannelQueueSettings {
  const queue = item.queue
  return {
    enabled: queue?.enabled ?? false,
    model: queue?.model ?? item.models[0] ?? '',
    interval: queue?.interval || 30,
    endpoint_type: queue?.endpoint_type ?? '',
    warmup_message: queue?.warmup_message ?? 'hi',
    max_tokens: queue?.max_tokens || 16,
    timeout: queue?.timeout || 25,
    circuit_breaker_enabled: queue?.circuit_breaker_enabled ?? true,
    max_consecutive_failures: queue?.max_consecutive_failures || 10,
    cooldown_seconds: queue?.cooldown_seconds || 300,
    max_queue_attempts: queue?.max_queue_attempts || 3,
    backoff_seconds: queue?.backoff_seconds || 5,
    queue_busy_status_codes: queue?.queue_busy_status_codes?.length
      ? queue.queue_busy_status_codes
      : DEFAULT_BUSY_CODES,
  }
}

function formatEpoch(seconds?: number) {
  if (!seconds) return '-'
  return new Date(seconds * 1000).toLocaleString()
}

function parseBusyStatusCodes(value: string) {
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599)
}

function statusLabel(
  status: ChannelQueueStatus | undefined,
  t: (key: string) => string
) {
  if (!status?.enabled) return t('Disabled')
  if (!status.channel_enabled) return t('Channel disabled')
  if (status.warming) return t('Warming')
  if (status.breaker_active) return t('Circuit breaker active')
  if (status.last_result === 'ok') return t('Ready')
  return t('Waiting')
}

type QueueChannelCardProps = {
  item: ChannelQueueConfig
  status?: ChannelQueueStatus
  onSave: (channelId: number, queue: ChannelQueueSettings) => Promise<void>
  onRemove: (channelId: number) => Promise<void>
  saving: boolean
  removing: boolean
}

function QueueChannelCard(props: QueueChannelCardProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() => makeQueueDraft(props.item))
  const [busyCodeInput, setBusyCodeInput] = useState(() =>
    (props.item.queue?.queue_busy_status_codes ?? DEFAULT_BUSY_CODES).join(', ')
  )
  const queueSignature = JSON.stringify(props.item.queue)

  useEffect(() => {
    const nextDraft = makeQueueDraft(props.item)
    setDraft(nextDraft)
    setBusyCodeInput((nextDraft.queue_busy_status_codes ?? []).join(', '))
  }, [props.item, props.item.channel_id, queueSignature])

  const status = props.status ?? props.item.status
  const update = (patch: Partial<ChannelQueueSettings>) => {
    setDraft((previous) => ({ ...previous, ...patch }))
  }

  return (
    <Card className='min-w-0'>
      <CardHeader className='border-b'>
        <div className='flex items-start justify-between gap-3'>
          <div className='flex min-w-0 items-start gap-2'>
            <span
              className={cn(
                'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
                status?.warming
                  ? 'bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              <Flame
                className={cn('size-4', status?.warming && 'animate-pulse')}
                aria-hidden='true'
              />
            </span>
            <div className='min-w-0'>
              <CardTitle className='truncate text-sm'>
                {props.item.channel_name}
              </CardTitle>
              <CardDescription className='mt-1 truncate text-xs'>
                #{props.item.channel_id} ·{' '}
                {status?.model || draft.model || t('No model selected')}
              </CardDescription>
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-1'>
            <Button
              type='button'
              variant='ghost'
              size='icon-sm'
              onClick={() => void props.onRemove(props.item.channel_id)}
              disabled={props.removing}
              title={t('Remove')}
              aria-label={t('Remove')}
            >
              <Trash2 className='size-4' />
            </Button>
            <Badge
              variant={status?.warming ? 'default' : 'outline'}
              className={cn(
                'shrink-0',
                status?.warming && 'bg-orange-500 hover:bg-orange-500'
              )}
            >
              {statusLabel(status, t)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='bg-muted/20 flex items-center justify-between rounded-lg border px-3 py-2'>
          <div>
            <div className='text-sm font-medium'>
              {t('Enable queue warmer')}
            </div>
            <div className='text-muted-foreground text-xs'>
              {t('Warm this channel in the background without billing users.')}
            </div>
          </div>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
            aria-label={t('Enable queue warmer')}
          />
        </div>

        <div className='grid gap-3 sm:grid-cols-2'>
          <label className='space-y-1.5 text-xs'>
            <span className='text-muted-foreground'>{t('Warm-up model')}</span>
            <select
              className='border-input bg-background h-8 w-full rounded-lg border px-2 text-sm outline-none'
              value={draft.model}
              onChange={(event) => update({ model: event.target.value })}
            >
              <option value=''>{t('Select a model')}</option>
              {props.item.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label className='space-y-1.5 text-xs'>
            <span className='text-muted-foreground'>{t('Endpoint')}</span>
            <select
              className='border-input bg-background h-8 w-full rounded-lg border px-2 text-sm outline-none'
              value={draft.endpoint_type}
              onChange={(event) =>
                update({ endpoint_type: event.target.value })
              }
            >
              <option value=''>{t('Automatic')}</option>
              <option value='openai'>{t('Chat Completions')}</option>
              <option value='openai-response'>{t('Responses')}</option>
              <option value='openai-response-compact'>
                {t('Responses compact')}
              </option>
              <option value='anthropic'>{t('Anthropic Messages')}</option>
              <option value='gemini'>{t('Gemini Generate Content')}</option>
              <option value='embeddings'>{t('Embeddings')}</option>
              <option value='image-generation'>{t('Image generation')}</option>
              <option value='jina-rerank'>{t('Rerank')}</option>
            </select>
          </label>
        </div>

        <label className='block space-y-1.5 text-xs'>
          <span className='text-muted-foreground'>{t('Warm-up message')}</span>
          <Textarea
            value={draft.warmup_message}
            onChange={(event) => update({ warmup_message: event.target.value })}
            rows={2}
            className='min-h-16 resize-y text-sm'
          />
        </label>

        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          <NumberField
            label={t('Interval (seconds)')}
            value={draft.interval}
            onChange={(value) => update({ interval: value })}
          />
          <NumberField
            label={t('Timeout (seconds)')}
            value={draft.timeout}
            onChange={(value) => update({ timeout: value })}
          />
          <NumberField
            label={t('Max output tokens')}
            value={draft.max_tokens ?? 16}
            onChange={(value) => update({ max_tokens: value })}
          />
          <NumberField
            label={t('Retry attempts')}
            value={draft.max_queue_attempts}
            onChange={(value) => update({ max_queue_attempts: value })}
          />
        </div>

        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          <NumberField
            label={t('Backoff (seconds)')}
            value={draft.backoff_seconds}
            onChange={(value) => update({ backoff_seconds: value })}
          />
          <NumberField
            label={t('Max failures')}
            value={draft.max_consecutive_failures}
            onChange={(value) => update({ max_consecutive_failures: value })}
          />
          <NumberField
            label={t('Cooldown (seconds)')}
            value={draft.cooldown_seconds}
            onChange={(value) => update({ cooldown_seconds: value })}
          />
          <label className='space-y-1.5 text-xs'>
            <span className='text-muted-foreground'>
              {t('Busy status codes')}
            </span>
            <Input
              value={busyCodeInput}
              onChange={(event) => {
                setBusyCodeInput(event.target.value)
              }}
              placeholder='429, 503'
              className='h-8 text-sm'
            />
          </label>
        </div>

        <div className='flex items-center justify-between gap-3 border-t pt-3'>
          <label className='text-muted-foreground inline-flex items-center gap-2 text-xs'>
            <Switch
              checked={draft.circuit_breaker_enabled}
              onCheckedChange={(circuit_breaker_enabled) =>
                update({ circuit_breaker_enabled })
              }
              size='sm'
            />
            {t('Enable circuit breaker')}
          </label>
          <Button
            type='button'
            size='sm'
            onClick={() =>
              void props.onSave(props.item.channel_id, {
                ...draft,
                queue_busy_status_codes: parseBusyStatusCodes(busyCodeInput),
              })
            }
            disabled={props.saving}
          >
            <Save data-icon='inline-start' />
            {props.saving ? t('Saving...') : t('Save')}
          </Button>
        </div>

        <div className='text-muted-foreground grid gap-1 text-xs sm:grid-cols-3'>
          <span>
            {t('Last warm-up')}: {formatEpoch(status?.last_warm_at)}
          </span>
          <span>
            {t('Last status')}: {status?.last_status_code || '-'}
          </span>
          <span>
            {t('Failures')}: {status?.consecutive_failures ?? 0}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function NumberField(props: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className='space-y-1.5 text-xs'>
      <span className='text-muted-foreground'>{props.label}</span>
      <Input
        type='number'
        min={0}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className='h-8 text-sm'
      />
    </label>
  )
}

function QueueLogsTable({ logs }: { logs: QueueWarmupTask[] }) {
  const { t } = useTranslation()
  return (
    <div className='overflow-x-auto rounded-lg border'>
      <Table className='min-w-[760px]'>
        <TableHeader>
          <TableRow className='bg-muted/40 hover:bg-muted/40'>
            <TableHead>{t('Time')}</TableHead>
            <TableHead>{t('Status')}</TableHead>
            <TableHead>{t('Trigger')}</TableHead>
            <TableHead>{t('Summary')}</TableHead>
            <TableHead>{t('Error')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((log) => {
            const result = log.result
            const summary = result
              ? `${result.succeeded ?? 0} ${t('succeeded')} · ${result.queue_busy ?? 0} ${t('queue busy')} · ${result.failed ?? 0} ${t('failed')}`
              : '-'
            const trigger =
              typeof log.payload?.trigger === 'string'
                ? log.payload.trigger
                : '-'
            return (
              <TableRow key={log.task_id}>
                <TableCell className='text-xs whitespace-nowrap'>
                  {formatEpoch(log.updated_at)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      log.status === 'failed' ? 'destructive' : 'outline'
                    }
                  >
                    {t(log.status)}
                  </Badge>
                </TableCell>
                <TableCell className='text-muted-foreground text-xs'>
                  {trigger}
                </TableCell>
                <TableCell className='text-xs'>{summary}</TableCell>
                <TableCell
                  className='text-destructive max-w-[260px] truncate text-xs'
                  title={log.error || undefined}
                >
                  {log.error || '-'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

export function ChannelQueuePage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [channelToAdd, setChannelToAdd] = useState('')
  const configQuery = useQuery({
    queryKey: ['channel-queue', 'config'],
    queryFn: getChannelQueueConfig,
    retry: false,
  })
  const statusQuery = useQuery({
    queryKey: ['channel-queue', 'status'],
    queryFn: getChannelQueueStatus,
    retry: false,
    refetchInterval: 8000,
  })
  const logsQuery = useQuery({
    queryKey: ['channel-queue', 'logs'],
    queryFn: () => listChannelQueueWarmupLogs(20),
    retry: false,
    refetchInterval: 15000,
  })

  const invalidateQueueData = () => {
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['channel-queue', 'config'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['channel-queue', 'status'],
      }),
    ])
  }

  const saveMutation = useMutation({
    mutationFn: ({
      channelId,
      queue,
    }: {
      channelId: number
      queue: ChannelQueueSettings
    }) => updateChannelQueueConfig(channelId, queue),
    onSuccess: () => {
      toast.success(t('Queue settings saved'))
      invalidateQueueData()
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : t('Save failed')),
  })
  const addMutation = useMutation({
    mutationFn: (item: ChannelQueueConfig) =>
      updateChannelQueueConfig(item.channel_id, makeQueueDraft(item)),
    onSuccess: () => {
      setChannelToAdd('')
      toast.success(t('Queue channel added'))
      invalidateQueueData()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : t('Unable to add queue channel')
      ),
  })
  const removeMutation = useMutation({
    mutationFn: removeChannelQueueConfig,
    onSuccess: () => {
      toast.success(t('Queue channel removed'))
      invalidateQueueData()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : t('Unable to remove queue channel')
      ),
  })
  const runMutation = useMutation({
    mutationFn: runChannelQueueWarmup,
    onSuccess: (data) => {
      toast.success(
        data?.created
          ? t('Queue warm-up started')
          : t('A queue warm-up is already running')
      )
      void Promise.all([statusQuery.refetch(), logsQuery.refetch()])
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : t('Run failed')),
  })

  const statusMap = useMemo(
    () =>
      new Map(
        (statusQuery.data ?? []).map((status) => [status.channel_id, status])
      ),
    [statusQuery.data]
  )
  const allChannels = configQuery.data ?? []
  const selectedChannels = allChannels.filter((item) => item.queue != null)
  const availableChannels = allChannels.filter((item) => item.queue == null)
  const selectedChannel = availableChannels.find(
    (item) => String(item.channel_id) === channelToAdd
  )
  const enabledCount = selectedChannels.filter(
    (item) => item.queue?.enabled
  ).length
  const savingChannelId = saveMutation.variables?.channelId
  const removingChannelId = removeMutation.variables

  const refresh = () => {
    void Promise.all([
      configQuery.refetch(),
      statusQuery.refetch(),
      logsQuery.refetch(),
    ])
  }

  let channelContent: ReactNode
  if (configQuery.isLoading) {
    channelContent = (
      <div className='grid gap-4 xl:grid-cols-2'>
        {['one', 'two', 'three', 'four'].map((key) => (
          <Skeleton key={key} className='h-[520px] rounded-xl' />
        ))}
      </div>
    )
  } else if (configQuery.isError) {
    channelContent = (
      <Card>
        <CardContent className='text-destructive py-10 text-center text-sm'>
          {configQuery.error instanceof Error
            ? configQuery.error.message
            : t('Unable to load queue settings')}
        </CardContent>
      </Card>
    )
  } else if (selectedChannels.length === 0) {
    channelContent = (
      <Card>
        <CardContent className='text-muted-foreground py-10 text-center text-sm'>
          {t('No queue channels added')}
        </CardContent>
      </Card>
    )
  } else {
    channelContent = (
      <div className='grid gap-4 xl:grid-cols-2'>
        {selectedChannels.map((item) => (
          <QueueChannelCard
            key={item.channel_id}
            item={item}
            status={statusMap.get(item.channel_id)}
            onSave={async (channelId, queue) => {
              await saveMutation.mutateAsync({ channelId, queue })
            }}
            saving={
              savingChannelId === item.channel_id && saveMutation.isPending
            }
            onRemove={async (channelId) => {
              await removeMutation.mutateAsync(channelId)
            }}
            removing={
              removingChannelId === item.channel_id && removeMutation.isPending
            }
          />
        ))}
      </div>
    )
  }

  let logsContent: ReactNode
  if (logsQuery.isLoading) {
    logsContent = <Skeleton className='h-32 w-full' />
  } else if (logsQuery.isError) {
    logsContent = (
      <p className='text-destructive text-sm'>
        {logsQuery.error instanceof Error
          ? logsQuery.error.message
          : t('Unable to load queue logs')}
      </p>
    )
  } else if (logsQuery.data && logsQuery.data.length > 0) {
    logsContent = <QueueLogsTable logs={logsQuery.data} />
  } else {
    logsContent = (
      <p className='text-muted-foreground py-8 text-center text-sm'>
        {t('No queue warm-up logs yet')}
      </p>
    )
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='flex min-w-0 items-center gap-2'>
          <Flame className='size-4 text-orange-500' aria-hidden='true' />
          <span className='truncate'>{t('Queue')}</span>
          <Badge variant='outline' className='shrink-0'>
            {enabledCount}
          </Badge>
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={refresh}
          disabled={configQuery.isFetching || statusQuery.isFetching}
        >
          <RefreshCw
            data-icon='inline-start'
            className={cn('size-3.5', configQuery.isFetching && 'animate-spin')}
          />
          {t('Refresh')}
        </Button>
        <Button
          type='button'
          size='sm'
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending || enabledCount === 0}
        >
          <Play data-icon='inline-start' />
          {runMutation.isPending ? t('Starting...') : t('Run now')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='space-y-4'>
          <Card>
            <CardContent className='flex flex-wrap items-center justify-between gap-3 py-3'>
              <div className='min-w-0'>
                <div className='text-sm font-medium'>{t('Queue channels')}</div>
                <div className='text-muted-foreground text-xs'>
                  {t('Enabled channels')}: {enabledCount} ·{' '}
                  {t('Status refresh')}: 8s
                </div>
              </div>
              <div className='flex min-w-0 items-center gap-2'>
                <select
                  className='border-input bg-background h-8 max-w-[min(60vw,20rem)] min-w-48 rounded-lg border px-2 text-sm outline-none'
                  value={channelToAdd}
                  onChange={(event) => setChannelToAdd(event.target.value)}
                  disabled={
                    availableChannels.length === 0 || addMutation.isPending
                  }
                  aria-label={t('Select a channel')}
                >
                  <option value=''>
                    {availableChannels.length > 0
                      ? t('Select a channel')
                      : t('All channels added')}
                  </option>
                  {availableChannels.map((item) => (
                    <option key={item.channel_id} value={item.channel_id}>
                      #{item.channel_id} · {item.channel_name}
                    </option>
                  ))}
                </select>
                <Button
                  type='button'
                  size='sm'
                  onClick={() => {
                    if (selectedChannel) addMutation.mutate(selectedChannel)
                  }}
                  disabled={!selectedChannel || addMutation.isPending}
                >
                  <Plus data-icon='inline-start' />
                  {t('Add')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {channelContent}

          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-sm'>
                <Settings2 className='size-4' aria-hidden='true' />
                {t('Queue warm-up logs')}
              </CardTitle>
            </CardHeader>
            <CardContent>{logsContent}</CardContent>
          </Card>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

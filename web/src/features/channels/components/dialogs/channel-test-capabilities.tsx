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
  AlertCircleIcon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  PlayIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import {
  CHANNEL_PROBES,
  CHANNEL_PROBE_BY_ID,
  CHANNEL_PROBE_REASONS,
  CHANNEL_PROBE_STATUS_LABELS,
  CHANNEL_TEST_ENDPOINTS,
  isProbeNotApplicable,
  type ChannelProbeId,
  type ChannelProbeResult,
  type ChannelProbeStatus,
} from '../../lib/channel-test'
import { ChannelProbeResponsePreview } from './channel-test-preview'

const STATUS_VARIANTS = {
  idle: 'neutral',
  queued: 'neutral',
  running: 'info',
  passed: 'success',
  failed: 'danger',
  degraded: 'warning',
  skipped: 'neutral',
  cancelled: 'neutral',
} as const

/** Short glyph per probe, so four capabilities fit one table cell. */
const PROBE_GLYPHS: Record<ChannelProbeId, string> = {
  basic: 'J',
  stream: 'S',
  tool: 'TJ',
  'tool-stream': 'TS',
}

export function ChannelProbeStatusLabel(props: {
  status: ChannelProbeStatus | 'idle'
}) {
  const { t } = useTranslation()
  return (
    <StatusBadge
      className='whitespace-normal [&>span]:overflow-visible [&>span]:text-clip [&>span]:whitespace-normal'
      copyable={false}
      label={t(CHANNEL_PROBE_STATUS_LABELS[props.status])}
      type='text'
      variant={STATUS_VARIANTS[props.status]}
    />
  )
}

function ProbeStatusIcon(props: { status: ChannelProbeStatus | 'idle' }) {
  if (props.status === 'running') {
    return (
      <Spinner
        aria-hidden='true'
        className='size-3 motion-reduce:animate-none'
      />
    )
  }
  if (props.status === 'passed') {
    return (
      <HugeiconsIcon
        aria-hidden='true'
        className='text-success size-3'
        icon={Tick02Icon}
      />
    )
  }
  if (props.status === 'failed' || props.status === 'degraded') {
    return (
      <HugeiconsIcon
        aria-hidden='true'
        className={cn(
          'size-3',
          props.status === 'failed' ? 'text-destructive' : 'text-warning'
        )}
        icon={AlertCircleIcon}
      />
    )
  }
  return null
}

/**
 * The four capability probes for one model, compact enough to sit beside the
 * existing quick-test columns. Clicking a probe runs it, or opens its result.
 */
export function ChannelCapabilitiesCell(props: {
  model: string
  endpoint: string
  results?: Partial<Record<ChannelProbeId, ChannelProbeResult>>
  configurationKey: (probe: ChannelProbeId) => string
  busy: boolean
  onRun: (probe: ChannelProbeId) => void
  onDetails: (probe: ChannelProbeId, trigger: HTMLElement) => void
}) {
  const { t } = useTranslation()

  return (
    <div className='flex flex-wrap items-center gap-1'>
      {CHANNEL_PROBES.map((probe) => {
        const result = props.results?.[probe.id]
        const notApplicable = isProbeNotApplicable(props.endpoint, probe.id)
        const status = result?.status ?? (notApplicable ? 'skipped' : 'idle')
        const stale = Boolean(
          result && result.configurationKey !== props.configurationKey(probe.id)
        )
        const interactive = Boolean(result) || (!notApplicable && !props.busy)

        return (
          <Tooltip key={probe.id}>
            <TooltipTrigger
              render={
                <button
                  aria-label={t('{{model}} · {{test}}: {{status}}', {
                    model: props.model,
                    test: t(probe.labelKey),
                    status: t(CHANNEL_PROBE_STATUS_LABELS[status]),
                  })}
                  className={cn(
                    'focus-visible:ring-ring flex min-w-11 items-center justify-center gap-1 rounded-md border px-1.5 py-1 font-mono text-[11px] leading-none outline-none transition-colors enabled:hover:bg-muted/60 focus-visible:ring-2 disabled:cursor-default',
                    status === 'passed' && 'border-success/40',
                    status === 'failed' && 'border-destructive/40',
                    status === 'degraded' && 'border-warning/40',
                    (status === 'idle' || status === 'skipped') &&
                      'text-muted-foreground border-dashed',
                    stale && 'opacity-60'
                  )}
                  disabled={!interactive}
                  onClick={(event) =>
                    result
                      ? props.onDetails(probe.id, event.currentTarget)
                      : props.onRun(probe.id)
                  }
                  type='button'
                />
              }
            >
              <ProbeStatusIcon status={status} />
              {PROBE_GLYPHS[probe.id]}
            </TooltipTrigger>
            <TooltipContent>
              <p>{t(probe.labelKey)}</p>
              <p className='text-muted-foreground'>
                {t(CHANNEL_PROBE_STATUS_LABELS[status])}
                {stale ? ` · ${t('Settings changed')}` : ''}
              </p>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

export function ChannelProbeDetails(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  model: string
  probe: ChannelProbeId
  result?: ChannelProbeResult
  stale: boolean
  busy: boolean
  onRetry: () => void
  returnFocus: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const spec = CHANNEL_PROBE_BY_ID[props.probe]
  const result = props.result
  const diagnostic = result?.diagnostics
  const status = result?.status ?? 'idle'
  const reason = diagnostic?.reason ?? result?.errorCode ?? 'request_failed'
  const reasonLabel = CHANNEL_PROBE_REASONS[reason]
  const endpoint = CHANNEL_TEST_ENDPOINTS.find(
    (item) => item.value === diagnostic?.endpoint_type
  )
  const endpointPath = diagnostic?.endpoint_path || endpoint?.path

  let upstreamResponse = '—'
  if (diagnostic?.upstream_stream !== undefined) {
    upstreamResponse = diagnostic.upstream_stream ? 'SSE' : 'JSON'
  }

  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent
        className='w-full sm:max-w-lg'
        finalFocus={props.returnFocus}
        showCloseButton={false}
      >
        <SheetHeader className='border-b pr-14'>
          <SheetTitle>{t('Test details')}</SheetTitle>
          <SheetDescription className='font-mono break-all'>
            {props.model}
          </SheetDescription>
          <SheetClose
            render={
              <Button
                aria-label={t('Close test details')}
                className='absolute top-3 right-3'
                size='icon-sm'
                variant='ghost'
              />
            }
          >
            <HugeiconsIcon aria-hidden='true' icon={Cancel01Icon} />
          </SheetClose>
        </SheetHeader>

        <div className='flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4'>
          <div className='flex items-center justify-between gap-3'>
            <span className='font-medium'>{t(spec.labelKey)}</span>
            <ChannelProbeStatusLabel status={status} />
          </div>

          {props.stale && (
            <p
              className='border-warning/30 bg-warning/5 rounded-lg border p-3 text-sm'
              role='status'
            >
              {t(
                'These results used earlier settings. Run this test again to check the current configuration.'
              )}
            </p>
          )}

          {diagnostic || result?.errorCode === 'diagnostics_unavailable' ? (
            <p className='text-sm leading-relaxed'>
              {reasonLabel ? t(reasonLabel) : result?.error}
            </p>
          ) : null}

          <dl className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm'>
            <dt className='text-muted-foreground'>{t('Endpoint Type')}</dt>
            <dd className='text-right'>
              {endpoint ? t(endpoint.labelKey) : t('Auto detect (default)')}
            </dd>
            <dt className='text-muted-foreground'>{t('Total time')}</dt>
            <dd className='text-right font-mono'>
              {diagnostic
                ? t('{{duration}} ms', {
                    duration: diagnostic.duration_ms.toLocaleString(),
                  })
                : '—'}
            </dd>
            <dt className='text-muted-foreground'>{t('First response')}</dt>
            <dd className='text-right font-mono'>
              {diagnostic?.first_response_ms !== undefined
                ? t('{{duration}} ms', {
                    duration: diagnostic.first_response_ms.toLocaleString(),
                  })
                : '—'}
            </dd>
            {spec.stream && (
              <>
                <dt className='text-muted-foreground'>
                  {t('Upstream response')}
                </dt>
                <dd className='text-right'>{upstreamResponse}</dd>
                <dt className='text-muted-foreground'>{t('Stream events')}</dt>
                <dd className='text-right font-mono'>
                  {diagnostic?.event_count ?? '—'}
                </dd>
              </>
            )}
            {spec.testType === 'tool_call' && (
              <>
                <dt className='text-muted-foreground'>{t('Tool calls')}</dt>
                <dd className='text-right font-mono'>
                  {diagnostic?.tool_count ?? '—'}
                </dd>
                <dt className='text-muted-foreground'>{t('Tool name')}</dt>
                <dd className='text-right'>
                  {diagnostic?.tool_name_valid === undefined
                    ? '—'
                    : t(diagnostic.tool_name_valid ? 'Passed' : 'Failed')}
                </dd>
                <dt className='text-muted-foreground'>{t('Tool arguments')}</dt>
                <dd className='text-right'>
                  {diagnostic?.tool_arguments_valid === undefined
                    ? '—'
                    : t(diagnostic.tool_arguments_valid ? 'Passed' : 'Failed')}
                </dd>
              </>
            )}
          </dl>

          {endpointPath && (
            <code className='bg-muted/50 rounded-lg p-3 text-xs break-all'>
              {endpointPath}
            </code>
          )}

          {result?.error && (
            <div className='flex flex-col gap-2'>
              <p className='text-muted-foreground text-xs font-medium'>
                {t('Error details')}
              </p>
              <pre className='border-destructive/20 bg-destructive/5 rounded-lg border p-3 text-xs break-words whitespace-pre-wrap'>
                {result.error}
              </pre>
            </div>
          )}

          {result?.errorCode === 'model_price_error' && (
            <Button
              onClick={() =>
                window.open(
                  '/system-settings/billing/model-pricing',
                  '_blank',
                  'noopener,noreferrer'
                )
              }
              variant='outline'
            >
              {t('Go to Settings')}
            </Button>
          )}

          {result?.preview ? (
            <ChannelProbeResponsePreview
              endpoint={diagnostic?.endpoint_type ?? result.endpoint}
              key={result.configurationKey}
              model={props.model}
              response={result.preview}
            />
          ) : (
            <p className='text-muted-foreground text-xs'>
              {t(
                'No response preview is available. Preview visibility follows the channel test settings.'
              )}
            </p>
          )}
        </div>

        <SheetFooter className='border-t'>
          <Button
            disabled={props.busy || status === 'skipped'}
            onClick={props.onRetry}
          >
            <HugeiconsIcon
              aria-hidden='true'
              icon={result ? ArrowReloadHorizontalIcon : PlayIcon}
            />
            {t('Retest this capability')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

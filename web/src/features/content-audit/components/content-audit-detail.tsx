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
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CodeBlockFrame } from '@/components/ai-elements/code-block'
import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { getContentAuditDetail, getContentAuditImages } from '../api'
import {
  contentAuditQueryOptions,
  useContentAuditAccess,
} from '../hooks/use-content-audit-access'
import { useContentAuditExpiry } from '../hooks/use-content-audit-expiry'
import {
  contentAuditCodeLabel,
  contentAuditErrorMessage,
  formatAuditBytes,
  formatAuditTime,
} from '../lib/labels'
import type { ContentAuditDetail } from '../types'
import { ContentAuditDeleteButton } from './content-audit-delete'
import { ContentAuditOriginal } from './content-audit-original'

type ContentAuditDetailProps = {
  id: string
  onClose: () => void
}

export function ContentAuditDetailDialog(props: ContentAuditDetailProps) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <ContentAuditDetailContent
      key={props.id}
      id={props.id}
      onClose={() => {
        setDismissed(true)
        props.onClose()
      }}
    />
  )
}

function ContentAuditDetailContent(props: ContentAuditDetailProps) {
  const { t } = useTranslation()
  const access = useContentAuditAccess()
  const client = useQueryClient()
  const recordKey = useMemo(
    () => [...access.queryKey, 'record', props.id],
    [access.queryKey, props.id]
  )
  const [expired, setExpired] = useState(false)
  const query = useQuery({
    ...contentAuditQueryOptions,
    queryKey: [...recordKey, 'detail'],
    queryFn: ({ signal }) =>
      access.run(
        (requestSignal) => getContentAuditDetail(props.id, requestSignal),
        signal
      ),
    enabled: !expired,
  })
  const expiresAt = query.data?.record.expires_at
  useContentAuditExpiry(expiresAt, () => {
    setExpired(true)
    void client.cancelQueries({ queryKey: recordKey })
    client.removeQueries({ queryKey: recordKey })
  })
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: recordKey })
      client.removeQueries({ queryKey: recordKey })
    },
    [client, recordKey]
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Content audit details')}
      description={t(
        'Redacted protocol content is shown as inert text. Auxiliary image addresses are not download links.'
      )}
      contentClassName='sm:max-w-5xl'
      footer={
        <>
          <Button variant='outline' onClick={props.onClose}>
            {t('Close')}
          </Button>
          <ContentAuditDeleteButton
            ids={[props.id]}
            onRequested={props.onClose}
            disabled={
              query.isPending ||
              query.isError ||
              expired ||
              query.data?.record.status === 'deleting'
            }
          />
        </>
      }
    >
      {expired && (
        <ErrorState
          description={t(
            'This content audit record has expired and is no longer readable.'
          )}
        />
      )}
      {!expired && query.isPending && <LoadingState />}
      {!expired && query.isError && (
        <ErrorState
          description={contentAuditErrorMessage(query.error, t)}
          onRetry={() => void query.refetch()}
        />
      )}
      {!expired && !query.isError && query.data && (
        <ContentAuditPayload key={props.id} detail={query.data} />
      )}
    </Dialog>
  )
}

function ContentAuditPayload(props: { detail: ContentAuditDetail }) {
  const { t } = useTranslation()
  const record = props.detail.record
  const payload = props.detail.payload
  const request = useMemo(
    () => JSON.stringify(payload.request, null, 2) ?? '',
    [payload.request]
  )
  const response = useMemo(
    () => JSON.stringify(payload.response, null, 2) ?? '',
    [payload.response]
  )
  const facts = [
    [t('Record ID'), record.id],
    [t('Request ID'), record.request_id],
    [t('Upstream request ID'), record.upstream_request_id],
    [t('User'), `${record.username} (#${record.user_id})`],
    [t('Channel'), `${record.channel_name} (#${record.channel_id})`],
    [t('Model'), record.model],
    [t('Group'), record.group],
    [t('Protocol'), record.protocol],
    [t('Path'), record.path],
    [t('HTTP status'), record.http_status],
    [t('Duration (ms)'), record.duration_ms],
    [t('Retries'), record.retry_count],
    [
      t('Completion reason'),
      contentAuditCodeLabel(record.completion_reason, t),
    ],
    [t('Streaming'), record.is_stream ? t('Yes') : t('No')],
    [t('Created At'), formatAuditTime(record.created_at)],
    [t('Expires At'), formatAuditTime(record.expires_at)],
    [
      t('Request saved / observed'),
      `${formatAuditBytes(record.request_saved)} / ${formatAuditBytes(record.request_observed)}`,
    ],
    [
      t('Response saved / observed'),
      `${formatAuditBytes(record.response_saved)} / ${formatAuditBytes(record.response_observed)}`,
    ],
    [t('Omitted images'), record.omitted_images],
    [
      t('Format / redaction version'),
      `${record.format_version} / ${record.redaction_version}`,
    ],
    [t('Encryption mode'), record.mode],
    [t('Key fingerprint'), record.key_id || '—'],
  ]
  const blocks = [
    { label: t('Request content'), value: request },
    { label: t('Response content'), value: response },
  ]
  if (payload.response_text) {
    blocks.push({
      label: t('Response text view'),
      value: payload.response_text,
    })
  }
  return (
    <div className='min-w-0 space-y-4'>
      <div className='flex flex-wrap gap-2'>
        <Badge variant='secondary'>
          {contentAuditCodeLabel(record.status, t)}
        </Badge>
        <Badge variant='outline'>
          {contentAuditCodeLabel(record.integrity, t)}
        </Badge>
      </div>
      {(record.integrity === 'partial' ||
        record.request_truncated ||
        record.response_truncated ||
        payload.text_view_truncated ||
        record.completion_reason !== 'completed') && (
        <Alert>
          <AlertDescription className='space-y-1'>
            <p>
              {t(
                'This capture may be incomplete. HTTP success does not guarantee a complete stream.'
              )}
            </p>
            {record.request_truncated && (
              <p>{t('Request content was truncated')}</p>
            )}
            {record.response_truncated && (
              <p>{t('Response content was truncated')}</p>
            )}
            {payload.text_view_truncated && (
              <p>
                {t(
                  'Response text view was truncated; inspect the protocol response for available structure.'
                )}
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}
      {record.error_code && (
        <Alert variant='destructive'>
          <AlertDescription>
            {contentAuditCodeLabel(record.error_code, t)}
          </AlertDescription>
        </Alert>
      )}
      <dl className='grid min-w-0 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3'>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className='text-muted-foreground'>{label}</dt>
            <dd className='break-all'>{value === '' ? '—' : value}</dd>
          </div>
        ))}
      </dl>
      {blocks.map((block) => (
        <CodeBlockFrame
          key={block.label}
          showToolbar
          title={block.label}
          endActions={
            <CopyButton
              value={block.value}
              aria-label={t('Copy {{label}}', { label: block.label })}
            />
          }
          bodyClassName='max-h-96'
        >
          <pre
            aria-label={block.label}
            tabIndex={0}
            className='min-w-0 p-3 font-mono text-xs break-words whitespace-pre-wrap'
          >
            <code>{block.value}</code>
          </pre>
        </CodeBlockFrame>
      ))}
      {(payload.image_total > 0 || (payload.images?.length ?? 0) > 0) && (
        <ContentAuditImages detail={props.detail} />
      )}
    </div>
  )
}

function ContentAuditImages(props: { detail: ContentAuditDetail }) {
  const { t } = useTranslation()
  const access = useContentAuditAccess()
  const [cursors, setCursors] = useState([-1])
  const after = cursors.at(-1) ?? -1
  const query = useQuery({
    ...contentAuditQueryOptions,
    queryKey: [
      ...access.queryKey,
      'record',
      props.detail.record.id,
      'images',
      after,
    ],
    queryFn: ({ signal }) =>
      access.run(
        (requestSignal) =>
          getContentAuditImages(props.detail.record.id, after, requestSignal),
        signal
      ),
    enabled: after !== -1,
  })
  const payload = props.detail.payload
  const page =
    after === -1
      ? {
          items: payload.images ?? [],
          next_after: payload.image_next_after ?? null,
          total: payload.image_total ?? payload.images?.length ?? 0,
        }
      : query.data
  const next = page?.next_after
  return (
    <section aria-label={t('Audit images')} className='flex flex-col gap-3'>
      <h3 className='text-sm font-medium'>{t('Audit images')}</h3>
      {after !== -1 && query.isPending && <LoadingState />}
      {after !== -1 && query.isError && (
        <ErrorState
          description={contentAuditErrorMessage(query.error, t)}
          onRetry={() => void query.refetch()}
        />
      )}
      {page && !query.isError && (
        <ContentAuditOriginal
          key={after}
          recordId={props.detail.record.id}
          images={page.items}
        />
      )}
      <nav
        aria-label={t('Image pages')}
        className='flex flex-wrap items-center gap-2'
      >
        <Button
          variant='outline'
          size='sm'
          disabled={cursors.length === 1}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          {t('Previous images')}
        </Button>
        <span role='status' className='text-muted-foreground text-sm'>
          {t('Image page {{page}} · {{total}} images', {
            page: cursors.length,
            total: page?.total ?? payload.image_total,
          })}
        </span>
        <Button
          variant='outline'
          size='sm'
          disabled={next == null || query.isError}
          onClick={() => {
            if (next != null) setCursors((current) => [...current, next])
          }}
        >
          {t('Next images')}
        </Button>
      </nav>
    </section>
  )
}

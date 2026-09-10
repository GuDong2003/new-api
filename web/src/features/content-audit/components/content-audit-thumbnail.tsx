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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'

import { getContentAuditThumbnail } from '../api'
import {
  contentAuditQueryOptions,
  useContentAuditAccess,
} from '../hooks/use-content-audit-access'
import { contentAuditCodeLabel, contentAuditErrorMessage } from '../lib/labels'
import type { ContentAuditImage } from '../types'

export function ContentAuditThumbnail(props: {
  recordId: string
  image: ContentAuditImage
  onView: () => void
  onDownload: () => void
}) {
  const { t } = useTranslation()
  const access = useContentAuditAccess()
  const image = props.image
  const query = useQuery({
    ...contentAuditQueryOptions,
    queryKey: [
      ...access.queryKey,
      'record',
      props.recordId,
      'thumbnail',
      image.index,
    ],
    queryFn: ({ signal }) =>
      access.run(
        (requestSignal) =>
          getContentAuditThumbnail(props.recordId, image.index, requestSignal),
        signal
      ),
    enabled:
      image.status === 'ready' &&
      Number.isInteger(image.index) &&
      image.index >= 0,
  })
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(
    null
  )
  const [failedBlob, setFailedBlob] = useState<Blob | null>(null)
  const blob = query.isError ? undefined : query.data
  useEffect(() => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setPreview({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])
  const url =
    blob && blob !== failedBlob && preview?.blob === blob
      ? preview.url
      : undefined
  return (
    <figure className='min-w-0 space-y-2 rounded-lg border p-3'>
      {image.status !== 'ready' && (
        <p>{contentAuditCodeLabel(image.status, t)}</p>
      )}
      {image.status === 'ready' && query.isPending && (
        <LoadingState size='sm' />
      )}
      {url && (
        <img
          src={url}
          alt={t('Audit thumbnail {{index}}', { index: image.index + 1 })}
          className='max-h-80 max-w-full object-contain'
          onError={() => {
            URL.revokeObjectURL(url)
            setFailedBlob(blob ?? null)
          }}
        />
      )}
      {(query.isError || (blob && failedBlob === blob)) && (
        <div role='alert' className='space-y-2 text-sm'>
          <p>
            {query.isError
              ? contentAuditErrorMessage(query.error, t)
              : t('Thumbnail unavailable')}
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => void query.refetch()}
          >
            {t('Retry')}
          </Button>
        </div>
      )}
      <figcaption className='text-muted-foreground space-y-1 text-xs break-all'>
        <p>{t('Image {{index}}', { index: image.index + 1 })}</p>
        {image.width && image.height && (
          <p>
            {image.width} × {image.height}
          </p>
        )}
        {image.address && <p>{image.address}</p>}
      </figcaption>
      {image.original_status === 'ready' ? (
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' size='sm' onClick={props.onView}>
            {t('View original')}
          </Button>
          <Button variant='outline' size='sm' onClick={props.onDownload}>
            {t('Download original')}
          </Button>
        </div>
      ) : (
        <p className='text-muted-foreground text-xs'>
          {image.original_status === 'not_saved' || !image.original_status
            ? t('Original not saved')
            : t('Original unavailable: {{reason}}', {
                reason: contentAuditCodeLabel(image.original_status, t),
              })}
        </p>
      )}
    </figure>
  )
}

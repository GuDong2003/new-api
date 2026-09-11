/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'

import { useGalleryFile } from '../hooks/use-gallery-file'
import type { GalleryIdentity, GalleryImage } from '../types'

export function GalleryPreview(props: {
  image: GalleryImage
  identity: GalleryIdentity
  onClose: () => void
}) {
  const { t } = useTranslation()
  const file = useGalleryFile(props.identity, props.image.id, false, true, {
    blob: props.image.localBlob,
    only: props.image.localOnly,
  })
  const extension = props.image.mime_type.split('/')[1] || 'image'
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Image details')}
      description={t('Private original image and generation metadata')}
      contentClassName='sm:max-w-4xl'
      footer={
        file.url && (
          <Button
            role='link'
            render={
              <a href={file.url} download={`${props.image.id}.${extension}`} />
            }
          >
            {t('Download original')}
          </Button>
        )
      }
    >
      <div className='flex min-w-0 flex-col gap-4'>
        {file.isError ? (
          <ErrorState onRetry={() => void file.refetch()} />
        ) : null}
        {!file.url && !file.isError ? <LoadingState /> : null}
        {file.url ? (
          <img
            src={file.url}
            alt={props.image.prompt}
            className='max-h-[60vh] w-full object-contain'
          />
        ) : null}
        <dl className='grid min-w-0 gap-2 text-sm sm:grid-cols-[auto_1fr]'>
          <dt>{t('Prompt')}</dt>
          <dd className='[overflow-wrap:anywhere] whitespace-pre-wrap'>
            {props.image.prompt}
          </dd>
          <dt>{t('Negative prompt')}</dt>
          <dd className='[overflow-wrap:anywhere] whitespace-pre-wrap'>
            {props.image.negative_prompt || '—'}
          </dd>
          <dt>{t('Model')}</dt>
          <dd className='[overflow-wrap:anywhere]'>{props.image.model}</dd>
          <dt>{t('Source')}</dt>
          <dd>
            {props.image.source === 'nai' ? t('NAI Canvas') : t('Drawing')}
          </dd>
          <dt>{t('Image size')}</dt>
          <dd>
            {props.image.width} × {props.image.height}
          </dd>
          <dt>{t('Original size')}</dt>
          <dd>
            {(props.image.bytes / 1048576).toFixed(2)} MiB ·{' '}
            {props.image.mime_type}
          </dd>
          <dt>{t('Created at')}</dt>
          <dd>{new Date(props.image.created_at * 1000).toLocaleString()}</dd>
          <dt>{t('Expires at')}</dt>
          <dd>
            {props.image.expires_at
              ? new Date(props.image.expires_at * 1000).toLocaleString()
              : t('Local draft')}
          </dd>
        </dl>
        <h3 className='text-sm font-medium'>{t('Generation parameters')}</h3>
        <dl className='grid min-w-0 gap-2 text-sm sm:grid-cols-[auto_1fr]'>
          {Object.entries(props.image.parameters).map(([key, value]) => (
            <div key={key} className='contents'>
              <dt className='[overflow-wrap:anywhere]'>{key}</dt>
              <dd className='[overflow-wrap:anywhere]'>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Dialog>
  )
}

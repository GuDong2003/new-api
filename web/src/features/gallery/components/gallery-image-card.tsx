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

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import { useGalleryFile } from '../hooks/use-gallery-file'
import type { GalleryIdentity, GalleryImage } from '../types'

export function GalleryImageCard(props: {
  image: GalleryImage
  identity: GalleryIdentity
  onPreview: () => void
  onDelete: () => void
  onOpenCanvas?: () => void
}) {
  const { t } = useTranslation()
  const file = useGalleryFile(
    props.identity,
    props.image.id,
    true,
    props.image.has_thumbnail && !props.image.localBlob
  )
  const original = useGalleryFile(
    props.identity,
    props.image.id,
    false,
    Boolean(props.image.localBlob) ||
      !props.image.has_thumbnail ||
      file.isError,
    { blob: props.image.localBlob, only: props.image.localOnly }
  )
  const imageUrl = file.url ?? original.url
  return (
    <article className='flex min-w-0 flex-col gap-3'>
      <Button
        variant='ghost'
        className='h-auto w-full overflow-hidden p-0'
        onClick={props.onPreview}
        aria-label={t('Preview original')}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={props.image.prompt}
            loading='lazy'
            className='aspect-square w-full rounded-md object-contain'
          />
        ) : (
          <div className='bg-muted flex aspect-square w-full items-center justify-center rounded-md p-4 text-sm'>
            {props.image.has_thumbnail && file.isPending ? (
              <Skeleton className='size-full' />
            ) : (
              t('Thumbnail unavailable')
            )}
          </div>
        )}
      </Button>
      <div className='flex min-w-0 flex-col gap-1 text-sm'>
        <p className='line-clamp-2 break-words'>{props.image.prompt}</p>
        <p className='text-muted-foreground truncate'>
          {props.image.model} · {props.image.width} × {props.image.height}
        </p>
        <p className='text-muted-foreground'>
          {props.image.source === 'nai' ? t('NAI Canvas') : t('Drawing')}
        </p>
        {props.onOpenCanvas ? (
          <Button
            variant='link'
            className='h-auto justify-start p-0 text-xs'
            onClick={props.onOpenCanvas}
          >
            {t('Open source canvas')}
          </Button>
        ) : null}
        <p className='text-muted-foreground text-xs'>
          {props.image.localOnly || !props.image.expires_at
            ? t('Local draft')
            : t('Expires: {{date}}', {
                date: new Date(props.image.expires_at * 1000).toLocaleString(),
              })}
        </p>
      </div>
      <Button variant='outline' onClick={props.onDelete}>
        {t('Delete')}
      </Button>
    </article>
  )
}

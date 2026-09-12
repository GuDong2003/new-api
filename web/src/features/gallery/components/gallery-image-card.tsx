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
import { Delete02Icon, FolderOpenIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
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
  const expiry =
    props.image.localOnly || !props.image.expires_at
      ? t('Local draft')
      : t('Expires: {{date}}', {
          date: new Date(props.image.expires_at * 1000).toLocaleDateString(),
        })
  return (
    <article className='flex min-w-0 flex-col gap-1.5'>
      <Button
        variant='ghost'
        className='bg-muted/40 h-auto w-full overflow-hidden rounded-md p-0'
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
          <div className='bg-muted flex aspect-square w-full items-center justify-center rounded-md p-2 text-xs'>
            {props.image.has_thumbnail && file.isPending ? (
              <Skeleton className='size-full' />
            ) : (
              t('Thumbnail unavailable')
            )}
          </div>
        )}
      </Button>
      <div className='flex min-w-0 items-start gap-1'>
        <div className='min-w-0 flex-1 text-xs'>
          <p className='line-clamp-2 break-words' title={props.image.prompt}>
            {props.image.prompt}
          </p>
          <p className='text-muted-foreground truncate'>
            {props.image.width} × {props.image.height} ·{' '}
            {props.image.source === 'nai' ? t('NAI Canvas') : t('Drawing')}
          </p>
          <p className='text-muted-foreground truncate'>{expiry}</p>
        </div>
        <div className='flex shrink-0'>
          {props.onOpenCanvas ? (
            <Button
              size='icon-xs'
              variant='ghost'
              onClick={props.onOpenCanvas}
              aria-label={t('Open source canvas')}
            >
              <HugeiconsIcon
                icon={FolderOpenIcon}
                size={14}
                aria-hidden='true'
              />
            </Button>
          ) : null}
          <Button
            size='icon-xs'
            variant='ghost'
            onClick={props.onDelete}
            aria-label={t('Delete')}
          >
            <HugeiconsIcon icon={Delete02Icon} size={14} aria-hidden='true' />
          </Button>
        </div>
      </div>
    </article>
  )
}

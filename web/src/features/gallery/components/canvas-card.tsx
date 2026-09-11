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
import { Delete02Icon, PencilEdit01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import { useGalleryFile } from '../hooks/use-gallery-file'
import type { GalleryIdentity } from '../types'

export type CanvasProjectView = {
  id: string
  kind: 'drawing' | 'nai'
  name: string
  revision: number
  state: 'ready' | 'deleted' | 'expired'
  updatedAt: number
  expiresAt: number
  coverAssetIds: string[]
  coverBlobs?: Record<string, Blob>
  localOnly?: boolean
  status?: 'local' | 'pending' | 'synced' | 'full' | 'conflict' | 'error'
}

export function CanvasCard(props: {
  project: CanvasProjectView
  identity: GalleryIdentity
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const project = props.project
  const status = {
    conflict: t('Cloud conflict'),
    error: t('Cloud save failed'),
    local: t('Local draft'),
    pending: t('Local draft'),
    full: t('Local draft'),
    synced: t('Synced'),
  }[project.status ?? 'synced']
  const type = project.kind === 'nai' ? t('NAI Canvas') : t('Drawing')
  const updated = project.updatedAt
    ? new Date(project.updatedAt * 1000).toLocaleString()
    : t('Not synced')
  return (
    <article className='bg-background flex min-w-0 flex-col overflow-hidden rounded-xl border'>
      <Button
        variant='ghost'
        className='h-44 w-full rounded-none p-0'
        onClick={props.onOpen}
        aria-label={t('Open canvas: {{name}}', { name: project.name })}
      >
        <div className='bg-muted flex size-full items-center justify-center p-4'>
          {project.coverAssetIds.length ? (
            <div className='grid w-full max-w-xs grid-cols-2 gap-2'>
              {project.coverAssetIds.slice(0, 4).map((id) => (
                <CanvasCover
                  key={id}
                  identity={props.identity}
                  id={id}
                  blob={project.coverBlobs?.[id]}
                  localOnly={project.localOnly}
                />
              ))}
            </div>
          ) : (
            <span className='text-muted-foreground text-sm'>
              {t('Empty canvas')}
            </span>
          )}
        </div>
      </Button>
      <div className='flex min-w-0 flex-col gap-2 p-4'>
        <div className='flex min-w-0 items-start justify-between gap-2'>
          <h3 className='min-w-0 truncate font-medium' title={project.name}>
            {project.name}
          </h3>
          <div className='flex shrink-0 gap-1'>
            <Button
              size='icon-sm'
              variant='ghost'
              onClick={props.onRename}
              aria-label={t('Rename canvas')}
            >
              <HugeiconsIcon
                icon={PencilEdit01Icon}
                size={16}
                aria-hidden='true'
              />
            </Button>
            <Button
              size='icon-sm'
              variant='ghost'
              onClick={props.onDelete}
              aria-label={t('Delete canvas')}
            >
              <HugeiconsIcon icon={Delete02Icon} size={16} aria-hidden='true' />
            </Button>
          </div>
        </div>
        <p className='text-muted-foreground truncate text-xs'>
          {type} · {updated}
        </p>
        <p className='text-muted-foreground text-xs'>{status}</p>
      </div>
    </article>
  )
}

function CanvasCover(props: {
  identity: GalleryIdentity
  id: string
  blob?: Blob
  localOnly?: boolean
}) {
  const { t } = useTranslation()
  const file = useGalleryFile(
    props.identity,
    props.id,
    true,
    !props.blob && !props.localOnly
  )
  const original = useGalleryFile(
    props.identity,
    props.id,
    false,
    Boolean(props.blob) || file.isError || Boolean(props.localOnly),
    { blob: props.blob, only: props.localOnly }
  )
  const url = file.url ?? original.url
  return url ? (
    <img
      src={url}
      alt=''
      className='bg-background aspect-video w-full rounded-md border object-contain'
    />
  ) : (
    <div
      className='bg-background aspect-video rounded-md border'
      aria-label={t('Canvas cover')}
    />
  )
}

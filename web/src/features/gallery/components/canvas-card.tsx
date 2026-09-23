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
import { Skeleton } from '@/components/ui/skeleton'
import { useInView } from '@/hooks/use-in-view'
import { cn } from '@/lib/utils'

import { useGalleryImage } from '../hooks/use-gallery-image'
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
  /** Covers for a canvas this browser holds, which the server has no preview of. */
  coverAssets?: Record<string, { blob: Blob; sha256: string }>
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
  const covers = project.coverAssetIds.slice(0, 4)
  const updated = project.updatedAt
    ? new Date(project.updatedAt * 1000).toLocaleString()
    : t('Not synced')
  return (
    <article className='bg-background flex h-full min-w-0 flex-col overflow-hidden rounded-xl border'>
      <Button
        variant='ghost'
        className='h-auto min-h-0 w-full flex-1 rounded-none p-0'
        onClick={props.onOpen}
        aria-label={t('Open canvas: {{name}}', { name: project.name })}
      >
        <div className='bg-muted flex size-full items-center justify-center p-1.5'>
          {covers.length ? (
            <div
              className={cn(
                'grid size-full gap-1.5',
                covers.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
                covers.length > 2 && 'grid-rows-2'
              )}
            >
              {covers.map((id, index) => (
                <CanvasCover
                  key={id}
                  // Three covers read best as one tall image beside a stack.
                  className={
                    covers.length === 3 && index === 0
                      ? 'row-span-2'
                      : undefined
                  }
                  identity={props.identity}
                  id={id}
                  local={
                    project.localOnly ? project.coverAssets?.[id] : undefined
                  }
                  localOnly={project.localOnly}
                />
              ))}
            </div>
          ) : (
            <span className='text-muted-foreground text-xs'>
              {t('Empty canvas')}
            </span>
          )}
        </div>
      </Button>
      <div className='flex min-w-0 shrink-0 flex-col gap-0.5 p-3'>
        <div className='flex min-w-0 items-center justify-between gap-1'>
          <h3
            className='min-w-0 truncate text-sm font-medium'
            title={project.name}
          >
            {project.name}
          </h3>
          <div className='flex shrink-0'>
            <Button
              size='icon-xs'
              variant='ghost'
              onClick={props.onRename}
              aria-label={t('Rename canvas')}
            >
              <HugeiconsIcon
                icon={PencilEdit01Icon}
                size={14}
                aria-hidden='true'
              />
            </Button>
            <Button
              size='icon-xs'
              variant='ghost'
              onClick={props.onDelete}
              aria-label={t('Delete canvas')}
            >
              <HugeiconsIcon icon={Delete02Icon} size={14} aria-hidden='true' />
            </Button>
          </div>
        </div>
        <p className='text-muted-foreground truncate text-xs'>
          {type} · {updated}
        </p>
        <p className='text-muted-foreground truncate text-xs'>{status}</p>
      </div>
    </article>
  )
}

function CanvasCover(props: {
  identity: GalleryIdentity
  id: string
  local?: { blob: Blob; sha256: string }
  localOnly?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  // Four covers a canvas, and a page holds more canvases than fit on screen.
  const view = useInView<HTMLElement>()
  // A draft the server has never seen is only ever shown from what is in hand.
  const file = useGalleryImage(props.identity, props.id, {
    enabled: view.inView && (Boolean(props.local) || !props.localOnly),
    preview: true,
    blob: props.local?.blob,
    sha256: props.local?.sha256,
    only: props.localOnly,
  })
  const url = file.url
  const loading = file.isPending
  return url ? (
    <img
      ref={view.ref}
      src={url}
      alt=''
      className={cn(
        'bg-background size-full rounded-md border object-cover',
        props.className
      )}
    />
  ) : (
    <div
      ref={view.ref}
      className={cn(
        'bg-background relative size-full rounded-md border',
        props.className
      )}
      aria-label={t('Canvas cover')}
    >
      {loading ? <Skeleton className='absolute inset-0 size-full' /> : null}
    </div>
  )
}

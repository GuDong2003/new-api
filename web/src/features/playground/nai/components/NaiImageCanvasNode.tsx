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
import {
  ArrowReloadHorizontalIcon,
  Delete02Icon,
  Download04Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useCanvasNodeDeletionRequest } from '@/features/gallery/components/canvas-node-deletion'
import { cn } from '@/lib/utils'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { imageAssetToFile, downloadBlob } from '../../drawing/lib/image-assets'
import { useNaiImageGeneration } from '../hooks/use-nai-image-generation'
import type { NaiCanvasNode } from '../types'

export const NaiImageCanvasNode = memo(function NaiImageCanvasNode(
  props: NodeProps<NaiCanvasNode>
) {
  const { t } = useTranslation()
  const { retry } = useNaiImageGeneration()
  const checkpoint = useNaiDrawingStore((state) => state.checkpoint)
  const removeNodes = useCanvasNodeDeletionRequest()
  const [downloading, setDownloading] = useState(false)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const asset = props.data.asset
  const imageFailed = Boolean(asset && failedSource === asset.src)
  const failed = props.data.status === 'error'
  const complete = props.data.status === 'complete'
  const pending = props.data.status === 'pending'

  return (
    <>
      <NodeResizer
        isVisible={props.selected}
        minWidth={220}
        minHeight={230}
        maxWidth={10000}
        maxHeight={10000}
        onResizeStart={checkpoint}
        lineClassName='!border-primary/70'
        handleClassName='!size-2 !rounded-sm !bg-background !border-primary'
      />
      <article
        className={cn(
          'flex size-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm',
          props.selected && 'border-primary ring-primary/20 ring-2'
        )}
        aria-label={props.data.prompt || asset?.name || t('NAI image')}
      >
        <div className='nai-drawing-node-handle flex h-9 shrink-0 cursor-grab items-center gap-2 border-b px-3 active:cursor-grabbing'>
          <span className='min-w-0 flex-1 truncate text-[11px] font-medium'>
            {props.data.settings.model || t('NAI image')}
          </span>
          <Badge variant='secondary' className='text-[10px]'>
            NAI
          </Badge>
          {pending && <Spinner className='size-3' aria-hidden='true' />}
          {asset && complete && (
            <span className='text-muted-foreground font-mono text-[10px]'>
              {asset.width} × {asset.height}
            </span>
          )}
        </div>
        <div className='nai-drawing-node-handle bg-muted/40 relative flex min-h-0 flex-1 cursor-grab items-center justify-center overflow-hidden'>
          {asset && !imageFailed && (
            <img
              src={asset.src}
              alt={props.data.prompt || asset.name}
              draggable={false}
              loading='lazy'
              className='size-full object-contain'
              onError={() => setFailedSource(asset.src)}
            />
          )}
          {pending && (
            <div className='bg-background/90 absolute inset-0 flex items-center justify-center p-5 text-center text-xs'>
              <div className='flex flex-col items-center gap-2'>
                <Spinner />
                <span>{t('Generating NovelAI image…')}</span>
              </div>
            </div>
          )}
          {!pending && (!asset || imageFailed || !complete) && (
            <div className='bg-background/75 absolute inset-0 flex flex-col items-center justify-center gap-2 p-5 text-center text-xs'>
              {failed && (
                <p
                  role='alert'
                  className='text-destructive max-w-full break-words'
                >
                  <span className='font-medium'>
                    {t('NovelAI image generation failed.')}
                  </span>
                  {props.data.error && (
                    <span className='mt-1 block'>{props.data.error}</span>
                  )}
                </p>
              )}
              {props.data.status === 'cancelled' && (
                <p>{t('Generation stopped')}</p>
              )}
              {imageFailed && <p>{t('The image could not be loaded.')}</p>}
            </div>
          )}
        </div>
        <div className='shrink-0 space-y-2 border-t p-3'>
          <p
            className='line-clamp-2 text-xs leading-relaxed break-words'
            title={props.data.prompt}
          >
            {props.data.prompt || asset?.name}
          </p>
          <div className='nodrag nopan flex items-center gap-1'>
            {failed && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='min-w-0 flex-1 text-xs'
                title={t('Retry')}
                onClick={() => {
                  if (retry(props.id)) setFailedSource(null)
                }}
              >
                <HugeiconsIcon
                  icon={ArrowReloadHorizontalIcon}
                  size={14}
                  aria-hidden='true'
                />
                <span className='truncate'>{t('Retry')}</span>
              </Button>
            )}
            <Button
              type='button'
              size='icon-xs'
              variant='ghost'
              disabled={!asset}
              title={t('Preview')}
              aria-label={t('Preview')}
              onClick={() => useNaiDrawingStore.getState().setPreview(props.id)}
            >
              <HugeiconsIcon icon={ViewIcon} size={14} aria-hidden='true' />
            </Button>
            <Button
              type='button'
              size='icon-xs'
              variant='ghost'
              disabled={!asset || !complete || downloading}
              title={t('Download')}
              aria-label={t('Download')}
              onClick={async () => {
                if (!asset) return
                setDownloading(true)
                try {
                  const file = await imageAssetToFile(asset)
                  downloadBlob(file, `new-api-nai-${props.id}.png`)
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : t('Download failed.')
                  )
                } finally {
                  setDownloading(false)
                }
              }}
            >
              <HugeiconsIcon
                icon={Download04Icon}
                size={14}
                aria-hidden='true'
              />
            </Button>
            <Button
              type='button'
              size='icon-xs'
              variant='ghost'
              title={t('Delete')}
              aria-label={t('Delete')}
              onClick={() => removeNodes([props.id])}
            >
              <HugeiconsIcon icon={Delete02Icon} size={14} aria-hidden='true' />
            </Button>
          </div>
        </div>
      </article>
    </>
  )
})

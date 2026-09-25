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
  ArrowReloadHorizontalIcon,
  Delete02Icon,
  Download04Icon,
  ImageAdd01Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { memo, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useCanvasNodeDeletionRequest } from '@/features/gallery/components/canvas-node-deletion'
import {
  readCanvasNodeOriginal,
  useCanvasNodeImage,
} from '@/features/gallery/hooks/use-canvas-node-image'
import { useGalleryIdentity } from '@/features/gallery/hooks/use-gallery-identity'
import { cn } from '@/lib/utils'
import { useDrawingStore } from '@/stores/drawing-store'

import { ImageCollectContext } from '../context/image-collect-context'
import { ImageRetryContext } from '../context/image-retry-context'
import {
  CANVAS_NODE_MIN_HEIGHT,
  CANVAS_NODE_MIN_WIDTH,
} from '../lib/canvas-geometry'
import { downloadBlob } from '../lib/image-assets'
import { getMaxReferenceImages } from '../lib/image-settings'
import type { DrawingNode } from '../types'
import {
  ImageGenerationElapsed,
  ImageGenerationProgress,
} from './ImageGenerationProgress'

export const ImageCanvasNode = memo(function ImageCanvasNode(
  props: NodeProps<DrawingNode>
) {
  const { t } = useTranslation()
  const retry = useContext(ImageRetryContext)
  const collect = useContext(ImageCollectContext)
  const requestDeletion = useCanvasNodeDeletionRequest()
  const reference = useDrawingStore((state) =>
    state.referenceIds.includes(props.id)
  )
  const checkpoint = useDrawingStore((state) => state.checkpoint)
  const [downloading, setDownloading] = useState(false)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const asset = props.data.asset
  const identity = useGalleryIdentity()
  const source = useCanvasNodeImage(asset)
  const imageFailed = Boolean(asset && failedSource === source)
  const pending = props.data.status === 'pending'
  const complete = props.data.status === 'complete'
  const failed = props.data.status === 'error'
  // A cancelled generation was still billed, so its finished image stays
  // available until the node is regenerated.
  const collectable =
    props.data.status === 'cancelled' && Boolean(props.data.taskId)
  const canReceive =
    props.isConnectable &&
    !pending &&
    getMaxReferenceImages(props.data.settings.model) > 0
  const canReference = props.isConnectable && complete && Boolean(asset)
  return (
    <>
      <NodeResizer
        isVisible={props.selected}
        minWidth={CANVAS_NODE_MIN_WIDTH}
        minHeight={CANVAS_NODE_MIN_HEIGHT}
        maxWidth={10000}
        maxHeight={10000}
        onResizeStart={checkpoint}
        lineClassName='!border-transparent'
        handleClassName='!size-2 !rounded-sm !bg-background !border-primary'
      />
      <Handle
        type='target'
        position={Position.Left}
        className='!bg-background !border-primary focus-visible:!ring-primary !z-10 !size-4 !border-2 focus-visible:!ring-2 aria-disabled:!opacity-40'
        isConnectable={canReceive}
        isConnectableStart={canReceive}
        isConnectableEnd={canReceive}
        role='button'
        tabIndex={canReceive ? 0 : -1}
        aria-label={t('Reference input')}
        aria-disabled={!canReceive}
        title={t('Reference input')}
        onKeyDown={(event) => {
          if (canReceive && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.click()
          }
        }}
      />
      <Handle
        type='source'
        position={Position.Right}
        className='!bg-primary !border-background focus-visible:!ring-primary !z-10 !size-4 !border-2 focus-visible:!ring-2 aria-disabled:!opacity-40'
        isConnectable={canReference}
        isConnectableStart={canReference}
        isConnectableEnd={canReference}
        role='button'
        tabIndex={canReference ? 0 : -1}
        aria-label={t('Reference output')}
        aria-disabled={!canReference}
        title={t('Drag to another image’s reference input')}
        onKeyDown={(event) => {
          if (canReference && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.click()
          }
        }}
      />
      <article
        className={cn(
          'flex size-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm',
          // The resizer draws four separate straight lines, which leave the
          // corners of a rounded card open. The outline belongs here instead.
          props.selected && 'ring-primary/70 ring-2',
          reference && 'border-primary'
        )}
        aria-label={props.data.prompt || asset?.name || t('Image')}
      >
        <div className='drawing-node-handle flex h-8 shrink-0 cursor-grab items-center gap-2 border-b px-2.5 active:cursor-grabbing'>
          <span className='min-w-0 flex-1 truncate text-[11px] font-medium'>
            {props.data.settings.model || t('Uploaded image')}
          </span>
          {reference && (
            <Badge variant='secondary' className='text-[10px]'>
              {t('Reference')}
            </Badge>
          )}
          {pending && (
            <ImageGenerationElapsed
              startedAt={props.data.progress?.startedAt ?? props.data.createdAt}
            />
          )}
          {pending && <Spinner className='size-3' aria-hidden='true' />}
          {asset && complete && (
            <span className='text-muted-foreground font-mono text-[10px]'>
              {asset.width} × {asset.height}
            </span>
          )}
        </div>
        <div
          className='drawing-node-handle bg-muted/40 relative flex min-h-0 flex-1 cursor-grab items-center justify-center overflow-hidden'
          onDoubleClick={() => {
            if (asset) useDrawingStore.getState().setPreview(props.id)
          }}
        >
          {asset && !imageFailed && (
            <img
              src={source}
              alt={props.data.prompt || asset.name}
              draggable={false}
              className='size-full object-contain'
              onError={() => setFailedSource(source)}
            />
          )}
          {pending && (
            <div
              className={cn(
                'absolute inset-x-0 bottom-0 bg-background/90 p-2 text-center text-xs',
                (!asset || imageFailed) &&
                  'drawing-generation-fill inset-0 flex flex-col justify-center'
              )}
            >
              <ImageGenerationProgress
                key={props.data.progress?.startedAt}
                progress={
                  props.data.progress || {
                    startedAt: props.data.createdAt,
                    phase: 'generating',
                    previewCount: 0,
                  }
                }
              />
              {imageFailed && !asset && (
                <p>{t('The image could not be loaded.')}</p>
              )}
            </div>
          )}
          {!pending && (!asset || !complete) && (
            <div className='bg-background/75 absolute inset-0 flex flex-col items-center justify-center gap-2 p-5 text-center text-xs'>
              {props.data.status === 'error' && (
                <p
                  role='alert'
                  className='text-destructive max-w-full break-words'
                >
                  <span className='font-medium'>
                    {t('Image generation failed.')}
                  </span>
                  {props.data.error &&
                    props.data.error !== 'Image generation failed.' && (
                      <span className='mt-1 block'>
                        {/* A failure that met several causes lists one per line. */}
                        {t(props.data.error)
                          .split('\n')
                          .map((line) => (
                            <span key={line} className='block'>
                              {line}
                            </span>
                          ))}
                      </span>
                    )}
                </p>
              )}
              {props.data.status === 'cancelled' && (
                <p>
                  {t('Generation stopped')}
                  {collectable && (
                    <span className='mt-1 block'>
                      {t(
                        'This image was already charged and can be collected.'
                      )}
                    </span>
                  )}
                </p>
              )}
              {imageFailed && !asset && (
                <p>{t('The image could not be loaded.')}</p>
              )}
            </div>
          )}
        </div>
        <div className='shrink-0 space-y-1.5 border-t p-2.5'>
          <p
            className='line-clamp-1 text-xs leading-relaxed break-words'
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
                disabled={!retry}
                title={t('Retry')}
                className='min-w-0 flex-1 text-xs'
                onClick={() => {
                  if (retry?.(props.id)) setFailedSource(null)
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
            {collectable && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={!collect}
                title={t('Collect result')}
                className='min-w-0 flex-1 text-xs'
                onClick={() => collect?.(props.id)}
              >
                <HugeiconsIcon
                  icon={Download04Icon}
                  size={14}
                  aria-hidden='true'
                />
                <span className='truncate'>{t('Collect result')}</span>
              </Button>
            )}
            {!failed && !collectable && (
              <Button
                type='button'
                size='sm'
                variant={reference ? 'secondary' : 'ghost'}
                disabled={!complete || !asset}
                aria-pressed={reference}
                className='min-w-0 flex-1 text-xs'
                onClick={() =>
                  useDrawingStore.getState().toggleReference(props.id)
                }
              >
                <HugeiconsIcon
                  icon={ImageAdd01Icon}
                  size={14}
                  aria-hidden='true'
                />
                {reference ? t('Reference selected') : t('Use as reference')}
              </Button>
            )}
            <Button
              type='button'
              size='icon-xs'
              variant='ghost'
              disabled={!asset}
              title={t('Preview')}
              aria-label={t('Preview')}
              onClick={() => useDrawingStore.getState().setPreview(props.id)}
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
                  const file = await readCanvasNodeOriginal(identity, asset)
                  downloadBlob(
                    file,
                    `new-api-${props.id}.${file.type.split('/')[1]}`
                  )
                } catch {
                  toast.error(
                    t(
                      'The image could not be downloaded. Try opening the preview.'
                    )
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
              title={t('Reuse prompt and settings')}
              aria-label={t('Reuse prompt and settings')}
              onClick={() =>
                useDrawingStore.getState().reuseNodeSettings(props.id)
              }
            >
              <HugeiconsIcon
                icon={ArrowReloadHorizontalIcon}
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
              onClick={() => requestDeletion([props.id])}
            >
              <HugeiconsIcon icon={Delete02Icon} size={14} aria-hidden='true' />
            </Button>
          </div>
        </div>
      </article>
    </>
  )
})

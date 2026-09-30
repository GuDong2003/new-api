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
import { useCallback, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { readCanvasNodeOriginal } from '@/features/gallery/hooks/use-canvas-node-image'
import { useGalleryIdentity } from '@/features/gallery/hooks/use-gallery-identity'

import { imageSourceToAsset } from '../lib/image-assets'
import type { ImageAsset } from '../types'

type MaskEditorProps = {
  image: ImageAsset
  mask?: ImageAsset
  onClose: () => void
  onSave: (mask: ImageAsset) => void
}

export function MaskEditor(props: MaskEditorProps) {
  const { t } = useTranslation()
  const canvas = useRef<HTMLCanvasElement>(null)
  const previous = useRef<{ x: number; y: number } | null>(null)
  const [brush, setBrush] = useState(50)
  const [saving, setSaving] = useState(false)
  const identity = useGalleryIdentity()
  const [loading, setLoading] = useState(Boolean(props.mask))
  const [maskError, setMaskError] = useState(false)
  const ready = useRef(false)

  const initializeCanvas = useCallback(
    (target: HTMLCanvasElement | null) => {
      canvas.current = target
      const context = target?.getContext('2d')
      if (!target || !context) return
      ready.current = false
      previous.current = null
      context.globalCompositeOperation = 'source-over'
      context.clearRect(0, 0, props.image.width, props.image.height)
      setMaskError(false)
      const mask = props.mask
      if (!mask) {
        context.fillStyle = 'rgba(20, 20, 20, 0.65)'
        context.fillRect(0, 0, props.image.width, props.image.height)
        ready.current = true
        setLoading(false)
        return
      }

      setLoading(true)
      const image = new Image()
      const controller = new AbortController()
      let objectUrl: string | undefined
      image.addEventListener('load', () => {
        if (controller.signal.aborted) return
        context.globalCompositeOperation = 'source-over'
        context.clearRect(0, 0, target.width, target.height)
        context.globalAlpha = 0.65
        context.drawImage(image, 0, 0, target.width, target.height)
        context.globalAlpha = 1
        ready.current = true
        setLoading(false)
      })
      image.addEventListener('error', () => {
        if (controller.signal.aborted) return
        setMaskError(true)
        setLoading(false)
      })
      if (mask.previewOnly) {
        void readCanvasNodeOriginal(identity, mask, controller.signal)
          .then((file) => {
            if (controller.signal.aborted) return
            objectUrl = URL.createObjectURL(file)
            image.src = objectUrl
          })
          .catch(() => {
            if (controller.signal.aborted) return
            setMaskError(true)
            setLoading(false)
          })
      } else {
        image.crossOrigin = 'anonymous'
        image.src = mask.src
      }
      return () => {
        controller.abort()
        ready.current = false
        if (canvas.current === target) {
          canvas.current = null
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }
    },
    [props.image.width, props.image.height, props.mask, identity]
  )

  const paint = (event: PointerEvent<HTMLCanvasElement>) => {
    const target = canvas.current
    const context = target?.getContext('2d')
    if (
      !target ||
      !context ||
      !ready.current ||
      saving ||
      event.buttons !== 1
    ) {
      return
    }
    const rect = target.getBoundingClientRect()
    const point = {
      x: ((event.clientX - rect.left) * target.width) / rect.width,
      y: ((event.clientY - rect.top) * target.height) / rect.height,
    }
    context.globalCompositeOperation = 'destination-out'
    context.lineWidth = brush
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(
      previous.current?.x ?? point.x,
      previous.current?.y ?? point.y
    )
    context.lineTo(point.x + 0.01, point.y)
    context.stroke()
    previous.current = point
  }
  return (
    <Dialog
      open
      title={t('Paint mask')}
      description={t(
        'Brush over the area to edit. Unpainted areas are preserved.'
      )}
      contentClassName='max-h-[90svh] sm:max-w-3xl'
      footer={
        <>
          <Button type='button' variant='outline' onClick={props.onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type='button'
            disabled={saving || loading || maskError}
            onClick={async () => {
              const target = canvas.current
              if (!target) return
              setSaving(true)
              try {
                // Preserve fully opaque pixels outside the erased (editable) region.
                const context = target.getContext('2d')
                if (!context) return
                const pixels = context.getImageData(
                  0,
                  0,
                  target.width,
                  target.height
                )
                for (let i = 3; i < pixels.data.length; i += 4) {
                  pixels.data[i] = pixels.data[i] > 0 ? 255 : 0
                }
                const output = document.createElement('canvas')
                output.width = target.width
                output.height = target.height
                output.getContext('2d')?.putImageData(pixels, 0, 0)
                props.onSave(
                  await imageSourceToAsset(
                    output.toDataURL('image/png'),
                    'mask.png',
                    'image/png'
                  )
                )
              } catch {
                toast.error(t('The mask could not be saved.'))
              } finally {
                setSaving(false)
              }
            }}
          >
            {t('Apply mask')}
          </Button>
        </>
      }
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <div className='space-y-4'>
        <div className='flex flex-wrap items-end gap-3'>
          <div className='space-y-1'>
            <Label htmlFor='mask-brush'>{t('Brush size')}</Label>
            <Input
              id='mask-brush'
              type='range'
              min={4}
              max={Math.max(200, Math.round(props.image.width / 4))}
              value={brush}
              disabled={loading || saving}
              onChange={(event) => setBrush(Number(event.target.value))}
              className='w-40'
            />
          </div>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={loading || saving}
            onClick={() => {
              const context = canvas.current?.getContext('2d')
              if (!context) return
              context.globalCompositeOperation = 'source-over'
              context.clearRect(0, 0, props.image.width, props.image.height)
              context.fillStyle = 'rgba(20, 20, 20, 0.65)'
              context.fillRect(0, 0, props.image.width, props.image.height)
              ready.current = true
              previous.current = null
              setMaskError(false)
            }}
          >
            {t('Reset mask')}
          </Button>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={loading || saving}
            onClick={() => {
              canvas.current
                ?.getContext('2d')
                ?.clearRect(0, 0, props.image.width, props.image.height)
              ready.current = true
              previous.current = null
              setMaskError(false)
            }}
          >
            {t('Edit entire image')}
          </Button>
        </div>
        {maskError && (
          <Alert variant='destructive'>
            <AlertDescription>
              {t('The mask could not be loaded.')}
            </AlertDescription>
          </Alert>
        )}
        <div
          className='relative mx-auto max-h-[55svh] max-w-full overflow-hidden rounded-lg'
          style={{
            aspectRatio: props.image.width / props.image.height,
            width: `min(100%, ${55 * (props.image.width / props.image.height)}svh)`,
          }}
        >
          <img
            src={props.image.src}
            alt={t('Reference image')}
            className='size-full object-contain'
          />
          <canvas
            ref={initializeCanvas}
            width={props.image.width}
            height={props.image.height}
            className='absolute inset-0 size-full cursor-crosshair touch-none'
            aria-label={t('Paint the area to edit')}
            aria-busy={loading}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              previous.current = null
              paint(event)
            }}
            onPointerMove={paint}
            onPointerUp={() => {
              previous.current = null
            }}
            onPointerCancel={() => {
              previous.current = null
            }}
          />
        </div>
      </div>
    </Dialog>
  )
}

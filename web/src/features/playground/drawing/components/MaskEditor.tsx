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

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { imageSourceToAsset } from '../lib/image-assets'
import type { ImageAsset } from '../types'

type MaskEditorProps = {
  image: ImageAsset
  onClose: () => void
  onSave: (mask: ImageAsset) => void
}

export function MaskEditor(props: MaskEditorProps) {
  const { t } = useTranslation()
  const canvas = useRef<HTMLCanvasElement>(null)
  const previous = useRef<{ x: number; y: number } | null>(null)
  const [brush, setBrush] = useState(50)
  const [saving, setSaving] = useState(false)
  const initializeCanvas = useCallback(
    (target: HTMLCanvasElement | null) => {
      canvas.current = target
      const context = target?.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, props.image.width, props.image.height)
      context.fillStyle = 'rgba(20, 20, 20, 0.65)'
      context.fillRect(0, 0, props.image.width, props.image.height)
    },
    [props.image.width, props.image.height]
  )

  const paint = (event: PointerEvent<HTMLCanvasElement>) => {
    const target = canvas.current
    const context = target?.getContext('2d')
    if (!target || !context || event.buttons !== 1) return
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
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{t('Paint mask')}</DialogTitle>
          <DialogDescription>
            {t('Brush over the area to edit. Unpainted areas are preserved.')}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-wrap items-end gap-3'>
          <div className='space-y-1'>
            <Label htmlFor='mask-brush'>{t('Brush size')}</Label>
            <Input
              id='mask-brush'
              type='range'
              min={4}
              max={Math.max(200, Math.round(props.image.width / 4))}
              value={brush}
              onChange={(event) => setBrush(Number(event.target.value))}
              className='w-40'
            />
          </div>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => {
              const context = canvas.current?.getContext('2d')
              if (!context) return
              context.globalCompositeOperation = 'source-over'
              context.clearRect(0, 0, props.image.width, props.image.height)
              context.fillStyle = 'rgba(20, 20, 20, 0.65)'
              context.fillRect(0, 0, props.image.width, props.image.height)
            }}
          >
            {t('Reset mask')}
          </Button>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => {
              canvas.current
                ?.getContext('2d')
                ?.clearRect(0, 0, props.image.width, props.image.height)
            }}
          >
            {t('Edit entire image')}
          </Button>
        </div>
        <div
          className='relative mx-auto max-h-[55svh] max-w-full overflow-hidden rounded-lg'
          style={{ aspectRatio: props.image.width / props.image.height }}
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
        <DialogFooter>
          <Button type='button' variant='outline' onClick={props.onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type='button'
            disabled={saving}
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

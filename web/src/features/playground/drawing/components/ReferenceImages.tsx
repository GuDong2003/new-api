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
  Cancel01Icon,
  ImageAdd01Icon,
  PaintBrush01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useDrawingStore } from '@/stores/drawing-store'

import type { ImageAsset } from '../types'

type ReferenceImagesProps = {
  onUpload: (files: File[]) => void
  mask?: ImageAsset
  onMaskUpload: (file: File) => void
  onClearMask: () => void
  onDrawMask: () => void
}

export function ReferenceImages(props: ReferenceImagesProps) {
  const { t } = useTranslation()
  const upload = useRef<HTMLInputElement>(null)
  const maskUpload = useRef<HTMLInputElement>(null)
  const nodes = useDrawingStore((state) => state.nodes)
  const ids = useDrawingStore((state) => state.referenceIds)
  const toggleReference = useDrawingStore((state) => state.toggleReference)
  const references = ids.flatMap((id) => {
    const node = nodes.find(
      (item) => item.id === id && item.data.status === 'complete'
    )
    return node?.data.asset ? [{ id, asset: node.data.asset }] : []
  })
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <Label>
          {t('Reference images')}{' '}
          <span className='text-muted-foreground font-normal'>
            {references.length}/16
          </span>
        </Label>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          disabled={references.length >= 16}
          onClick={() => upload.current?.click()}
        >
          <HugeiconsIcon icon={ImageAdd01Icon} size={15} aria-hidden='true' />
          {t('Upload')}
        </Button>
      </div>
      <input
        ref={upload}
        type='file'
        className='hidden'
        aria-label={t('Upload reference images')}
        accept='image/png,image/jpeg,image/webp'
        multiple
        onChange={(event) => {
          props.onUpload([...(event.target.files || [])])
          event.target.value = ''
        }}
      />
      {references.length === 0 && (
        <p className='text-muted-foreground rounded-lg border border-dashed p-3 text-xs leading-relaxed'>
          {t('Upload an image or choose Use as reference on a canvas image.')}
        </p>
      )}
      <div className='grid grid-cols-4 gap-2'>
        {references.map(({ id, asset }, index) => (
          <div
            key={id}
            className='group bg-muted relative aspect-square overflow-hidden rounded-lg border'
          >
            <img
              src={asset.src}
              alt={asset.name}
              className='size-full object-cover'
            />
            <span className='bg-background/90 absolute bottom-0 left-0 px-1 text-[10px]'>
              {index + 1}
            </span>
            <Button
              type='button'
              size='icon-xs'
              variant='secondary'
              className='absolute top-0.5 right-0.5'
              aria-label={t('Remove reference')}
              title={t('Remove reference')}
              onClick={() => toggleReference(id)}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} aria-hidden='true' />
            </Button>
          </div>
        ))}
      </div>
      {references.length > 0 && (
        <>
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={props.onDrawMask}
            >
              <HugeiconsIcon
                icon={PaintBrush01Icon}
                size={14}
                aria-hidden='true'
              />
              {t('Paint mask')}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() => maskUpload.current?.click()}
            >
              {t('Upload mask')}
            </Button>
            {props.mask && (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={props.onClearMask}
              >
                {t('Remove mask')}
              </Button>
            )}
          </div>
          <input
            ref={maskUpload}
            className='hidden'
            type='file'
            accept='image/png'
            aria-label={t('Upload mask')}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) props.onMaskUpload(file)
              event.target.value = ''
            }}
          />
          {props.mask && (
            <p className='text-muted-foreground text-xs'>
              {t('Mask ready. Transparent areas will be edited.')}
            </p>
          )}
          <p className='text-muted-foreground text-xs leading-relaxed'>
            {t('The mask applies to the first reference image.')}
          </p>
        </>
      )}
    </div>
  )
}

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
import { useCallback, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useCanvasNodeImage } from '@/features/gallery/hooks/use-canvas-node-image'

import type { ImageAsset } from '../types'

/** The mask's transparent pixels are the editable area, regardless of its RGB. */
export function MaskOverlay(props: {
  mask: ImageAsset
  fit?: 'cover' | 'contain'
}) {
  const { t } = useTranslation()
  const id = useId()
  const source = useCanvasNodeImage(props.mask)
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const maskId = `editable-mask-${id}`
  const filterId = `mask-alpha-${id}`
  const observeImage = useCallback(
    (image: SVGImageElement | null) => {
      if (!image) return
      const loaded = () => setLoadedSource(source)
      const failed = () => setFailedSource(source)
      image.addEventListener('load', loaded, { once: true })
      image.addEventListener('error', failed, { once: true })
      return () => {
        image.removeEventListener('load', loaded)
        image.removeEventListener('error', failed)
      }
    },
    [source]
  )
  return (
    <>
      <svg
        className='pointer-events-none absolute inset-0 size-full'
        viewBox={`0 0 ${props.mask.width} ${props.mask.height}`}
        preserveAspectRatio={
          props.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'
        }
        role='img'
        aria-label={t('Mask preview')}
        aria-busy={loadedSource !== source && failedSource !== source}
      >
        <defs>
          <filter id={filterId} colorInterpolationFilters='sRGB'>
            <feColorMatrix
              type='matrix'
              values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'
            />
          </filter>
          <mask
            id={maskId}
            maskUnits='userSpaceOnUse'
            x={0}
            y={0}
            width={props.mask.width}
            height={props.mask.height}
            style={{ maskType: 'luminance' }}
          >
            <rect width='100%' height='100%' fill='white' />
            <image
              ref={observeImage}
              href={source}
              width={props.mask.width}
              height={props.mask.height}
              filter={`url(#${filterId})`}
            />
          </mask>
        </defs>
        {loadedSource === source && failedSource !== source && (
          <rect
            width='100%'
            height='100%'
            fill='#f43f5e'
            fillOpacity={0.45}
            mask={`url(#${maskId})`}
          />
        )}
      </svg>
      {failedSource === source && (
        <span
          role='status'
          className='text-destructive bg-background/90 absolute inset-x-1 bottom-1 rounded px-1 text-xs'
        >
          {t('The mask could not be loaded.')}
        </span>
      )}
    </>
  )
}

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
import { MagicWand01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AspectRatio } from '@/components/ui/aspect-ratio'
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

import {
  getImagePresetSize,
  getImageSizePreset,
  getImageSizes,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  supportsCustomImageSize,
  type ImageAspectRatio,
  type ImageResolution,
} from '../lib/image-settings'

type ImageSizeFieldsProps = {
  model: string
  size: string
  onChange: (size: string) => void
}

export function ImageSizeFields(props: ImageSizeFieldsProps) {
  const { t } = useTranslation()
  const [customSize, setCustomSize] = useState<string | null>(null)
  const automatic = props.size === 'auto'
  const preset = getImageSizePreset(props.size)
  const custom = !automatic && (!preset || customSize === props.size)
  const [width = '', height = ''] = props.size.split('x')
  const aspectRatio =
    preset?.aspectRatio ??
    IMAGE_ASPECT_RATIOS.find((ratio) => {
      const [ratioWidth, ratioHeight] = ratio.split(':').map(Number)
      return (
        Number(width) > 0 &&
        Number(height) > 0 &&
        Number(width) * ratioHeight === Number(height) * ratioWidth
      )
    })

  const changeSize = (size: string, isCustom = false) => {
    setCustomSize(isCustom ? size : null)
    props.onChange(size)
  }

  // Retain the model's exact supported sizes, including legacy landscape sizes.
  if (!supportsCustomImageSize(props.model)) {
    const sizes = getImageSizes(props.model)
    return (
      <Field>
        <FieldLabel htmlFor='drawing-size'>{t('Image resolution')}</FieldLabel>
        <NativeSelect
          id='drawing-size'
          value={props.size}
          onChange={(event) => changeSize(event.target.value)}
        >
          {!sizes.includes(props.size) && (
            <NativeSelectOption value={props.size}>
              {automatic ? t('Auto') : props.size.replace('x', ' × ')}
            </NativeSelectOption>
          )}
          {sizes.map((size) => (
            <NativeSelectOption key={size} value={size}>
              {size === 'auto' ? t('Auto') : size.replace('x', ' × ')}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    )
  }

  let selectedResolution: string[] = []
  if (!automatic) {
    selectedResolution = [custom ? 'custom' : (preset?.resolution ?? '1K')]
  }

  return (
    <FieldGroup className='gap-3'>
      <Field>
        <FieldTitle id='drawing-aspect-ratio-label'>
          {t('Image aspect ratio')}
        </FieldTitle>
        <ToggleGroup
          aria-labelledby='drawing-aspect-ratio-label'
          value={automatic ? ['auto'] : [aspectRatio ?? '']}
          onValueChange={(values) => {
            const ratio = values[0]
            if (!ratio) return
            changeSize(
              ratio === 'auto'
                ? 'auto'
                : getImagePresetSize(
                    ratio as ImageAspectRatio,
                    preset?.resolution ?? '1K'
                  )
            )
          }}
          variant='outline'
          size='sm'
          spacing={1}
          className='grid w-full grid-cols-4 gap-1.5'
        >
          <ToggleGroupItem
            value='auto'
            className='h-auto min-h-12 min-w-0 flex-col gap-1 px-1 py-2'
          >
            <HugeiconsIcon icon={MagicWand01Icon} aria-hidden='true' />
            {t('Auto')}
          </ToggleGroupItem>
          {IMAGE_ASPECT_RATIOS.map((ratio) => {
            const [ratioWidth, ratioHeight] = ratio.split(':').map(Number)
            return (
              <ToggleGroupItem
                key={ratio}
                value={ratio}
                className='h-auto min-h-12 min-w-0 flex-col gap-1 px-1 py-2'
              >
                <span
                  aria-hidden='true'
                  className='flex size-4 items-center justify-center'
                >
                  <AspectRatio
                    ratio={ratioWidth / ratioHeight}
                    className={cn(
                      'rounded-xs border border-current',
                      ratioWidth >= ratioHeight ? 'w-4' : 'h-4'
                    )}
                  />
                </span>
                {ratio}
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
      </Field>
      <Field>
        <FieldTitle id='drawing-resolution-label'>
          {t('Image resolution')}
        </FieldTitle>
        <ToggleGroup
          aria-labelledby='drawing-resolution-label'
          value={selectedResolution}
          onValueChange={(values) => {
            const resolution = values[0]
            if (!resolution) return
            if (resolution === 'custom') {
              changeSize(automatic ? '1024x1024' : props.size, true)
              return
            }
            changeSize(
              getImagePresetSize(
                aspectRatio ?? '1:1',
                resolution as ImageResolution
              )
            )
          }}
          variant='outline'
          size='sm'
          spacing={1}
          className='grid w-full grid-cols-4 gap-1.5'
        >
          {IMAGE_RESOLUTIONS.map((resolution) => (
            <ToggleGroupItem
              key={resolution}
              value={resolution}
              disabled={automatic}
            >
              {resolution}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem value='custom'>{t('Custom')}</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {custom && (
        <FieldGroup className='grid grid-cols-2 gap-3'>
          {(['width', 'height'] as const).map((dimension) => {
            const value = dimension === 'width' ? width : height
            const invalid =
              !value ||
              Number(value) < 16 ||
              Number(value) > 4096 ||
              Number(value) % 16 !== 0
            return (
              <Field key={dimension} data-invalid={invalid}>
                <FieldLabel htmlFor={`drawing-${dimension}`}>
                  {dimension === 'width' ? t('Width') : t('Height')}
                </FieldLabel>
                <Input
                  id={`drawing-${dimension}`}
                  type='number'
                  min={16}
                  max={4096}
                  step={16}
                  value={value}
                  aria-invalid={invalid}
                  placeholder={
                    dimension === 'width' ? t('Enter width') : t('Enter height')
                  }
                  onChange={(event) =>
                    changeSize(
                      dimension === 'width'
                        ? `${event.target.value}x${height}`
                        : `${width}x${event.target.value}`,
                      true
                    )
                  }
                />
              </Field>
            )
          })}
        </FieldGroup>
      )}
      <p role='status' className='text-muted-foreground text-xs'>
        {automatic
          ? t('Size is chosen automatically by the model.')
          : props.size.replace('x', ' × ')}
      </p>
    </FieldGroup>
  )
}

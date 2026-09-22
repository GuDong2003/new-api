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
import { useTranslation } from 'react-i18next'

import { AspectRatio } from '@/components/ui/aspect-ratio'
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

import {
  getImagePresetSize,
  getImageResolutionTier,
  getImageSizePreset,
  getImageSizes,
  getImageAspectRatios,
  IMAGE_RESOLUTIONS,
  supportsAutomaticImageSize,
  supportsImageSizePresets,
  type ImageAspectRatio,
  type ImageResolution,
} from '../lib/image-settings'

type ImageSizeFieldsProps = {
  model: string
  mode: 'generate' | 'edit'
  size: string
  onChange: (size: string) => void
}

export function ImageSizeFields(props: ImageSizeFieldsProps) {
  const { t } = useTranslation()
  const automatic = props.size === 'auto'
  // `auto` takes its ratio from the reference image, so it only means
  // something while editing; text-to-image is rejected outright.
  const offersAutomatic =
    supportsAutomaticImageSize(props.model) && props.mode === 'edit'
  const preset = getImageSizePreset(props.size, props.model)
  const resolution = preset?.resolution ?? '1K'
  const [width = '', height = ''] = props.size.split('x')
  const aspectRatio =
    preset?.aspectRatio ??
    getImageAspectRatios(props.model).find((ratio) => {
      const [ratioWidth, ratioHeight] = ratio.split(':').map(Number)
      return (
        Number(width) > 0 &&
        Number(height) > 0 &&
        Number(width) * ratioHeight === Number(height) * ratioWidth
      )
    })

  const changeSize = props.onChange

  // Retain the model's exact supported sizes, including legacy landscape sizes.
  // The tier row still renders, locked, so the controls do not come and go as
  // the model changes; it reports which tier the chosen size falls into.
  if (!supportsImageSizePresets(props.model)) {
    const sizes = getImageSizes(props.model)
    return (
      <FieldGroup className='gap-3'>
        <Field>
          <FieldLabel htmlFor='drawing-size'>{t('Image size')}</FieldLabel>
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
        <Field>
          <FieldTitle id='drawing-resolution-label'>
            {t('Image resolution')}
          </FieldTitle>
          <ToggleGroup
            aria-labelledby='drawing-resolution-label'
            value={automatic ? [] : [getImageResolutionTier(props.size)]}
            variant='outline'
            size='sm'
            spacing={1}
            className='grid w-full grid-cols-3 gap-1.5'
          >
            {IMAGE_RESOLUTIONS.map((step) => (
              <ToggleGroupItem key={step} value={step} disabled>
                {step}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      </FieldGroup>
    )
  }

  const selectedResolution = automatic ? [] : [resolution]

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
                : getImagePresetSize(ratio as ImageAspectRatio, resolution, props.model)
            )
          }}
          variant='outline'
          size='sm'
          spacing={1}
          className='grid w-full grid-cols-4 gap-1.5'
        >
          {offersAutomatic && (
            <ToggleGroupItem
              value='auto'
              className='h-auto min-h-12 min-w-0 flex-col gap-1 px-1 py-2'
            >
              <HugeiconsIcon icon={MagicWand01Icon} aria-hidden='true' />
              {t('Auto')}
            </ToggleGroupItem>
          )}
          {getImageAspectRatios(props.model).map((ratio) => {
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
            const selected = values[0]
            if (!selected) return
            const next = selected as ImageResolution
            changeSize(getImagePresetSize(aspectRatio ?? '1:1', next, props.model))
          }}
          variant='outline'
          size='sm'
          spacing={1}
          className='grid w-full grid-cols-3 gap-1.5'
        >
          {IMAGE_RESOLUTIONS.map((step) => (
            <ToggleGroupItem
              key={step}
              value={step}
              disabled={automatic}
            >
              {step}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <p role='status' className='text-muted-foreground text-xs'>
        {automatic
          ? t('Size is chosen automatically by the model.')
          : props.size.replace('x', ' × ')}
      </p>
    </FieldGroup>
  )
}

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
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

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
  getAllowedImageSize,
  getAutomaticImageAspectRatio,
  getImageModelFamily,
  getImagePresetSize,
  getImageResolutionTier,
  IMAGE_RESOLUTION_MAX_DIMENSIONS,
  getImageSizePreset,
  getImageSizes,
  getImageAspectRatios,
  IMAGE_RESOLUTIONS,
  supportsAutomaticImageSize,
  supportsImageSizePresets,
  supportsImageSizePresetTable,
  type ImageResolution,
} from '../lib/image-settings'
import { ImageDimensionFields } from './ImageDimensionFields'

type ImageSizeFieldsProps = {
  model: string
  mode: 'generate' | 'edit'
  size: string
  /** Tiers the canvas withholds from the user's group. */
  disabledResolutions?: readonly string[]
  /** Wait until the group's settings are known before offering automatic size. */
  automaticSizeEnabled?: boolean
  onChange: (size: string) => void
}

const TIER_COLUMNS = [
  'grid-cols-1',
  'grid-cols-2',
  'grid-cols-3',
  'grid-cols-4',
]

export function ImageSizeFields(props: ImageSizeFieldsProps) {
  const { t } = useTranslation()
  const withheld = props.disabledResolutions ?? []
  const size = getAllowedImageSize(props.size, props.model, withheld)
  const automatic = size === 'auto'
  const automaticRatio = getAutomaticImageAspectRatio(size, props.model)
  const preset = getImageSizePreset(size, props.model)
  const resolution =
    automatic || automaticRatio
      ? 'auto'
      : (preset?.resolution ?? getImageResolutionTier(size, props.model))
  const ratios = [...getImageAspectRatios(props.model)]
  // Keep a saved legacy ratio selectable without adding it to new canvases.
  if (preset && !ratios.includes(preset.aspectRatio)) {
    ratios.push(preset.aspectRatio)
  }
  if (automaticRatio && !ratios.includes(automaticRatio)) {
    ratios.push(automaticRatio)
  }
  const [width = '', height = ''] = size.split('x')
  const aspectRatio =
    automaticRatio ??
    preset?.aspectRatio ??
    ratios.reduce((nearest, ratio) => {
      const [ratioWidth, ratioHeight] = ratio.split(':').map(Number)
      const [nearestWidth, nearestHeight] = nearest.split(':').map(Number)
      const target = Number(width) / Number(height)
      return Math.abs(ratioWidth / ratioHeight - target) <
        Math.abs(nearestWidth / nearestHeight - target)
        ? ratio
        : nearest
    }, ratios[0])
  const automaticEnabled =
    props.automaticSizeEnabled !== false && withheld.length === 0
  const automaticHint = automaticEnabled
    ? undefined
    : t('Automatic size requires all resolution tiers to be enabled.')
  const offersAutomaticRatio =
    getImageModelFamily(props.model) === 'gpt-image' ||
    (supportsAutomaticImageSize(props.model) && props.mode === 'edit')

  // Fixed-size models retain their own supported dimensions.
  if (!supportsImageSizePresets(props.model)) {
    const sizes = getImageSizes(props.model)
    return (
      <FieldGroup className='gap-3'>
        <Field>
          <FieldLabel htmlFor='drawing-size'>{t('Image size')}</FieldLabel>
          <NativeSelect
            id='drawing-size'
            value={props.size}
            onChange={(event) => props.onChange(event.target.value)}
          >
            {!sizes.includes(props.size) && (
              <NativeSelectOption value={props.size}>
                {automatic ? t('Auto') : props.size.replace('x', ' × ')}
              </NativeSelectOption>
            )}
            {sizes.map((item) => (
              <NativeSelectOption key={item} value={item}>
                {item === 'auto' ? t('Auto') : item.replace('x', ' × ')}
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
            value={[
              automatic
                ? 'auto'
                : getImageResolutionTier(props.size, props.model),
            ]}
            variant='outline'
            size='sm'
            spacing={1}
            className='grid w-full grid-cols-4 gap-1.5'
          >
            {IMAGE_RESOLUTIONS.map((step) => (
              <ToggleGroupItem key={step} value={step} disabled>
                {step}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value='auto' disabled>
              {t('Auto')}
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>
    )
  }

  const offeredResolutions = IMAGE_RESOLUTIONS.filter(
    (step) => !withheld.includes(step)
  )
  const displaySize =
    automatic || automaticRatio
      ? getImagePresetSize(aspectRatio ?? '1:1', '1K', props.model)
      : size
  const [displayWidth, displayHeight] = displaySize.split('x').map(Number)

  return (
    <FieldGroup className='gap-3'>
      <ImageDimensionFields
        width={displayWidth}
        height={displayHeight}
        maxDimension={Math.max(
          ...offeredResolutions.map(
            (tier) => IMAGE_RESOLUTION_MAX_DIMENSIONS[tier]
          )
        )}
        disabled={automatic || !supportsImageSizePresetTable(props.model)}
        onChange={(nextSize) => {
          if (
            getAllowedImageSize(nextSize, props.model, withheld) !== nextSize
          ) {
            toast.error(
              t(
                'This image resolution is disabled for your group. Choose an available resolution.'
              )
            )
            return false
          }
          props.onChange(nextSize)
          return true
        }}
      />
      <Field>
        <FieldTitle id='drawing-resolution-label'>
          {t('Image resolution')}
        </FieldTitle>
        <ToggleGroup
          aria-labelledby='drawing-resolution-label'
          value={[resolution]}
          onValueChange={(values) => {
            const selected = values[0]
            if (!selected || selected === resolution) return
            if (selected === 'auto') {
              if (automaticEnabled) props.onChange(aspectRatio ?? '1:1')
              return
            }
            if (!offeredResolutions.includes(selected as ImageResolution)) {
              return
            }
            props.onChange(
              getImagePresetSize(
                aspectRatio ?? '1:1',
                selected as ImageResolution,
                props.model
              )
            )
          }}
          variant='outline'
          size='sm'
          spacing={1}
          className={cn(
            'grid w-full gap-1.5',
            TIER_COLUMNS[offeredResolutions.length]
          )}
        >
          {offeredResolutions.map((step) => (
            <ToggleGroupItem key={step} value={step}>
              {step}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem
            value='auto'
            disabled={!automaticEnabled}
            title={automaticHint}
          >
            {t('Auto')}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <Field>
        <FieldTitle id='drawing-aspect-ratio-label'>
          {t('Image aspect ratio')}
        </FieldTitle>
        <ToggleGroup
          aria-labelledby='drawing-aspect-ratio-label'
          value={[automatic ? 'auto' : (aspectRatio ?? '')]}
          onValueChange={(values) => {
            const ratio = values[0]
            if (!ratio) return
            if (ratio === 'auto') {
              if (offersAutomaticRatio && automaticEnabled) {
                props.onChange('auto')
              }
              return
            }
            const selected = ratios.find((item) => item === ratio)
            if (!selected) return
            props.onChange(
              resolution === 'auto'
                ? selected
                : getImagePresetSize(selected, resolution, props.model)
            )
          }}
          variant='outline'
          size='sm'
          spacing={1}
          className='grid w-full grid-cols-4 gap-1.5'
        >
          {ratios.map((ratio) => {
            const [ratioWidth, ratioHeight] = ratio.split(':').map(Number)
            const longest = Math.max(ratioWidth, ratioHeight)
            return (
              <ToggleGroupItem
                key={ratio}
                value={ratio}
                className='h-18 min-w-0 flex-col gap-1 px-1 py-2'
              >
                <span
                  aria-hidden='true'
                  className='flex h-6 items-center justify-center'
                >
                  <span
                    className='rounded-xs border border-current'
                    style={{
                      width: Math.max(10, (24 * ratioWidth) / longest),
                      height: Math.max(10, (24 * ratioHeight) / longest),
                    }}
                  />
                </span>
                {ratio}
              </ToggleGroupItem>
            )
          })}
          {offersAutomaticRatio && (
            <ToggleGroupItem
              value='auto'
              disabled={!automaticEnabled}
              title={automaticHint}
              className='h-18 min-w-0 flex-col gap-1 px-1 py-2'
            >
              {t('Auto')}
            </ToggleGroupItem>
          )}
        </ToggleGroup>
      </Field>
    </FieldGroup>
  )
}

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
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Field, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

import {
  getImageModelFamily,
  getImageQualities,
  getMaxImagesPerRequest,
} from '../lib/image-settings'
import type { ImageSettings } from '../types'
import {
  ImageOutputFields,
  type ImageOutputSettings,
} from './ImageOutputFields'
import { ImageSizeFields } from './ImageSizeFields'

const QUALITY_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Maximum' },
  { value: 'standard', label: 'Standard' },
  { value: 'hd', label: 'High definition' },
] as const

type SelectFieldProps = {
  name: keyof ImageSettings
  label: string
  options: { value: string; label: string }[]
}

function ParameterSelect(props: SelectFieldProps) {
  const { t } = useTranslation()
  const form = useFormContext<ImageSettings>()
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={`drawing-${props.name}`}>{t(props.label)}</Label>
      <NativeSelect
        id={`drawing-${props.name}`}
        className='w-full'
        {...form.register(props.name)}
      >
        {props.options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {t(option.label)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}

export function ImageParameterFields(props: {
  /** Tiers the canvas withholds from the user's group. */
  disabledResolutions?: readonly string[]
  automaticSizeEnabled?: boolean
  onSizeChange?: (size: string) => void
  onQualityChange?: (quality: ImageSettings['quality']) => void
  onOutputChange?: (settings: ImageOutputSettings) => void
  onModerationChange?: (moderation: ImageSettings['moderation']) => void
}) {
  const { t } = useTranslation()
  const form = useFormContext<ImageSettings>()
  const settings = useWatch({ control: form.control }) as ImageSettings
  const family = getImageModelFamily(settings.model)
  const maxImages = getMaxImagesPerRequest(
    settings.model,
    settings.outputFormat
  )
  const qualities = getImageQualities(settings.model)
  const qualityOptions = QUALITY_OPTIONS.filter((option) =>
    family === 'gpt-image'
      ? option.value !== 'standard' && option.value !== 'hd'
      : qualities.includes(option.value)
  )
  return (
    <>
      {qualities.length > 0 && (
        <Field>
          <FieldTitle id='drawing-quality-label'>
            {t('Image quality')}
          </FieldTitle>
          <ToggleGroup
            aria-labelledby='drawing-quality-label'
            value={[settings.quality]}
            onValueChange={(values) => {
              const option = qualityOptions.find(
                (item) => item.value === values[0]
              )
              if (!option || !qualities.includes(option.value)) return
              form.setValue('quality', option.value, { shouldDirty: true })
              form.clearErrors('root')
              props.onQualityChange?.(option.value)
            }}
            variant='outline'
            size='sm'
            spacing={1}
            className={cn(
              'grid w-full grid-cols-3 gap-1.5',
              qualityOptions.length === 1 && 'grid-cols-1',
              qualityOptions.length === 2 && 'grid-cols-2'
            )}
          >
            {qualityOptions.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                disabled={!qualities.includes(option.value)}
                className='h-auto min-h-9 min-w-0 px-2 py-1.5 whitespace-normal'
              >
                {t(option.label)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      )}
      <ImageSizeFields
        key={settings.model}
        model={settings.model}
        mode={settings.mode}
        size={settings.size}
        disabledResolutions={props.disabledResolutions}
        automaticSizeEnabled={props.automaticSizeEnabled}
        onChange={(size) => {
          form.setValue('size', size, { shouldDirty: true })
          form.clearErrors('root')
          props.onSizeChange?.(size)
        }}
      />
      {family === 'gpt-image' && (
        <ImageOutputFields
          key={`output-${settings.model}`}
          onChange={props.onOutputChange}
        />
      )}
      {settings.outputFormat === 'svg' && (
        <ParameterSelect
          name='complexity'
          label='Image complexity'
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
        />
      )}
      {(maxImages > 1 || family !== 'gpt-image') && (
        <div className='grid grid-cols-2 gap-3'>
          {maxImages > 1 && (
            <div className='space-y-1.5'>
              <Label htmlFor='drawing-n'>{t('Image count')}</Label>
              <Input
                id='drawing-n'
                type='number'
                min={1}
                max={maxImages}
                step={1}
                aria-invalid={Boolean(form.formState.errors.n)}
                {...form.register('n', { valueAsNumber: true })}
              />
            </div>
          )}
          {family !== 'gpt-image' && (
            <ParameterSelect
              name='responseFormat'
              label='Image response format'
              options={[
                { value: 'b64_json', label: 'Base64' },
                { value: 'url', label: 'URL' },
              ]}
            />
          )}
        </div>
      )}
      {family !== 'gpt-image' && settings.responseFormat === 'url' && (
        <p className='text-muted-foreground text-xs'>
          {t('Image URLs expire. Download results to keep a copy.')}
        </p>
      )}
      {family === 'gpt-image' && (
        <>
          {(settings.outputFormat === 'jpeg' ||
            settings.outputFormat === 'webp') && (
            <div className='space-y-1.5'>
              <Label htmlFor='drawing-compression'>
                {t('Output compression')}
              </Label>
              <Input
                id='drawing-compression'
                type='number'
                min={0}
                max={100}
                step={1}
                aria-invalid={Boolean(form.formState.errors.outputCompression)}
                {...form.register('outputCompression', {
                  valueAsNumber: true,
                })}
              />
            </div>
          )}
          {settings.mode === 'edit' && (
            <ParameterSelect
              name='inputFidelity'
              label='Image input fidelity'
              options={[
                { value: 'default', label: 'Image model default' },
                { value: 'high', label: 'High' },
                { value: 'low', label: 'Low' },
              ]}
            />
          )}
        </>
      )}
      {family === 'dall-e-3' && (
        <ParameterSelect
          name='style'
          label='Image style'
          options={[
            { value: 'vivid', label: 'Vivid' },
            { value: 'natural', label: 'Natural' },
          ]}
        />
      )}
      {family === 'grok-imagine' && (
        <label className='flex items-center justify-between gap-3 text-sm'>
          <span>{t('Allow NSFW content')}</span>
          <Switch
            checked={settings.nsfw}
            onCheckedChange={(checked) =>
              form.setValue('nsfw', checked, { shouldDirty: true })
            }
          />
        </label>
      )}
      {family === 'gpt-image' && (
        <Field>
          <FieldTitle id='drawing-moderation-label'>
            {t('Image moderation')}
          </FieldTitle>
          <ToggleGroup
            aria-labelledby='drawing-moderation-label'
            value={[settings.moderation]}
            onValueChange={(values) => {
              const moderation = values[0]
              if (moderation !== 'auto' && moderation !== 'low') return
              form.setValue('moderation', moderation, { shouldDirty: true })
              form.clearErrors('root')
              props.onModerationChange?.(moderation)
            }}
            variant='outline'
            size='sm'
            spacing={1}
            className='grid w-full grid-cols-2 gap-1.5'
          >
            <ToggleGroupItem value='auto'>{t('Auto')}</ToggleGroupItem>
            <ToggleGroupItem value='low'>{t('Low')}</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}
    </>
  )
}

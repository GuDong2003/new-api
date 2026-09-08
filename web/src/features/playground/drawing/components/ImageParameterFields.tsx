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

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

import {
  getImageModelFamily,
  getImageQualities,
  getImageSizes,
} from '../lib/image-settings'
import type { ImageSettings } from '../types'

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

export function ImageParameterFields() {
  const { t } = useTranslation()
  const form = useFormContext<ImageSettings>()
  const settings = useWatch({ control: form.control }) as ImageSettings
  const family = getImageModelFamily(settings.model)
  const qualityLabels: Record<string, string> = {
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    standard: 'Standard',
    hd: 'High definition',
  }
  return (
    <>
      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1.5'>
          <Label htmlFor='drawing-size'>{t('Image size')}</Label>
          <Input
            id='drawing-size'
            list='drawing-sizes'
            {...form.register('size')}
            autoComplete='off'
            placeholder='1024x1024'
          />
          <datalist id='drawing-sizes'>
            {getImageSizes(settings.model).map((size) => (
              <option key={size} value={size} />
            ))}
          </datalist>
        </div>
        <ParameterSelect
          name='quality'
          label='Image quality'
          options={getImageQualities(settings.model).map((quality) => ({
            value: quality,
            label: qualityLabels[quality],
          }))}
        />
        <div className='space-y-1.5'>
          <Label htmlFor='drawing-n'>{t('Image count')}</Label>
          <Input
            id='drawing-n'
            type='number'
            min={1}
            max={family === 'dall-e-3' ? 1 : 10}
            step={1}
            aria-invalid={Boolean(form.formState.errors.n)}
            {...form.register('n', { valueAsNumber: true })}
          />
        </div>
        {family === 'gpt-image' && (
          <ParameterSelect
            name='outputFormat'
            label='Image output format'
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPEG' },
              { value: 'webp', label: 'WebP' },
            ]}
          />
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
      {family === 'gpt-image' && (
        <p className='text-muted-foreground text-xs leading-relaxed'>
          {t(
            'Use auto or WIDTHxHEIGHT. Custom resolutions require model support.'
          )}
        </p>
      )}
      {family !== 'gpt-image' && settings.responseFormat === 'url' && (
        <p className='text-muted-foreground text-xs'>
          {t('Image URLs expire. Download results to keep a copy.')}
        </p>
      )}
      <Accordion>
        <AccordionItem value='advanced'>
          <AccordionTrigger className='py-2 text-xs'>
            {t('Advanced settings')}
          </AccordionTrigger>
          <AccordionContent className='space-y-4 pt-2'>
            {family === 'gpt-image' && (
              <>
                <div className='grid grid-cols-2 gap-3'>
                  <ParameterSelect
                    name='background'
                    label='Image background'
                    options={[
                      { value: 'auto', label: 'Auto' },
                      { value: 'opaque', label: 'Opaque' },
                      { value: 'transparent', label: 'Transparent' },
                    ]}
                  />
                  <ParameterSelect
                    name='moderation'
                    label='Image moderation'
                    options={[
                      { value: 'auto', label: 'Auto' },
                      { value: 'low', label: 'Low' },
                    ]}
                  />
                </div>
                {settings.outputFormat !== 'png' && (
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
                      aria-invalid={Boolean(
                        form.formState.errors.outputCompression
                      )}
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
                <label className='flex cursor-pointer items-center gap-2 text-sm'>
                  <input
                    type='checkbox'
                    className='accent-primary size-4'
                    {...form.register('stream')}
                  />
                  {t('Stream image previews')}
                </label>
                {settings.stream && (
                  <div className='space-y-1.5'>
                    <Label htmlFor='drawing-partials'>
                      {t('Partial images')}
                    </Label>
                    <Input
                      id='drawing-partials'
                      type='number'
                      min={0}
                      max={3}
                      step={1}
                      aria-invalid={Boolean(
                        form.formState.errors.partialImages
                      )}
                      {...form.register('partialImages', {
                        valueAsNumber: true,
                      })}
                    />
                  </div>
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
            <div className='space-y-1.5'>
              <Label htmlFor='drawing-user'>{t('User identifier')}</Label>
              <Input
                id='drawing-user'
                {...form.register('user')}
                placeholder={t('Optional')}
                autoComplete='off'
                maxLength={512}
              />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  )
}

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
import { ArrowLeftRightIcon, DiceIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'

import { getAlibabaImageModel } from '../lib/image-models'
import {
  getImageModelFamily,
  getMaxImageSeed,
  getMaxImagesPerRequest,
} from '../lib/image-settings'
import type { ImageSettings } from '../types'

const SAMPLERS = [
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
  'ddim_v3',
] as const

const NOISE_SCHEDULES = [
  'native',
  'karras',
  'exponential',
  'polyexponential',
] as const

type TagParameterFieldsProps = {
  // Switches and buttons change settings without a native form event.
  onChange: (settings: Partial<ImageSettings>) => void
}

/** The sampling controls of the tag-prompted models: NovelAI and Alibaba. */
export function TagParameterFields(props: TagParameterFieldsProps) {
  const { t } = useTranslation()
  const form = useFormContext<ImageSettings>()
  const settings = useWatch({ control: form.control }) as ImageSettings
  const family = getImageModelFamily(settings.model)
  const alibaba = getAlibabaImageModel(settings.model)
  const maxImages = getMaxImagesPerRequest(settings.model)
  const change = (next: Partial<ImageSettings>) => {
    for (const [key, value] of Object.entries(next)) {
      form.setValue(key as keyof ImageSettings, value as never, {
        shouldDirty: true,
      })
    }
    form.clearErrors('root')
    props.onChange(next)
  }
  const seed = (
    <div className='space-y-1.5'>
      <Label htmlFor='drawing-seed'>{t('Seed')}</Label>
      <div className='flex gap-2'>
        <Input
          id='drawing-seed'
          type='number'
          min={0}
          max={getMaxImageSeed(settings.model)}
          step={1}
          placeholder={t('Random')}
          aria-invalid={Boolean(form.formState.errors.seed)}
          {...form.register('seed', {
            setValueAs: (value: string) =>
              value === '' ? null : Number(value),
          })}
        />
        <Button
          type='button'
          variant='outline'
          size='icon-sm'
          className='shrink-0'
          title={t('Random seed')}
          aria-label={t('Random seed')}
          onClick={() =>
            change({
              seed: Math.floor(
                Math.random() * (getMaxImageSeed(settings.model) + 1)
              ),
            })
          }
        >
          <HugeiconsIcon icon={DiceIcon} size={15} aria-hidden='true' />
        </Button>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='shrink-0'
          disabled={settings.seed === null}
          onClick={() => change({ seed: null })}
        >
          {t('Clear')}
        </Button>
      </div>
    </div>
  )
  const count = maxImages > 1 && (
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
  )

  if (family === 'alibaba') {
    return (
      <div className='space-y-4'>
        <div className='grid grid-cols-2 gap-3'>
          {alibaba?.sizes.length ? (
            <div className='space-y-1.5'>
              <Label htmlFor='drawing-size'>{t('Image size')}</Label>
              <NativeSelect
                id='drawing-size'
                className='w-full'
                {...form.register('size')}
              >
                {alibaba.sizes.map((size) => (
                  <NativeSelectOption key={size} value={size}>
                    {size.replace('*', ' × ')}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          {count}
        </div>
        {seed}
        {alibaba?.promptExtend && (
          <label className='flex items-center justify-between gap-3 text-sm'>
            <span>{t('Prompt rewriting')}</span>
            <Switch
              checked={settings.promptExtend}
              onCheckedChange={(checked) => change({ promptExtend: checked })}
            />
          </label>
        )}
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-[1fr_auto_1fr] items-end gap-2'>
        <div className='space-y-1.5'>
          <Label htmlFor='drawing-width'>{t('Width')}</Label>
          <Input
            id='drawing-width'
            type='number'
            min={64}
            max={2048}
            step={64}
            aria-invalid={Boolean(form.formState.errors.width)}
            {...form.register('width', { valueAsNumber: true })}
          />
        </div>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          title={t('Swap width and height')}
          aria-label={t('Swap width and height')}
          onClick={() =>
            change({ width: settings.height, height: settings.width })
          }
        >
          <HugeiconsIcon
            icon={ArrowLeftRightIcon}
            size={15}
            aria-hidden='true'
          />
        </Button>
        <div className='space-y-1.5'>
          <Label htmlFor='drawing-height'>{t('Height')}</Label>
          <Input
            id='drawing-height'
            type='number'
            min={64}
            max={2048}
            step={64}
            aria-invalid={Boolean(form.formState.errors.height)}
            {...form.register('height', { valueAsNumber: true })}
          />
        </div>
      </div>
      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1.5'>
          <Label htmlFor='drawing-sampler'>{t('Sampler')}</Label>
          <NativeSelect
            id='drawing-sampler'
            className='w-full'
            {...form.register('sampler')}
          >
            {SAMPLERS.map((sampler) => (
              <NativeSelectOption key={sampler} value={sampler}>
                {sampler}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='drawing-noise'>{t('Noise schedule')}</Label>
          <NativeSelect
            id='drawing-noise'
            className='w-full'
            {...form.register('noiseSchedule')}
          >
            {NOISE_SCHEDULES.map((schedule) => (
              <NativeSelectOption key={schedule} value={schedule}>
                {schedule}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='drawing-steps'>{t('Steps')}</Label>
          <Input
            id='drawing-steps'
            type='number'
            min={1}
            max={50}
            step={1}
            aria-invalid={Boolean(form.formState.errors.steps)}
            {...form.register('steps', { valueAsNumber: true })}
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='drawing-scale'>{t('Guidance strength')}</Label>
          <Input
            id='drawing-scale'
            type='number'
            min={0}
            max={30}
            step={0.1}
            aria-invalid={Boolean(form.formState.errors.scale)}
            {...form.register('scale', { valueAsNumber: true })}
          />
        </div>
        {count}
      </div>
      {seed}
      <Accordion>
        <AccordionItem value='advanced'>
          <AccordionTrigger className='py-2 text-xs'>
            {t('Advanced settings')}
          </AccordionTrigger>
          <AccordionContent className='space-y-3 pt-2'>
            <label className='flex items-center justify-between gap-3 text-sm'>
              <span>{t('Quality tags')}</span>
              <Switch
                checked={settings.qualityToggle}
                onCheckedChange={(checked) =>
                  change({ qualityToggle: checked })
                }
              />
            </label>
            {settings.qualityToggle && (
              <div className='space-y-1.5'>
                <Label htmlFor='drawing-quality-tier'>
                  {t('Quality tag preset')}
                </Label>
                <NativeSelect
                  id='drawing-quality-tier'
                  className='w-full'
                  {...form.register('qualityTier')}
                >
                  <NativeSelectOption value='standard'>
                    {t('Standard')}
                  </NativeSelectOption>
                  <NativeSelectOption value='light'>
                    {t('Lightweight')}
                  </NativeSelectOption>
                </NativeSelect>
              </div>
            )}
            <div className='space-y-1.5'>
              <Label htmlFor='drawing-uc-preset'>
                {t('Undesired content preset')}
              </Label>
              <NativeSelect
                id='drawing-uc-preset'
                className='w-full'
                {...form.register('ucPreset')}
              >
                <NativeSelectOption value='none'>
                  {t('None')}
                </NativeSelectOption>
                <NativeSelectOption value='heavy'>
                  {t('Heavy')}
                </NativeSelectOption>
                <NativeSelectOption value='light'>
                  {t('Lightweight')}
                </NativeSelectOption>
                <NativeSelectOption value='humanFocus'>
                  {t('Human focus')}
                </NativeSelectOption>
              </NativeSelect>
            </div>
            <label className='flex items-center justify-between gap-3 text-sm'>
              <span>{t('SMEA')}</span>
              <Switch
                checked={settings.smea}
                onCheckedChange={(checked) => change({ smea: checked })}
              />
            </label>
            <label className='flex items-center justify-between gap-3 text-sm'>
              <span>{t('SMEA dynamic')}</span>
              <Switch
                checked={settings.smeaDyn}
                onCheckedChange={(checked) => change({ smeaDyn: checked })}
              />
            </label>
            <label className='flex items-center justify-between gap-3 text-sm'>
              <span>{t('Decrisp')}</span>
              <Switch
                checked={settings.decrisp}
                onCheckedChange={(checked) => change({ decrisp: checked })}
              />
            </label>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}

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
import { useId, useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import { isGPTImage26, supportsSVGOutput } from '../lib/image-settings'
import type { ImageSettings } from '../types'

const OUTPUT_FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
  { value: 'gif', label: 'GIF' },
  { value: 'svg', label: 'SVG' },
] as const

export type ImageOutputSettings = Pick<
  ImageSettings,
  'background' | 'outputFormat' | 'frameCount' | 'frameDurationMs'
>

export function ImageOutputFields(props: {
  onChange?: (settings: ImageOutputSettings) => void
}) {
  const { t } = useTranslation()
  const form = useFormContext<ImageSettings>()
  const [background, outputFormat, model, mode] = useWatch({
    control: form.control,
    name: ['background', 'outputFormat', 'model', 'mode'],
  })
  const animationSupported = isGPTImage26(model)
  const svgSupported = supportsSVGOutput(model, mode)
  const formats = OUTPUT_FORMATS.filter((option) => {
    if (option.value === 'gif') return animationSupported
    if (option.value === 'svg') return svgSupported
    return true
  })
  let formatColumns = 'grid-cols-3'
  if (svgSupported) formatColumns = 'grid-cols-5'
  else if (animationSupported) formatColumns = 'grid-cols-4'
  const transparent = background === 'transparent'
  const [jpegWarning, setJpegWarning] = useState(false)
  const warningId = useId()
  const backgroundDescriptionId = useId()
  const formatDescriptionId = useId()
  const timingDescriptionId = useId()
  const showWarning = jpegWarning && transparent
  const transparentGif = transparent && outputFormat === 'gif'
  const formatDescriptionIds =
    [animationSupported && formatDescriptionId, showWarning && warningId]
      .filter(Boolean)
      .join(' ') || undefined
  const changeOutput = (
    next: Pick<ImageOutputSettings, 'background' | 'outputFormat'>
  ) => {
    form.setValue('background', next.background, { shouldDirty: true })
    form.setValue('outputFormat', next.outputFormat, { shouldDirty: true })
    if (next.outputFormat === 'svg') {
      form.setValue('n', 1, { shouldDirty: true })
      form.clearErrors('n')
    }
    form.clearErrors('root')
    setJpegWarning(false)
    props.onChange?.({
      ...next,
      frameCount: form.getValues('frameCount'),
      frameDurationMs: form.getValues('frameDurationMs'),
    })
  }
  const changeTiming = () => {
    const frameCount = form.getValues('frameCount')
    const frameDurationMs = form.getValues('frameDurationMs')
    if (
      !Number.isInteger(frameCount) ||
      frameCount < 2 ||
      frameCount > 16 ||
      !Number.isInteger(frameDurationMs) ||
      frameDurationMs < 20 ||
      frameDurationMs > 2000
    ) {
      return
    }
    form.clearErrors('root')
    props.onChange?.({ background, outputFormat, frameCount, frameDurationMs })
  }

  return (
    <>
      <Field>
        <FieldTitle>{t('Image background')}</FieldTitle>
        <Field orientation='horizontal'>
          <FieldLabel htmlFor='drawing-transparent-background'>
            {t('Transparent background')}
          </FieldLabel>
          <Switch
            id='drawing-transparent-background'
            checked={transparent}
            aria-describedby={
              transparentGif ? backgroundDescriptionId : undefined
            }
            onCheckedChange={(checked) =>
              changeOutput({
                background: checked ? 'transparent' : 'opaque',
                outputFormat:
                  checked && outputFormat === 'jpeg' ? 'png' : outputFormat,
              })
            }
          />
        </Field>
        {transparentGif && (
          <FieldDescription id={backgroundDescriptionId}>
            {t(
              'Transparent GIF availability depends on the upstream provider.'
            )}
          </FieldDescription>
        )}
      </Field>
      <Field>
        <FieldTitle id='drawing-output-format-label'>
          {t('Image output format')}
        </FieldTitle>
        <ToggleGroup
          aria-labelledby='drawing-output-format-label'
          aria-describedby={formatDescriptionIds}
          value={[outputFormat]}
          onValueChange={(values) => {
            const option = formats.find((item) => item.value === values[0])
            if (!option) {
              setJpegWarning(false)
              return
            }
            if (transparent && option.value === 'jpeg') {
              setJpegWarning(true)
              return
            }
            changeOutput({
              background: transparent ? 'transparent' : 'opaque',
              outputFormat: option.value,
            })
          }}
          variant='outline'
          size='sm'
          spacing={1}
          className={`grid w-full gap-1.5 ${formatColumns}`}
        >
          {formats.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {t(option.label)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {animationSupported && (
          <FieldDescription id={formatDescriptionId}>
            {svgSupported
              ? t('GIF and SVG availability depends on the upstream provider.')
              : t(
                  'GPT Image 2.6 offers PNG, JPEG, WebP and GIF output. GIF availability depends on the model and provider.'
                )}
            {outputFormat === 'svg' && (
              <> {t('SVG generates one image per request.')}</>
            )}
          </FieldDescription>
        )}
        {showWarning && (
          <Alert id={warningId}>
            <AlertDescription>
              {t(
                'JPEG does not support transparent backgrounds. Use PNG or WebP, or turn off transparency.'
              )}
            </AlertDescription>
          </Alert>
        )}
      </Field>
      {outputFormat === 'gif' && (
        <div className='grid grid-cols-2 gap-3'>
          <div className='space-y-1.5'>
            <Label htmlFor='drawing-frame-count'>{t('GIF frame count')}</Label>
            <Input
              id='drawing-frame-count'
              type='number'
              min={2}
              max={16}
              step={1}
              aria-describedby={timingDescriptionId}
              aria-invalid={Boolean(form.formState.errors.frameCount)}
              {...form.register('frameCount', {
                valueAsNumber: true,
                onChange: changeTiming,
              })}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='drawing-frame-duration'>
              {t('Frame duration (ms)')}
            </Label>
            <Input
              id='drawing-frame-duration'
              type='number'
              min={20}
              max={2000}
              step={10}
              aria-describedby={timingDescriptionId}
              aria-invalid={Boolean(form.formState.errors.frameDurationMs)}
              {...form.register('frameDurationMs', {
                valueAsNumber: true,
                onChange: changeTiming,
              })}
            />
          </div>
          <FieldDescription id={timingDescriptionId} className='col-span-2'>
            {t(
              'Frame count, frame duration and dimensions are request values. The provider may return different animation settings.'
            )}
          </FieldDescription>
          <FieldDescription className='col-span-2'>
            {t(
              'Preview or download the original GIF to view the animation. Thumbnails may show a still frame.'
            )}
          </FieldDescription>
        </div>
      )}
    </>
  )
}

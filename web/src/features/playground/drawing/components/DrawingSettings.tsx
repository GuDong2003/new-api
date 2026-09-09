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
import { zodResolver } from '@hookform/resolvers/zod'
import { MagicWand01Icon, StopIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useEffect } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { useDrawingStore } from '@/stores/drawing-store'

import { useImageOptions } from '../hooks/use-image-options'
import {
  getImageModelFamily,
  settingsForImageModel,
  imageSettingsSchema,
  validateImageSettings,
} from '../lib/image-settings'
import type { ImageAsset, ImageSettings } from '../types'
import { ImageParameterFields } from './ImageParameterFields'
import { ReferenceImages } from './ReferenceImages'

type DrawingSettingsProps = {
  userId: number
  pendingCount: number
  onGenerate: (settings: ImageSettings) => void
  onCancel: () => void
  onUploadReferences: (files: File[]) => void
  mask?: ImageAsset
  onMaskUpload: (file: File) => void
  onClearMask: () => void
  onDrawMask: () => void
}

export function DrawingSettings(props: DrawingSettingsProps) {
  const { t } = useTranslation()
  const settings = useDrawingStore((state) => state.settings)
  const references = useDrawingStore((state) => state.referenceIds)
  const updateSettings = useDrawingStore((state) => state.updateSettings)
  const { groups, models } = useImageOptions(props.userId)
  const form = useForm({
    defaultValues: settings,
    resolver: zodResolver(imageSettingsSchema),
  })
  useEffect(() => {
    if (JSON.stringify(settings) !== JSON.stringify(form.getValues())) {
      form.reset(settings)
    }
  }, [settings, form])
  const family = getImageModelFamily(settings.model)
  const unavailable =
    groups.isPending ||
    models.isPending ||
    groups.isError ||
    models.isError ||
    !groups.data?.length

  return (
    <FormProvider {...form}>
      <form
        className='flex h-full min-h-0 flex-col'
        aria-label={t('Image generation settings')}
        onChange={() => {
          form.clearErrors('root')
          updateSettings(form.getValues())
        }}
        onSubmit={form.handleSubmit((values) => {
          const error = validateImageSettings(values, references.length)
          if (error) {
            form.setError('root', { message: error })
            return
          }
          props.onGenerate(values)
        })}
      >
        <div className='min-h-0 flex-1 space-y-5 overflow-y-auto p-4'>
          <div className='space-y-1'>
            <h2 className='text-sm font-semibold'>{t('Image generation')}</h2>
            <p className='text-muted-foreground text-xs'>
              {t('Create and refine images on your canvas.')}
            </p>
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div className='space-y-1.5'>
              <Label htmlFor='drawing-mode'>{t('Mode')}</Label>
              <NativeSelect
                id='drawing-mode'
                className='w-full'
                {...form.register('mode')}
              >
                <NativeSelectOption value='generate'>
                  {t('Text to image')}
                </NativeSelectOption>
                <NativeSelectOption
                  value='edit'
                  disabled={family === 'dall-e-3'}
                >
                  {t('Image editing')}
                </NativeSelectOption>
              </NativeSelect>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='drawing-group'>{t('Group')}</Label>
              <NativeSelect
                id='drawing-group'
                className='w-full'
                disabled={groups.isPending}
                {...form.register('group', {
                  onChange: () => form.setValue('model', ''),
                })}
              >
                {!groups.data?.length && (
                  <NativeSelectOption value=''>
                    {t('Select a group.')}
                  </NativeSelectOption>
                )}
                {groups.data?.map((group) => (
                  <NativeSelectOption key={group.value} value={group.value}>
                    {group.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='drawing-model'>{t('Model')}</Label>
            <Combobox
              options={models.data || []}
              value={form.watch('model') || ''}
              onValueChange={(model) => {
                const selectedModel = model ?? ''
                const next = settingsForImageModel(
                  form.getValues(),
                  selectedModel
                )
                form.reset(next)
                updateSettings(next)
              }}
              placeholder={t('Select an image model.')}
              searchPlaceholder={t('Search models...')}
              emptyText={t('No image models are available in this group.')}
              className='w-full'
              openOnFocus={false}
            />
            <p className='text-muted-foreground text-xs leading-relaxed'>
              {t('Choose an image model available in the selected group.')}
            </p>
          </div>
          {(groups.isError ||
            models.isError ||
            (!groups.isPending && !groups.data?.length)) && (
            <Alert variant='destructive'>
              <AlertDescription>
                {t('Could not load available models or groups.')}
                <Button
                  type='button'
                  variant='link'
                  size='sm'
                  onClick={() => {
                    void groups.refetch()
                    void models.refetch()
                  }}
                >
                  {t('Retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className='space-y-1.5'>
            <Label htmlFor='drawing-prompt'>{t('Prompt')}</Label>
            <Textarea
              id='drawing-prompt'
              className='min-h-32 resize-y text-sm leading-relaxed'
              maxLength={32000}
              placeholder={t(
                'Describe your image, including subject, composition, lighting and style.'
              )}
              {...form.register('prompt')}
              onKeyDown={(event) => {
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key === 'Enter' &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
            />
          </div>
          {settings.mode === 'edit' && (
            <ReferenceImages
              onUpload={props.onUploadReferences}
              mask={props.mask}
              onMaskUpload={props.onMaskUpload}
              onClearMask={props.onClearMask}
              onDrawMask={props.onDrawMask}
            />
          )}
          <Separator />
          <ImageParameterFields />
          {Object.keys(form.formState.errors).length > 0 && (
            <p role='alert' className='text-destructive text-xs'>
              {t(
                form.formState.errors.root?.message ||
                  'Check the image generation parameters.'
              )}
            </p>
          )}
        </div>
        <div className='bg-background shrink-0 space-y-2 border-t p-4'>
          <Button
            type='submit'
            className='w-full'
            disabled={
              unavailable || !settings.prompt.trim() || !settings.model.trim()
            }
          >
            <HugeiconsIcon
              icon={MagicWand01Icon}
              size={17}
              aria-hidden='true'
            />
            {settings.mode === 'edit'
              ? t('Generate edits')
              : t('Generate images')}
          </Button>
          {props.pendingCount > 0 && (
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='w-full'
              onClick={props.onCancel}
            >
              <HugeiconsIcon icon={StopIcon} size={14} aria-hidden='true' />
              {t('Stop generation')} · {props.pendingCount}
            </Button>
          )}
          <p className='text-muted-foreground text-center text-[10px] leading-relaxed'>
            {t('Uses your account balance and selected group rates.')}
          </p>
        </div>
      </form>
    </FormProvider>
  )
}

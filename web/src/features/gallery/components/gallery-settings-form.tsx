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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FormDirtyIndicator } from '@/features/system-settings/components/form-dirty-indicator'
import { FormNavigationGuard } from '@/features/system-settings/components/form-navigation-guard'
import { SettingsCard } from '@/features/system-settings/components/settings-card'
import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '@/features/system-settings/components/settings-form-layout'
import { SettingsPageFormActions } from '@/features/system-settings/components/settings-page-context'

import { updateGallerySettings } from '../api'
import { galleryErrorMessage } from '../lib/errors'
import {
  gallerySettingsSchema,
  gallerySettingsToForm,
  type GallerySettingsFormValues,
} from '../lib/settings'
import type { GalleryIdentity, GallerySettings } from '../types'

export function GallerySettingsForm(props: {
  settings: GallerySettings
  identity: GalleryIdentity
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const form = useForm<GallerySettingsFormValues>({
    resolver: zodResolver(gallerySettingsSchema),
    defaultValues: gallerySettingsToForm(props.settings),
  })
  const mutation = useMutation({
    mutationFn: (values: GallerySettingsFormValues) =>
      updateGallerySettings(props.identity, {
        enabled: values.enabled,
        retention_days: values.retention_days,
        user_max_images: values.user_max_images,
        user_max_bytes: Math.round(values.user_max_mib * 1048576),
        total_max_bytes: Math.round(values.total_max_mib * 1048576),
      }),
    onSuccess: (settings) => {
      form.reset(gallerySettingsToForm(settings))
      client.setQueryData(
        [
          'gallery',
          props.identity.userId,
          props.identity.sessionId,
          'settings',
        ],
        settings
      )
      void client.invalidateQueries({
        queryKey: [
          'gallery',
          props.identity.userId,
          props.identity.sessionId,
          'usage',
        ],
      })
      toast.success(t('Settings saved successfully'))
    },
    onError: (error) => toast.error(t(galleryErrorMessage(error))),
  })
  const submit = form.handleSubmit((values) => mutation.mutate(values))
  const numbers = [
    {
      name: 'retention_days',
      label: t('Image retention days'),
      min: 1,
      max: 3650,
      placeholder: '7',
      help: t('Retention changes apply only to images saved in the future.'),
    },
    {
      name: 'user_max_images',
      label: t('Maximum images per person'),
      min: 1,
      max: 100000,
      placeholder: '100',
      help: t('Drawing and NAI Canvas share this image count limit.'),
    },
    {
      name: 'user_max_mib',
      label: t('Storage per person (MiB)'),
      min: 1,
      max: 1048576,
      placeholder: '200',
      help: t('Originals, thumbnails and metadata count toward this limit.'),
    },
    {
      name: 'total_max_mib',
      label: t('Total gallery storage (MiB)'),
      min: 1,
      max: 1048576,
      placeholder: '512',
      help: t(
        'Shared by all users. At least 512 MiB of physical disk space is kept free.'
      ),
    },
  ] as const
  return (
    <>
      <FormDirtyIndicator isDirty={form.formState.isDirty} />
      <FormNavigationGuard when={form.formState.isDirty} />
      <SettingsPageFormActions
        onSave={() => void submit()}
        onReset={() => form.reset(gallerySettingsToForm(props.settings))}
        isSaving={mutation.isPending}
        isSaveDisabled={!form.formState.isDirty}
        isResetDisabled={!form.formState.isDirty}
      />
      <SettingsCard
        title={t('Gallery storage')}
        description={t(
          'When limits are reached, generation continues without saving. Unexpired images are not automatically deleted to make room.'
        )}
      >
        <Form {...form}>
          <SettingsForm onSubmit={submit} noValidate>
            <FormField
              control={form.control}
              name='enabled'
              render={({ field }) => (
                <SettingsSwitchItem>
                  <SettingsSwitchContent>
                    <FormLabel>{t('Enable personal gallery')}</FormLabel>
                    <FormDescription>
                      {t(
                        'Automatically save new final images from the two site canvases. Existing images are retained when disabled.'
                      )}
                    </FormDescription>
                  </SettingsSwitchContent>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={mutation.isPending}
                    />
                  </FormControl>
                </SettingsSwitchItem>
              )}
            />
            {numbers.map((item) => (
              <FormField
                key={item.name}
                control={form.control}
                name={item.name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{item.label}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type='number'
                        min={item.min}
                        max={item.max}
                        step={1}
                        placeholder={item.placeholder}
                        value={Number.isNaN(field.value) ? '' : field.value}
                        onChange={(event) =>
                          field.onChange(
                            event.target.value === ''
                              ? Number.NaN
                              : Number(event.target.value)
                          )
                        }
                        disabled={mutation.isPending}
                      />
                    </FormControl>
                    <FormDescription>
                      {item.help}{' '}
                      {t('Allowed range: {{min}}–{{max}}.', {
                        min: item.min,
                        max: item.max,
                      })}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </SettingsForm>
        </Form>
      </SettingsCard>
    </>
  )
}

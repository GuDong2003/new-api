/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useMemo, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useResetForm } from '../hooks/use-reset-form'
import { useUpdateOption } from '../hooks/use-update-option'

// Scheduled tests, their mode, concurrency and interval, and re-enabling on
// success are channel health settings under Request policies. This section
// keeps the request a channel test sends.
const channelTestSchema = z.object({
  monitor_setting: z.object({
    channel_test_message: z.string().max(4096),
    channel_test_use_channel_style: z.boolean(),
    channel_test_show_response_preview: z.boolean(),
  }),
})

type ChannelTestFormInput = z.input<typeof channelTestSchema>
type ChannelTestFormValues = z.output<typeof channelTestSchema>

type FlatChannelTestDefaults = {
  'monitor_setting.channel_test_message': string
  'monitor_setting.channel_test_use_channel_style': boolean
  'monitor_setting.channel_test_show_response_preview': boolean
}

type ChannelTestSectionProps = {
  defaultValues: FlatChannelTestDefaults
}

function normalizeMessage(value: string) {
  return value.replaceAll('\r\n', '\n').trim() || '你好，请简单介绍一下你自己。'
}

function normalizeDefaults(
  defaults: FlatChannelTestDefaults
): FlatChannelTestDefaults {
  return {
    'monitor_setting.channel_test_message': normalizeMessage(
      defaults['monitor_setting.channel_test_message'] ?? ''
    ),
    'monitor_setting.channel_test_use_channel_style':
      defaults['monitor_setting.channel_test_use_channel_style'] ?? true,
    'monitor_setting.channel_test_show_response_preview':
      defaults['monitor_setting.channel_test_show_response_preview'] ?? false,
  }
}

function buildFormDefaults(
  defaults: FlatChannelTestDefaults
): ChannelTestFormInput {
  const normalized = normalizeDefaults(defaults)
  return {
    monitor_setting: {
      channel_test_message: normalized['monitor_setting.channel_test_message'],
      channel_test_use_channel_style:
        normalized['monitor_setting.channel_test_use_channel_style'],
      channel_test_show_response_preview:
        normalized['monitor_setting.channel_test_show_response_preview'],
    },
  }
}

function normalizeFormValues(
  values: ChannelTestFormValues
): FlatChannelTestDefaults {
  return {
    'monitor_setting.channel_test_message': normalizeMessage(
      values.monitor_setting.channel_test_message
    ),
    'monitor_setting.channel_test_use_channel_style':
      values.monitor_setting.channel_test_use_channel_style,
    'monitor_setting.channel_test_show_response_preview':
      values.monitor_setting.channel_test_show_response_preview,
  }
}

export function ChannelTestSection({ defaultValues }: ChannelTestSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const normalizedDefaults = useMemo(
    () => normalizeDefaults(defaultValues),
    [defaultValues]
  )
  const formDefaults = useMemo(
    () => buildFormDefaults(defaultValues),
    [defaultValues]
  )
  const baselineRef = useRef(normalizedDefaults)
  const baselineSerializedRef = useRef(JSON.stringify(normalizedDefaults))

  const form = useForm<ChannelTestFormInput, unknown, ChannelTestFormValues>({
    resolver: zodResolver(channelTestSchema),
    defaultValues: formDefaults,
  })
  useResetForm(form, formDefaults)

  useEffect(() => {
    const normalized = normalizeDefaults(defaultValues)
    const serialized = JSON.stringify(normalized)
    if (serialized === baselineSerializedRef.current) return

    baselineRef.current = normalized
    baselineSerializedRef.current = serialized
  }, [defaultValues])

  const onSubmit = async (values: ChannelTestFormValues) => {
    const normalized = normalizeFormValues(values)
    const updates = (
      Object.keys(normalized) as Array<keyof FlatChannelTestDefaults>
    ).filter((key) => normalized[key] !== baselineRef.current[key])

    if (updates.length === 0) {
      toast.info(t('No changes to save'))
      return
    }
    for (const key of updates) {
      await updateOption.mutateAsync({ key, value: normalized[key] })
    }
    baselineRef.current = normalized
    baselineSerializedRef.current = JSON.stringify(normalized)
  }

  return (
    <SettingsSection title={t('Channel Test')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending}
          />

          <div className='flex min-w-0 flex-col gap-4'>
            <div className='flex flex-col gap-1'>
              <h4 className='text-sm font-medium'>{t('Test request')}</h4>
              <p className='text-muted-foreground text-xs'>
                {t(
                  'Set the shared request used when the system checks channel connections.'
                )}
              </p>
            </div>
            <FormField
              control={form.control}
              name='monitor_setting.channel_test_message'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Default test message')}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} maxLength={4096} {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('Used by scheduled and detailed channel tests.')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className='grid min-w-0 gap-6 lg:grid-cols-2'>
              <FormField
                control={form.control}
                name='monitor_setting.channel_test_use_channel_style'
                render={({ field }) => (
                  <SettingsSwitchItem>
                    <SettingsSwitchContent>
                      <FormLabel>{t('Use channel style')}</FormLabel>
                      <FormDescription>
                        {t(
                          'Keep the channel-specific request style while testing.'
                        )}
                      </FormDescription>
                    </SettingsSwitchContent>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingsSwitchItem>
                )}
              />
              <FormField
                control={form.control}
                name='monitor_setting.channel_test_show_response_preview'
                render={({ field }) => (
                  <SettingsSwitchItem>
                    <SettingsSwitchContent>
                      <FormLabel>{t('Show response preview')}</FormLabel>
                      <FormDescription>
                        {t(
                          'Show a short, sanitized response preview in detailed test results.'
                        )}
                      </FormDescription>
                    </SettingsSwitchContent>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingsSwitchItem>
                )}
              />
            </div>
          </div>
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}

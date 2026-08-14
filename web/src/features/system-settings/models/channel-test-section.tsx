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
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
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
import { safeNumberFieldProps } from '../utils/numeric-field'

const channelTestModes = ['scheduled_all', 'passive_recovery'] as const
type ChannelTestMode = (typeof channelTestModes)[number]

const channelTestSchema = z.object({
  AutomaticEnableChannelEnabled: z.boolean(),
  monitor_setting: z.object({
    channel_test_message: z.string().max(4096),
    channel_test_use_channel_style: z.boolean(),
    channel_test_show_response_preview: z.boolean(),
    auto_test_channel_enabled: z.boolean(),
    auto_test_channel_minutes: z.coerce
      .number()
      .int()
      .min(1, 'Interval must be at least 1 minute'),
    channel_test_mode: z.enum(channelTestModes),
  }),
})

type ChannelTestFormInput = z.input<typeof channelTestSchema>
type ChannelTestFormValues = z.output<typeof channelTestSchema>

type FlatChannelTestDefaults = {
  AutomaticEnableChannelEnabled: boolean
  'monitor_setting.channel_test_message': string
  'monitor_setting.channel_test_use_channel_style': boolean
  'monitor_setting.channel_test_show_response_preview': boolean
  'monitor_setting.auto_test_channel_enabled': boolean
  'monitor_setting.auto_test_channel_minutes': number
  'monitor_setting.channel_test_mode': ChannelTestMode | 'auto_ban_only'
}

type ChannelTestSectionProps = {
  defaultValues: FlatChannelTestDefaults
}

function normalizeChannelTestMode(value?: string): ChannelTestMode {
  return value === 'passive_recovery' ? 'passive_recovery' : 'scheduled_all'
}

function normalizeMessage(value: string) {
  return value.replaceAll('\r\n', '\n').trim() || '你好，请简单介绍一下你自己。'
}

function normalizeDefaults(
  defaults: FlatChannelTestDefaults
): FlatChannelTestDefaults {
  return {
    AutomaticEnableChannelEnabled: defaults.AutomaticEnableChannelEnabled,
    'monitor_setting.channel_test_message': normalizeMessage(
      defaults['monitor_setting.channel_test_message'] ?? ''
    ),
    'monitor_setting.channel_test_use_channel_style':
      defaults['monitor_setting.channel_test_use_channel_style'] ?? true,
    'monitor_setting.channel_test_show_response_preview':
      defaults['monitor_setting.channel_test_show_response_preview'] ?? false,
    'monitor_setting.auto_test_channel_enabled':
      defaults['monitor_setting.auto_test_channel_enabled'],
    'monitor_setting.auto_test_channel_minutes':
      defaults['monitor_setting.auto_test_channel_minutes'] ?? 10,
    'monitor_setting.channel_test_mode': normalizeChannelTestMode(
      defaults['monitor_setting.channel_test_mode']
    ),
  }
}

function buildFormDefaults(
  defaults: FlatChannelTestDefaults
): ChannelTestFormInput {
  const normalized = normalizeDefaults(defaults)
  return {
    AutomaticEnableChannelEnabled: normalized.AutomaticEnableChannelEnabled,
    monitor_setting: {
      channel_test_message: normalized['monitor_setting.channel_test_message'],
      channel_test_use_channel_style:
        normalized['monitor_setting.channel_test_use_channel_style'],
      channel_test_show_response_preview:
        normalized['monitor_setting.channel_test_show_response_preview'],
      auto_test_channel_enabled:
        normalized['monitor_setting.auto_test_channel_enabled'],
      auto_test_channel_minutes:
        normalized['monitor_setting.auto_test_channel_minutes'],
      channel_test_mode: normalized[
        'monitor_setting.channel_test_mode'
      ] as ChannelTestMode,
    },
  }
}

function normalizeFormValues(
  values: ChannelTestFormValues
): FlatChannelTestDefaults {
  return {
    AutomaticEnableChannelEnabled: values.AutomaticEnableChannelEnabled,
    'monitor_setting.channel_test_message': normalizeMessage(
      values.monitor_setting.channel_test_message
    ),
    'monitor_setting.channel_test_use_channel_style':
      values.monitor_setting.channel_test_use_channel_style,
    'monitor_setting.channel_test_show_response_preview':
      values.monitor_setting.channel_test_show_response_preview,
    'monitor_setting.auto_test_channel_enabled':
      values.monitor_setting.auto_test_channel_enabled,
    'monitor_setting.auto_test_channel_minutes':
      values.monitor_setting.auto_test_channel_minutes,
    'monitor_setting.channel_test_mode':
      values.monitor_setting.channel_test_mode,
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

  const channelTestMode = form.watch('monitor_setting.channel_test_mode')

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

          <Separator />

          <div className='flex min-w-0 flex-col gap-4'>
            <div className='flex flex-col gap-1'>
              <h4 className='text-sm font-medium'>
                {t('Channel health checks')}
              </h4>
              <p className='text-muted-foreground text-xs'>
                {t('Set how the system checks channels in the background.')}
              </p>
            </div>
            <div className='grid min-w-0 gap-6 lg:grid-cols-3'>
              <FormField
                control={form.control}
                name='monitor_setting.auto_test_channel_enabled'
                render={({ field }) => (
                  <SettingsSwitchItem>
                    <SettingsSwitchContent>
                      <FormLabel>{t('Scheduled channel tests')}</FormLabel>
                      <FormDescription>
                        {t('Automatically probe channels in the background.')}
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
                name='monitor_setting.channel_test_mode'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Channel test mode')}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue>
                            {field.value === 'passive_recovery'
                              ? t('Passive recovery only')
                              : t('Scheduled full test')}
                          </SelectValue>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectGroup>
                          <SelectItem value='scheduled_all'>
                            {t('Scheduled full test')}
                          </SelectItem>
                          <SelectItem value='passive_recovery'>
                            {t('Passive recovery only')}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {channelTestMode === 'passive_recovery'
                        ? t(
                            'Only recheck channels disabled after real request failures.'
                          )
                        : t(
                            'Check all channels that are not manually disabled.'
                          )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='monitor_setting.auto_test_channel_minutes'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Test interval (minutes)')}</FormLabel>
                    <FormControl>
                      <Input
                        type='number'
                        min={1}
                        step={1}
                        {...safeNumberFieldProps(field)}
                      />
                    </FormControl>
                    <FormDescription>
                      {t('How often the system runs channel tests.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='AutomaticEnableChannelEnabled'
                render={({ field }) => (
                  <SettingsSwitchItem>
                    <SettingsSwitchContent>
                      <FormLabel>{t('Re-enable on success')}</FormLabel>
                      <FormDescription>
                        {t(
                          'Bring channels back online after a successful check.'
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

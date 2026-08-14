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
import { Textarea } from '@/components/ui/textarea'

import { SettingsForm } from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

const CHANNEL_TEST_MESSAGE_MAX_LENGTH = 4096

const channelTestSchema = z.object({
  monitor_setting: z.object({
    channel_test_message: z.string().max(CHANNEL_TEST_MESSAGE_MAX_LENGTH),
  }),
})

type ChannelTestFormInput = z.input<typeof channelTestSchema>
type ChannelTestFormValues = z.output<typeof channelTestSchema>

type FlatChannelTestDefaults = {
  'monitor_setting.channel_test_message': string
}

function normalizeMessage(value: string) {
  return value.replaceAll('\r\n', '\n').trim()
}

function buildFormDefaults(
  defaults: FlatChannelTestDefaults
): ChannelTestFormInput {
  return {
    monitor_setting: {
      channel_test_message: defaults['monitor_setting.channel_test_message'],
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
  }
}

type ChannelTestSectionProps = {
  defaultValues: FlatChannelTestDefaults
}

export function ChannelTestSection({ defaultValues }: ChannelTestSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const normalizedDefaults = useMemo(
    () =>
      normalizeFormValues(
        buildFormDefaults(defaultValues) as ChannelTestFormValues
      ),
    [defaultValues]
  )
  const formDefaults = useMemo(
    () => buildFormDefaults(defaultValues),
    [defaultValues]
  )
  const baselineRef = useRef<FlatChannelTestDefaults>(normalizedDefaults)
  const baselineSerializedRef = useRef(JSON.stringify(normalizedDefaults))

  const form = useForm<ChannelTestFormInput, unknown, ChannelTestFormValues>({
    resolver: zodResolver(channelTestSchema),
    defaultValues: formDefaults,
  })

  useEffect(() => {
    const serialized = JSON.stringify(normalizedDefaults)
    if (serialized === baselineSerializedRef.current) return

    baselineRef.current = normalizedDefaults
    baselineSerializedRef.current = serialized
    form.reset(formDefaults)
  }, [form, formDefaults, normalizedDefaults])

  const onSubmit = async (values: ChannelTestFormValues) => {
    const normalized = normalizeFormValues(values)
    const key = 'monitor_setting.channel_test_message' as const

    if (normalized[key] === baselineRef.current[key]) {
      toast.info(t('No changes to save'))
      return
    }

    await updateOption.mutateAsync({
      key,
      value: normalized[key],
    })

    baselineRef.current = normalized
    baselineSerializedRef.current = JSON.stringify(normalized)
    form.reset(buildFormDefaults(normalized))
  }

  return (
    <SettingsSection title={t('Channel Test')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending}
          />

          <FormField
            control={form.control}
            name='monitor_setting.channel_test_message'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Default test message')}</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    maxLength={CHANNEL_TEST_MESSAGE_MAX_LENGTH}
                    rows={5}
                    placeholder={t(
                      'Enter the default message used for channel tests.'
                    )}
                  />
                </FormControl>
                <FormDescription>
                  {t(
                    'Used by scheduled and detailed channel tests when no temporary message is entered. The same prompt is used for image generation tests.'
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}

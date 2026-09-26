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
import { Code2, Palette } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import * as z from 'zod'

import { JsonCodeEditor } from '@/components/json-code-editor'
import { Button } from '@/components/ui/button'
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
import { capsOfRpm, RPM_MAX, rpmOfCaps } from '@/lib/request-rate-limit'

import {
  SettingsControlChildren,
  SettingsControlGroup,
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import type { SecuritySettings } from '../types'
import { RateLimitVisualEditor } from './rate-limit-visual-editor'

const isValidJSON = (value: string | undefined) => {
  if (!value || value.trim() === '') return true
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    for (const [, val] of Object.entries(parsed)) {
      if (!Array.isArray(val) || val.length !== 2) return false
      if (typeof val[0] !== 'number' || typeof val[1] !== 'number') return false
      if (val[0] < 0 || val[1] < 1) return false
      if (val[0] > 2147483647 || val[1] > 2147483647) return false
    }
    return true
  } catch {
    return false
  }
}

const createRateLimitSchema = (t: (key: string) => string) =>
  z.object({
    defaultRpm: z.number().int().min(0).max(RPM_MAX),
    groups: z
      .string()
      .optional()
      .refine(isValidJSON, {
        message: t('Invalid JSON format or values out of allowed range'),
      }),
    siteLimitEnabled: z.boolean(),
    siteRpm: z.number().int().min(0).max(RPM_MAX),
  })

type RateLimitFormValues = z.infer<ReturnType<typeof createRateLimitSchema>>

type RateLimitSettings = Pick<
  SecuritySettings,
  | 'ModelRequestRateLimitEnabled'
  | 'ModelRequestRateLimitCount'
  | 'ModelRequestRateLimitSuccessCount'
  | 'ModelRequestRateLimitGroup'
  | 'ModelRequestRateLimitGlobalCount'
  | 'ModelRequestRateLimitGlobalSuccessCount'
>

type RateLimitSectionProps = {
  defaultValues: RateLimitSettings
}

/** The form's values for the stored options: each limit as one RPM. */
function rateLimitFormValues(settings: RateLimitSettings): RateLimitFormValues {
  return {
    defaultRpm: rpmOfCaps({
      count: settings.ModelRequestRateLimitCount,
      success_count: settings.ModelRequestRateLimitSuccessCount,
    }),
    groups: settings.ModelRequestRateLimitGroup,
    siteLimitEnabled: settings.ModelRequestRateLimitEnabled,
    siteRpm: rpmOfCaps({
      count: settings.ModelRequestRateLimitGlobalCount,
      success_count: settings.ModelRequestRateLimitGlobalSuccessCount,
    }),
  }
}

export function RateLimitSection(props: RateLimitSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const [useVisualEditor, setUseVisualEditor] = useState(true)

  const rateLimitSchema = createRateLimitSchema(t)
  const initialValues = useMemo(
    () => rateLimitFormValues(props.defaultValues),
    [props.defaultValues]
  )

  const form = useForm<RateLimitFormValues>({
    resolver: zodResolver(rateLimitSchema),
    mode: 'onChange', // Enable real-time validation
    defaultValues: initialValues,
  })

  useEffect(() => {
    form.reset(initialValues)
  }, [initialValues, form])

  const siteLimitEnabled = form.watch('siteLimitEnabled')

  const onSubmit = async (values: RateLimitFormValues) => {
    // An RPM is stored as both of its option's caps, and only once it changes,
    // so saving the page leaves caps set another way as they are.
    const updates: { key: string; value: string | number | boolean }[] = []
    if (values.defaultRpm !== initialValues.defaultRpm) {
      const caps = capsOfRpm(values.defaultRpm)
      updates.push(
        { key: 'ModelRequestRateLimitCount', value: caps.count },
        { key: 'ModelRequestRateLimitSuccessCount', value: caps.success_count }
      )
    }
    if ((values.groups ?? '') !== (initialValues.groups ?? '')) {
      updates.push({
        key: 'ModelRequestRateLimitGroup',
        value: values.groups ?? '',
      })
    }
    if (values.siteLimitEnabled !== initialValues.siteLimitEnabled) {
      updates.push({
        key: 'ModelRequestRateLimitEnabled',
        value: values.siteLimitEnabled,
      })
    }
    if (values.siteRpm !== initialValues.siteRpm) {
      const caps = capsOfRpm(values.siteRpm)
      updates.push(
        { key: 'ModelRequestRateLimitGlobalCount', value: caps.count },
        {
          key: 'ModelRequestRateLimitGlobalSuccessCount',
          value: caps.success_count,
        }
      )
    }

    for (const update of updates) {
      await updateOption.mutateAsync(update)
    }
  }

  return (
    <SettingsSection title={t('Rate Limiting')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending}
            saveLabel='Save rate limits'
          />
          <p className='text-muted-foreground text-sm'>
            {t(
              "Every user is always held to their own RPM: the one set for them, else their group's, else the default."
            )}
          </p>

          <FormField
            control={form.control}
            name='defaultRpm'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Default RPM')}</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    min={0}
                    max={RPM_MAX}
                    step={1}
                    {...field}
                    onChange={(e) =>
                      field.onChange(Number.parseInt(e.target.value) || 0)
                    }
                  />
                </FormControl>
                <FormDescription>
                  {t(
                    'For users whose group has no RPM of its own. 0 = unlimited.'
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='groups'
            render={({ field }) => (
              <FormItem>
                <div className='flex items-center justify-between'>
                  <FormLabel>{t('Group RPM')}</FormLabel>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => setUseVisualEditor(!useVisualEditor)}
                  >
                    {useVisualEditor ? (
                      <>
                        <Code2 className='mr-2 h-4 w-4' />
                        {t('JSON Mode')}
                      </>
                    ) : (
                      <>
                        <Palette className='mr-2 h-4 w-4' />
                        {t('Visual Mode')}
                      </>
                    )}
                  </Button>
                </div>
                <FormControl>
                  {useVisualEditor ? (
                    <RateLimitVisualEditor
                      value={field.value || ''}
                      onChange={field.onChange}
                    />
                  ) : (
                    <JsonCodeEditor
                      value={field.value || ''}
                      onChange={field.onChange}
                      name={field.name}
                      onBlur={field.onBlur}
                      textareaRef={field.ref}
                      placeholder={`{\n  "default": [60, 60],\n  "vip": [300, 300]\n}`}
                      aria-invalid={Boolean(form.formState.errors.groups)}
                    />
                  )}
                </FormControl>
                {!useVisualEditor && (
                  <FormDescription>
                    <div className='space-y-1 text-xs'>
                      <p className='font-semibold'>{t('Format:')}</p>
                      <ul className='list-inside list-disc space-y-0.5 pl-2'>
                        <li>
                          {t('JSON object:')}{' '}
                          {`{"groupName": [maxRequests, maxSuccess]}`}
                        </li>
                        <li>
                          {t('Example:')}{' '}
                          {`{"default": [60, 60], "vip": [300, 300]}`}
                        </li>
                        <li>
                          {t(
                            'maxRequests ≥ 0, maxSuccess ≥ 1, both ≤ 2,147,483,647'
                          )}
                        </li>
                        <li>
                          {t(
                            'A group RPM replaces the default for users in that group'
                          )}
                        </li>
                      </ul>
                    </div>
                  </FormDescription>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          <SettingsControlGroup>
            <FormField
              control={form.control}
              name='siteLimitEnabled'
              render={({ field }) => (
                <SettingsSwitchItem>
                  <SettingsSwitchContent>
                    <FormLabel>{t('Enable site-wide limit')}</FormLabel>
                    <FormDescription>
                      {t(
                        "When on, all users' requests together stay within the site-wide RPM."
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
            {siteLimitEnabled && (
              <SettingsControlChildren>
                <FormField
                  control={form.control}
                  name='siteRpm'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('Site-wide RPM')}</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          min={0}
                          max={RPM_MAX}
                          step={1}
                          {...field}
                          onChange={(e) =>
                            field.onChange(Number.parseInt(e.target.value) || 0)
                          }
                        />
                      </FormControl>
                      <FormDescription>{t('0 = unlimited')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </SettingsControlChildren>
            )}
          </SettingsControlGroup>

          <p className='text-muted-foreground text-xs'>
            {t(
              'This controls model request rate limiting. Web/API route throttling is configured by environment variables and may still return 429.'
            )}
          </p>
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}

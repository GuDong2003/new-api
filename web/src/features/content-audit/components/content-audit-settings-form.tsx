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
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { SecureVerificationDialog } from '@/features/auth/secure-verification'
import type { ContentAuditOperation } from '@/features/auth/secure-verification/types'
import { SettingsCard } from '@/features/system-settings/components/settings-card'
import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '@/features/system-settings/components/settings-form-layout'
import { SettingsPageFormActions } from '@/features/system-settings/components/settings-page-context'

import { useContentAuditAction } from '../hooks/use-content-audit-action'
import { contentAuditSettingsSchema } from '../lib/schema'
import type { ContentAuditSettings, ContentAuditStatus } from '../types'

export function ContentAuditSettingsForm(props: {
  status: ContentAuditStatus
}) {
  const { t } = useTranslation()
  const state = props.status.state
  // A status refresh must not lend a newer version to an older draft.
  const [expectedVersion, setExpectedVersion] = useState(state.config_version)
  const defaults = contentAuditSettingsSchema.parse(state)
  const form = useForm<ContentAuditSettings>({
    resolver: zodResolver(contentAuditSettingsSchema),
    defaultValues: defaults,
  })
  const action = useContentAuditAction()
  const [confirmation, setConfirmation] =
    useState<ContentAuditOperation | null>(null)
  const busy = action.mutation.isPending
  const canEnable = Boolean(state.storage_id) && props.status.ready
  const plaintextAcknowledged = form.watch('plaintext_acknowledged')
  const submit = form.handleSubmit((values) => {
    setConfirmation({
      scope: 'content_audit.settings.update',
      context: { expected_version: expectedVersion, ...values },
    })
  })
  const numbers = [
    {
      name: 'retention_days',
      label: t('Retention (days)'),
      min: 1,
      max: 30,
      help: t('1–30 days. Changes apply to new records only.'),
    },
    {
      name: 'request_limit',
      label: t('Request body limit (bytes)'),
      min: 65536,
      max: 2097152,
      help: '64 KiB–2 MiB',
    },
    {
      name: 'response_limit',
      label: t('Response body limit (bytes)'),
      min: 65536,
      max: 4194304,
      help: '64 KiB–4 MiB',
    },
    {
      name: 'capacity_bytes',
      label: t('Storage capacity (bytes)'),
      min: 67108864,
      max: 10737418240,
      help: '64 MiB–10 GiB',
    },
  ] as const

  return (
    <>
      <SettingsPageFormActions
        onSave={() => void submit()}
        onReset={() => {
          form.reset(defaults)
          setExpectedVersion(state.config_version)
        }}
        isSaving={busy}
        isSaveDisabled={!form.formState.isDirty || Boolean(confirmation)}
        isResetDisabled={!form.formState.isDirty || Boolean(confirmation)}
      />
      <SettingsCard title={t('Content audit controls')}>
        <Form {...form}>
          <SettingsForm onSubmit={submit} noValidate autoComplete='off'>
            <FormField
              control={form.control}
              name='enabled'
              render={({ field }) => (
                <SettingsSwitchItem>
                  <SettingsSwitchContent>
                    <FormLabel>{t('Collect content audit records')}</FormLabel>
                    <FormDescription>
                      {t(
                        'Best-effort capture of new supported requests across all users. Disabling collection keeps existing records.'
                      )}
                    </FormDescription>
                  </SettingsSwitchContent>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={
                        busy ||
                        Boolean(confirmation) ||
                        (!state.enabled && !canEnable)
                      }
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
                        value={Number.isNaN(field.value) ? '' : field.value}
                        onChange={(event) =>
                          field.onChange(
                            event.target.value === ''
                              ? Number.NaN
                              : Number(event.target.value)
                          )
                        }
                        disabled={busy || Boolean(confirmation)}
                      />
                    </FormControl>
                    <FormDescription>{item.help}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <FormField
              control={form.control}
              name='thumbnail_enabled'
              render={({ field }) => (
                <SettingsSwitchItem>
                  <SettingsSwitchContent>
                    <FormLabel>{t('Save image thumbnails')}</FormLabel>
                    <FormDescription>
                      {t(
                        'This switch only controls previews. Original results and content share the total storage quota.'
                      )}
                    </FormDescription>
                  </SettingsSwitchContent>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={busy || Boolean(confirmation)}
                    />
                  </FormControl>
                </SettingsSwitchItem>
              )}
            />
            {((!state.storage_id && !props.status.stable_key_configured) ||
              state.mode === 'plaintext') && (
              <FormField
                control={form.control}
                name='plaintext_acknowledged'
                render={({ field }) => (
                  <FormItem className='flex items-start gap-3'>
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) =>
                          field.onChange(checked === true)
                        }
                        disabled={
                          busy ||
                          Boolean(confirmation) ||
                          state.mode === 'plaintext'
                        }
                      />
                    </FormControl>
                    <div className='space-y-2'>
                      <FormLabel>
                        {t(
                          'I acknowledge that audit content will be stored without encryption.'
                        )}
                      </FormLabel>
                      <FormDescription>
                        {t(
                          'Configure a stable CRYPTO_SECRET or SESSION_SECRET before initialization to use encryption. The encryption mode and key cannot be changed here.'
                        )}
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            )}
            {!state.storage_id && (
              <div>
                <Button
                  type='button'
                  variant='outline'
                  disabled={
                    busy ||
                    Boolean(confirmation) ||
                    !props.status.storage_configured ||
                    (!props.status.stable_key_configured &&
                      !plaintextAcknowledged)
                  }
                  onClick={() =>
                    setConfirmation({
                      scope: 'content_audit.initialize',
                      context: {
                        expected_version: expectedVersion,
                        plaintext_acknowledged: plaintextAcknowledged,
                      },
                    })
                  }
                >
                  {t('Initialize audit storage')}
                </Button>
              </div>
            )}
            {!canEnable && !state.enabled && (
              <Alert>
                <AlertDescription>
                  {t(
                    'Initialize storage and wait for local checks to pass before enabling collection.'
                  )}
                </AlertDescription>
              </Alert>
            )}
          </SettingsForm>
        </Form>
      </SettingsCard>
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
        title={
          confirmation?.scope === 'content_audit.initialize'
            ? t('Initialize audit storage')
            : t('Confirm content audit changes')
        }
        desc={t(
          'Content may contain personal information and secrets despite redaction. Restrict access, inform users, and choose an appropriate retention period. This operation requires security verification.'
        )}
        confirmText={t('Confirm')}
        handleConfirm={() => {
          if (!confirmation) return
          const operation = confirmation
          setConfirmation(null)
          action.mutation.mutate(operation, {
            onSuccess: (result) => {
              if (!result || !('state' in result)) return
              form.reset(contentAuditSettingsSchema.parse(result.state))
              setExpectedVersion(result.state.config_version)
            },
          })
        }}
      />
      <SecureVerificationDialog {...action.verification.dialogProps} />
    </>
  )
}

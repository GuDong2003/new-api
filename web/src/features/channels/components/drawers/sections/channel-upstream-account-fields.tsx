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
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { sideDrawerSwitchItemClassName } from '@/components/drawer-layout'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import {
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import type { UpstreamSiteTypeOption } from '../../../../upstream-accounts/types'
import {
  type ChannelFormValues,
  EMPTY_UPSTREAM_ACCOUNT,
} from '../../../lib/channel-form'
import {
  formatLastCheckinTime,
  getUpstreamAuthTypeLabel,
} from '../../../lib/upstream-account-display'
import type { ChannelUpstreamAccountConfig } from '../../../types'

const CHECKIN_STATUS: Record<
  NonNullable<ChannelUpstreamAccountConfig['last_checkin_status']>,
  { label: string; variant: StatusVariant }
> = {
  healthy: { label: 'Healthy', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  manual_required: {
    label: 'Manual verification required',
    variant: 'warning',
  },
  unknown: { label: 'Unknown', variant: 'neutral' },
}

type ChannelUpstreamAccountFieldsProps = {
  siteTypes: UpstreamSiteTypeOption[]
  /** The accounts as last saved, for how their latest check-in went. */
  savedAccounts?: ChannelUpstreamAccountConfig[]
}

/**
 * The check-in part of the channel editor: the upstream site's own check-in
 * and recharge pages, which a channel links to with or without accounts, and
 * the accounts that check in on the channel.
 */
export function ChannelUpstreamAccountFields(
  props: ChannelUpstreamAccountFieldsProps
) {
  const { t } = useTranslation()
  const form = useFormContext<ChannelFormValues>()
  // The account id is a form value, so the row key needs another name.
  const accounts = useFieldArray({
    control: form.control,
    name: 'upstream_accounts',
    keyName: 'key',
  })
  const watchedAccounts = useWatch({
    control: form.control,
    name: 'upstream_accounts',
  })
  const siteTypeValue = useWatch({
    control: form.control,
    name: 'upstream_account_site_type',
  })
  const siteType = props.siteTypes.find(
    (option) => option.value === (siteTypeValue || 'new_api')
  )
  const authTypes = siteType?.auth_types ?? ['token', 'cookie']
  // A saved account is deleted once the channel is saved without it, so its
  // removal is confirmed; a new one only leaves the form.
  const [pendingRemoval, setPendingRemoval] = useState<number | null>(null)
  const pendingAccount =
    pendingRemoval === null ? undefined : watchedAccounts?.[pendingRemoval]

  // Like the account page, every account follows what the site supports.
  const changeSiteType = (value: string) => {
    form.setValue('upstream_account_site_type', value, { shouldDirty: true })
    const option = props.siteTypes.find((item) => item.value === value)
    if (!option) return
    for (const [index, account] of (
      form.getValues('upstream_accounts') ?? []
    ).entries()) {
      if (!option.auth_types.includes(account.auth_type)) {
        form.setValue(
          `upstream_accounts.${index}.auth_type`,
          option.auth_types[0] ?? 'token',
          { shouldDirty: true }
        )
      }
      if (!option.supports_checkin && account.auto_checkin) {
        form.setValue(`upstream_accounts.${index}.auto_checkin`, false, {
          shouldDirty: true,
        })
      }
    }
    if (!option.supports_balance) {
      form.setValue('upstream_account_auto_balance', false, {
        shouldDirty: true,
      })
    }
  }

  return (
    <div className='min-w-0 space-y-4'>
      <div className='grid min-w-0 gap-4 sm:grid-cols-2'>
        <FormField
          control={form.control}
          name='external_checkin_url'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('External check-in URL')}</FormLabel>
              <FormControl>
                <Input
                  inputMode='url'
                  placeholder={t('Optional external check-in page')}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name='redeem_url'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Recharge / redeem URL')}</FormLabel>
              <FormControl>
                <Input
                  inputMode='url'
                  placeholder={t('Optional recharge or redeem page')}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <FormField
        control={form.control}
        name='open_redeem_with_checkin'
        render={({ field }) => (
          <FormItem className={sideDrawerSwitchItemClassName()}>
            <FormLabel>{t('Open recharge / redeem after check-in')}</FormLabel>
            <FormControl>
              <Switch
                checked={field.value === true}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />

      <div className='flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <h4 className='text-sm font-medium'>{t('Check-in accounts')}</h4>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Each account checks in on its own, and its credential is stored encrypted. Removing an account no other channel uses deletes it.'
            )}
          </p>
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() =>
            accounts.append({
              ...EMPTY_UPSTREAM_ACCOUNT,
              auth_type: authTypes[0] ?? 'token',
              auto_checkin: siteType?.supports_checkin !== false,
            })
          }
        >
          <Plus aria-hidden='true' />
          {t('Add account')}
        </Button>
      </div>

      {accounts.fields.length === 0 ? (
        <p className='text-muted-foreground rounded-lg border border-dashed p-3 text-xs'>
          {t('No account checks in on this channel yet.')}
        </p>
      ) : (
        <div className='min-w-0 space-y-4'>
          <div className='grid min-w-0 gap-4 sm:grid-cols-2'>
            <FormField
              control={form.control}
              name='upstream_account_site_type'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Site type')}</FormLabel>
                  <FormControl>
                    <Combobox
                      options={props.siteTypes.map((option) => ({
                        value: option.value,
                        label: option.label,
                      }))}
                      value={field.value || 'new_api'}
                      onValueChange={(value) =>
                        changeSiteType(value || 'new_api')
                      }
                      placeholder={t('Select site type')}
                      searchPlaceholder={t('Search site type...')}
                      emptyText={t('No site type found.')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='upstream_account_balance_interval'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t('Balance refresh interval (minutes)')}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      step={1}
                      {...field}
                      onChange={(event) =>
                        field.onChange(Number(event.target.value))
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'This only affects scheduled refreshes; the channel card can refresh manually at any time.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={form.control}
            name='upstream_account_auto_balance'
            render={({ field }) => (
              <FormItem className={sideDrawerSwitchItemClassName()}>
                <div className='flex min-w-0 flex-col gap-0.5'>
                  <FormLabel>{t('Automatic balance refresh')}</FormLabel>
                  <FormDescription className='text-xs'>
                    {t('Refresh the stored balance on the schedule.')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value !== false}
                    disabled={siteType?.supports_balance === false}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          {accounts.fields.map((account, index) => {
            const authType = watchedAccounts?.[index]?.auth_type
            const saved = props.savedAccounts?.find(
              (item) => item.id !== undefined && item.id === account.id
            )
            const lastCheckinTime = formatLastCheckinTime(
              saved?.last_checkin_time
            )
            const status =
              CHECKIN_STATUS[saved?.last_checkin_status ?? 'unknown']
            let credentialPlaceholder = t('Enter pass token')
            if (authType === 'cookie') {
              credentialPlaceholder = t('Enter browser cookie')
            }
            if (account.id) {
              credentialPlaceholder = t(
                'Already configured; leave empty to keep it'
              )
            }
            const title = t('Account {{number}}', { number: index + 1 })
            return (
              <div
                key={account.key}
                role='group'
                aria-label={title}
                className='min-w-0 space-y-4 rounded-lg border p-3'
              >
                <div className='flex items-center justify-between gap-2'>
                  <span className='text-sm font-medium'>{title}</span>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon-sm'
                    aria-label={t('Remove account {{number}}', {
                      number: index + 1,
                    })}
                    onClick={() => {
                      if (account.id) setPendingRemoval(index)
                      else accounts.remove(index)
                    }}
                  >
                    <Trash2 aria-hidden='true' />
                  </Button>
                </div>
                <div className='grid min-w-0 gap-4 sm:grid-cols-2'>
                  <FormField
                    control={form.control}
                    name={`upstream_accounts.${index}.name`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Name')}</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={t(
                              'Leave empty to name it after the channel'
                            )}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`upstream_accounts.${index}.user_id`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Upstream user ID')}</FormLabel>
                        <FormControl>
                          <Input
                            type='number'
                            step={1}
                            placeholder={t('Upstream user ID (optional)')}
                            value={field.value ?? ''}
                            onChange={(event) => {
                              const value = event.target.value.trim()
                              field.onChange(
                                value === ''
                                  ? undefined
                                  : Math.max(0, Math.trunc(Number(value)) || 0)
                              )
                            }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`upstream_accounts.${index}.auth_type`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Authentication')}</FormLabel>
                        <Select
                          value={field.value || 'token'}
                          onValueChange={field.onChange}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue>
                                {getUpstreamAuthTypeLabel(field.value, t)}
                              </SelectValue>
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {authTypes.map((authType) => (
                              <SelectItem key={authType} value={authType}>
                                {getUpstreamAuthTypeLabel(authType, t)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`upstream_accounts.${index}.credential`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {getUpstreamAuthTypeLabel(authType, t)}
                        </FormLabel>
                        <FormControl>
                          <Input
                            type='password'
                            autoComplete='new-password'
                            placeholder={credentialPlaceholder}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name={`upstream_accounts.${index}.auto_checkin`}
                  render={({ field }) => (
                    <FormItem className={sideDrawerSwitchItemClassName()}>
                      <FormLabel>{t('Automatic check-in')}</FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value === true}
                          disabled={siteType?.supports_checkin === false}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                {lastCheckinTime && (
                  <div className='text-muted-foreground flex flex-wrap items-center justify-end gap-2 text-xs'>
                    <span>
                      {t('Last check-in time')}: {lastCheckinTime}
                    </span>
                    <StatusBadge
                      label={t(status.label)}
                      variant={status.variant}
                      copyable={false}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null)
        }}
        title={t('Remove this account?')}
        desc={t(
          'Once the channel is saved, {{name}} and its check-in history are deleted, unless another channel still uses the account.',
          { name: pendingAccount?.name || t('this account') }
        )}
        confirmText={t('Remove')}
        destructive
        handleConfirm={() => {
          if (pendingRemoval !== null) accounts.remove(pendingRemoval)
          setPendingRemoval(null)
        }}
      />
    </div>
  )
}

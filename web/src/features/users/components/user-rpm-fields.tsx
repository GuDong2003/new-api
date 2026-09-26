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
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { sideDrawerSwitchItemClassName } from '@/components/drawer-layout'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { RPM_MAX } from '@/lib/request-rate-limit'

import type { UserFormValues } from '../lib'

/** The user drawer's own RPM for a user: a switch, then the RPM while on. */
export function UserRpmFields(props: { disabled?: boolean }) {
  const { t } = useTranslation()
  const form = useFormContext<UserFormValues>()
  const enabled = form.watch('rpm_limit.enabled')

  return (
    <div className='flex flex-col gap-3'>
      <FormField
        control={form.control}
        name='rpm_limit.enabled'
        render={({ field }) => (
          <FormItem className={sideDrawerSwitchItemClassName()}>
            <div className='flex flex-col gap-0.5'>
              <FormLabel className='text-sm'>
                {t('Set an RPM for this user')}
              </FormLabel>
              <FormDescription className='text-xs'>
                {t(
                  'When off, the user follows their group RPM, or the default when the group has none.'
                )}
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={props.disabled}
              />
            </FormControl>
          </FormItem>
        )}
      />
      {enabled && (
        <FormField
          control={form.control}
          name='rpm_limit.rpm'
          render={({ field }) => (
            <FormItem>
              <FormLabel>RPM</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type='number'
                  min={1}
                  max={RPM_MAX}
                  step={1}
                  disabled={props.disabled}
                  onChange={(e) =>
                    field.onChange(Number.parseInt(e.target.value, 10) || 0)
                  }
                />
              </FormControl>
              <FormDescription>
                {t('Requests per minute, failed ones included')}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </div>
  )
}

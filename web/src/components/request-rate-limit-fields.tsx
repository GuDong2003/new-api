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
import {
  REQUEST_RATE_LIMIT_MAX,
  type RequestRateLimitFieldsValues,
} from '@/lib/request-rate-limit'

type RequestRateLimitFormValues = {
  rate_limit: RequestRateLimitFieldsValues
}

type RequestRateLimitFieldsProps = {
  /** Names what turning the switch on does. */
  label: string
  /** Says what applies while the switch is off. */
  description: string
  disabled?: boolean
}

/**
 * The request limit fields of a form that keeps them under `rate_limit`: a
 * switch, then the two caps while it is on.
 */
export function RequestRateLimitFields(props: RequestRateLimitFieldsProps) {
  const { t } = useTranslation()
  const form = useFormContext<RequestRateLimitFormValues>()
  const enabled = form.watch('rate_limit.enabled')

  return (
    <div className='flex flex-col gap-3'>
      <FormField
        control={form.control}
        name='rate_limit.enabled'
        render={({ field }) => (
          <FormItem className={sideDrawerSwitchItemClassName()}>
            <div className='flex flex-col gap-0.5'>
              <FormLabel className='text-sm'>{props.label}</FormLabel>
              <FormDescription className='text-xs'>
                {props.description}
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
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
          <FormField
            control={form.control}
            name='rate_limit.count'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Max requests per period')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type='number'
                    min={0}
                    max={REQUEST_RATE_LIMIT_MAX}
                    step={1}
                    disabled={props.disabled}
                    onChange={(e) =>
                      field.onChange(Number.parseInt(e.target.value, 10) || 0)
                    }
                  />
                </FormControl>
                <FormDescription>
                  {t('Including failed requests, 0 = unlimited')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='rate_limit.success_count'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Max successful requests')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type='number'
                    min={1}
                    max={REQUEST_RATE_LIMIT_MAX}
                    step={1}
                    disabled={props.disabled}
                    onChange={(e) =>
                      field.onChange(Number.parseInt(e.target.value, 10) || 1)
                    }
                  />
                </FormControl>
                <FormDescription>
                  {t('Only successful requests')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}
    </div>
  )
}

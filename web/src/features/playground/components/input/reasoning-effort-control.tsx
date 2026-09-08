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
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * Suggestions only. Each upstream provider accepts a different set of levels
 * and adds new ones over time, so the value stays free text.
 */
const EFFORT_OPTIONS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

const MAX_EFFORT_LENGTH = 64

type ReasoningEffortControlProps = {
  value: string
  enabled: boolean
  disabled?: boolean
  onValueChange: (value: string) => void
  onEnabledChange: (value: boolean) => void
}

export function ReasoningEffortControl(props: ReasoningEffortControlProps) {
  const { t } = useTranslation()
  const id = useId()
  const inputDisabled = props.disabled || !props.enabled

  return (
    <div
      className={cn(
        'border-border/70 bg-background/60 grid gap-2 rounded-lg border p-3 transition-opacity',
        inputDisabled && 'opacity-55'
      )}
    >
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0 space-y-1'>
          <label className='text-sm leading-5 font-medium' htmlFor={id}>
            {t('Reasoning Effort')}
          </label>
          <p
            className='text-muted-foreground text-xs leading-4'
            id={`${id}-description`}
          >
            {t(
              'Controls how much the model thinks. Supported levels depend on the model; you can also enter a custom value.'
            )}
          </p>
        </div>

        <Switch
          aria-label={t('Enable {{parameter}}', {
            parameter: t('Reasoning Effort'),
          })}
          checked={props.enabled}
          disabled={props.disabled}
          onCheckedChange={(checked) => props.onEnabledChange(checked)}
          size='sm'
        />
      </div>

      <Combobox
        disabled={inputDisabled}
        inputValue={props.value}
        items={EFFORT_OPTIONS}
        onInputValueChange={(value) => props.onValueChange(value)}
        onValueChange={(value) => {
          if (typeof value === 'string') props.onValueChange(value)
        }}
        value={props.value || null}
      >
        <ComboboxInput
          aria-describedby={`${id}-description`}
          disabled={inputDisabled}
          id={id}
          maxLength={MAX_EFFORT_LENGTH}
          placeholder={t('Select or type...')}
          showTrigger={false}
        />
        <ComboboxContent>
          <ComboboxEmpty>
            {t('Use a value supported by the selected model.')}
          </ComboboxEmpty>
          <ComboboxList>
            {(option: string) => (
              <ComboboxItem key={option} value={option}>
                {option}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  )
}

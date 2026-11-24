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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Field, FieldTitle } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { formatNumber } from '@/lib/format'

type ImageDimensionFieldsProps = {
  width: number
  height: number
  maxDimension: number
  disabled: boolean
  onChange: (size: string) => boolean
}

export function ImageDimensionFields(props: ImageDimensionFieldsProps) {
  const { t } = useTranslation()
  const [alignToStep, setAlignToStep] = useState(true)

  return (
    <Field aria-labelledby='drawing-dimensions-label'>
      <div className='flex items-center justify-between gap-2'>
        <FieldTitle id='drawing-dimensions-label'>{t('Image size')}</FieldTitle>
        <div className='flex items-center gap-2'>
          <Label
            htmlFor='drawing-align-dimensions'
            className='text-muted-foreground text-xs'
          >
            {t('Align to multiples of 16')}
          </Label>
          <Switch
            id='drawing-align-dimensions'
            size='sm'
            checked={alignToStep}
            disabled={props.disabled}
            onCheckedChange={setAlignToStep}
          />
        </div>
      </div>
      <div className='grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2'>
        {(['width', 'height'] as const).map((dimension) => (
          <InputGroup
            key={dimension}
            className={
              dimension === 'height'
                ? 'col-start-3 row-start-1'
                : 'col-start-1 row-start-1'
            }
          >
            <InputGroupAddon aria-hidden='true'>
              {dimension === 'width' ? 'W' : 'H'}
            </InputGroupAddon>
            <InputGroupInput
              key={props[dimension]}
              type='number'
              className='text-center'
              aria-label={dimension === 'width' ? t('Width') : t('Height')}
              defaultValue={props[dimension]}
              min={1}
              step={1}
              max={props.disabled ? undefined : props.maxDimension}
              disabled={props.disabled}
              onBlur={(event) => {
                const input = event.currentTarget
                const value = Math.floor(input.valueAsNumber)
                if (!Number.isFinite(value) || value < 1) {
                  input.value = String(props[dimension])
                  return
                }
                const dimensions = {
                  width: props.width,
                  height: props.height,
                  [dimension]: value,
                }
                if (alignToStep) {
                  dimensions.width = Math.ceil(dimensions.width / 16) * 16
                  dimensions.height = Math.ceil(dimensions.height / 16) * 16
                }
                if (
                  Math.max(dimensions.width, dimensions.height) >
                  props.maxDimension
                ) {
                  toast.error(
                    t('Width and height must each be at most {{max}} pixels.', {
                      max: formatNumber(props.maxDimension),
                    })
                  )
                  return
                }
                if (
                  dimensions.width === props.width &&
                  dimensions.height === props.height
                ) {
                  input.value = String(props[dimension])
                  return
                }
                const accepted = props.onChange(
                  `${dimensions.width}x${dimensions.height}`
                )
                input.value = String(
                  accepted ? dimensions[dimension] : props[dimension]
                )
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
          </InputGroup>
        ))}
        <span
          aria-hidden='true'
          className='text-muted-foreground col-start-2 row-start-1'
        >
          ↔
        </span>
      </div>
    </Field>
  )
}

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
import {
  AiChat02Icon,
  ArrowDown01Icon,
  CodeIcon,
  FunctionSquareIcon,
  Pulse01Icon,
  Settings02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'

import {
  CHANNEL_PROBES,
  CHANNEL_TEST_ENDPOINTS,
  type ChannelProbeId,
} from '../../lib/channel-test'

const probeIcons = [AiChat02Icon, Pulse01Icon, FunctionSquareIcon, CodeIcon]

export function ChannelProbeEndpointSelect(props: {
  value: string
  onChange: (value: string) => void
  label: string
  disabled?: boolean
  inherited?: boolean
  compact?: boolean
}) {
  const { t } = useTranslation()
  const items = [
    ...(props.inherited
      ? [{ value: 'inherit', label: t('Use default endpoint') }]
      : []),
    ...CHANNEL_TEST_ENDPOINTS.map((endpoint) => ({
      value: endpoint.value,
      label: t(endpoint.labelKey),
    })),
  ]

  return (
    <Select
      items={items}
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value) props.onChange(value)
      }}
    >
      <SelectTrigger
        aria-label={props.label}
        size={props.compact ? 'sm' : 'default'}
        className={cn(
          'min-w-0',
          props.compact
            ? 'max-w-56 border-transparent px-0 text-xs'
            : 'w-full sm:w-64'
        )}
      >
        <SelectValue className='min-w-0 truncate' />
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        className='w-80 max-w-[calc(100vw-2rem)]'
      >
        <SelectGroup>
          {props.inherited && (
            <SelectItem value='inherit'>{t('Use default endpoint')}</SelectItem>
          )}
          {CHANNEL_TEST_ENDPOINTS.map((endpoint) => (
            <SelectItem key={endpoint.value} value={endpoint.value}>
              <span className='flex min-w-0 flex-col gap-0.5'>
                <span>{t(endpoint.labelKey)}</span>
                {endpoint.path && (
                  <span className='text-muted-foreground font-mono text-[11px] break-all whitespace-normal'>
                    {endpoint.path}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function ChannelTestControls(props: {
  selected: ChannelProbeId[]
  onSelectedChange: (value: ChannelProbeId[]) => void
  endpoint: string
  onEndpointChange: (value: string) => void
  message: string
  onMessageChange: (value: string) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [capabilitiesExpanded, setCapabilitiesExpanded] = useState(false)
  const capabilitiesOpen = !isMobile || capabilitiesExpanded

  return (
    <Collapsible className='flex shrink-0 flex-col gap-3 border-b px-4 pb-4 sm:px-6'>
      <Collapsible
        open={capabilitiesOpen}
        onOpenChange={setCapabilitiesExpanded}
        className='min-w-0'
      >
        {isMobile && (
          <CollapsibleTrigger
            render={<Button variant='outline' />}
            className='h-10 w-full justify-between gap-3 px-3'
          >
            <span>{t('Test capabilities')}</span>
            <Badge variant='secondary' className='ml-auto tabular-nums'>
              {t('{{selected}} / {{total}} selected', {
                selected: props.selected.length,
                total: CHANNEL_PROBES.length,
              })}
            </Badge>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              aria-hidden='true'
              className={cn(
                'text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none',
                capabilitiesOpen && 'rotate-180'
              )}
            />
          </CollapsibleTrigger>
        )}
        <CollapsibleContent className='pt-2 md:pt-0'>
          <fieldset
            disabled={props.disabled}
            className='min-w-0'
            aria-label={t('Test capabilities')}
          >
            <legend
              className={cn(
                'text-muted-foreground text-xs font-medium',
                isMobile ? 'sr-only' : 'mb-2'
              )}
            >
              {t('Test capabilities')}
            </legend>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
              {CHANNEL_PROBES.map((probe, index) => {
                const checked = props.selected.includes(probe.id)
                return (
                  <label
                    key={probe.id}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 transition-colors',
                      checked
                        ? 'border-primary/35 bg-primary/5'
                        : 'border-border text-muted-foreground',
                      props.disabled && 'cursor-default opacity-60'
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={props.disabled}
                      onCheckedChange={(value) =>
                        props.onSelectedChange(
                          value
                            ? [...props.selected, probe.id]
                            : props.selected.filter((item) => item !== probe.id)
                        )
                      }
                    />
                    <HugeiconsIcon
                      icon={probeIcons[index] ?? AiChat02Icon}
                      className='text-muted-foreground hidden size-4 shrink-0 lg:block'
                      aria-hidden='true'
                    />
                    <span className='text-xs leading-snug font-medium sm:text-sm'>
                      {t(probe.labelKey)}
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>
        </CollapsibleContent>
      </Collapsible>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 flex-1 items-center gap-3'>
          <span className='text-muted-foreground shrink-0 text-xs'>
            {t('Default endpoint')}
          </span>
          <ChannelProbeEndpointSelect
            value={props.endpoint}
            onChange={props.onEndpointChange}
            label={t('Default endpoint')}
            disabled={props.disabled}
          />
        </div>
        <CollapsibleTrigger render={<Button variant='ghost' size='sm' />}>
          <HugeiconsIcon icon={Settings02Icon} aria-hidden='true' />
          {t('Advanced settings')}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className='max-h-52 overflow-y-auto'>
        <div className='bg-muted/40 grid gap-4 rounded-lg p-3 md:grid-cols-2'>
          <div className='flex flex-col gap-2'>
            <Label htmlFor={id}>{t('Test message override')}</Label>
            <Textarea
              id={id}
              rows={2}
              maxLength={4096}
              disabled={props.disabled}
              value={props.message}
              onChange={(event) => props.onMessageChange(event.target.value)}
              placeholder={t('Leave blank to use the global default.')}
            />
            <p className='text-muted-foreground text-xs'>
              {t(
                'Overrides basic text and image tests for this session. Tool tests always use the built-in probe.'
              )}
            </p>
          </div>
          <div className='text-muted-foreground flex flex-col justify-center gap-2 text-xs'>
            <p className='text-foreground font-medium'>
              {t('Tool call validation')}
            </p>
            <code className='bg-background w-fit rounded border px-2 py-1 font-mono'>
              channel_test_echo({'{'}message: "ping"{'}'})
            </code>
            <p>
              {t(
                'Checks the tool name and complete arguments. No tool is executed and no result is sent back.'
              )}
            </p>
            <p>
              {t(
                'Image tests generate one image per mode. Up to five tests run at once.'
              )}
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

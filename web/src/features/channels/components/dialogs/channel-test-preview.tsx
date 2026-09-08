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
  ArrowDown01Icon,
  Cancel01Icon,
  Copy01Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

import { parseChannelTestPreview } from '../../lib/channel-test-preview'

export function ChannelProbeResponsePreview(props: {
  model: string
  endpoint: string
  response: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant='outline' className='w-full justify-start' />}
      >
        <HugeiconsIcon icon={ViewIcon} aria-hidden='true' />
        {t('Response preview')}
      </SheetTrigger>
      <SheetContent className='w-full sm:max-w-2xl' showCloseButton={false}>
        <SheetHeader className='shrink-0 border-b pr-14'>
          <SheetTitle>{t('Response preview')}</SheetTitle>
          <SheetDescription className='font-mono break-all'>
            {props.model}
          </SheetDescription>
          <SheetClose
            render={
              <Button
                variant='ghost'
                size='icon-sm'
                className='absolute top-3 right-3'
                aria-label={t('Close response preview')}
              />
            }
          >
            <HugeiconsIcon icon={Cancel01Icon} aria-hidden='true' />
          </SheetClose>
        </SheetHeader>
        {open && (
          <ChannelProbeResponseContent
            response={props.response}
            endpoint={props.endpoint}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function ChannelProbeResponseContent(props: {
  response: string
  endpoint: string
}) {
  const { t } = useTranslation()
  const { copyToClipboard } = useCopyToClipboard()
  const preview = useMemo(
    () => parseChannelTestPreview(props.response, props.endpoint),
    [props.response, props.endpoint]
  )
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4'>
      {preview.text && (
        <div className='text-sm leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap'>
          {preview.text}
        </div>
      )}
      {preview.images.map((image) => (
        <img
          key={image}
          src={image}
          alt={t('Generated image')}
          className='max-w-full rounded-lg border object-contain'
        />
      ))}
      {preview.tools.length > 0 && (
        <div className='flex flex-col gap-2'>
          <p className='text-muted-foreground text-xs font-medium'>
            {t('Tool calls')}
          </p>
          {preview.tools.map((tool) => (
            <div key={tool.id} className='rounded-lg border p-3'>
              <p className='font-mono text-xs font-medium break-all'>
                {tool.name}
              </p>
              <pre className='mt-2 font-mono text-xs break-all whitespace-pre-wrap'>
                {tool.arguments}
              </pre>
            </div>
          ))}
        </div>
      )}
      {!preview.text &&
        preview.images.length === 0 &&
        preview.tools.length === 0 && (
          <p className='text-muted-foreground text-sm'>
            {t('No readable output. Expand the raw response for details.')}
          </p>
        )}
      <Collapsible className='rounded-lg border'>
        <CollapsibleTrigger
          render={
            <Button
              variant='ghost'
              className='group h-auto w-full justify-between rounded-lg px-3 py-3 text-xs'
            />
          }
        >
          {t('Raw response')}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className='transition-transform group-aria-expanded:rotate-180'
            aria-hidden='true'
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className='flex justify-end border-t px-2 py-1'>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => void copyToClipboard(props.response)}
            >
              <HugeiconsIcon icon={Copy01Icon} aria-hidden='true' />
              {t('Copy')}
            </Button>
          </div>
          <pre className='bg-muted/40 overflow-x-auto border-t p-3 font-mono text-xs break-all whitespace-pre-wrap'>
            {props.response}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

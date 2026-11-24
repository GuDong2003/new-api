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
import { ImageAdd01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ImageUploadPlaceholderProps = {
  label: string
  disabled?: boolean
  compact?: boolean
  className?: string
  onUpload: (files: File[]) => void
}

export function ImageUploadPlaceholder(props: ImageUploadPlaceholderProps) {
  const { t } = useTranslation()
  const descriptionId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  return (
    <div
      className={cn(
        props.compact ? 'w-24 shrink-0' : 'w-full',
        props.className
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = props.disabled ? 'none' : 'copy'
        setDragging(!props.disabled)
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return
        }
        setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        const files = [...event.dataTransfer.files]
        if (!props.disabled && files.length) props.onUpload(files)
      }}
    >
      <Button
        type='button'
        variant='outline'
        aria-label={props.label}
        aria-describedby={props.compact ? undefined : descriptionId}
        title={props.compact ? props.label : undefined}
        disabled={props.disabled}
        className={cn(
          'border-dashed',
          props.compact
            ? 'size-24'
            : 'h-auto min-h-24 w-full flex-col gap-2 px-3 py-4 whitespace-normal',
          dragging && !props.disabled && 'border-primary bg-primary/5'
        )}
        onClick={() => input.current?.click()}
      >
        <span className='flex items-center gap-2'>
          <HugeiconsIcon
            icon={ImageAdd01Icon}
            className='size-5'
            aria-hidden='true'
          />
          {!props.compact && <span>{props.label}</span>}
        </span>
        {!props.compact && (
          <span
            id={descriptionId}
            className='text-muted-foreground flex flex-col gap-1 text-center text-xs leading-relaxed font-normal'
          >
            <span>{t('Drop images here or click to upload')}</span>{' '}
            <span>{t('PNG, JPEG or WebP')}</span>
          </span>
        )}
      </Button>
      <input
        ref={input}
        type='file'
        className='hidden'
        aria-label={props.label}
        accept='image/png,image/jpeg,image/webp,image/gif'
        multiple
        disabled={props.disabled}
        onChange={(event) => {
          const files = [...(event.target.files || [])]
          event.target.value = ''
          if (!props.disabled && files.length) props.onUpload(files)
        }}
      />
    </div>
  )
}

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
  ArrangeIcon,
  Cursor01Icon,
  Delete02Icon,
  Download04Icon,
  HandPointingLeft01Icon,
  ImageAdd01Icon,
  RedoIcon,
  Settings02Icon,
  UndoIcon,
  Upload01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

type CanvasToolbarProps = {
  tool: 'select' | 'hand'
  onToolChange: (tool: 'select' | 'hand') => void
  canUndo: boolean
  canRedo: boolean
  count: number
  onUndo: () => void
  onRedo: () => void
  onExport: () => void
  onSettings: () => void
  onArrange: () => void
  compact: boolean
  busy?: boolean
  onUpload?: (files: File[]) => void
  onImport?: (file: File) => void
  onClear?: () => void
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  const { t } = useTranslation()
  const upload = useRef<HTMLInputElement>(null)
  const importFile = useRef<HTMLInputElement>(null)
  return (
    <>
      {props.compact && (
        <Button
          type='button'
          variant='secondary'
          size='sm'
          onClick={props.onSettings}
        >
          <HugeiconsIcon icon={Settings02Icon} size={15} aria-hidden='true' />
          {t('Generate')}
        </Button>
      )}
      <Button
        type='button'
        variant={props.tool === 'select' ? 'secondary' : 'ghost'}
        size='icon-sm'
        aria-label={t('Select images')}
        title={t('Select images')}
        aria-pressed={props.tool === 'select'}
        onClick={() => props.onToolChange('select')}
      >
        <HugeiconsIcon icon={Cursor01Icon} size={16} aria-hidden='true' />
      </Button>
      <Button
        type='button'
        variant={props.tool === 'hand' ? 'secondary' : 'ghost'}
        size='icon-sm'
        aria-label={t('Pan canvas')}
        title={t('Pan canvas')}
        aria-pressed={props.tool === 'hand'}
        onClick={() => props.onToolChange('hand')}
      >
        <HugeiconsIcon
          icon={HandPointingLeft01Icon}
          size={16}
          aria-hidden='true'
        />
      </Button>
      <Separator orientation='vertical' className='mx-1 h-5' />
      <Button
        type='button'
        variant='ghost'
        size='icon-sm'
        aria-label={t('Undo')}
        title={t('Undo')}
        disabled={!props.canUndo}
        onClick={props.onUndo}
      >
        <HugeiconsIcon icon={UndoIcon} size={16} aria-hidden='true' />
      </Button>
      <Button
        type='button'
        variant='ghost'
        size='icon-sm'
        aria-label={t('Redo')}
        title={t('Redo')}
        disabled={!props.canRedo}
        onClick={props.onRedo}
      >
        <HugeiconsIcon icon={RedoIcon} size={16} aria-hidden='true' />
      </Button>
      <Button
        type='button'
        variant='ghost'
        size='icon-sm'
        aria-label={t('Arrange images')}
        title={t('Arrange images')}
        disabled={!props.count}
        onClick={props.onArrange}
      >
        <HugeiconsIcon icon={ArrangeIcon} size={16} aria-hidden='true' />
      </Button>
      <Separator orientation='vertical' className='mx-1 h-5' />
      {props.onUpload && (
        <Button
          type='button'
          variant='ghost'
          size='sm'
          disabled={props.busy}
          onClick={() => upload.current?.click()}
        >
          <HugeiconsIcon icon={ImageAdd01Icon} size={16} aria-hidden='true' />
          <span className='hidden sm:inline'>{t('Add images')}</span>
          <span className='sr-only sm:hidden'>{t('Add images')}</span>
        </Button>
      )}
      {props.onImport && (
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          disabled={props.busy}
          onClick={() => importFile.current?.click()}
          aria-label={t('Import canvas')}
          title={t('Import canvas')}
        >
          <HugeiconsIcon icon={Upload01Icon} size={16} aria-hidden='true' />
        </Button>
      )}
      <Button
        type='button'
        variant='ghost'
        size='icon-sm'
        disabled={!props.count}
        onClick={props.onExport}
        aria-label={t('Export canvas')}
        title={t('Export canvas')}
      >
        <HugeiconsIcon icon={Download04Icon} size={16} aria-hidden='true' />
      </Button>
      {props.onClear && (
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          disabled={!props.count}
          onClick={props.onClear}
          aria-label={t('Clear canvas')}
          title={t('Clear canvas')}
        >
          <HugeiconsIcon icon={Delete02Icon} size={16} aria-hidden='true' />
        </Button>
      )}
      {props.onUpload && (
        <input
          ref={upload}
          type='file'
          className='hidden'
          accept='image/png,image/jpeg,image/webp'
          multiple
          aria-label={t('Add images')}
          onChange={(event) => {
            props.onUpload?.([...(event.target.files || [])])
            event.target.value = ''
          }}
        />
      )}
      {props.onImport && (
        <input
          ref={importFile}
          type='file'
          className='hidden'
          accept='.json,application/json'
          aria-label={t('Import canvas')}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) props.onImport?.(file)
            event.target.value = ''
          }}
        />
      )}
    </>
  )
}

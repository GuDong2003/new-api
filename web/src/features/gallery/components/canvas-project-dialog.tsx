/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export function CanvasProjectDialog(props: {
  open: boolean
  mode: 'create' | 'rename'
  initialName?: string
  busy?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(props.initialName ?? '')
  useEffect(() => {
    if (props.open) setName(props.initialName ?? '')
  }, [props.initialName, props.open])
  const create = props.mode === 'create'
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={create ? t('New canvas') : t('Rename canvas')}
      description={
        create
          ? t('Create a browser-first canvas project.')
          : t('Choose a new name for this canvas.')
      }
      footer={
        <>
          <Button
            variant='outline'
            disabled={props.busy}
            onClick={() => props.onOpenChange(false)}
          >
            {t('Cancel')}
          </Button>
          <Button
            onClick={() => props.onSubmit(name.trim())}
            disabled={props.busy || !name.trim()}
          >
            {create ? t('Create canvas') : t('Save')}
          </Button>
        </>
      }
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor='canvas-project-name'>
            {t('Canvas name')}
          </FieldLabel>
          <Input
            id='canvas-project-name'
            value={name}
            maxLength={255}
            disabled={props.busy}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </Field>
        {props.error ? (
          <p role='alert' className='text-destructive text-sm'>
            {t(props.error)}
          </p>
        ) : null}
      </FieldGroup>
    </Dialog>
  )
}

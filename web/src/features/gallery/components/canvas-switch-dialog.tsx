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
import { useTranslation } from 'react-i18next'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

export function CanvasSwitchDialog(props: {
  open: boolean
  busy?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onSave: () => void
  onDiscard: () => void
}) {
  const { t } = useTranslation()
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader className='text-start'>
          <AlertDialogTitle>{t('Unsaved canvas changes')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('Save the current canvas before switching?')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {props.error ? (
          <p role='alert' className='text-destructive text-sm'>
            {t(props.error)}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.busy}>
            {t('Cancel')}
          </AlertDialogCancel>
          <Button
            type='button'
            variant='outline'
            disabled={props.busy}
            onClick={props.onDiscard}
          >
            {t('Discard changes')}
          </Button>
          <Button type='button' disabled={props.busy} onClick={props.onSave}>
            {t('Save and continue')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

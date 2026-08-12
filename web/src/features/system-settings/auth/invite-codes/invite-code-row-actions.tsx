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
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import type { InviteCode } from './types'

type InviteCodeRowActionsProps = {
  inviteCode: InviteCode
  onDelete: (inviteCode: InviteCode) => void
  onEdit: (inviteCode: InviteCode) => void
}

export function InviteCodeRowActions(props: InviteCodeRowActionsProps) {
  const { t } = useTranslation()
  const deleteDisabled = props.inviteCode.used_count > 0
  const deleteTitle = deleteDisabled
    ? t('Used invitation codes cannot be deleted. Disable them instead.')
    : t('Delete Invitation Code')

  return (
    <div className='flex justify-end gap-2'>
      <Button
        variant='outline'
        size='sm'
        onClick={() => props.onEdit(props.inviteCode)}
      >
        {t('Edit')}
      </Button>
      <Button
        variant='destructive'
        size='sm'
        className='gap-1.5'
        disabled={deleteDisabled}
        aria-label={deleteTitle}
        title={deleteTitle}
        onClick={() => props.onDelete(props.inviteCode)}
      >
        <Trash2 aria-hidden='true' className='h-3.5 w-3.5' />
        {t('Delete')}
      </Button>
    </div>
  )
}

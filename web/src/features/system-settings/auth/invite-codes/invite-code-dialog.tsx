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
import { Loader2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { DateTimePicker } from '@/components/datetime-picker'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

import { createInviteCode, updateInviteCode } from './api'
import type { GeneratedInviteCode, InviteCode } from './types'

type InviteCodeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  inviteCode?: InviteCode
  onSaved: () => void
}

export function InviteCodeDialog(props: InviteCodeDialogProps) {
  const { t } = useTranslation()
  const { copyToClipboard } = useCopyToClipboard()
  const [name, setName] = useState('')
  const [maxUses, setMaxUses] = useState(1)
  const [expiredAt, setExpiredAt] = useState<Date | undefined>()
  const [enabled, setEnabled] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [generated, setGenerated] = useState<GeneratedInviteCode[]>([])
  const isEditing = Boolean(props.inviteCode)

  useEffect(() => {
    if (!props.open) return
    setName(props.inviteCode?.name ?? '')
    setMaxUses(props.inviteCode?.max_uses ?? 1)
    setExpiredAt(
      props.inviteCode?.expired_time
        ? new Date(props.inviteCode.expired_time * 1000)
        : undefined
    )
    setEnabled(props.inviteCode?.status === 1 || !props.inviteCode)
    setGenerated([])
  }, [props.open, props.inviteCode])

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setGenerated([])
    }
    props.onOpenChange(open)
  }

  const closeDialog = () => handleOpenChange(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) {
      toast.error(t('Maximum uses must be between 1 and 100000'))
      return
    }
    const originalExpiredTime = props.inviteCode?.expired_time ?? 0
    const selectedExpiredTime = expiredAt
      ? Math.floor(expiredAt.getTime() / 1000)
      : 0
    if (
      expiredAt &&
      expiredAt.getTime() <= Date.now() &&
      selectedExpiredTime !== originalExpiredTime
    ) {
      toast.error(t('Expiration time must be in the future'))
      return
    }
    setIsSubmitting(true)
    try {
      const input = {
        name: name.trim(),
        max_uses: maxUses,
        expired_time: selectedExpiredTime,
      }
      if (props.inviteCode) {
        const result = await updateInviteCode(props.inviteCode.id, {
          ...input,
          status: enabled ? 1 : 2,
        })
        if (result.success) {
          toast.success(t('Invitation code updated'))
          props.onSaved()
          closeDialog()
        }
        return
      }
      const result = await createInviteCode(input)
      if (result.success && result.data?.length) {
        setGenerated(result.data)
        props.onSaved()
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  if (generated.length > 0) {
    const codes = generated.map((item) => item.code).join('\n')
    return (
      <Dialog
        open={props.open}
        onOpenChange={handleOpenChange}
        title={t('Invitation Code Created')}
        description={t(
          'Copy it now. For security, the full invitation code will not be shown again after this dialog is closed.'
        )}
        contentClassName='sm:max-w-lg'
        footer={
          <>
            <Button variant='outline' onClick={closeDialog}>
              {t('Close')}
            </Button>
            <Button onClick={() => void copyToClipboard(codes)}>
              {t('Copy Invitation Code')}
            </Button>
          </>
        }
      >
        <pre className='bg-muted overflow-x-auto rounded-md border p-4 text-center font-mono text-sm font-semibold'>
          {codes}
        </pre>
      </Dialog>
    )
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={handleOpenChange}
      title={
        isEditing ? t('Edit Invitation Code') : t('Create Invitation Code')
      }
      description={
        isEditing
          ? t('Change the usage limit, expiration time, or availability.')
          : t(
              'The code can be used once by default. You can increase its usage limit or set an expiration time.'
            )
      }
      contentClassName='sm:max-w-lg'
      footer={
        <>
          <Button
            variant='outline'
            onClick={closeDialog}
            disabled={isSubmitting}
          >
            {t('Cancel')}
          </Button>
          <Button form='invite-code-form' type='submit' disabled={isSubmitting}>
            {isSubmitting ? <Loader2 className='h-4 w-4 animate-spin' /> : null}
            {isEditing ? t('Save changes') : t('Create')}
          </Button>
        </>
      }
    >
      <form
        id='invite-code-form'
        className='grid gap-4'
        onSubmit={handleSubmit}
      >
        <div className='grid gap-2'>
          <Label htmlFor='invite-code-name'>{t('Name (optional)')}</Label>
          <Input
            id='invite-code-name'
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('For example: August early access')}
          />
        </div>
        <div className='grid gap-2'>
          <Label htmlFor='invite-code-max-uses'>{t('Maximum Uses')}</Label>
          <Input
            id='invite-code-max-uses'
            type='number'
            min={Math.max(1, props.inviteCode?.used_count ?? 1)}
            max={100000}
            value={maxUses}
            onChange={(event) => setMaxUses(Number(event.target.value))}
          />
          <p className='text-muted-foreground text-xs'>
            {t('Used {{used}} time(s)', {
              used: props.inviteCode?.used_count ?? 0,
            })}
          </p>
        </div>
        <div className='grid gap-2'>
          <Label>{t('Expiration Time')}</Label>
          <DateTimePicker
            value={expiredAt}
            onChange={setExpiredAt}
            placeholder={t('Never expires')}
          />
        </div>
        {isEditing ? (
          <div className='flex items-center justify-between gap-4 rounded-md border p-3'>
            <div>
              <Label htmlFor='invite-code-enabled'>{t('Enabled')}</Label>
              <p className='text-muted-foreground text-xs'>
                {t('Disabled codes cannot be used for registration')}
              </p>
            </div>
            <Switch
              id='invite-code-enabled'
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
        ) : null}
      </form>
    </Dialog>
  )
}

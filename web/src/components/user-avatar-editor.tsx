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
import { Camera, Link2, Loader2, Trash2, Upload } from 'lucide-react'
import { useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getUserAvatarFallback, getUserAvatarStyle } from '@/lib/avatar'
import {
  importAvatarFromURL,
  removeAvatar,
  uploadAvatar,
} from '@/lib/avatar-api'
import { useAuthStore } from '@/stores/auth-store'

interface UserAvatarEditorProps {
  avatarUrl?: string
  name: string
  userId?: number
  compact?: boolean
  onChanged?: (avatarUrl: string) => void | Promise<void>
}

const maxAvatarBytes = 2 * 1024 * 1024

export function UserAvatarEditor(props: UserAvatarEditorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [imageURL, setImageURL] = useState('')
  const fallback = getUserAvatarFallback(props.name)
  const fallbackStyle = getUserAvatarStyle(props.name)

  const applyAvatarChange = async (avatarUrl: string) => {
    if (props.userId === undefined) {
      const auth = useAuthStore.getState().auth
      if (auth.user) {
        auth.setUser({ ...auth.user, avatar_url: avatarUrl })
      }
    }
    setOpen(false)
    try {
      await props.onChanged?.(avatarUrl)
    } catch {
      // The avatar mutation already succeeded; a later refresh will reconcile
      // any parent view that could not refresh immediately.
    }
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > maxAvatarBytes) {
      toast.error(t('Avatar must not exceed 2 MiB'))
      return
    }
    setLoading(true)
    try {
      const result = await uploadAvatar(file, props.userId)
      if (!result.success || !result.data) {
        toast.error(result.message || t('Failed to upload avatar'))
        return
      }
      toast.success(t('Avatar updated successfully'))
      await applyAvatarChange(result.data.avatar_url)
    } catch {
      toast.error(t('Failed to upload avatar'))
    } finally {
      setLoading(false)
    }
  }

  const handleURLImport = async () => {
    const url = imageURL.trim()
    if (!url.startsWith('https://')) {
      toast.error(t('Please enter a valid HTTPS image URL'))
      return
    }
    setLoading(true)
    try {
      const result = await importAvatarFromURL(url, props.userId)
      if (!result.success || !result.data) {
        toast.error(result.message || t('Failed to import avatar'))
        return
      }
      setImageURL('')
      toast.success(t('Avatar updated successfully'))
      await applyAvatarChange(result.data.avatar_url)
    } catch {
      toast.error(t('Failed to import avatar'))
    } finally {
      setLoading(false)
    }
  }

  const handleRemove = async () => {
    setLoading(true)
    try {
      const result = await removeAvatar(props.userId)
      if (!result.success) {
        toast.error(result.message || t('Failed to remove avatar'))
        return
      }
      toast.success(t('Avatar removed successfully'))
      await applyAvatarChange('')
    } catch {
      toast.error(t('Failed to remove avatar'))
    } finally {
      setLoading(false)
    }
  }

  const avatar = (
    <Avatar
      className={
        props.compact
          ? 'ring-background h-12 w-12 rounded-xl text-sm ring-2 sm:h-16 sm:w-16 sm:rounded-2xl sm:text-lg sm:ring-4'
          : 'size-14'
      }
    >
      {props.avatarUrl && (
        <AvatarImage
          src={props.avatarUrl}
          alt={t("{{name}}'s avatar", { name: props.name })}
          className={props.compact ? 'rounded-xl sm:rounded-2xl' : undefined}
        />
      )}
      <AvatarFallback
        className={
          props.compact
            ? 'rounded-xl font-semibold text-white sm:rounded-2xl'
            : 'font-semibold text-white'
        }
        style={fallbackStyle}
      >
        {fallback}
      </AvatarFallback>
    </Avatar>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={t('Change Avatar')}
      description={t(
        'Upload an image or import one from an HTTPS URL. Safe SVG animations are preserved.'
      )}
      contentClassName='sm:max-w-md'
      trigger={
        <button
          type='button'
          className={
            props.compact
              ? 'group focus-visible:ring-ring relative shrink-0 rounded-2xl outline-none focus-visible:ring-2'
              : 'hover:bg-muted flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors'
          }
          aria-label={t('Change Avatar')}
        >
          {avatar}
          {props.compact ? (
            <span className='bg-background/85 absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border shadow-sm'>
              <Camera className='size-3.5' aria-hidden='true' />
            </span>
          ) : (
            <span className='min-w-0 flex-1'>
              <span className='block text-sm font-medium'>{t('Avatar')}</span>
              <span className='text-muted-foreground block truncate text-xs'>
                {props.avatarUrl
                  ? t('Change or remove avatar')
                  : t('Add avatar')}
              </span>
            </span>
          )}
        </button>
      }
    >
      <div className='space-y-5'>
        <div className='space-y-2'>
          <Label htmlFor='avatar-file'>{t('Upload image')}</Label>
          <Input
            id='avatar-file'
            type='file'
            accept='.svg,image/svg+xml,image/jpeg,image/png,image/webp'
            disabled={loading}
            onChange={handleFileChange}
          />
          <p className='text-muted-foreground text-xs'>
            {t('JPEG, PNG, WebP or SVG, up to 2 MiB.')}
          </p>
        </div>

        <div className='space-y-2'>
          <Label htmlFor='avatar-url'>{t('Import from image URL')}</Label>
          <div className='flex gap-2'>
            <Input
              id='avatar-url'
              type='url'
              value={imageURL}
              disabled={loading}
              onChange={(event) => setImageURL(event.target.value)}
              placeholder='https://example.com/avatar.svg'
            />
            <Button
              type='button'
              variant='outline'
              disabled={loading || !imageURL.trim()}
              onClick={handleURLImport}
            >
              <Link2 className='size-4' aria-hidden='true' />
              {t('Import')}
            </Button>
          </div>
          <p className='text-muted-foreground text-xs'>
            {t('The image is downloaded, sanitized, and stored on this site.')}
          </p>
        </div>

        <div className='flex flex-wrap justify-between gap-2 border-t pt-4'>
          <Button
            type='button'
            variant='destructive'
            disabled={loading || !props.avatarUrl}
            onClick={handleRemove}
          >
            <Trash2 className='size-4' aria-hidden='true' />
            {t('Remove Avatar')}
          </Button>
          <div className='text-muted-foreground flex items-center gap-1.5 text-xs'>
            {loading ? (
              <Loader2 className='size-4 animate-spin' aria-hidden='true' />
            ) : (
              <Upload className='size-4' aria-hidden='true' />
            )}
            {loading ? t('Processing image...') : t('SVG animation supported')}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

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
import { useEffect, useEffectEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { handleServerError } from '@/lib/handle-server-error'

import { getChannel } from '../api'
import { useChannels } from './channels-provider'

type ChannelLinkOpenerProps = {
  /** The channel a link asks to open, such as one from the logs. */
  channelId?: number
  /** Called once the channel has opened or failed to load. */
  onHandled: () => void
}

/** Opens the edit drawer of the channel a link names. */
export function ChannelLinkOpener(props: ChannelLinkOpenerProps) {
  const { t } = useTranslation()
  const { setCurrentRow, setOpen } = useChannels()
  const handled = useEffectEvent(props.onHandled)
  const channelId = props.channelId

  useEffect(() => {
    if (!channelId) return
    let cancelled = false
    getChannel(channelId)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          setCurrentRow(result.data)
          setOpen('update-channel')
        } else {
          handleServerError(result, t('Failed to load'))
        }
        handled()
      })
      .catch((error: unknown) => {
        if (cancelled) return
        handleServerError(error, t('Failed to load'))
        handled()
      })
    return () => {
      cancelled = true
    }
  }, [channelId, setCurrentRow, setOpen, t])

  return null
}

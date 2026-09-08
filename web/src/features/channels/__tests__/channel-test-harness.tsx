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
import { useEffect, useState } from 'react'

import { useChannels } from '../components/channels-provider'
import { ChannelTestDialog } from '../components/dialogs/channel-test-dialog'
import type { Channel } from '../types'

export function TestDialogHarness(props: { channel: Channel }) {
  const { setCurrentRow } = useChannels()
  const [open, setOpen] = useState(true)
  useEffect(() => setCurrentRow(props.channel), [props.channel, setCurrentRow])
  return (
    <>
      <button type='button' onClick={() => setOpen(true)}>
        Open probe dialog
      </button>
      <ChannelTestDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

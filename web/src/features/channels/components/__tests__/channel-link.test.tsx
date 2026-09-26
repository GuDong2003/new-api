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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ChannelLinkOpener } from '../channel-link-opener'
import { ChannelsProvider, useChannels } from '../channels-provider'

function OpenDrawer() {
  const { open, currentRow } = useChannels()
  return (
    <p>
      {open ?? 'closed'}:{currentRow?.name ?? ''}
    </p>
  )
}

function renderOpener(onHandled: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ChannelsProvider>
        <ChannelLinkOpener channelId={5} onHandled={onHandled} />
        <OpenDrawer />
      </ChannelsProvider>
    </QueryClientProvider>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ChannelLinkOpener', () => {
  it('opens the edit drawer of the linked channel', async () => {
    const request = vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: { id: 5, name: 'alpha' } },
    })
    const onHandled = vi.fn()
    renderOpener(onHandled)

    expect(await screen.findByText('update-channel:alpha')).toBeInTheDocument()
    expect(request).toHaveBeenCalledWith('/api/channel/5')
    expect(onHandled).toHaveBeenCalledTimes(1)
  })

  it('leaves the drawer closed when the channel cannot be loaded', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: false, message: 'channel not found' },
    })
    const onHandled = vi.fn()
    renderOpener(onHandled)

    await waitFor(() => expect(onHandled).toHaveBeenCalledTimes(1))
    expect(screen.getByText('closed:')).toBeInTheDocument()
  })
})

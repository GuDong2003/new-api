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
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import { validateImageSettings } from '../../lib/image-settings'
import { useDrawingPersistence } from '../use-drawing-persistence'
import { useImageOptions } from '../use-image-options'

describe('Drawing settings and persistence', () => {
  it('reports unsaved changes immediately while waiting for the autosave debounce', async () => {
    const hook = renderHook(() => useDrawingPersistence(811))
    await waitFor(() => expect(hook.result.current).toBe('saved'))
    act(() =>
      useDrawingStore.getState().updateSettings({ prompt: 'A new draft' })
    )
    expect(hook.result.current).toBe('saving')
    await waitFor(() => expect(hook.result.current).toBe('saved'))
    hook.unmount()
  })

  it('selects compatible parameters when the available model is DALL·E 3', async () => {
    useDrawingStore.getState().initialize(812)
    useDrawingStore.getState().hydrate(null)
    useDrawingStore.getState().updateSettings({
      mode: 'edit',
      prompt: 'A cup',
      n: 2,
      size: '1536x1024',
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(
      ['drawing-groups', 812],
      [{ value: 'default', label: 'default', ratio: 1 }]
    )
    client.setQueryData(
      ['drawing-models', 812, 'default'],
      [{ value: 'dall-e-3', label: 'dall-e-3' }]
    )
    const hook = renderHook(() => useImageOptions(812), {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    })
    await waitFor(() =>
      expect(useDrawingStore.getState().settings.model).toBe('dall-e-3')
    )
    expect(
      validateImageSettings(useDrawingStore.getState().settings, 0)
    ).toBeNull()
    expect(useDrawingStore.getState().settings).toMatchObject({
      n: 1,
      mode: 'generate',
      size: '1024x1024',
      quality: 'standard',
    })
    hook.unmount()
    client.clear()
  })
})

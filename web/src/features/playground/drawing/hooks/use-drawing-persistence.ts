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

import { useDrawingStore } from '@/stores/drawing-store'

import { loadDrawingDocument, saveDrawingDocument } from '../lib/canvas-storage'

export function useDrawingPersistence(
  userId: number
): 'loading' | 'saving' | 'saved' | 'error' {
  const [status, setStatus] = useState<
    'loading' | 'saving' | 'saved' | 'error'
  >('loading')
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let savedRevision = 0
    let queue = Promise.resolve()
    useDrawingStore.getState().initialize(userId)
    setStatus('loading')

    const save = () => {
      const state = useDrawingStore.getState()
      if (
        !state.ready ||
        state.userId !== userId ||
        state.revision === savedRevision
      ) {
        return
      }
      const revision = state.revision
      savedRevision = revision
      if (active) setStatus('saving')
      queue = queue
        .then(() => saveDrawingDocument(userId, state))
        .then(() => {
          if (active && useDrawingStore.getState().revision === revision) {
            setStatus('saved')
          }
        })
        .catch(() => {
          savedRevision = -1
          if (active) setStatus('error')
        })
    }

    void loadDrawingDocument(userId)
      .then((document) => {
        if (!active) return
        useDrawingStore.getState().hydrate(document)
        setStatus('saved')
      })
      .catch(() => {
        if (!active) return
        useDrawingStore.getState().hydrate(null)
        setStatus('error')
      })

    const unsubscribe = useDrawingStore.subscribe((state, previous) => {
      if (
        state.userId !== userId ||
        !state.ready ||
        state.revision === previous.revision
      ) {
        return
      }
      setStatus('saving')
      if (timer) clearTimeout(timer)
      timer = setTimeout(save, 500)
    })
    const flush = () => {
      if (timer) clearTimeout(timer)
      save()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      flush()
      active = false
      unsubscribe()
      window.removeEventListener('pagehide', flush)
    }
  }, [userId])
  return status
}

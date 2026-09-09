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
import { useEffect, useSyncExternalStore } from 'react'

import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import {
  loadNaiCanvasDocument,
  saveNaiCanvasDocument,
} from '../lib/canvas-storage'

export type NaiPersistenceStatus = 'loading' | 'saving' | 'saved' | 'error'

let session: { userId: number; stop: () => void } | null = null
let status: NaiPersistenceStatus = 'loading'
const listeners = new Set<() => void>()
const queues = new Map<number, Promise<void>>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(next: NaiPersistenceStatus) {
  if (status === next) return
  status = next
  listeners.forEach((listener) => listener())
}

function startPersistence(userId: number): () => void {
  if (session?.userId === userId) return session.stop
  session?.stop()
  useNaiDrawingStore.getState().initialize(userId)
  notify('loading')
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let savedRevision = 0
  const previousSave = queues.get(userId) ?? Promise.resolve()

  const save = () => {
    const state = useNaiDrawingStore.getState()
    if (
      !active ||
      !state.ready ||
      state.userId !== userId ||
      state.revision === savedRevision
    ) {
      return
    }
    const revision = state.revision
    savedRevision = revision
    notify('saving')
    const savePromise = (queues.get(userId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => saveNaiCanvasDocument(userId, state))
    queues.set(userId, savePromise)
    void savePromise
      .then(() => {
        if (active && useNaiDrawingStore.getState().revision === revision) {
          notify('saved')
        }
      })
      .catch(() => {
        savedRevision = -1
        if (active) notify('error')
      })
  }

  void previousSave
    .catch(() => undefined)
    .then(() => loadNaiCanvasDocument(userId))
    .then((document) => {
      if (!active) {
        return
      }
      useNaiDrawingStore.getState().hydrate(document)
      notify('saved')
    })
    .catch(() => {
      if (!active) return
      useNaiDrawingStore.getState().hydrate(null)
      notify('error')
    })

  const unsubscribe = useNaiDrawingStore.subscribe((state, previous) => {
    if (
      !active ||
      state.userId !== userId ||
      !state.ready ||
      state.revision === previous.revision
    ) {
      return
    }
    notify('saving')
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 500)
  })
  const flush = () => {
    if (timer) clearTimeout(timer)
    save()
  }
  const stop = () => {
    if (!active) return
    flush()
    active = false
    unsubscribe()
    window.removeEventListener('pagehide', flush)
    if (session?.userId === userId) session = null
  }
  window.addEventListener('pagehide', flush)
  session = { userId, stop }
  return stop
}

export function NaiDrawingPersistence(props: { userId: number | null }) {
  useEffect(() => {
    if (props.userId === null) return
    return startPersistence(props.userId)
  }, [props.userId])
  return null
}

export function useNaiDrawingPersistenceStatus(): NaiPersistenceStatus {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => status
  )
}

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
import { useEffect, useSyncExternalStore } from 'react'

import { useDrawingStore } from '@/stores/drawing-store'

import { loadDrawingDocument, saveDrawingDocument } from '../lib/canvas-storage'

export type DrawingPersistenceStatus = 'loading' | 'saving' | 'saved' | 'error'

type PersistenceSession = {
  userId: number
  stop: () => void
}

let session: PersistenceSession | null = null
let status: DrawingPersistenceStatus = 'loading'
const listeners = new Set<() => void>()
const persistenceQueues = new Map<number, Promise<void>>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getStatus() {
  return status
}

function setStatus(nextStatus: DrawingPersistenceStatus) {
  if (status === nextStatus) return
  status = nextStatus
  for (const listener of listeners) listener()
}

function startPersistence(userId: number): () => void {
  if (session?.userId === userId) return session.stop
  session?.stop()

  const previousSave = persistenceQueues.get(userId) ?? Promise.resolve()

  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let savedRevision = 0

  useDrawingStore.getState().initialize(userId)
  setStatus('loading')

  const save = () => {
    const state = useDrawingStore.getState()
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
    setStatus('saving')
    const savePromise = (persistenceQueues.get(userId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => saveDrawingDocument(userId, state))
    persistenceQueues.set(userId, savePromise)
    void savePromise
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

  void previousSave
    .catch(() => undefined)
    .then(() => loadDrawingDocument(userId))
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
      !active ||
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

export function DrawingPersistence(props: { userId: number | null }) {
  useEffect(() => {
    if (props.userId === null) return
    return startPersistence(props.userId)
  }, [props.userId])
  return null
}

// Compatibility hook for isolated drawing consumers and tests. The authenticated
// shell uses DrawingPersistence so the session survives child-route unmounts.
export function useDrawingPersistence(
  userId: number
): DrawingPersistenceStatus {
  useEffect(() => startPersistence(userId), [userId])
  return useDrawingPersistenceStatus()
}

export function useDrawingPersistenceStatus(): DrawingPersistenceStatus {
  return useSyncExternalStore(subscribe, getStatus, getStatus)
}

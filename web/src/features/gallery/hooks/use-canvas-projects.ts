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
import { useEffect, useState, useSyncExternalStore } from 'react'

import { useAuthStore } from '@/stores/auth-store'

import {
  deleteCanvasProject,
  deleteCanvasResource,
  replayCanvasRemovals,
} from '../lib/canvas-deletion'
import {
  flushLocalEditors,
  getCanvasEditorState,
  type CanvasLocalStatus,
  sameIdentity,
} from '../lib/canvas-editor'
import {
  canvasEditors,
  canvasProjectsVersion,
  subscribeCanvasProjects,
} from '../lib/canvas-events'
import {
  createCanvasProject,
  openCanvasProject,
  reloadCanvasProject,
  renameCanvasProject,
  startCanvasEditor,
} from '../lib/canvas-projects'
import {
  listLocalCanvases,
  readCanvasUserState,
} from '../lib/canvas-repository'
import { CANVAS_FULL_MESSAGE, syncCanvas } from '../lib/canvas-sync'
import type {
  CanvasKind,
  CanvasUserState,
  GalleryIdentity,
  LocalCanvas,
} from '../types'

export {
  createCanvasProject,
  openCanvasProject,
  reloadCanvasProject,
  renameCanvasProject,
  deleteCanvasProject,
  deleteCanvasResource,
}
export {
  syncCanvas,
  flushCanvasSession,
  checkCanvasCapacity,
} from '../lib/canvas-sync'

export function useCanvasPersistence(kind: CanvasKind, userId: number | null) {
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? null)
  useEffect(() => {
    if (userId === null || sessionId === null) return
    const identity = { userId, sessionId }
    void startCanvasEditor(identity, kind)
      .then(() => replayCanvasRemovals(identity))
      .catch(() => undefined)
    // Authenticated shell owns lifetime; route consumers only subscribe.
  }, [kind, userId, sessionId])
}
export function useCanvasPersistenceStatus(
  kind: CanvasKind
): CanvasLocalStatus {
  useSyncExternalStore(
    subscribeCanvasProjects,
    canvasProjectsVersion,
    canvasProjectsVersion
  )
  return getCanvasEditorState(kind)?.localStatus ?? 'loading'
}
export function useCanvasProjects(kind: CanvasKind) {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? null)
  const version = useSyncExternalStore(
    subscribeCanvasProjects,
    canvasProjectsVersion,
    canvasProjectsVersion
  )
  const [projects, setProjects] = useState<LocalCanvas[]>([])
  const [userState, setUserState] = useState<CanvasUserState | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    if (userId === null) {
      setProjects([])
      setUserState(null)
      return
    }
    void Promise.all([listLocalCanvases(userId), readCanvasUserState(userId)])
      .then(([canvases, state]) => {
        if (active) {
          setProjects(canvases)
          setUserState(state)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [userId, sessionId, version])
  const identity: GalleryIdentity = { userId, sessionId }
  const binding = canvasEditors.get(kind)
  const state =
    !binding || sameIdentity(binding.identity, identity)
      ? getCanvasEditorState(kind)
      : undefined
  const current =
    binding && sameIdentity(binding.identity, identity)
      ? (state?.canvas ?? null)
      : null
  return {
    identity,
    loading,
    version,
    projects: projects.filter((canvas) => canvas.kind === kind),
    current,
    localStatus: state?.localStatus ?? 'loading',
    localError: state?.error,
    cloudStatus: userState?.cloudPause ? 'full' : (current?.status ?? 'local'),
    statusText:
      userState?.cloudPause &&
      (state
        ? state.localStatus === 'saved'
        : projects.some(
            (canvas) =>
              canvas.kind === kind &&
              canvas.revision > 0 &&
              canvas.localSavedAt > 0
          ))
        ? CANVAS_FULL_MESSAGE
        : null,
    pendingCanvasRemovals: userState?.pendingCanvasRemovals ?? [],
    pendingAssetRemovals: userState?.pendingAssetRemovals ?? [],
    create: (name?: string) => createCanvasProject(identity, kind, name),
    open: (id: string, focusAssetId?: string) =>
      openCanvasProject(identity, id, focusAssetId, kind),
    rename: (id: string, name: string) =>
      renameCanvasProject(identity, id, name),
    save: async () => {
      await flushLocalEditors(identity)
      if (current) await syncCanvas(identity, current.id, 'manual')
    },
    // Task 5 owns ConfirmDialog before calling these deliberate actions.
    deleteProject: (id: string) => deleteCanvasProject(identity, id),
    deleteResource: (id: string, assetId: string) =>
      deleteCanvasResource(identity, id, assetId),
    reloadConflict: (id: string) => reloadCanvasProject(identity, id),
  }
}

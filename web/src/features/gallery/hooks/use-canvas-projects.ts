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
    return () => {
      active = false
    }
  }, [userId, sessionId, version])
  const identity: GalleryIdentity = { userId, sessionId }
  const state = getCanvasEditorState(kind)
  const current =
    canvasEditors.get(kind)?.identity.userId === userId
      ? (state?.canvas ?? null)
      : null
  return {
    identity,
    projects: projects.filter((canvas) => canvas.kind === kind),
    current,
    localStatus: state?.localStatus ?? 'loading',
    localError: state?.error,
    cloudStatus: userState?.cloudPause ? 'full' : (current?.status ?? 'local'),
    statusText:
      userState?.cloudPause && state?.localStatus === 'saved'
        ? CANVAS_FULL_MESSAGE
        : null,
    pendingCanvasRemovals: userState?.pendingCanvasRemovals ?? [],
    pendingAssetRemovals: userState?.pendingAssetRemovals ?? [],
    create: () => createCanvasProject(identity, kind),
    open: (id: string, focusAssetId?: string) =>
      openCanvasProject(identity, id, focusAssetId),
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

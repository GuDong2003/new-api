import type { CanvasKind, GalleryIdentity, LocalCanvas } from '../types'

export type CanvasEvent = {
  identity: GalleryIdentity
  canvas: LocalCanvas
  assetIdMap?: Readonly<Record<string, string>>
  removedIds?: string[]
}
export type CanvasDeletion = {
  identity: GalleryIdentity
  canvasId: string
  assetId?: string
}
export type CanvasDeletionEvent = CanvasDeletion & {
  version: number
}
type EditorBinding = {
  identity: GalleryIdentity
  kind: CanvasKind
  canvasId: string
  flush: () => Promise<void>
  isLocallySaved: () => boolean
  stop: () => void
  retainedAssetIds: () => string[]
  receive: (event: CanvasEvent) => Promise<void>
}
export const canvasEditors = new Map<CanvasKind, EditorBinding>()
const listeners = new Set<() => void>()
let version = 0
const deletionListeners = new Set<() => void>()
const deletionHistory: CanvasDeletionEvent[] = []
let deletionVersion = 0
export function subscribeCanvasProjects(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function canvasProjectsVersion() {
  return version
}
export function notifyCanvasProjects() {
  version++
  listeners.forEach((listener) => listener())
}
export function subscribeCanvasDeletions(listener: () => void) {
  deletionListeners.add(listener)
  return () => {
    deletionListeners.delete(listener)
  }
}
export function canvasDeletionVersion() {
  return deletionVersion
}
export function getCanvasDeletionEvents(
  identity: GalleryIdentity,
  sinceVersion = 0
): CanvasDeletionEvent[] {
  return deletionHistory
    .filter(
      (event) =>
        event.version > sinceVersion &&
        event.identity.userId === identity.userId &&
        event.identity.sessionId === identity.sessionId
    )
    .map((event) => ({ ...event, identity: { ...event.identity } }))
}
export function emitCanvasDeletion(event: CanvasDeletion) {
  const next: CanvasDeletionEvent = { ...event, version: ++deletionVersion }
  deletionHistory.push(next)
  if (deletionHistory.length > 64) deletionHistory.shift()
  deletionListeners.forEach((listener) => listener())
}
export async function emitCanvasEvent(event: CanvasEvent) {
  for (const binding of canvasEditors.values()) {
    if (
      binding.identity.userId === event.identity.userId &&
      binding.identity.sessionId === event.identity.sessionId &&
      binding.canvasId === event.canvas.id
    ) {
      await binding.receive(event)
    }
  }
  notifyCanvasProjects()
}

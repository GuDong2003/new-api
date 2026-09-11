import type { CanvasKind, GalleryIdentity, LocalCanvas } from '../types'

export type CanvasEvent = {
  identity: GalleryIdentity
  canvas: LocalCanvas
  assetIdMap?: Readonly<Record<string, string>>
  removedIds?: string[]
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

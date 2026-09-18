import type { GalleryIdentity } from '../types'

type CanvasMutation<T> = () => Promise<T> | T

const queues = new Map<string, Promise<unknown>>()

function queueKey(identity: GalleryIdentity, canvasId: string): string {
  return `${identity.userId}:${identity.sessionId}:${canvasId}`
}

/** Serialize local mutations for one authenticated canvas without blocking others. */
export function enqueueCanvasMutation<T>(
  identity: GalleryIdentity,
  canvasId: string,
  mutation: CanvasMutation<T>
): Promise<T> {
  const key = queueKey(identity, canvasId)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(mutation)
  queues.set(key, next)
  return next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  })
}

import {
  useCanvasPersistence,
  useCanvasPersistenceStatus,
} from '@/features/gallery/hooks/use-canvas-projects'

export type DrawingPersistenceStatus = 'loading' | 'saving' | 'saved' | 'error'
export function DrawingPersistence(props: { userId: number | null }) {
  useCanvasPersistence('drawing', props.userId)
  return null
}
export function useDrawingPersistence(
  userId: number
): DrawingPersistenceStatus {
  useCanvasPersistence('drawing', userId)
  return useDrawingPersistenceStatus()
}
export function useDrawingPersistenceStatus(): DrawingPersistenceStatus {
  return useCanvasPersistenceStatus('drawing')
}

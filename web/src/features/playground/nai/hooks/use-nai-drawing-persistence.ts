import {
  useCanvasPersistence,
  useCanvasPersistenceStatus,
} from '@/features/gallery/hooks/use-canvas-projects'

export type NaiPersistenceStatus = 'loading' | 'saving' | 'saved' | 'error'
export function NaiDrawingPersistence(props: { userId: number | null }) {
  useCanvasPersistence('nai', props.userId)
  return null
}
export function useNaiDrawingPersistenceStatus(): NaiPersistenceStatus {
  return useCanvasPersistenceStatus('nai')
}

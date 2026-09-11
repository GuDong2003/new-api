import { readRemoteCanvasOriginal } from '../api'
import type { GalleryIdentity } from '../types'
import { assertGalleryIdentity } from './session'

/** Portable final original; no generated-image upload-size guard or cloud quota. */
export async function preserveCanvasOriginalSource(
  identity: GalleryIdentity,
  source: string,
  mimeType: string,
  signal: AbortSignal
): Promise<string> {
  assertGalleryIdentity(identity)
  signal.throwIfAborted()
  if (source.startsWith('data:')) return source
  const blob = await readRemoteCanvasOriginal(identity, source, signal)
  assertGalleryIdentity(identity)
  signal.throwIfAborted()
  if (!blob.size || blob.type !== mimeType) {
    throw new Error('Canvas original is unavailable.')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

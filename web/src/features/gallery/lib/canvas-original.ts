import { readRemoteCanvasOriginal } from '../api'
import type { GalleryIdentity } from '../types'
import { canvasResponseStatus } from './canvas-sync'
import { assertGalleryIdentity } from './session'

/**
 * The original of a returned picture this browser cannot display, downloaded
 * by the server as a portable source in the type the server found. Nothing
 * while the server cannot be asked. A link the server cannot download a picture
 * from either can never join a canvas: a canvas saves every original it shows,
 * so one such link would fail every save after it.
 */
export async function preserveCanvasOriginalSource(
  identity: GalleryIdentity,
  source: string,
  signal: AbortSignal
): Promise<{ src: string; mimeType: string } | null> {
  assertGalleryIdentity(identity)
  signal.throwIfAborted()
  let blob: Blob
  try {
    blob = await readRemoteCanvasOriginal(identity, source, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (canvasResponseStatus(error) === 400) {
      throw new Error('The returned image could not be downloaded.')
    }
    return null
  }
  assertGalleryIdentity(identity)
  signal.throwIfAborted()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
  }
  return {
    src: `data:${blob.type};base64,${btoa(binary)}`,
    mimeType: blob.type,
  }
}

import { getGalleryFile, readRemoteCanvasOriginal } from '../api'
import type { CanvasKind, GalleryIdentity } from '../types'
import { decodeCanvas, encodeCanvas } from './canvas-document'
import { notifyCanvasProjects } from './canvas-events'
import { enqueueCanvasMutation } from './canvas-mutation-queue'
import {
  loadLocalCanvas,
  readCanvasAssets,
  saveLocalCanvas,
} from './canvas-repository'
import {
  assertGalleryIdentity,
  galleryOwner,
  isGalleryIdentityCurrent,
} from './session'

export type PersistedGenerationAsset = {
  id: string
  name: string
  src: string
  width: number
  height: number
  mimeType: string
}

export async function persistCanvasGenerationResult(options: {
  identity: GalleryIdentity
  kind: CanvasKind
  canvasId: string
  nodeIds: readonly string[]
  assets: readonly (PersistedGenerationAsset | null)[]
  errors?: readonly (string | undefined)[]
  revisedPrompts?: readonly (string | undefined)[]
  usage?: Record<string, unknown>
}): Promise<boolean> {
  return enqueueCanvasMutation(options.identity, options.canvasId, async () => {
    // Another tab can save this canvas meanwhile; start again from what it
    // stored rather than drop the result.
    for (let attempt = 0; ; attempt++) {
      try {
        return await persistCanvasGenerationResultUnsafe(options)
      } catch (error) {
        if (
          attempt === 2 ||
          !(error instanceof Error) ||
          error.message !== 'Stale canvas revision.'
        ) {
          throw error
        }
      }
    }
  })
}

async function persistCanvasGenerationResultUnsafe(options: {
  identity: GalleryIdentity
  kind: CanvasKind
  canvasId: string
  nodeIds: readonly string[]
  assets: readonly (PersistedGenerationAsset | null)[]
  errors?: readonly (string | undefined)[]
  revisedPrompts?: readonly (string | undefined)[]
  usage?: Record<string, unknown>
}): Promise<boolean> {
  if (!isGalleryIdentityCurrent(options.identity)) return false
  const userId = galleryOwner(options.identity)
  const canvas = await loadLocalCanvas(userId, options.canvasId)
  if (!canvas || canvas.deleted || canvas.kind !== options.kind) return false

  const document = await decodeCanvas(
    canvas,
    await readCanvasAssets(userId, canvas.id)
  )
  let changed = false
  const nodes = document.nodes.map((node) => {
    const index = options.nodeIds.indexOf(node.id)
    if (index < 0) return node
    changed = true
    const asset = options.assets[index]
    if (!asset) {
      return {
        ...node,
        data: {
          ...node.data,
          status: 'error' as const,
          progress: undefined,
          error: options.errors?.[index] ?? 'The image could not be loaded.',
        },
      }
    }
    return {
      ...node,
      data: {
        ...node.data,
        asset,
        status: 'complete' as const,
        progress: undefined,
        error: undefined,
        ...(options.revisedPrompts?.[index]
          ? { revisedPrompt: options.revisedPrompts[index] }
          : {}),
        ...(options.usage ? { usage: options.usage } : {}),
      },
    }
  })
  if (!changed || !isGalleryIdentityCurrent(options.identity)) return false

  const nextDocument = { ...document, nodes }
  const existingAssets = await readCanvasAssets(userId, canvas.id)
  const existingRoles = Object.fromEntries(
    existingAssets.map((asset) => [
      asset.id,
      { role: asset.role, nodeId: asset.nodeId },
    ])
  )
  const generatedRoles = Object.fromEntries(
    options.assets.flatMap((asset, index) =>
      asset
        ? [
            [
              asset.id,
              { role: 'generated' as const, nodeId: options.nodeIds[index] },
            ],
          ]
        : []
    )
  )
  const encoded = await encodeCanvas(options.kind, nextDocument, {
    existingAssets,
    roles: { ...existingRoles, ...generatedRoles },
    readOriginal: (asset, signal, source) =>
      source === 'gallery-preview'
        ? getGalleryFile(options.identity, asset.id, false, signal)
        : readRemoteCanvasOriginal(options.identity, asset.src, signal),
  })
  assertGalleryIdentity(options.identity)
  const saved = await saveLocalCanvas(
    {
      ...canvas,
      document: encoded.document,
      status: canvas.status === 'conflict' ? 'conflict' : 'pending',
      needsExplicitSave: false,
    },
    encoded.assets
  )
  notifyCanvasProjects()
  return saved.id === canvas.id
}

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
import type { CanvasBinary, GalleryImage, LocalCanvas } from '../types'

export function localGalleryImages(
  canvas: LocalCanvas,
  assets: readonly CanvasBinary[]
): GalleryImage[] {
  const nodes = (canvas.document.nodes ?? []) as Array<{
    id: string
    data: {
      asset?: {
        id: string
        name: string
        width: number
        height: number
        mimeType: string
      }
      prompt?: string
      createdAt?: number
      settings?: Record<string, unknown>
      status?: string
    }
  }>
  return nodes.flatMap((node) => {
    const asset = node.data.asset
    const binary = assets.find(
      (item) => item.id === asset?.id && item.role === 'generated'
    )
    if (
      !asset ||
      !binary ||
      node.data.status !== 'complete' ||
      canvas.removedAssetIds.includes(asset.id)
    ) {
      return []
    }
    const settings = node.data.settings ?? {}
    return [
      {
        id: asset.id,
        canvas_id: canvas.id,
        canvas_name: canvas.name,
        node_id: node.id,
        source_id: node.id,
        source: canvas.kind,
        model: String(settings.model ?? ''),
        prompt: node.data.prompt ?? '',
        negative_prompt: String(settings.negativePrompt ?? ''),
        parameters: settings,
        width: asset.width,
        height: asset.height,
        mime_type: asset.mimeType,
        bytes: binary.blob.size,
        created_at: Math.floor(
          (node.data.createdAt ?? canvas.localSavedAt) / 1000
        ),
        expires_at: 0,
        has_thumbnail: false,
        localBlob: binary.blob,
        localOnly: true,
      },
    ]
  })
}

/** Merge before filtering/pagination, so linked originals occupy exactly one slot. */
export function mergeGalleryImages(
  remote: readonly GalleryImage[],
  local: readonly GalleryImage[]
) {
  const remoteImages = new Map(remote.map((image) => [image.id, image]))
  const images = new Map(remoteImages)
  for (const image of local) {
    // Canvas publication does not prove that this newly generated asset was
    // uploaded. Only an exact original in the remote listing establishes that.
    const cloud = remoteImages.get(image.id)
    images.set(image.id, {
      ...image,
      ...cloud,
      localBlob: image.localBlob,
      localOnly: !cloud,
      expires_at: cloud?.expires_at ?? 0,
    })
  }
  return [...images.values()]
}

/** Lists contain metadata only; originals are acquired for visible cards/preview. */
export async function collectGalleryPages<T>(
  read: (
    page: number
  ) => Promise<{ items: T[]; total: number; page_size: number }>
) {
  const first = await read(1)
  const items = [...first.items]
  for (let page = 2; page <= Math.ceil(first.total / first.page_size); page++) {
    items.push(...(await read(page)).items)
  }
  return items
}

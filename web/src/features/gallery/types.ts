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
export type GalleryIdentity = {
  userId: number | null
  sessionId: string | null
}
export type GallerySource = 'drawing' | 'nai'
export type GalleryMetadata = {
  source_id: string
  source: GallerySource
  model: string
  prompt: string
  negative_prompt: string
  parameters: Record<string, unknown>
}
export type GalleryImage = GalleryMetadata & {
  id: string
  width: number
  height: number
  mime_type: string
  bytes: number
  created_at: number
  expires_at: number
  has_thumbnail: boolean
}
export type GalleryUsage = {
  enabled: boolean
  retention_days: number
  max_images: number
  max_bytes: number
  used_images: number
  used_bytes: number
  can_save: boolean
  reason: string
  available_bytes?: number
  available_images?: number
}
export type GallerySettings = {
  enabled: boolean
  retention_days: number
  user_max_images: number
  user_max_bytes: number
  total_max_bytes: number
}
export type GalleryPage = {
  items: GalleryImage[]
  total: number
  page: number
  page_size: number
}

export type CanvasKind = 'drawing' | 'nai'
export type CanvasAssetRole = 'generated' | 'reference' | 'mask'
export type CanvasAssetRef = {
  id: string
  name: string
  width: number
  height: number
  mimeType: string
}
export type CanvasRemoteAsset = {
  id: string
  role: CanvasAssetRole
  node_id: string
  sha256: string
  bytes: number
  width: number
  height: number
  mime_type: string
  has_thumbnail: boolean
}
export type CanvasRecord = {
  id: string
  kind: CanvasKind
  name: string
  revision: number
  state: 'ready' | 'deleted' | 'expired'
  updated_at: number
  expires_at: number
  document: Record<string, unknown> | null
  removed_asset_ids: string[]
  assets: CanvasRemoteAsset[]
  asset_id_map: Record<string, string>
}
export type CanvasSummary = Omit<
  CanvasRecord,
  'document' | 'assets' | 'asset_id_map' | 'removed_asset_ids'
> & { cover_asset_ids: string[] }
export type CanvasSaveMetadata = {
  id: string
  kind: CanvasKind
  name: string
  base_revision: number
  mutation_id: string
  document: Record<string, unknown>
  explicit_save?: boolean
  assets: {
    id: string
    role: CanvasAssetRole
    node_id: string
    bytes: number
    sha256: string
  }[]
}
export type CanvasBinary = {
  id: string
  blob: Blob
  role: CanvasAssetRole
  nodeId: string
  sha256: string
}
export type LocalCanvas = {
  id: string
  userId: number
  kind: CanvasKind
  name: string
  document: Record<string, unknown>
  revision: number
  cloudRevision: number
  localSavedAt: number
  cloudSavedRevision: number
  expiresAt: number
  status: 'local' | 'pending' | 'synced' | 'full' | 'conflict' | 'error'
  needsExplicitSave: boolean
  removedAssetIds: string[]
  deleted: boolean
}
export type CanvasUserState = {
  lastOpened: Partial<Record<CanvasKind, string>>
  cloudPause: {
    reason: string
    requiredBytes: number
    requiredImages: number
    lastQuotaCheck: number
    notified: boolean
  } | null
  pendingCanvasRemovals: { canvasId: string; revision: number }[]
  pendingAssetRemovals: {
    canvasId: string
    assetId: string
    revision: number
  }[]
  migratedKinds: Partial<Record<CanvasKind, string>>
}

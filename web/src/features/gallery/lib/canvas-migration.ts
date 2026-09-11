/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { t } from 'i18next'

import { loadDrawingDocument } from '../../playground/drawing/lib/canvas-storage'
import { loadNaiCanvasDocument } from '../../playground/nai/lib/canvas-storage'
import type { CanvasKind, LocalCanvas } from '../types'
import { encodeCanvas, type CanvasCodecContext } from './canvas-document'
import {
  importLegacyCanvas,
  loadLocalCanvas,
  readCanvasUserState,
} from './canvas-repository'

/** Read old stores without deleting or rewriting them. Call on editor entry. */
export async function migrateLegacyCanvases(
  userId: number,
  context: CanvasCodecContext = {},
  kinds: readonly CanvasKind[] = ['drawing', 'nai']
): Promise<LocalCanvas[]> {
  const migrated: LocalCanvas[] = []
  for (const kind of kinds) {
    context.signal?.throwIfAborted()
    const state = await readCanvasUserState(userId)
    const migratedId = state.migratedKinds[kind]
    if (migratedId) {
      const existing = await loadLocalCanvas(userId, migratedId)
      if (existing && !existing.deleted) migrated.push(existing)
      continue
    }
    const document =
      kind === 'drawing'
        ? await loadDrawingDocument(userId)
        : await loadNaiCanvasDocument(userId)
    if (!document) continue
    const roles = { ...context.roles }
    for (const node of document.nodes) {
      const asset = node.data.asset
      if (!asset || roles[asset.id]) continue
      const known = context.existingAssets?.find((item) => item.id === asset.id)
      // This is a new import of historical local material, not evidence of a
      // generated gallery original. Reference selection/prompt/time is irrelevant.
      roles[asset.id] = known
        ? { role: known.role, nodeId: known.nodeId }
        : { role: 'reference', nodeId: node.id }
    }
    const encoded = await encodeCanvas(kind, document, { ...context, roles })
    context.signal?.throwIfAborted()
    const canvas = await importLegacyCanvas(
      {
        id: crypto.randomUUID(),
        userId,
        kind,
        name: kind === 'drawing' ? t('Drawing') : t('NovelAI'),
        document: encoded.document,
        revision: 0,
        cloudRevision: 0,
        localSavedAt: 0,
        cloudSavedRevision: 0,
        expiresAt: 0,
        status: 'local',
        needsExplicitSave: true,
        removedAssetIds: [],
        deleted: false,
      },
      encoded.assets
    )
    if (!canvas.deleted) migrated.push(canvas)
  }
  return migrated
}

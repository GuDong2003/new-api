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
import { useReactFlow } from '@xyflow/react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  captureCanvasTarget,
  assertCanvasTarget,
} from '@/features/gallery/components/canvas-node-deletion'
import { exportCanvasProject } from '@/features/gallery/lib/canvas-projects'
import { useDrawingStore } from '@/stores/drawing-store'

import { parseDrawingDocument } from '../lib/canvas-document'
import { downloadBlob, imageFileToAsset } from '../lib/image-assets'
import type { DrawingDocument, DrawingNode, ImageAsset } from '../types'

export function useCanvasFiles() {
  const { t } = useTranslation()
  const flow = useReactFlow<DrawingNode>()
  const [busy, setBusy] = useState(false)
  const pendingImportTarget = useRef<ReturnType<
    typeof captureCanvasTarget
  > | null>(null)
  const [pendingImport, setPendingImport] = useState<DrawingDocument | null>(
    null
  )

  const addImages = async (
    files: File[],
    position: { x: number; y: number },
    asReferences = false
  ) => {
    if (!files.length) return
    const target = captureCanvasTarget('drawing')
    if (useDrawingStore.getState().nodes.length + files.length > 500) {
      toast.error(
        t(
          'This canvas can hold up to 500 images. Export it before starting a new one.'
        )
      )
      return
    }
    setBusy(true)
    try {
      const assets: ImageAsset[] = []
      for (const file of files) assets.push(await imageFileToAsset(file))
      assertCanvasTarget('drawing', target)
      const state = useDrawingStore.getState()
      const nodes: DrawingNode[] = assets.map((asset, index) => ({
        id: crypto.randomUUID(),
        type: 'image',
        dragHandle: '.drawing-node-handle',
        position: {
          x: position.x + (index % 3) * 312,
          y: position.y + Math.floor(index / 3) * 370,
        },
        width: 280,
        height: 330,
        selected: true,
        data: {
          asset,
          prompt: '',
          settings: { ...state.settings },
          status: 'complete',
          createdAt: Date.now(),
        },
      }))
      state.addNodes(nodes)
      if (asReferences) {
        state.setReferences([
          ...state.referenceIds,
          ...nodes.map((node) => node.id),
        ])
        state.updateSettings({ mode: 'edit' })
      }
      requestAnimationFrame(() => {
        try {
          assertCanvasTarget('drawing', target)
          void flow.fitView({ nodes, padding: 0.3, maxZoom: 1 })
        } catch {
          /* The selected canvas changed during layout. */
        }
      })
    } catch (error) {
      toast.error(
        t(
          error instanceof Error
            ? error.message
            : 'The image could not be loaded.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const importCanvas = async (file: File) => {
    const target = captureCanvasTarget('drawing')
    setBusy(true)
    try {
      if (file.size > 200 * 1024 * 1024) {
        throw new Error('Canvas files must be smaller than 200 MB.')
      }
      const document = parseDrawingDocument(JSON.parse(await file.text()))
      assertCanvasTarget('drawing', target)
      pendingImportTarget.current = target
      setPendingImport(document)
    } catch (error) {
      toast.error(
        t(
          error instanceof Error && !(error instanceof SyntaxError)
            ? error.message
            : 'This file is not a valid drawing canvas.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const exportCanvas = async () => {
    try {
      const target = captureCanvasTarget('drawing')
      downloadBlob(
        await exportCanvasProject(target.identity, 'drawing'),
        `new-api-canvas-${new Date().toISOString().slice(0, 10)}.json`
      )
    } catch {
      toast.error(t('The canvas could not be exported.'))
    }
  }
  return {
    addImages,
    importCanvas,
    exportCanvas,
    busy,
    pendingImport,
    pendingImportTarget,
    setPendingImport,
  }
}

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
import { beforeEach, describe, expect, it } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import type { DrawingNode } from '../../types'
import {
  parseDrawingDocument,
  serializeDrawingDocument,
} from '../canvas-document'
import { loadDrawingDocument, saveDrawingDocument } from '../canvas-storage'
import { DEFAULT_IMAGE_SETTINGS } from '../image-settings'

const image: DrawingNode = {
  id: 'image-a',
  type: 'image',
  position: { x: 12, y: 24 },
  width: 280,
  height: 330,
  data: {
    prompt: 'A cup',
    status: 'complete',
    createdAt: 1,
    settings: {
      ...DEFAULT_IMAGE_SETTINGS,
      prompt: 'A cup',
      model: 'gpt-image-1',
    },
    asset: {
      id: 'asset-a',
      name: 'cup.png',
      src: 'data:image/png;base64,YWJj',
      mimeType: 'image/png',
      width: 1024,
      height: 1024,
    },
  },
}
beforeEach(() => useDrawingStore.getState().initialize(802))
describe('Canvas documents', () => {
  it('persists the canvas store as data and restores images only for their owner', async () => {
    useDrawingStore.getState().addNodes([image])
    await saveDrawingDocument(802, useDrawingStore.getState())
    const restored = await loadDrawingDocument(802)
    expect(restored?.nodes[0].data.asset?.src).toBe(image.data.asset?.src)
    expect(restored?.nodes[0].position).toEqual({ x: 12, y: 24 })
    expect(await loadDrawingDocument(803)).toBeNull()
  })
  it('exports no transient state or undo history and restores pending generations as stopped', () => {
    useDrawingStore.getState().addNodes([
      {
        ...image,
        data: { ...image.data, status: 'pending', jobId: 'job-a' },
      },
    ])
    const exported = serializeDrawingDocument(useDrawingStore.getState())
    expect(Object.keys(exported).sort()).toEqual([
      'edges',
      'mask',
      'nodes',
      'referenceIds',
      'settings',
      'version',
      'viewport',
    ])
    const restored = parseDrawingDocument(exported)
    expect(restored.nodes[0].data.status).toBe('cancelled')
    expect(restored.nodes[0].data.jobId).toBeUndefined()
  })
  it('keeps generated images recoverable when an unfinished numeric form field is invalid', () => {
    useDrawingStore.getState().addNodes([image])
    useDrawingStore
      .getState()
      .updateSettings({ n: Number.NaN, prompt: 'Next image' })
    const restored = parseDrawingDocument(
      serializeDrawingDocument(useDrawingStore.getState())
    )
    expect(restored.nodes[0].data.asset?.src).toBe(image.data.asset?.src)
    expect(restored.settings.n).toBe(1)
    expect(restored.settings.prompt).toBe('Next image')
  })
  it('restores the active reference selection when reopening an editing canvas', () => {
    useDrawingStore.getState().addNodes([image])
    useDrawingStore.getState().toggleReference(image.id)
    const restored = parseDrawingDocument(
      serializeDrawingDocument(useDrawingStore.getState())
    )
    useDrawingStore.getState().initialize(802)
    useDrawingStore.getState().hydrate(restored)
    expect(useDrawingStore.getState().referenceIds).toEqual([image.id])
    expect(useDrawingStore.getState().settings.mode).toBe('edit')
  })
  it('rejects executable image URLs and duplicate node IDs on import', () => {
    useDrawingStore.getState().addNodes([image])
    const document = serializeDrawingDocument(useDrawingStore.getState())
    expect(() =>
      parseDrawingDocument({ ...document, nodes: [image, image] })
    ).toThrow('This file is not a valid drawing canvas.')
    expect(() =>
      parseDrawingDocument({
        ...document,
        nodes: [
          {
            ...image,
            data: {
              ...image.data,
              asset: { ...image.data.asset, src: 'javascript:alert(1)' },
            },
          },
        ],
      })
    ).toThrow('This file is not a valid drawing canvas.')
  })
  it('undoes moves and deletions without reverting asynchronous generation results', () => {
    useDrawingStore
      .getState()
      .addNodes([{ ...image, data: { ...image.data, status: 'pending' } }])
    useDrawingStore.getState().checkpoint()
    useDrawingStore.getState().changeNodes([
      {
        type: 'position',
        id: image.id,
        position: { x: 120, y: 200 },
        dragging: true,
      },
    ])
    useDrawingStore.getState().updateNodeData(image.id, { status: 'complete' })
    useDrawingStore.getState().undo()
    expect(useDrawingStore.getState().nodes[0].position).toEqual({
      x: 12,
      y: 24,
    })
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
    useDrawingStore.getState().removeNodes([image.id])
    expect(useDrawingStore.getState().nodes).toHaveLength(0)
    useDrawingStore.getState().undo()
    expect(useDrawingStore.getState().nodes[0].data.status).toBe('complete')
    useDrawingStore.getState().redo()
    expect(useDrawingStore.getState().nodes).toHaveLength(0)
  })
})

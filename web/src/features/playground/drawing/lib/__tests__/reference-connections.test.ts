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
import { DEFAULT_IMAGE_SETTINGS } from '../image-settings'

function imageNode(
  id: string,
  status: DrawingNode['data']['status'] = 'complete'
): DrawingNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      prompt: id,
      settings: { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1', prompt: id },
      status,
      createdAt: 1,
      asset:
        status === 'complete'
          ? {
              id,
              name: `${id}.png`,
              src: 'data:image/png;base64,YWJj',
              mimeType: 'image/png',
              width: 512,
              height: 512,
            }
          : undefined,
    },
  }
}

beforeEach(() => useDrawingStore.getState().initialize(818))

describe('Image reference connections', () => {
  it('automatically switches the sidebar mode when references are selected or cleared', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A')])

    store.setReferences(['A'])
    expect(useDrawingStore.getState().settings.mode).toBe('edit')

    store.setReferences([])
    expect(useDrawingStore.getState().settings.mode).toBe('generate')
  })

  it('reorders selected references without changing the selected set', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A'), imageNode('B'), imageNode('C')])
    store.setReferences(['A', 'B', 'C'])

    store.reorderReferences('C', 'A')

    expect(useDrawingStore.getState().referenceIds).toEqual(['C', 'A', 'B'])
    expect(useDrawingStore.getState().settings.mode).toBe('edit')
  })

  it('keeps a manually selected mode while the reference set remains non-empty', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A'), imageNode('B')])
    store.setReferences(['A'])
    store.updateSettings({ mode: 'generate' })

    store.setReferences(['A', 'B'])
    store.reorderReferences('B', 'A')

    expect(useDrawingStore.getState().settings.mode).toBe('generate')
  })

  it('connects a completed image to a failed result without starting generation and preserves the relation across save and undo', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A'), imageNode('B', 'error')])

    expect(store.connectReference({ source: 'A', target: 'B' })).toBe(true)
    expect(useDrawingStore.getState().nodes[1].data).toMatchObject({
      referenceIds: ['A'],
      settings: { mode: 'edit' },
      status: 'error',
    })
    expect(useDrawingStore.getState().edges).toMatchObject([
      { source: 'A', target: 'B' },
    ])
    const saved = parseDrawingDocument(
      serializeDrawingDocument(useDrawingStore.getState())
    )
    expect(saved.nodes[1].data.referenceIds).toEqual(['A'])
    expect(saved.edges).toHaveLength(1)

    store.undo()
    expect(useDrawingStore.getState().edges).toEqual([])
    expect(useDrawingStore.getState().nodes[1].data.settings.mode).toBe(
      'generate'
    )
    store.redo()
    expect(useDrawingStore.getState().nodes[1].data.referenceIds).toEqual(['A'])
  })

  it('removes a reference and its mask with a selected edge and restores them on undo', () => {
    const a = imageNode('A')
    const b = imageNode('B', 'error')
    b.data = {
      ...b.data,
      referenceIds: ['A'],
      mask: a.data.asset,
      settings: { ...b.data.settings, mode: 'edit' },
    }
    const store = useDrawingStore.getState()
    store.addNodes([a, b], [{ id: 'A-B', source: 'A', target: 'B' }])

    store.changeEdges([{ type: 'remove', id: 'A-B' }])
    expect(useDrawingStore.getState().nodes[1].data).toMatchObject({
      referenceIds: [],
      settings: { mode: 'generate' },
    })
    expect(useDrawingStore.getState().nodes[1].data.mask).toBeUndefined()
    expect(useDrawingStore.getState().edges).toEqual([])
    store.undo()
    expect(useDrawingStore.getState().nodes[1].data.mask).toEqual(a.data.asset)
    expect(useDrawingStore.getState().edges).toHaveLength(1)
  })

  it('rejects duplicate, self and circular references', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A'), imageNode('B'), imageNode('C')])
    expect(store.connectReference({ source: 'A', target: 'B' })).toBe(true)
    expect(store.connectReference({ source: 'B', target: 'C' })).toBe(true)
    expect(store.connectReference({ source: 'A', target: 'B' })).toBe(false)
    expect(store.connectReference({ source: 'A', target: 'A' })).toBe(false)
    expect(store.connectReference({ source: 'C', target: 'A' })).toBe(false)
    expect(useDrawingStore.getState().edges).toHaveLength(2)
  })

  it('keeps references immutable during generation and rejects unavailable source images', () => {
    const store = useDrawingStore.getState()
    const pending = imageNode('B', 'pending')
    pending.data.referenceIds = ['A']
    store.addNodes(
      [imageNode('A'), pending, imageNode('C', 'error')],
      [{ id: 'A-B', source: 'A', target: 'B' }]
    )
    expect(store.connectReference({ source: 'A', target: 'B' })).toBe(false)
    expect(store.connectReference({ source: 'C', target: 'A' })).toBe(false)
    store.changeEdges([{ type: 'remove', id: 'A-B' }])
    expect(useDrawingStore.getState().edges).toHaveLength(1)
    expect(useDrawingStore.getState().nodes[1].data.referenceIds).toEqual(['A'])
  })

  it('enforces model reference limits and rejects connections to models without editing support', () => {
    const store = useDrawingStore.getState()
    const b = imageNode('B')
    b.data.settings.model = 'dall-e-2'
    const c = imageNode('C')
    c.data.settings.model = 'dall-e-3'
    store.addNodes([imageNode('A'), b, c, imageNode('D')])
    expect(store.connectReference({ source: 'A', target: 'B' })).toBe(true)
    expect(store.connectReference({ source: 'D', target: 'B' })).toBe(false)
    expect(store.connectReference({ source: 'A', target: 'C' })).toBe(false)
  })
})

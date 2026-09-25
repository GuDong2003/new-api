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
import type { Edge } from '@xyflow/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import type { DrawingNode } from '../../types'
import {
  parseDrawingDocument,
  serializeDrawingDocument,
} from '../canvas-document'
import { DEFAULT_IMAGE_SETTINGS } from '../image-settings'
import { decorateReferenceEdges } from '../reference-connections'

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

describe('Prompt mentions follow the reference list', () => {
  function withReferences(
    node: DrawingNode,
    prompt: string,
    referenceIds: string[]
  ): DrawingNode {
    return {
      ...node,
      data: {
        ...node.data,
        prompt,
        referenceIds,
        settings: { ...node.data.settings, prompt, mode: 'edit' },
      },
    }
  }

  // Every image one model generates is named after the model, so names alone
  // cannot tell such references apart.
  function named(id: string, name: string): DrawingNode {
    const node = imageNode(id)
    return {
      ...node,
      data: {
        ...node.data,
        asset: node.data.asset && { ...node.data.asset, name },
      },
    }
  }
  const SAME_NAMED_PROMPT = '把@1 (gpt-image-2-1)的角色放进@2 (gpt-image-2-1)'

  it('restores same-named mentions exactly when undo reverses a clear', () => {
    const store = useDrawingStore.getState()
    store.addNodes([named('X1', 'gpt-image-2-1'), named('X2', 'gpt-image-2-1')])
    store.setReferences(['X1', 'X2'])
    store.updateSettings({ prompt: SAME_NAMED_PROMPT })
    store.clear()
    expect(useDrawingStore.getState().settings.prompt).toBe(
      '把@? (gpt-image-2-1)的角色放进@? (gpt-image-2-1)'
    )

    store.undo()

    expect(useDrawingStore.getState().settings.prompt).toBe(SAME_NAMED_PROMPT)
  })

  it('restores same-named mentions through undoing and redoing each deletion', () => {
    const store = useDrawingStore.getState()
    store.addNodes([named('X1', 'gpt-image-2-1'), named('X2', 'gpt-image-2-1')])
    store.setReferences(['X1', 'X2'])
    store.updateSettings({ prompt: SAME_NAMED_PROMPT })
    store.removeNodes(['X1'])
    store.removeNodes(['X2'])

    store.undo()
    store.undo()
    expect(useDrawingStore.getState().referenceIds).toEqual(['X1', 'X2'])
    expect(useDrawingStore.getState().settings.prompt).toBe(SAME_NAMED_PROMPT)

    store.redo()
    expect(useDrawingStore.getState().settings.prompt).toBe(
      '把@? (gpt-image-2-1)的角色放进@1 (gpt-image-2-1)'
    )
  })

  it('keeps the edits and renumbers the bound mentions when the prompt changed after the deletion', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A'), imageNode('B')])
    store.setReferences(['A', 'B'])
    store.updateSettings({ prompt: '@1 (A.png) 和 @2 (B.png)' })
    store.removeNodes(['A'])
    store.updateSettings({ prompt: '@? (A.png) 和 @1 (B.png)，再加点雾' })

    store.undo()

    expect(useDrawingStore.getState().settings.prompt).toBe(
      '@? (A.png) 和 @2 (B.png)，再加点雾'
    )
  })

  it('leaves same-named mentions unbound instead of guessing when their images are selected again', () => {
    const store = useDrawingStore.getState()
    store.addNodes([named('X1', 'gpt-image-2-1'), named('X2', 'gpt-image-2-1')])
    store.setReferences(['X1', 'X2'])
    store.updateSettings({ prompt: SAME_NAMED_PROMPT })

    for (const id of ['X1', 'X2', 'X1', 'X2']) store.toggleReference(id)

    expect(useDrawingStore.getState().referenceIds).toEqual(['X1', 'X2'])
    expect(useDrawingStore.getState().settings.prompt).toBe(
      '把@? (gpt-image-2-1)的角色放进@? (gpt-image-2-1)'
    )
  })

  it('renumbers the composer prompt when references are reordered', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A'), imageNode('B')])
    store.setReferences(['A', 'B'])
    store.updateSettings({ prompt: '把@2 (B.png)的角色放进@1 (A.png)' })

    store.reorderReferences('B', 'A')

    expect(useDrawingStore.getState().settings.prompt).toBe(
      '把@1 (B.png)的角色放进@2 (A.png)'
    )
  })

  it('unbinds the mention of a reference taken off the list and shifts the ones after it', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A'), imageNode('B'), imageNode('C')])
    store.setReferences(['A', 'B', 'C'])
    store.updateSettings({ prompt: '@1 (A.png) @2 (B.png) @3 (C.png)' })

    store.toggleReference('B')

    expect(useDrawingStore.getState().settings.prompt).toBe(
      '@1 (A.png) @? (B.png) @2 (C.png)'
    )
  })

  it('numbers the mentions again when undo brings a deleted reference back', () => {
    const store = useDrawingStore.getState()
    store.addNodes([imageNode('A'), imageNode('B'), imageNode('C')])
    store.setReferences(['A', 'B', 'C'])
    store.updateSettings({ prompt: '@1 (A.png) @2 (B.png) @3 (C.png)' })
    store.removeNodes(['B'])
    expect(useDrawingStore.getState().settings.prompt).toBe(
      '@1 (A.png) @? (B.png) @2 (C.png)'
    )

    store.undo()

    expect(useDrawingStore.getState().referenceIds).toEqual(['A', 'B', 'C'])
    expect(useDrawingStore.getState().settings.prompt).toBe(
      '@1 (A.png) @2 (B.png) @3 (C.png)'
    )
  })

  it("renumbers an image's own prompt when one of its reference connections is removed", () => {
    const store = useDrawingStore.getState()
    const target = withReferences(
      imageNode('C', 'error'),
      '@1 (A.png) 和 @2 (B.png)',
      ['A', 'B']
    )
    store.addNodes(
      [imageNode('A'), imageNode('B'), target],
      [
        { id: 'A-C', source: 'A', target: 'C' },
        { id: 'B-C', source: 'B', target: 'C' },
      ]
    )

    store.changeEdges([{ type: 'remove', id: 'A-C' }])

    expect(useDrawingStore.getState().nodes[2].data).toMatchObject({
      referenceIds: ['B'],
      prompt: '@? (A.png) 和 @1 (B.png)',
    })
  })

  it("reuses an image's prompt numbered for its own references, whatever the composer held", () => {
    const store = useDrawingStore.getState()
    const source = withReferences(imageNode('C'), '@1 (A.png) 和 @2 (B.png)', [
      'A',
      'B',
    ])
    store.addNodes([imageNode('A'), imageNode('B'), source])
    store.setReferences(['B', 'A'])
    store.updateSettings({ prompt: '先前的 @1 (B.png)' })

    store.reuseNodeSettings('C')

    expect(useDrawingStore.getState().referenceIds).toEqual(['A', 'B'])
    expect(useDrawingStore.getState().settings.prompt).toBe(
      '@1 (A.png) 和 @2 (B.png)'
    )
  })

  it("carries a reused prompt's mentions over to the references that still exist", () => {
    const store = useDrawingStore.getState()
    const source = withReferences(imageNode('C'), '@1 (A.png) 和 @2 (B.png)', [
      'A',
      'B',
    ])
    store.addNodes([imageNode('A'), imageNode('B'), source])
    store.removeNodes(['A'])

    store.reuseNodeSettings('C')

    expect(useDrawingStore.getState().referenceIds).toEqual(['B'])
    expect(useDrawingStore.getState().settings.prompt).toBe(
      '@? (A.png) 和 @1 (B.png)'
    )
  })
})

describe('Reference edge appearance', () => {
  const edge = (id: string, target: string, selected = false): Edge => ({
    id,
    source: 'reference',
    target,
    ...(selected ? { selected } : {}),
  })

  it('leaves a quiet connection untouched so it stays in the background', () => {
    const edges = [edge('quiet', 'idle')]

    const decorated = decorateReferenceEdges(edges, new Set<string>())

    expect(decorated[0]).toBe(edges[0])
  })

  it('animates a connection feeding an image that is generating', () => {
    const decorated = decorateReferenceEdges(
      [edge('busy', 'generating')],
      new Set(['generating'])
    )

    expect(decorated[0].animated).toBe(true)
    expect(decorated[0].style).toMatchObject({
      stroke: 'var(--primary)',
      strokeWidth: 2.5,
    })
  })

  // Selecting an edge is how a reference gets removed, so it has to stand out,
  // but nothing is being consumed yet and marching ants would claim otherwise.
  it('highlights a selected connection without animating it', () => {
    const decorated = decorateReferenceEdges(
      [edge('picked', 'idle', true)],
      new Set<string>()
    )

    expect(decorated[0].animated).toBe(false)
    expect(decorated[0].style).toMatchObject({ stroke: 'var(--primary)' })
  })
})

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
  arrangeImageNodes,
  parseDrawingDocument,
  positionGeneratedImageNodes,
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

function canvasImage(
  id: string,
  position = { x: 0, y: 0 },
  dimensions?: { width?: number; height?: number },
  selected?: boolean
): DrawingNode {
  return {
    ...image,
    id,
    position,
    ...dimensions,
    ...(selected === undefined ? {} : { selected }),
  }
}

beforeEach(() => useDrawingStore.getState().initialize(802))
describe('Canvas documents', () => {
  it('arranges two reference images above one generated result', () => {
    const referenceA = canvasImage('reference-a', { x: 900, y: 20 })
    const referenceB = canvasImage('reference-b', { x: 120, y: 640 })
    const result = canvasImage('generated-result', { x: -400, y: -300 })

    const arranged = arrangeImageNodes(
      [referenceA, referenceB, result],
      [
        {
          id: 'reference-a-generated-result',
          source: referenceA.id,
          target: result.id,
        },
        {
          id: 'reference-b-generated-result',
          source: referenceB.id,
          target: result.id,
        },
      ]
    )

    expect(arranged.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 370 },
      { x: 320, y: 185 },
    ])
  })

  it('places generated results to the right of references and centers them vertically', () => {
    const referenceA = canvasImage('reference-a', { x: 100, y: 100 })
    const referenceB = canvasImage('reference-b', { x: 100, y: 470 })
    const generated = canvasImage('generated-result')

    const positioned = positionGeneratedImageNodes(
      [referenceA, referenceB],
      [generated],
      [referenceA, referenceB],
      { x: 20, y: 30 }
    )

    expect(positioned[0].position).toEqual({ x: 420, y: 285 })
  })

  it('uses reference connections when arranging through the drawing store', () => {
    const referenceA = canvasImage('reference-a', { x: 900, y: 20 })
    const referenceB = canvasImage('reference-b', { x: 120, y: 640 })
    const result = canvasImage('generated-result', { x: -400, y: -300 })
    const store = useDrawingStore.getState()
    const edges = [
      {
        id: 'reference-a-generated-result',
        source: referenceA.id,
        target: result.id,
      },
      {
        id: 'reference-b-generated-result',
        source: referenceB.id,
        target: result.id,
      },
    ]
    store.addNodes([referenceA, referenceB, result], edges)

    store.arrange()

    expect(useDrawingStore.getState().edges).toEqual(edges)
    expect(
      useDrawingStore.getState().nodes.map((node) => node.position)
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 370 },
      { x: 320, y: 185 },
    ])
  })

  it('uses an adaptive row for two generated results without references', () => {
    const generatedA = canvasImage('generated-a')
    const generatedB = canvasImage('generated-b')

    const positioned = positionGeneratedImageNodes(
      [],
      [generatedA, generatedB],
      [],
      { x: 10, y: 20 }
    )

    expect(positioned.map((node) => node.position)).toEqual([
      { x: 10, y: 20 },
      { x: 330, y: 20 },
    ])
  })

  it('keeps a one-to-two generation graph on separate adaptive layers', () => {
    const source = canvasImage('source')
    const generatedA = canvasImage('generated-a')
    const generatedB = canvasImage('generated-b')

    const arranged = arrangeImageNodes(
      [source, generatedA, generatedB],
      [
        { id: 'source-generated-a', source: source.id, target: generatedA.id },
        { id: 'source-generated-b', source: source.id, target: generatedB.id },
      ]
    )

    expect(arranged.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 320, y: 0 },
      { x: 640, y: 0 },
    ])
  })

  it('keeps a multi-step image chain flowing from left to right', () => {
    const referenceA = canvasImage('reference-a')
    const referenceB = canvasImage('reference-b')
    const result = canvasImage('generated-result')
    const refined = canvasImage('refined-result')

    const arranged = arrangeImageNodes(
      [referenceA, referenceB, result, refined],
      [
        { id: 'reference-a-result', source: referenceA.id, target: result.id },
        { id: 'reference-b-result', source: referenceB.id, target: result.id },
        { id: 'result-refined', source: result.id, target: refined.id },
      ]
    )

    expect(arranged.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 370 },
      { x: 320, y: 185 },
      { x: 640, y: 185 },
    ])
  })

  it('uses a compact grid for a larger generated batch', () => {
    const generated = Array.from({ length: 4 }, (_, index) =>
      canvasImage(`generated-${index}`)
    )

    const positioned = positionGeneratedImageNodes([], generated, [], {
      x: 10,
      y: 20,
    })

    expect(positioned.map((node) => node.position)).toEqual([
      { x: 10, y: 20 },
      { x: 330, y: 20 },
      { x: 10, y: 390 },
      { x: 330, y: 390 },
    ])
  })

  it('moves a generated group past an occupied area instead of overlapping it', () => {
    const reference = canvasImage('reference', { x: 100, y: 100 })
    const occupied = canvasImage('occupied', { x: 420, y: 100 })
    const generated = canvasImage('generated')

    const positioned = positionGeneratedImageNodes(
      [reference, occupied],
      [generated],
      [reference],
      { x: 0, y: 0 }
    )

    expect(positioned[0].position).toEqual({ x: 740, y: 100 })
  })

  it('keeps moving a generated group until all occupied areas are clear', () => {
    const reference = canvasImage('reference', { x: 100, y: 100 })
    const occupiedA = canvasImage('occupied-a', { x: 420, y: 100 })
    const occupiedB = canvasImage('occupied-b', { x: 740, y: 100 })
    const generated = canvasImage('generated')

    const positioned = positionGeneratedImageNodes(
      [reference, occupiedA, occupiedB],
      [generated],
      [reference],
      { x: 0, y: 0 }
    )

    expect(positioned[0].position).toEqual({ x: 1060, y: 100 })
  })

  it('uses actual node dimensions when centering a relationship layer', () => {
    const referenceA = canvasImage(
      'reference-a',
      { x: 0, y: 0 },
      {
        width: 200,
        height: 200,
      }
    )
    const referenceB = canvasImage(
      'reference-b',
      { x: 0, y: 0 },
      {
        width: 300,
        height: 400,
      }
    )
    const result = canvasImage(
      'generated-result',
      { x: 0, y: 0 },
      {
        width: 250,
        height: 100,
      }
    )

    const arranged = arrangeImageNodes(
      [referenceA, referenceB, result],
      [
        {
          id: 'reference-a-generated-result',
          source: referenceA.id,
          target: result.id,
        },
        {
          id: 'reference-b-generated-result',
          source: referenceB.id,
          target: result.id,
        },
      ]
    )

    expect(arranged.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 240 },
      { x: 340, y: 270 },
    ])
  })

  it('packs disconnected images into an adaptive grid', () => {
    const arranged = arrangeImageNodes([
      canvasImage('image-a'),
      canvasImage('image-b'),
      canvasImage('image-c'),
    ])

    expect(arranged.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 376, y: 0 },
      { x: 0, y: 426 },
    ])
  })

  it('keeps unrelated nodes in place when arranging a selected connection group', () => {
    const referenceA = canvasImage('reference-a', { x: 500, y: 200 })
    const referenceB = canvasImage('reference-b', { x: 500, y: 570 })
    const result = canvasImage(
      'generated-result',
      { x: 820, y: 385 },
      undefined,
      true
    )
    const unrelated = canvasImage('unrelated', { x: 1400, y: 900 })

    const arranged = arrangeImageNodes(
      [referenceA, referenceB, result, unrelated],
      [
        {
          id: 'reference-a-generated-result',
          source: referenceA.id,
          target: result.id,
        },
        {
          id: 'reference-b-generated-result',
          source: referenceB.id,
          target: result.id,
        },
      ]
    )

    expect(arranged.find((node) => node.id === unrelated.id)?.position).toEqual(
      unrelated.position
    )
    const arrangedA = arranged.find((node) => node.id === referenceA.id)
    const arrangedB = arranged.find((node) => node.id === referenceB.id)
    const arrangedResult = arranged.find((node) => node.id === result.id)
    expect(arrangedA?.position.x).toBe(arrangedB?.position.x)
    expect(arrangedResult?.position.x).toBeGreaterThan(
      arrangedA?.position.x ?? 0
    )
  })

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

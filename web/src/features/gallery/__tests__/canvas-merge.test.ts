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
import { describe, expect, it } from 'vitest'

import { mergeCanvasDocuments } from '../lib/canvas-document'

const node = (id: string, data: Record<string, unknown> = {}) => ({
  id,
  type: 'image',
  position: { x: 0, y: 0 },
  data: { prompt: '', status: 'complete', createdAt: 1, ...data },
})
const asset = (id: string) => ({
  id,
  name: `${id}.png`,
  width: 1,
  height: 1,
  mimeType: 'image/png',
})
const drawing = (nodes: ReturnType<typeof node>[]) => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  settings: { prompt: '' },
  referenceIds: [],
  mask: null,
  nodes,
  edges: [],
})

describe('merging what two tabs saved', () => {
  it('settles a node both tabs changed on the same version in either tab', () => {
    const base = drawing([node('generating', { status: 'pending' })])
    const here = drawing([node('generating', { asset: asset('a') })])
    const there = drawing([node('generating', { asset: asset('b') })])

    expect(mergeCanvasDocuments(base, here, there, []).nodes).toEqual(
      mergeCanvasDocuments(base, there, here, []).nodes
    )
  })

  it('keeps a move made here and a result stored there on the same node', () => {
    const base = drawing([node('generating', { status: 'pending' })])
    const here = drawing([
      {
        ...node('generating', { status: 'pending' }),
        position: { x: 5, y: 6 },
      },
    ])
    const there = drawing([node('generating', { asset: asset('a') })])

    expect(mergeCanvasDocuments(base, here, there, []).nodes).toEqual([
      {
        ...node('generating', { asset: asset('a') }),
        position: { x: 5, y: 6 },
      },
    ])
  })

  // A request numbers its references by their order, so an original deleted
  // elsewhere unbinds the mentions that named it and moves the rest up.
  it('renumbers the prompt mentions of references an original deleted elsewhere takes away', () => {
    const saved = {
      ...drawing([
        node('a', { asset: asset('a') }),
        node('b', { asset: asset('b') }),
        node('edited', {
          status: 'error',
          prompt: '@1 (a.png) 和 @2 (b.png)',
          referenceIds: ['a', 'b'],
        }),
      ]),
      referenceIds: ['a', 'b'],
      settings: { prompt: '把@2 (b.png)放进@1 (a.png)' },
    }

    const merged = mergeCanvasDocuments(saved, saved, saved, ['a'])

    expect(merged.referenceIds).toEqual(['b'])
    expect(merged.settings).toEqual({ prompt: '把@1 (b.png)放进@? (a.png)' })
    expect(
      (merged.nodes as ReturnType<typeof node>[]).find(
        (item) => item.id === 'edited'
      )?.data
    ).toMatchObject({
      referenceIds: ['b'],
      prompt: '@? (a.png) 和 @1 (b.png)',
    })
  })
})

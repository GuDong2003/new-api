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
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'

import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  saveDrawingDocument,
  loadDrawingDocument,
} from '../../playground/drawing/lib/canvas-storage'
import type { DrawingDocument } from '../../playground/drawing/types'
import {
  saveNaiCanvasDocument,
  loadNaiCanvasDocument,
} from '../../playground/nai/lib/canvas-storage'
import type { NaiCanvasDocument } from '../../playground/nai/types'
import { encodeCanvas, decodeCanvas } from '../lib/canvas-document'
import { migrateLegacyCanvases } from '../lib/canvas-migration'
import {
  saveLocalCanvas,
  loadLocalCanvas,
  listLocalCanvases,
  readCanvasAssets,
  removeLocalCanvasAsset,
  removeLocalCanvas,
  readCanvasUserState,
  updateCanvasUserState,
  writeCanvasUserState,
  acknowledgeCanvasSave,
} from '../lib/canvas-repository'
import type { CanvasRemoteAsset, LocalCanvas } from '../types'

const originalId = '00000000-0000-4000-8000-000000000001'
const maskId = '00000000-0000-4000-8000-000000000002'
const otherId = '00000000-0000-4000-8000-000000000003'
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKn0AAAAASUVORK5CYII='
const pngBytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0))
const source = `data:image/png;base64,${pngBase64}`
const asset = {
  id: originalId,
  name: '原图.png',
  src: source,
  width: 1,
  height: 1,
  mimeType: 'image/png',
}

// Literal settings intentionally contain an unknown secret: only the parser's
// supported settings may reach IndexedDB or a cloud document.
function drawing(): DrawingDocument {
  return {
    version: 1,
    nodes: [
      {
        id: 'source',
        type: 'image',
        position: { x: 11, y: 12 },
        data: {
          asset,
          prompt: '原图',
          settings: {},
          status: 'complete',
          createdAt: 1,
          usage: {
            input_tokens: 3,
            apiKey: 'never-persist',
            input_tokens_details: { image_tokens: 2, secret: 'never-persist' },
          },
        },
      },
      {
        id: 'duplicate',
        type: 'image',
        position: { x: 21, y: 22 },
        data: {
          asset,
          prompt: '重复引用',
          settings: {},
          status: 'complete',
          createdAt: 2,
        },
      },
    ],
    edges: [{ id: 'edge', source: 'source', target: 'duplicate' }],
    viewport: { x: 7, y: 8, zoom: 1.2 },
    settings: { prompt: '测试提示', apiKey: 'never-persist' },
    referenceIds: ['source'],
    mask: {
      referenceId: 'source',
      asset: { ...asset, id: maskId, name: '蒙版.png' },
    },
  } as unknown as DrawingDocument
}

function local(
  document: Record<string, unknown>,
  id = '00000000-0000-4000-8000-000000000041'
): LocalCanvas {
  return {
    id,
    userId: 41,
    kind: 'drawing',
    name: '测试画布',
    document,
    revision: 0,
    cloudRevision: 0,
    localSavedAt: 0,
    cloudSavedRevision: 0,
    expiresAt: 0,
    status: 'local',
    needsExplicitSave: false,
    removedAssetIds: [],
    deleted: false,
  }
}

async function encodedDrawing() {
  return encodeCanvas('drawing', drawing(), {
    roles: { [originalId]: { role: 'generated', nodeId: 'source' } },
  })
}

function remoteAsset(id: string, sha256: string): CanvasRemoteAsset {
  return {
    id,
    role: 'generated',
    node_id: 'source',
    sha256,
    bytes: 68,
    width: 1,
    height: 1,
    mime_type: 'image/png',
    has_thumbnail: false,
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('canvas originals and browser persistence', () => {
  it('roundtrips original PNG bytes and relations across multi-canvas and user-scoped reloads', async () => {
    const encoded = await encodedDrawing()
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    await saveLocalCanvas(
      local(encoded.document, '00000000-0000-4000-8000-000000000042'),
      encoded.assets
    )
    const loaded = await loadLocalCanvas(41, saved.id)
    expect(loaded?.name).toBe('测试画布')
    expect(loaded?.revision).toBe(1)
    expect(loaded?.localSavedAt).toBeGreaterThan(0)
    expect(await loadLocalCanvas(42, saved.id)).toBeNull()
    expect(await readCanvasAssets(42, saved.id)).toEqual([])
    expect(await listLocalCanvases(41)).toHaveLength(2)
    const binaries = await readCanvasAssets(41, saved.id)
    expect(binaries).toHaveLength(2)
    expect(new Uint8Array(await binaries[0].blob.arrayBuffer())).toEqual(
      pngBytes
    )
    expect(binaries.find((item) => item.id === originalId)?.role).toBe(
      'generated'
    )
    expect(JSON.stringify(loaded)).not.toMatch(/never-persist|data:image|"src"/)
    if (!loaded) throw new Error('Saved canvas missing')
    const restored = (await decodeCanvas(loaded, binaries)) as DrawingDocument
    expect(restored.nodes[0].data.asset).toEqual(asset)
    expect(restored.nodes[0].position).toEqual({ x: 11, y: 12 })
    expect(restored.settings.prompt).toBe('测试提示')
    expect(restored.referenceIds).toEqual(['source'])
    expect(restored.edges).toEqual([
      { id: 'edge', source: 'source', target: 'duplicate' },
    ])
    expect(restored.mask?.asset.id).toBe(maskId)
    expect(restored.nodes[0].data.usage).toEqual({
      input_tokens: 3,
      input_tokens_details: { image_tokens: 2 },
    })
  })

  it('rejects unknown original purpose rather than guessing from reference selection', async () => {
    await expect(encodeCanvas('drawing', drawing())).rejects.toThrow(/role/i)
  })

  it('does not save a URL placeholder when the captured original reader fails', async () => {
    const document = drawing()
    document.nodes[0].data.asset = {
      ...asset,
      src: 'https://example.test/original.png',
    }
    document.nodes[1].data.asset = document.nodes[0].data.asset
    await expect(
      encodeCanvas('drawing', document, {
        roles: { [originalId]: { role: 'generated', nodeId: 'source' } },
        readOriginal: async () => {
          throw new Error('original unavailable')
        },
      })
    ).rejects.toThrow('original unavailable')
    expect(await listLocalCanvases(41)).toEqual([])
  })

  it('rejects failed transactions and preserves the previous complete local revision', async () => {
    const encoded = await encodedDrawing()
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      const request = put.apply(this, args)
      if (this.name === 'assets') this.transaction.abort()
      return request
    })
    await expect(
      saveLocalCanvas({ ...saved, name: '不可见' }, encoded.assets)
    ).rejects.toBeTruthy()
    expect((await loadLocalCanvas(41, saved.id))?.name).toBe('测试画布')
  })

  it('explicit asset deletion prunes duplicates, edges and masks while preserving other images and blocking stale writes', async () => {
    const document = drawing()
    document.nodes.push({
      ...document.nodes[0],
      id: 'other',
      data: { ...document.nodes[0].data, asset: { ...asset, id: otherId } },
    })
    const encoded = await encodeCanvas('drawing', document, {
      roles: {
        [originalId]: { role: 'generated', nodeId: 'source' },
        [otherId]: { role: 'reference', nodeId: 'other' },
      },
    })
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    const removed = await removeLocalCanvasAsset(41, saved.id, originalId)
    const restored = (await decodeCanvas(
      removed,
      await readCanvasAssets(41, saved.id)
    )) as DrawingDocument
    expect(restored.nodes.map((node) => node.id)).toEqual(['other'])
    expect(restored.edges).toEqual([])
    expect(restored.referenceIds).toEqual([])
    expect(restored.mask).toBeNull()
    expect(
      (await readCanvasAssets(41, saved.id)).map((item) => item.id)
    ).toEqual([otherId])
    await expect(saveLocalCanvas(saved, encoded.assets)).rejects.toThrow(
      /stale|removed/i
    )
    await expect(
      saveLocalCanvas({ ...saved, revision: 99 }, encoded.assets)
    ).rejects.toThrow(/removed/i)
    expect((await readCanvasUserState(41)).pendingAssetRemovals).toEqual([
      { canvasId: saved.id, assetId: originalId, revision: 0 },
    ])
  })

  it('canvas tombstones survive reload and reject late saves even with a larger revision', async () => {
    const encoded = await encodedDrawing()
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    await removeLocalCanvas(41, saved.id)
    expect(await listLocalCanvases(41)).toEqual([])
    expect((await loadLocalCanvas(41, saved.id))?.deleted).toBe(true)
    expect(await readCanvasAssets(41, saved.id)).toEqual([])
    await expect(
      saveLocalCanvas({ ...saved, revision: 99 }, encoded.assets)
    ).rejects.toThrow(/deleted/i)
    expect((await readCanvasUserState(41)).pendingCanvasRemovals).toEqual([
      { canvasId: saved.id, revision: 0 },
    ])
  })

  it('persists quota pause across module reload and serializes concurrent user-state updates', async () => {
    const state = await readCanvasUserState(41)
    state.cloudPause = {
      reason: 'full',
      requiredBytes: 123,
      requiredImages: 2,
      lastQuotaCheck: 100,
      notified: true,
    }
    await writeCanvasUserState(41, state)
    await Promise.all([
      updateCanvasUserState(41, (current) => ({
        ...current,
        lastOpened: { ...current.lastOpened, drawing: 'a' },
      })),
      updateCanvasUserState(41, (current) => ({
        ...current,
        lastOpened: { ...current.lastOpened, nai: 'b' },
      })),
    ])
    vi.resetModules()
    const repository = await import('../lib/canvas-repository')
    const reloaded = await repository.readCanvasUserState(41)
    expect(reloaded.cloudPause).toEqual({
      reason: 'full',
      requiredBytes: 123,
      requiredImages: 2,
      lastQuotaCheck: 100,
      notified: true,
    })
    expect(reloaded.lastOpened).toEqual({ drawing: 'a', nai: 'b' })
    expect((await repository.readCanvasUserState(42)).cloudPause).toBeNull()
  })

  it('imports historical Drawing and NAI drafts once, preserves old stores, and keeps unknown origins local and explicit-save', async () => {
    await saveDrawingDocument(41, drawing())
    const nai = {
      version: 1,
      nodes: [
        {
          id: 'nai-node',
          type: 'nai-image',
          position: { x: 3, y: 4 },
          data: {
            asset: { ...asset, id: 'legacy-asset' },
            prompt: '白狐',
            settings: { negativePrompt: 'blur' },
            status: 'complete',
            createdAt: 2,
          },
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { negativePrompt: 'blur' },
    } as unknown as NaiCanvasDocument
    await saveNaiCanvasDocument(41, nai)
    await Promise.all([migrateLegacyCanvases(41), migrateLegacyCanvases(41)])
    const canvases = await listLocalCanvases(41)
    expect(canvases).toHaveLength(2)
    expect(canvases.map((canvas) => canvas.kind).sort()).toEqual([
      'drawing',
      'nai',
    ])
    for (const canvas of canvases) {
      expect(canvas.status).toBe('local')
      expect(canvas.needsExplicitSave).toBe(true)
      expect(canvas.cloudRevision).toBe(0)
      const originals = await readCanvasAssets(41, canvas.id)
      expect(originals.filter((item) => item.role === 'generated')).toEqual([])
      expect(new Uint8Array(await originals[0].blob.arrayBuffer())).toEqual(
        pngBytes
      )
      if (canvas.kind === 'nai') {
        expect(originals[0].id).toMatch(/^[0-9a-f-]{36}$/)
        const restored = (await decodeCanvas(
          canvas,
          originals
        )) as NaiCanvasDocument
        expect(restored.nodes[0].data.prompt).toBe('白狐')
        expect(restored.settings.negativePrompt).toBe('blur')
      }
    }
    expect((await loadDrawingDocument(41))?.nodes).toHaveLength(2)
    expect((await loadNaiCanvasDocument(41))?.nodes[0].data.asset?.id).toBe(
      'legacy-asset'
    )
    await removeLocalCanvas(41, canvases[0].id)
    await migrateLegacyCanvases(41)
    expect(await listLocalCanvases(41)).toHaveLength(1)
    expect(await migrateLegacyCanvases(42)).toEqual([])
  })

  it('rejects missing binaries during hydration instead of interpreting them as image removal', async () => {
    const encoded = await encodedDrawing()
    await expect(decodeCanvas(local(encoded.document), [])).rejects.toThrow(
      /unavailable/i
    )
  })

  it('rejects mismatched original checksums without publishing a new local revision', async () => {
    const encoded = await encodedDrawing()
    encoded.assets[0].sha256 = '0'.repeat(64)
    await expect(
      saveLocalCanvas(local(encoded.document), encoded.assets)
    ).rejects.toThrow(/checksum/i)
    expect(await listLocalCanvases(41)).toEqual([])
  })

  it('rejects conflicting descriptors for one original ID rather than losing one set of dimensions', async () => {
    const document = drawing()
    document.nodes[1].data.asset = { ...asset, width: 2 }
    await expect(
      encodeCanvas('drawing', document, {
        roles: { [originalId]: { role: 'generated', nodeId: 'source' } },
      })
    ).rejects.toThrow(/conflicting/i)
  })

  it('rejects a data source whose declared MIME differs from the original MIME', async () => {
    const document = drawing()
    for (const node of document.nodes) {
      node.data.asset = {
        ...asset,
        src: source.replace('image/png', 'image/jpeg'),
      }
    }
    await expect(
      encodeCanvas('drawing', document, {
        roles: { [originalId]: { role: 'generated', nodeId: 'source' } },
      })
    ).rejects.toThrow(/original bytes/i)
  })

  it('preserves generated originals above the reference-upload limit without recompression', async () => {
    const document = drawing()
    document.nodes = document.nodes.slice(0, 1)
    document.nodes[0].data.asset = {
      ...asset,
      src: 'https://example.test/large-original.png',
    }
    document.edges = []
    document.mask = null
    const largeOriginal = new Blob(
      [pngBytes, new Uint8Array(50 * 1024 * 1024)],
      { type: 'image/png' }
    )
    const encoded = await encodeCanvas('drawing', document, {
      roles: { [originalId]: { role: 'generated', nodeId: 'source' } },
      readOriginal: async () => largeOriginal,
    })
    expect(encoded.assets[0].blob.size).toBe(largeOriginal.size)
    expect(
      new Uint8Array(
        await encoded.assets[0].blob.slice(0, pngBytes.length).arrayBuffer()
      )
    ).toEqual(pngBytes)
  })

  it('applies canonical IDs to the latest document without overwriting edits made during upload', async () => {
    const encoded = await encodedDrawing()
    const sent = await saveLocalCanvas(local(encoded.document), encoded.assets)
    const edited = await saveLocalCanvas(
      {
        ...sent,
        name: '上传时的新名字',
        document: {
          ...sent.document,
          settings: { prompt: '上传时的新提示' },
          viewport: { x: 99, y: 22, zoom: 2 },
        },
      },
      []
    )
    const result = await acknowledgeCanvasSave(41, sent.id, {
      localRevision: sent.revision,
      cloudRevision: 1,
      expiresAt: 123,
      assetIdMap: { [originalId]: otherId },
      assets: [remoteAsset(otherId, encoded.assets[0].sha256)],
    })
    expect(result.name).toBe('上传时的新名字')
    expect(result.revision).toBe(edited.revision)
    expect(result.cloudSavedRevision).toBe(sent.revision)
    expect(result.cloudRevision).toBe(1)
    expect(result.status).toBe('pending')
    const restored = (await decodeCanvas(
      result,
      await readCanvasAssets(41, sent.id)
    )) as DrawingDocument
    expect(restored.settings.prompt).toBe('上传时的新提示')
    expect(restored.viewport).toEqual({ x: 99, y: 22, zoom: 2 })
    expect(restored.nodes.map((node) => node.data.asset?.id)).toEqual([
      otherId,
      otherId,
    ])
    expect(
      (await readCanvasAssets(41, sent.id)).map((item) => item.id).sort()
    ).toEqual([maskId, otherId])
    const synced = await acknowledgeCanvasSave(41, sent.id, {
      localRevision: edited.revision,
      cloudRevision: 2,
      expiresAt: 234,
      assetIdMap: {},
      assets: [],
    })
    expect(synced.status).toBe('synced')
    expect(synced.expiresAt).toBe(234)
  })

  it('refuses a late cloud remap after explicit asset or canvas deletion', async () => {
    const encoded = await encodedDrawing()
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    const ack = {
      localRevision: saved.revision,
      cloudRevision: 1,
      expiresAt: 123,
      assetIdMap: { [originalId]: otherId },
      assets: [remoteAsset(otherId, encoded.assets[0].sha256)],
    }
    await removeLocalCanvasAsset(41, saved.id, originalId)
    await expect(acknowledgeCanvasSave(41, saved.id, ack)).rejects.toThrow(
      /removed/i
    )
    await removeLocalCanvas(41, saved.id)
    await expect(acknowledgeCanvasSave(41, saved.id, ack)).rejects.toThrow(
      /deleted/i
    )
    expect(await readCanvasAssets(41, saved.id)).toEqual([])
  })

  it('rejects a remap with unverified bytes or an asset owned by another canvas', async () => {
    const encoded = await encodedDrawing()
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    const ack = {
      localRevision: saved.revision,
      cloudRevision: 1,
      expiresAt: 123,
      assetIdMap: { [originalId]: otherId },
      assets: [remoteAsset(otherId, '0'.repeat(64))],
    }
    await expect(acknowledgeCanvasSave(41, saved.id, ack)).rejects.toThrow(
      /checksum/i
    )
    await expect(acknowledgeCanvasSave(42, saved.id, ack)).rejects.toThrow(
      /unavailable/i
    )
    const another = drawing()
    another.nodes = [
      {
        ...another.nodes[0],
        data: { ...another.nodes[0].data, asset: { ...asset, id: otherId } },
      },
    ]
    another.edges = []
    another.mask = null
    const other = await encodeCanvas('drawing', another, {
      roles: { [otherId]: { role: 'generated', nodeId: 'source' } },
    })
    await saveLocalCanvas(
      local(other.document, '00000000-0000-4000-8000-000000000043'),
      other.assets
    )
    ack.assets[0].sha256 = encoded.assets[0].sha256
    await expect(acknowledgeCanvasSave(41, saved.id, ack)).rejects.toThrow(
      /owner|another canvas/i
    )
    expect((await loadLocalCanvas(41, saved.id))?.cloudRevision).toBe(0)
  })

  it('rejects snapshots captured before a canonical remap even when the content revision has not changed', async () => {
    const encoded = await encodedDrawing()
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    await acknowledgeCanvasSave(41, saved.id, {
      localRevision: saved.revision,
      cloudRevision: 1,
      expiresAt: 123,
      assetIdMap: { [originalId]: otherId },
      assets: [remoteAsset(otherId, encoded.assets[0].sha256)],
    })
    await expect(saveLocalCanvas(saved, encoded.assets)).rejects.toThrow(
      /canonical|stale/i
    )
    expect(
      (await readCanvasAssets(41, saved.id)).map((item) => item.id).sort()
    ).toEqual([maskId, otherId])
  })

  it('retains acknowledged cloud metadata when an edit without remapped assets finishes later', async () => {
    const encoded = await encodedDrawing()
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    await acknowledgeCanvasSave(41, saved.id, {
      localRevision: saved.revision,
      cloudRevision: 1,
      expiresAt: 123,
      assetIdMap: {},
      assets: [],
    })
    const edited = await saveLocalCanvas({ ...saved, name: '稍后的编辑' }, [])
    expect(edited.cloudRevision).toBe(1)
    expect(edited.cloudSavedRevision).toBe(1)
    expect(edited.expiresAt).toBe(123)
    expect(edited.status).toBe('pending')
  })

  it('adopts verified generated provenance from the authoritative manifest even when IDs are already canonical', async () => {
    const encoded = await encodeCanvas('drawing', drawing(), {
      roles: { [originalId]: { role: 'reference', nodeId: 'source' } },
    })
    const saved = await saveLocalCanvas(local(encoded.document), encoded.assets)
    await acknowledgeCanvasSave(41, saved.id, {
      localRevision: saved.revision,
      cloudRevision: 1,
      expiresAt: 123,
      assetIdMap: {},
      assets: [remoteAsset(originalId, encoded.assets[0].sha256)],
    })
    expect(
      (await readCanvasAssets(41, saved.id)).find(
        (item) => item.id === originalId
      )?.role
    ).toBe('generated')
  })
})

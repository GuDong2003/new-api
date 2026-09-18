import { describe, expect, it, vi } from 'vitest'

import { collectGalleryPages } from '../lib/gallery-collection'

describe('gallery page collection', () => {
  it('requests remaining pages in parallel after reading the first page', async () => {
    const pending = new Map<number, () => void>()
    const started: number[] = []
    const collected = collectGalleryPages(async (page) => {
      started.push(page)
      if (page === 1) {
        return { items: ['first'], total: 3, page_size: 1 }
      }
      await new Promise<void>((resolve) => pending.set(page, resolve))
      return { items: [`page-${page}`], total: 3, page_size: 1 }
    })

    await vi.waitFor(() => expect(started).toContain(2))
    const startedBeforeRelease = [...started]
    pending.get(2)?.()
    await vi.waitFor(() => expect(started).toContain(3))
    pending.get(3)?.()
    await expect(collected).resolves.toEqual(['first', 'page-2', 'page-3'])
    expect(startedBeforeRelease.sort()).toEqual([1, 2, 3])
  })
})

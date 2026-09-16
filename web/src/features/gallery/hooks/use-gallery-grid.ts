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
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** Narrowest a card may become before the grid drops to fewer columns. */
export const GALLERY_MIN_COLUMN_WIDTH = 224
export const GALLERY_GRID_GAP = 16
/**
 * Below this width a card sized for the desktop track would fill the screen, so
 * phones get their own column count: two keeps captions readable at the cost of
 * fitting fewer rows.
 */
export const GALLERY_NARROW_WIDTH = 640
export const GALLERY_NARROW_COLUMNS = 2
/**
 * Thumbnail height as a share of the card width. A phone spends a row on the
 * quota meters and still has to fit two rows of cards, so its thumbnails are
 * 4:3 rather than square. Images are contained, not cropped, so nothing is lost.
 */
export const GALLERY_NARROW_THUMBNAIL_RATIO = 0.75
export const GALLERY_THUMBNAIL_RATIO = 1
export const GALLERY_MIN_COLUMNS = 2
/** Cards never shrink past this, even if that means fewer rows than the target. */
export const GALLERY_MIN_CARD_WIDTH = 120
/** Rows the grid tries to fill before it starts shrinking cards. */
export const GALLERY_TARGET_ROWS = 2
/**
 * Room reserved under every square thumbnail for the caption and the card
 * actions. Both card types show at most three short lines plus padding, and
 * images and canvases reserve the same amount so switching tabs does not
 * reflow the grid.
 */
export const GALLERY_CARD_FOOTER_HEIGHT = 84

/** Page size used until the grid can be measured, e.g. before first layout. */
export const GALLERY_FALLBACK_PAGE_SIZE = 24

export type GalleryGridMetrics = {
  /** False while the container has no layout; callers fall back to CSS auto-fill. */
  measured: boolean
  columns: number
  rows: number
  pageSize: number
  rowHeight: number
}

/**
 * Fits whole cards into the space the grid actually has. Rows are not capped:
 * a desktop window lands on two, a tall phone screen fills three or four, and
 * nothing ever overflows into a scrollbar.
 */
export function calculateGalleryGrid(
  width: number,
  height: number
): GalleryGridMetrics {
  if (!(width > 0) || !(height > 0)) {
    return {
      measured: false,
      columns: 0,
      rows: 0,
      pageSize: GALLERY_FALLBACK_PAGE_SIZE,
      rowHeight: 0,
    }
  }

  const thumbnailRatio =
    width < GALLERY_NARROW_WIDTH
      ? GALLERY_NARROW_THUMBNAIL_RATIO
      : GALLERY_THUMBNAIL_RATIO
  const layoutFor = (columns: number) => {
    const columnWidth = (width - GALLERY_GRID_GAP * (columns - 1)) / columns
    const rowHeight = Math.max(
      1,
      Math.round(
        Math.max(columnWidth, 0) * thumbnailRatio + GALLERY_CARD_FOOTER_HEIGHT
      )
    )
    const rows = Math.max(
      1,
      Math.floor((height + GALLERY_GRID_GAP) / (rowHeight + GALLERY_GRID_GAP))
    )
    // Stretch the rows over the leftover height so the last row reaches the
    // pager instead of leaving a gap. Thumbnails stay square; the extra height
    // goes to the caption.
    const filledRowHeight = Math.max(
      rowHeight,
      Math.floor((height - GALLERY_GRID_GAP * (rows - 1)) / rows)
    )
    return {
      measured: true as const,
      columns,
      rows,
      pageSize: columns * rows,
      rowHeight: filledRowHeight,
    }
  }

  const widestColumns =
    width < GALLERY_NARROW_WIDTH
      ? GALLERY_NARROW_COLUMNS
      : Math.max(
          GALLERY_MIN_COLUMNS,
          Math.floor(
            (width + GALLERY_GRID_GAP) /
              (GALLERY_MIN_COLUMN_WIDTH + GALLERY_GRID_GAP)
          )
        )
  const densestColumns = Math.max(
    widestColumns,
    Math.floor(
      (width + GALLERY_GRID_GAP) / (GALLERY_MIN_CARD_WIDTH + GALLERY_GRID_GAP)
    )
  )

  // Prefer the largest cards, but a short window would only fit a single row of
  // them. Adding columns shrinks the cards until the target rows fit, which is
  // what keeps the page filled instead of half empty.
  let layout = layoutFor(widestColumns)
  for (
    let columns = widestColumns + 1;
    layout.rows < GALLERY_TARGET_ROWS && columns <= densestColumns;
    columns++
  ) {
    layout = layoutFor(columns)
  }
  return layout
}

/**
 * Measures the grid container and reports how many whole cards fit. The first
 * measurement happens before paint, so the grid never renders a wrong page size
 * and then reflows.
 */
export function useGalleryGrid() {
  const [metrics, setMetrics] = useState<GalleryGridMetrics>(() =>
    calculateGalleryGrid(0, 0)
  )
  const node = useRef<HTMLElement | null>(null)
  const gridRef = useCallback((element: HTMLElement | null) => {
    node.current = element
  }, [])

  useLayoutEffect(() => {
    const element = node.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setMetrics((current) => {
        const next = calculateGalleryGrid(rect.width, rect.height)
        return current.measured === next.measured &&
          current.columns === next.columns &&
          current.rows === next.rows &&
          current.rowHeight === next.rowHeight
          ? current
          : next
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  })

  return { gridRef, metrics }
}

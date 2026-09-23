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
import { useCallback, useEffect, useRef, useState } from 'react'

/** How far ahead of the viewport work starts, so it lands before it is seen. */
const IN_VIEW_MARGIN = '400px'

/**
 * Whether an element has come near the viewport, for work worth doing only for
 * what is being looked at.
 *
 * The answer only ever goes from false to true: scrolling a card away and back
 * would otherwise repeat whatever its arrival started. A browser with no
 * observer to ask is told everything is in view, so it does that work eagerly
 * rather than never.
 */
export function useInView<T extends Element>(rootMargin = IN_VIEW_MARGIN) {
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )
  const observer = useRef<IntersectionObserver | null>(null)
  const ref = useCallback(
    (node: T | null) => {
      observer.current?.disconnect()
      observer.current = null
      if (!node || typeof IntersectionObserver === 'undefined') return
      observer.current = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          setInView(true)
          observer.current?.disconnect()
          observer.current = null
        },
        { rootMargin }
      )
      observer.current.observe(node)
    },
    [rootMargin]
  )
  useEffect(
    () => () => {
      observer.current?.disconnect()
      observer.current = null
    },
    []
  )
  return { ref, inView }
}

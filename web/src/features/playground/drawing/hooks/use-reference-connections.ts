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
import { useStoreApi, type Connection } from '@xyflow/react'
import { useCallback, useEffect, useRef } from 'react'

import { useDrawingStore } from '@/stores/drawing-store'

import type { DrawingNode } from '../types'

export function useReferenceConnections() {
  const flowStore = useStoreApi<DrawingNode>()
  const dragged = useRef(false)

  const cancel = useCallback(() => {
    const state = flowStore.getState()
    if (!state.connection.inProgress && !state.connectionClickStartHandle) {
      return false
    }
    // XYFlow keeps click-to-connect and pointer dragging in separate states.
    state.cancelConnection()
    flowStore.setState({ connectionClickStartHandle: null })
    return true
  }, [flowStore])

  const onConnectStart = useCallback(() => {
    dragged.current = true
    flowStore.setState({ connectionClickStartHandle: null })
  }, [flowStore])

  const onConnect = useCallback(
    (connection: Connection) => {
      const state = flowStore.getState()
      // A cancelled drag can still deliver its previously hovered target on mouseup.
      if (
        !state.nodesConnectable ||
        (!state.connection.inProgress && !state.connectionClickStartHandle)
      ) {
        return
      }
      useDrawingStore.getState().connectReference(connection)
    },
    [flowStore]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && cancel()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      dragged.current = false
      const handle =
        event.target instanceof Element
          ? event.target.closest('.react-flow__handle')
          : null
      if (
        event.button !== 0 ||
        !handle ||
        !flowStore.getState().domNode?.contains(handle)
      ) {
        cancel()
      }
    }
    const onClick = (event: MouseEvent) => {
      if (!dragged.current) return
      dragged.current = false
      // Returning a drag to its starting port must not arm click-to-connect.
      // Keyboard activation has detail 0 and starts an intentional new connection.
      if (
        event.detail > 0 &&
        event.target instanceof Node &&
        flowStore.getState().domNode?.contains(event.target)
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointercancel', cancel, true)
    document.addEventListener('click', onClick, true)
    window.addEventListener('blur', cancel)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointercancel', cancel, true)
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [cancel, flowStore])

  return { cancel, onConnect, onConnectStart }
}

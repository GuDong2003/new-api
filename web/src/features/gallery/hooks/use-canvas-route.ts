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
import { useReactFlow } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'

import { useAuthStore } from '@/stores/auth-store'

import { storeFor } from '../lib/canvas-editor'
import { openCanvasProject, startCanvasEditor } from '../lib/canvas-projects'
import type { CanvasKind } from '../types'

export type CanvasRouteState = {
  loading: boolean
  error: string | null
}

export function useCanvasRoute(
  kind: CanvasKind,
  canvasId?: string,
  focusAssetId?: string
) {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? null)
  const flow = useReactFlow()
  const flowRef = useRef(flow)
  flowRef.current = flow
  const [attempt, setAttempt] = useState(0)
  const [route, setRoute] = useState<CanvasRouteState>(() => ({
    loading: Boolean(canvasId),
    error: null,
  }))
  useEffect(() => {
    if (!canvasId || userId === null || sessionId === null) {
      setRoute({ loading: false, error: null })
      return
    }
    let active = true
    setRoute({ loading: true, error: null })
    void (async () => {
      try {
        const identity = { userId, sessionId }
        await startCanvasEditor(identity, kind)
        if (!active) return
        await openCanvasProject(identity, canvasId, focusAssetId, kind)
        if (!active) return
        const node = storeFor(kind)
          .getState()
          .nodes.find((node) => node.data.asset?.id === focusAssetId)
        if (node) {
          await new Promise<void>((resolve, reject) => {
            requestAnimationFrame(() => {
              if (!active) {
                resolve()
                return
              }
              void Promise.resolve(
                flowRef.current.fitView({
                  nodes: [{ id: node.id }],
                  padding: 0.3,
                  maxZoom: 1,
                })
              )
                .then(() => resolve())
                .catch(reject)
            })
          })
        } else {
          await flowRef.current.setViewport(storeFor(kind).getState().viewport)
        }
      } catch (error: unknown) {
        if (active) {
          setRoute({
            loading: false,
            error: error instanceof Error ? error.message : 'Request failed',
          })
        }
        return
      }
      if (active) setRoute({ loading: false, error: null })
    })()
    return () => {
      active = false
    }
  }, [attempt, canvasId, focusAssetId, kind, userId, sessionId])
  return {
    ...route,
    retry: () => {
      setRoute({ loading: true, error: null })
      setAttempt((value) => value + 1)
    },
  }
}

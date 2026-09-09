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
import { useCallback, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useAuthStore } from '@/stores/auth-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { generateNaiImages, getNaiGenerationError } from '../api'
import { validateNaiSettings } from '../lib/nai-settings'
import type { NaiCanvasNode, NaiSettings } from '../types'

type NaiImageJob = {
  id: string
  controller: AbortController
  nodeIds: string[]
}

type NaiGenerationInput = {
  job: NaiImageJob
  settings: NaiSettings
  userId: number | null
  sessionId: string | null
}

const activeJobs = new Map<string, NaiGenerationInput>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify() {
  listeners.forEach((listener) => listener())
}

function getPendingCount(userId: number | null, sessionId: string | null) {
  return [...activeJobs.values()].filter(
    (input) => input.userId === userId && input.sessionId === sessionId
  ).length
}

function isCurrentJob(input: NaiGenerationInput) {
  return (
    useNaiDrawingStore.getState().userId === input.userId &&
    useAuthStore.getState().auth.session?.sid === input.sessionId
  )
}

async function executeJob(
  input: NaiGenerationInput,
  translate: (key: string) => string
) {
  try {
    const result = await generateNaiImages({
      settings: input.settings,
      signal: input.job.controller.signal,
    })
    if (!isCurrentJob(input)) return
    input.job.controller.signal.throwIfAborted()
    const state = useNaiDrawingStore.getState()
    input.job.nodeIds.forEach((id, index) => {
      const asset = result.images[index]
      if (!asset) {
        state.updateNodeData(
          id,
          {
            status: 'error',
            error: 'NovelAI returned fewer images than requested.',
          },
          input.job.id
        )
        return
      }
      state.updateNodeData(
        id,
        { asset, status: 'complete', usage: result.usage },
        input.job.id
      )
    })
  } catch (error) {
    if (!isCurrentJob(input)) return
    const cancelled = input.job.controller.signal.aborted
    const message = cancelled
      ? undefined
      : getNaiGenerationError(error).slice(0, 10000)
    input.job.nodeIds.forEach((id) => {
      useNaiDrawingStore.getState().updateNodeData(
        id,
        {
          status: cancelled ? 'cancelled' : 'error',
          error: message,
        },
        input.job.id
      )
    })
    if (message) toast.error(translate(message))
  } finally {
    activeJobs.delete(input.job.id)
    notify()
  }
}

function startJob(
  input: NaiGenerationInput,
  translate: (key: string) => string
) {
  activeJobs.set(input.job.id, input)
  notify()
  void executeJob(input, translate)
}

function createNodes(
  settings: NaiSettings,
  jobId: string,
  startIndex: number
): NaiCanvasNode[] {
  return Array.from({ length: settings.n }, (_, index) => ({
    id: crypto.randomUUID(),
    type: 'nai-image',
    dragHandle: '.nai-drawing-node-handle',
    position: {
      x: ((startIndex + index) % 3) * 320,
      y: Math.floor((startIndex + index) / 3) * 370,
    },
    width: 280,
    height: 330,
    data: {
      prompt: settings.prompt,
      settings: { ...settings },
      status: 'pending',
      jobId,
      createdAt: Date.now(),
    },
  }))
}

export function useNaiImageGeneration() {
  const { t } = useTranslation()
  const userId = useNaiDrawingStore((state) => state.userId)
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? null)
  const pendingCount = useSyncExternalStore(
    subscribe,
    () => getPendingCount(userId, sessionId),
    () => getPendingCount(userId, sessionId)
  )

  const generate = useCallback(
    (settings: NaiSettings): boolean => {
      const validation = validateNaiSettings(settings)
      if (validation) {
        toast.error(t(validation))
        return false
      }
      const state = useNaiDrawingStore.getState()
      if (state.nodes.length + settings.n > 500) {
        toast.error(
          t(
            'This canvas can hold up to 500 images. Export it before starting a new one.'
          )
        )
        return false
      }
      const job: NaiImageJob = {
        id: crypto.randomUUID(),
        controller: new AbortController(),
        nodeIds: [],
      }
      const nodes = createNodes(settings, job.id, state.nodes.length)
      job.nodeIds = nodes.map((node) => node.id)
      state.addNodes(nodes)
      startJob({ job, settings, userId: state.userId, sessionId }, t)
      return true
    },
    [sessionId, t]
  )

  const retry = useCallback(
    (nodeId: string): boolean => {
      const state = useNaiDrawingStore.getState()
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!node || node.data.status !== 'error') return false
      const settings = { ...node.data.settings, prompt: node.data.prompt, n: 1 }
      const validation = validateNaiSettings(settings)
      if (validation) {
        toast.error(t(validation))
        return false
      }
      const job: NaiImageJob = {
        id: crypto.randomUUID(),
        controller: new AbortController(),
        nodeIds: [nodeId],
      }
      state.updateNodeData(nodeId, {
        status: 'pending',
        jobId: job.id,
        asset: undefined,
        error: undefined,
      })
      startJob({ job, settings, userId: state.userId, sessionId }, t)
      return true
    },
    [sessionId, t]
  )

  const cancel = useCallback(() => {
    activeJobs.forEach((input) => {
      if (input.userId === userId && input.sessionId === sessionId) {
        input.job.controller.abort()
      }
    })
  }, [sessionId, userId])

  return { generate, retry, cancel, pendingCount }
}

export function cancelNaiGenerationJobs(
  userId: number | null,
  sessionId: string | null
) {
  activeJobs.forEach((input) => {
    if (input.userId === userId && input.sessionId === sessionId) {
      input.job.controller.abort()
    }
  })
}

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
import { useCallback, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { safeGalleryParameters } from '@/features/gallery/lib/metadata'
import { queueGallerySave } from '@/features/gallery/lib/save-queue'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'

import { generateImages } from '../api'
import { positionGeneratedImageNodes } from '../lib/canvas-document'
import { imageSourceToAsset } from '../lib/image-assets'
import { buildImagePayload, validateImageSettings } from '../lib/image-settings'
import type { DrawingNode, ImageAsset, ImageSettings } from '../types'

type ImageJob = { id: string; controller: AbortController; nodeIds: string[] }
type GenerationInput = {
  job: ImageJob
  settings: ImageSettings
  references: ImageAsset[]
  mask?: ImageAsset
  userId: number | null
  sessionId: string | null
}
type Translate = (key: string) => string

// Keep network jobs alive while authenticated routes are changing. The drawing
// store owns the visible nodes; this module owns only the request lifecycle.
const activeJobs = new Map<string, GenerationInput>()
const jobListeners = new Set<() => void>()

function subscribeToJobs(listener: () => void) {
  jobListeners.add(listener)
  return () => jobListeners.delete(listener)
}

function getPendingJobCount(userId: number | null, sessionId: string | null) {
  let count = 0
  for (const input of activeJobs.values()) {
    if (input.userId === userId && input.sessionId === sessionId) count++
  }
  return count
}

function isCurrentJob(input: GenerationInput): boolean {
  const currentUserId = useDrawingStore.getState().userId
  const currentSessionId = useAuthStore.getState().auth.session?.sid ?? null
  return currentUserId === input.userId && currentSessionId === input.sessionId
}

function notifyJobListeners() {
  for (const listener of jobListeners) listener()
}

async function executeImageJob(
  input: GenerationInput,
  translate: Translate
): Promise<void> {
  try {
    const result = await generateImages({
      settings: input.settings,
      references: input.references,
      mask: input.mask,
      signal: input.job.controller.signal,
      onPartial: (image, index) => {
        const state = useDrawingStore.getState()
        const id = input.job.nodeIds[index]
        if (
          !isCurrentJob(input) ||
          input.job.controller.signal.aborted ||
          !id
        ) {
          return
        }
        const progress = state.nodes.find((node) => node.id === id)?.data
          .progress
        state.updateNodeData(
          id,
          {
            progress: {
              startedAt: progress?.startedAt ?? Date.now(),
              phase: 'generating',
              previewCount: (progress?.previewCount ?? 0) + 1,
            },
            asset: {
              id,
              src: image.src,
              mimeType: image.mimeType,
              name: input.settings.prompt.slice(0, 512),
              width: 1024,
              height: 1024,
            },
          },
          input.job.id
        )
      },
    })
    const state = useDrawingStore.getState()
    if (!isCurrentJob(input)) return
    input.job.controller.signal.throwIfAborted()
    // Save final provider results before browser decoding; gallery failures must
    // never turn a successful generation into an error or delay the canvas.
    for (const [index, image] of result.images.entries()) {
      void queueGallerySave({
        userId: input.userId,
        sessionId: input.sessionId,
        src: image.src,
        metadata: {
          source_id: `${input.job.id}:${index}`,
          source: 'drawing',
          model: input.settings.model,
          prompt: input.settings.prompt,
          negative_prompt: '',
          parameters: safeGalleryParameters(buildImagePayload(input.settings)),
        },
      })
    }
    for (const id of input.job.nodeIds) {
      const progress = state.nodes.find((node) => node.id === id)?.data.progress
      if (progress) {
        state.updateNodeData(
          id,
          { progress: { ...progress, phase: 'decoding' } },
          input.job.id
        )
      }
    }
    const assets = await Promise.allSettled(
      result.images.map((image, index) =>
        imageSourceToAsset(
          image.src,
          `${input.settings.model}-${index + 1}`,
          image.mimeType,
          input.job.controller.signal
        )
      )
    )
    if (!isCurrentJob(input)) return
    input.job.controller.signal.throwIfAborted()
    for (const [index, id] of input.job.nodeIds.entries()) {
      const asset = assets[index]
      if (!asset) {
        useDrawingStore.getState().updateNodeData(
          id,
          {
            status: 'error',
            progress: undefined,
            error: 'The server returned fewer images than requested.',
          },
          input.job.id
        )
        continue
      }
      if (asset.status === 'rejected') {
        const error =
          asset.reason instanceof Error
            ? asset.reason.message.slice(0, 10000)
            : 'The image could not be loaded.'
        useDrawingStore
          .getState()
          .updateNodeData(
            id,
            { status: 'error', error, progress: undefined },
            input.job.id
          )
        continue
      }
      useDrawingStore.getState().updateNodeData(
        id,
        {
          asset: asset.value,
          status: 'complete',
          progress: undefined,
          revisedPrompt: result.images[index].revisedPrompt?.slice(0, 64000),
          usage: result.usage,
        },
        input.job.id
      )
    }
  } catch (error) {
    if (!isCurrentJob(input)) return
    const cancelled = input.job.controller.signal.aborted
    const message =
      error instanceof Error
        ? error.message.slice(0, 10000)
        : 'Image generation failed.'
    for (const id of input.job.nodeIds) {
      useDrawingStore.getState().updateNodeData(
        id,
        {
          status: cancelled ? 'cancelled' : 'error',
          progress: undefined,
          error: cancelled ? undefined : message,
        },
        input.job.id
      )
    }
    if (!cancelled) toast.error(translate(message))
  } finally {
    activeJobs.delete(input.job.id)
    notifyJobListeners()
  }
}

function startImageJob(input: GenerationInput, translate: Translate) {
  activeJobs.set(input.job.id, input)
  notifyJobListeners()
  void executeImageJob(input, translate)
}

export function useImageGeneration() {
  const { t } = useTranslation()
  const currentUserId = useDrawingStore((state) => state.userId)
  const currentSessionId = useAuthStore(
    (state) => state.auth.session?.sid ?? null
  )
  const pendingCount = useSyncExternalStore(
    subscribeToJobs,
    () => getPendingJobCount(currentUserId, currentSessionId),
    () => getPendingJobCount(currentUserId, currentSessionId)
  )

  const generate = (
    settings: ImageSettings,
    position: { x: number; y: number },
    mask?: ImageAsset
  ) => {
    const state = useDrawingStore.getState()
    const referenceNodes = state.referenceIds.flatMap((id) => {
      const node = state.nodes.find(
        (item) => item.id === id && item.data.status === 'complete'
      )
      return node?.data.asset ? [node] : []
    })
    const references = referenceNodes.flatMap((node) =>
      node.data.asset ? [node.data.asset] : []
    )
    const error = validateImageSettings(settings, references.length)
    if (error) {
      toast.error(t(error))
      return false
    }
    if (state.nodes.length + settings.n > 500) {
      toast.error(
        t(
          'This canvas can hold up to 500 images. Export it before starting a new one.'
        )
      )
      return false
    }
    const job: ImageJob = {
      id: crypto.randomUUID(),
      controller: new AbortController(),
      nodeIds: [],
    }
    const nodes: DrawingNode[] = Array.from({ length: settings.n }, () => ({
      id: crypto.randomUUID(),
      type: 'image',
      dragHandle: '.drawing-node-handle',
      position,
      width: 280,
      height: 330,
      data: {
        prompt: settings.prompt,
        settings: { ...settings },
        status: 'pending',
        jobId: job.id,
        createdAt: Date.now(),
        progress: {
          startedAt: Date.now(),
          phase: 'generating',
          previewCount: 0,
        },
        referenceIds:
          settings.mode === 'edit' ? referenceNodes.map((node) => node.id) : [],
        mask: settings.mode === 'edit' ? mask : undefined,
      },
    }))
    const positionedNodes = positionGeneratedImageNodes(
      state.nodes,
      nodes,
      settings.mode === 'edit' ? referenceNodes : [],
      position
    )
    job.nodeIds = nodes.map((node) => node.id)
    const edges =
      settings.mode === 'edit'
        ? referenceNodes.flatMap((source) =>
            nodes.map((target) => ({
              id: `${source.id}-${target.id}`,
              source: source.id,
              target: target.id,
            }))
          )
        : []
    state.addNodes(positionedNodes, edges)
    startImageJob(
      {
        job,
        settings,
        references,
        mask,
        userId: state.userId,
        sessionId: useAuthStore.getState().auth.session?.sid ?? null,
      },
      t
    )
    return true
  }

  const retry = useCallback(
    (nodeId: string): boolean => {
      const state = useDrawingStore.getState()
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!node || node.data.status !== 'error') return false

      const settings = {
        ...node.data.settings,
        prompt: node.data.prompt,
        n: 1,
      }
      const referenceIds =
        settings.mode === 'edit' ? node.data.referenceIds || [] : []
      const references = referenceIds.flatMap((id) => {
        const reference = state.nodes.find((item) => item.id === id)
        return reference?.data.status === 'complete' && reference.data.asset
          ? [reference.data.asset]
          : []
      })
      if (references.length !== referenceIds.length) {
        toast.error(
          t(
            'The original reference images are no longer available. Restore them before retrying.'
          )
        )
        return false
      }
      const error = validateImageSettings(settings, references.length)
      if (error) {
        toast.error(t(error))
        return false
      }

      const job: ImageJob = {
        id: crypto.randomUUID(),
        controller: new AbortController(),
        nodeIds: [nodeId],
      }
      state.updateNodeData(nodeId, {
        status: 'pending',
        progress: {
          startedAt: Date.now(),
          phase: 'generating',
          previewCount: 0,
        },
        jobId: job.id,
        settings,
        asset: undefined,
        error: undefined,
        revisedPrompt: undefined,
        usage: undefined,
      })
      startImageJob(
        {
          job,
          settings,
          references,
          mask: settings.mode === 'edit' ? node.data.mask : undefined,
          userId: state.userId,
          sessionId: useAuthStore.getState().auth.session?.sid ?? null,
        },
        t
      )
      return true
    },
    [t]
  )

  const cancel = (jobId?: string) => {
    for (const input of activeJobs.values()) {
      if (
        input.userId === currentUserId &&
        input.sessionId === currentSessionId &&
        (!jobId || input.job.id === jobId)
      ) {
        input.job.controller.abort()
      }
    }
  }

  return { generate, retry, cancel, pendingCount }
}

export function cancelImageGenerationJobs(
  userId: number | null,
  sessionId: string | null
) {
  for (const input of activeJobs.values()) {
    if (input.userId === userId && input.sessionId === sessionId) {
      input.job.controller.abort()
    }
  }
}

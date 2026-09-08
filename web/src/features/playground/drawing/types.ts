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
import type { Node, Edge, Viewport } from '@xyflow/react'
import type { z } from 'zod'

import type { imageSettingsSchema } from './lib/image-settings'

export type ImageSettings = z.infer<typeof imageSettingsSchema>
export type ImageAsset = {
  id: string
  name: string
  src: string
  width: number
  height: number
  mimeType: string
}
export type ImageNodeData = {
  asset?: ImageAsset
  prompt: string
  settings: ImageSettings
  status: 'pending' | 'complete' | 'error' | 'cancelled'
  error?: string
  revisedPrompt?: string
  jobId?: string
  createdAt: number
  progress?: ImageGenerationProgress
  referenceIds?: string[]
  mask?: ImageAsset
  usage?: Record<string, unknown>
}
export type ImageGenerationProgress = {
  startedAt: number
  phase: 'generating' | 'decoding'
  previewCount: number
}
export type DrawingNode = Node<ImageNodeData, 'image'>
export type DrawingMask = { referenceId: string; asset: ImageAsset }
export type DrawingDocument = {
  version: 1
  nodes: DrawingNode[]
  edges: Edge[]
  viewport: Viewport
  settings: ImageSettings
  referenceIds: string[]
  mask: DrawingMask | null
}
export type ImageResult = {
  src: string
  mimeType: string
  revisedPrompt?: string
}
export type ImageResponse = {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[]
  output_format?: string
  usage?: Record<string, unknown>
  error?: { message?: string }
}

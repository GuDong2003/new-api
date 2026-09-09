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
import type { Node, Viewport } from '@xyflow/react'
import type { z } from 'zod'

import type { naiSettingsSchema } from './lib/nai-settings'

export type NaiSettings = z.infer<typeof naiSettingsSchema>

export type NaiImageAsset = {
  id: string
  name: string
  src: string
  width: number
  height: number
  mimeType: string
}

export type NaiImageNodeData = {
  asset?: NaiImageAsset
  prompt: string
  settings: NaiSettings
  status: 'pending' | 'complete' | 'error' | 'cancelled'
  error?: string
  jobId?: string
  createdAt: number
  usage?: Record<string, unknown>
}

export type NaiCanvasNode = Node<NaiImageNodeData, 'nai-image'>

export type NaiCanvasDocument = {
  version: 1
  nodes: NaiCanvasNode[]
  viewport: Viewport
  settings: NaiSettings
}

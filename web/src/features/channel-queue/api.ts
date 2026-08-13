/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import { api } from '@/lib/api'

import type {
  ChannelQueueConfig,
  ChannelQueueSettings,
  QueueConfigItemResponse,
  QueueConfigResponse,
  QueueLogsResponse,
  QueueRunResponse,
  QueueStatusResponse,
} from './types'

export async function getChannelQueueConfig(): Promise<ChannelQueueConfig[]> {
  const res = await api.get<QueueConfigResponse>('/api/channel/queue/config')
  if (!res.data.success) {
    throw new Error(res.data.message || 'Unable to load queue settings')
  }
  return res.data.data ?? []
}

export async function getChannelQueueStatus() {
  const res = await api.get<QueueStatusResponse>('/api/channel/queue/status')
  if (!res.data.success) {
    throw new Error(res.data.message || 'Unable to load queue status')
  }
  return res.data.data ?? []
}

export async function updateChannelQueueConfig(
  channelId: number,
  queue: ChannelQueueSettings
) {
  const res = await api.put<QueueConfigItemResponse>(
    `/api/channel/queue/${channelId}`,
    queue
  )
  if (!res.data.success) {
    throw new Error(res.data.message || 'Unable to save queue settings')
  }
  return res.data.data ?? null
}

export async function runChannelQueueWarmup() {
  const res = await api.post<QueueRunResponse>('/api/channel/queue/run')
  if (!res.data.success) {
    throw new Error(res.data.message || 'Unable to start queue warm-up')
  }
  return res.data.data
}

export async function listChannelQueueWarmupLogs(limit = 20) {
  const res = await api.get<QueueLogsResponse>('/api/channel/queue/logs', {
    params: { limit },
  })
  if (!res.data.success) {
    throw new Error(res.data.message || 'Unable to load queue logs')
  }
  return res.data.data ?? []
}

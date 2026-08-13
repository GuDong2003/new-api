/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import type { SystemTask } from '@/features/system-settings/types'

export type ChannelQueueSettings = {
  enabled: boolean
  model: string
  interval: number
  endpoint_type: string
  warmup_message: string
  max_tokens?: number
  timeout: number
  circuit_breaker_enabled: boolean
  max_consecutive_failures: number
  cooldown_seconds: number
  max_queue_attempts: number
  backoff_seconds: number
  queue_busy_status_codes?: number[]
}

export type ChannelQueueStatus = {
  channel_id: number
  channel_name: string
  channel_enabled: boolean
  enabled: boolean
  model: string
  warming: boolean
  breaker_active: boolean
  breaker_until?: number
  consecutive_failures: number
  last_warm_at?: number
  last_status_code?: number
  last_result?: string
}

export type ChannelQueueConfig = {
  channel_id: number
  channel_name: string
  channel_status: number
  channel_enabled: boolean
  models: string[]
  queue?: ChannelQueueSettings | null
  status: ChannelQueueStatus
}

export type QueueConfigResponse = {
  success: boolean
  message?: string
  data?: ChannelQueueConfig[]
}

export type QueueConfigItemResponse = {
  success: boolean
  message?: string
  data?: ChannelQueueConfig
}

export type QueueStatusResponse = {
  success: boolean
  message?: string
  data?: ChannelQueueStatus[]
}

export type QueueRunResponse = {
  success: boolean
  message?: string
  data?: {
    task_id: string
    status: string
    created: boolean
  } | null
}

export type QueueWarmupResult = {
  scanned_channels?: number
  attempted_channels?: number
  succeeded?: number
  queue_busy?: number
  timeout?: number
  failed?: number
  skipped?: number
  status_codes?: Record<string, number>
  failure_samples?: string[]
}

export type QueueWarmupTask = SystemTask<
  Record<string, unknown>,
  Record<string, unknown>,
  QueueWarmupResult
>

export type QueueLogsResponse = {
  success: boolean
  message?: string
  data?: QueueWarmupTask[]
}

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
import { ERROR_MESSAGES } from '../../constants'
import type { ChatCompletionChunk } from '../../types'
import {
  parseAPIErrorDetails,
  type RequestErrorDetails,
} from './request-error-utils'

const STREAM_DONE_MESSAGE = '[DONE]'
const STREAM_CLOSED_READY_STATE = 2

export type StreamUpdateType = 'reasoning' | 'content'

export type StreamMessageUpdate = {
  type: StreamUpdateType
  chunk: string
}

export type StreamErrorDetails = RequestErrorDetails

/**
 * Raised when a stream frame carries an upstream error instead of a delta, so
 * the caller can surface the real message rather than a parse failure.
 */
export class StreamResponseError extends Error {
  readonly errorCode?: string

  constructor(details: StreamErrorDetails) {
    super(details.errorMessage)
    this.name = 'StreamResponseError'
    this.errorCode = details.errorCode
  }
}

export function parseStreamErrorDetails(
  data?: string,
  status?: number
): StreamErrorDetails {
  return parseAPIErrorDetails(data, status)
}

export function parseStreamMessageUpdates(data: string): StreamMessageUpdate[] {
  const chunk = JSON.parse(data) as ChatCompletionChunk & { error?: unknown }

  if (chunk.error) {
    throw new StreamResponseError(parseAPIErrorDetails(chunk))
  }

  const delta = chunk.choices?.[0]?.delta

  if (!delta) {
    return []
  }

  const updates: StreamMessageUpdate[] = []

  if (delta.reasoning_content) {
    updates.push({ type: 'reasoning', chunk: delta.reasoning_content })
  }

  if (delta.content) {
    updates.push({ type: 'content', chunk: delta.content })
  }

  return updates
}

export function isStreamDoneMessage(data: string): boolean {
  return data === STREAM_DONE_MESSAGE
}

export function isStreamClosedReadyState(readyState?: number): boolean {
  return readyState === STREAM_CLOSED_READY_STATE
}

/**
 * Describe a closed stream. Reaching the closed state before `[DONE]` means the
 * response was cut short, so a 2xx close is still reported as an interruption;
 * callers ignore this once the stream has completed normally.
 */
export function getStreamReadyStateError(
  eventReadyState: number | undefined,
  responseCode?: number
): string | null {
  if (!isStreamClosedReadyState(eventReadyState)) {
    return null
  }

  if (
    responseCode !== undefined &&
    (responseCode < 200 || responseCode >= 300)
  ) {
    const { errorMessage } = parseAPIErrorDetails(undefined, responseCode)
    // Statuses without a dedicated message keep the code visible, since the
    // response body is gone by the time the stream closes.
    if (errorMessage === ERROR_MESSAGES.API_REQUEST_ERROR) {
      return `HTTP ${responseCode}: ${ERROR_MESSAGES.CONNECTION_CLOSED}`
    }
    return errorMessage
  }

  return ERROR_MESSAGES.INTERRUPTED
}

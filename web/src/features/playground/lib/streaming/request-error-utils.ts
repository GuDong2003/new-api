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

type RequestErrorLike = {
  message?: string
  response?: {
    status?: number
    data?: unknown
  }
}

export type RequestErrorDetails = {
  errorCode?: string
  errorMessage: string
}

const HTML_DOCUMENT_PATTERN = /(?:<|&lt;)(?:!doctype\s+html|html|head|body)\b/i
const HTML_TITLE_STATUS_PATTERN = /<title>[^<]*\b(502|503|504)\b[^<]*<\/title>/i

const GATEWAY_MESSAGES: Record<number, string> = {
  502: ERROR_MESSAGES.BAD_GATEWAY,
  503: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
  504: ERROR_MESSAGES.GATEWAY_TIMEOUT,
}

type ErrorPayloadFields = {
  message?: string
  errorCode?: string
  /** True when the message came from a recognized API error shape. */
  structured: boolean
}

/** Read the message and code out of the API's `{error: {...}}` or flat shape. */
function readErrorPayloadFields(payload: unknown): ErrorPayloadFields {
  if (typeof payload === 'string') {
    return { message: payload, structured: false }
  }
  if (!payload || typeof payload !== 'object') {
    return { structured: false }
  }

  const record = payload as {
    error?: unknown
    message?: unknown
    code?: unknown
  }
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as { message?: unknown; code?: unknown })
      : record

  const fields: ErrorPayloadFields = { structured: false }
  if (typeof nested.code === 'string') {
    fields.errorCode = nested.code
  }
  if (typeof nested.message === 'string') {
    fields.message = nested.message
  } else if (typeof record.error === 'string') {
    fields.message = record.error
  }
  fields.structured = Boolean(fields.message)
  return fields
}

/**
 * Turn any error body into a message worth showing. A reverse proxy in front of
 * the gateway answers 502/503/504 with an HTML page rather than the API's JSON
 * envelope, so the raw body must never reach the conversation.
 */
export function parseAPIErrorDetails(
  data: unknown,
  status?: number,
  fallback?: string
): RequestErrorDetails {
  let payload = data
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as unknown
    } catch {
      // Plain text and proxy error pages are handled below.
    }
  }

  const fields = readErrorPayloadFields(payload)
  const message = fields.message?.trim() || fallback?.trim()
  const isHTML = HTML_DOCUMENT_PATTERN.test(message || '')

  // A mid-stream failure has no HTTP status of its own; the proxy still names
  // the status in the page title.
  const titleStatus = isHTML
    ? Number(message?.match(HTML_TITLE_STATUS_PATTERN)?.[1])
    : undefined
  const statusCode = status && status >= 400 ? status : titleStatus

  const errorCode =
    fields.errorCode || (statusCode ? `http_${statusCode}` : undefined)

  if ((isHTML || !fields.structured) && statusCode) {
    const gatewayMessage = GATEWAY_MESSAGES[statusCode]
    if (gatewayMessage) {
      return { errorCode, errorMessage: gatewayMessage }
    }
  }

  if (isHTML) {
    return { errorCode, errorMessage: ERROR_MESSAGES.HTML_RESPONSE }
  }

  if (message) {
    return { errorCode, errorMessage: message }
  }

  return {
    errorCode,
    errorMessage:
      status === 0
        ? ERROR_MESSAGES.NETWORK_ERROR
        : ERROR_MESSAGES.API_REQUEST_ERROR,
  }
}

export function parseRequestErrorDetails(error: unknown): RequestErrorDetails {
  const requestError = error as RequestErrorLike

  return parseAPIErrorDetails(
    requestError?.response?.data,
    requestError?.response?.status,
    requestError?.message
  )
}

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
import { describe, expect, it } from 'vitest'

import { ERROR_MESSAGES } from '../../../constants'
import {
  parseAPIErrorDetails,
  parseRequestErrorDetails,
} from '../request-error-utils'

const NGINX_502_PAGE =
  '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n'

describe('parseAPIErrorDetails', () => {
  it('returns the structured upstream message when the payload is a JSON error object', () => {
    const details = parseAPIErrorDetails(
      { error: { message: 'model not found', code: 'model_not_found' } },
      404
    )

    expect(details.errorMessage).toBe('model not found')
    expect(details.errorCode).toBe('model_not_found')
  })

  it('parses a JSON error payload delivered as a string', () => {
    const details = parseAPIErrorDetails(
      '{"error":{"message":"insufficient quota","code":"insufficient_quota"}}',
      403
    )

    expect(details.errorMessage).toBe('insufficient quota')
    expect(details.errorCode).toBe('insufficient_quota')
  })

  it('replaces a proxy HTML error page with the gateway message for its status', () => {
    const details = parseAPIErrorDetails(NGINX_502_PAGE, 502)

    expect(details.errorMessage).toBe(ERROR_MESSAGES.BAD_GATEWAY)
    expect(details.errorCode).toBe('http_502')
  })

  it('recovers the status from the HTML title when no HTTP status is available', () => {
    const details = parseAPIErrorDetails(NGINX_502_PAGE)

    expect(details.errorMessage).toBe(ERROR_MESSAGES.BAD_GATEWAY)
    expect(details.errorCode).toBe('http_502')
  })

  it('maps 503 and 504 gateway statuses to their own messages', () => {
    expect(parseAPIErrorDetails('<html><body/></html>', 503).errorMessage).toBe(
      ERROR_MESSAGES.SERVICE_UNAVAILABLE
    )
    expect(parseAPIErrorDetails('<html><body/></html>', 504).errorMessage).toBe(
      ERROR_MESSAGES.GATEWAY_TIMEOUT
    )
  })

  it('falls back to the generic page message for HTML without a known status', () => {
    const details = parseAPIErrorDetails('<!doctype html><html></html>')

    expect(details.errorMessage).toBe(ERROR_MESSAGES.HTML_RESPONSE)
  })

  it('detects an escaped HTML page that already passed through escaping', () => {
    const details = parseAPIErrorDetails('&lt;html&gt;&lt;/html&gt;')

    expect(details.errorMessage).toBe(ERROR_MESSAGES.HTML_RESPONSE)
  })

  it('keeps a structured upstream message even when the status is a gateway error', () => {
    const details = parseAPIErrorDetails(
      { error: { message: 'upstream channel disabled' } },
      503
    )

    expect(details.errorMessage).toBe('upstream channel disabled')
  })

  it('reports a network failure when the request never reached a server', () => {
    const details = parseAPIErrorDetails(undefined, 0)

    expect(details.errorMessage).toBe(ERROR_MESSAGES.NETWORK_ERROR)
  })

  it('uses the caller fallback when the payload carries no message', () => {
    const details = parseAPIErrorDetails({}, 400, 'Request failed')

    expect(details.errorMessage).toBe('Request failed')
  })

  it('derives an http error code from the status when the payload has none', () => {
    const details = parseAPIErrorDetails({ message: 'nope' }, 429)

    expect(details.errorMessage).toBe('nope')
    expect(details.errorCode).toBe('http_429')
  })
})

describe('parseRequestErrorDetails', () => {
  it('normalizes an axios-shaped error carrying a proxy HTML page', () => {
    const details = parseRequestErrorDetails({
      message: 'Request failed with status code 502',
      response: { status: 502, data: NGINX_502_PAGE },
    })

    expect(details.errorMessage).toBe(ERROR_MESSAGES.BAD_GATEWAY)
    expect(details.errorCode).toBe('http_502')
  })

  it('prefers the server error message over the axios message', () => {
    const details = parseRequestErrorDetails({
      message: 'Request failed with status code 400',
      response: { status: 400, data: { message: 'group not allowed' } },
    })

    expect(details.errorMessage).toBe('group not allowed')
  })

  it('falls back to the generic request error when nothing is available', () => {
    const details = parseRequestErrorDetails({})

    expect(details.errorMessage).toBe(ERROR_MESSAGES.API_REQUEST_ERROR)
  })
})

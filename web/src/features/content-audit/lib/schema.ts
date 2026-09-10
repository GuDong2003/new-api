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
import { z } from 'zod'

const integerMessage = 'Enter a whole number within the displayed limits.'

function boundedInteger(min: number, max: number) {
  return z
    .number({ error: integerMessage })
    .int(integerMessage)
    .min(min, integerMessage)
    .max(max, integerMessage)
}

export const contentAuditSettingsSchema = z.object({
  enabled: z.boolean(),
  retention_days: boundedInteger(1, 30),
  request_limit: boundedInteger(65536, 2097152),
  response_limit: boundedInteger(65536, 4194304),
  capacity_bytes: boundedInteger(67108864, 10737418240),
  thumbnail_enabled: z.boolean(),
  plaintext_acknowledged: z.boolean(),
})

const optionalId = z
  .string()
  .refine(
    (value) =>
      value === '' ||
      (/^\d+$/.test(value) &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) > 0),
    'Enter a positive integer ID.'
  )

export const contentAuditFilterSchema = z.object({
  range: z
    .object({ start: z.date().optional(), end: z.date().optional() })
    .refine((range) => {
      if (!range.start || !range.end) return false
      const start = Math.floor(range.start.getTime() / 1000)
      const end = Math.floor(range.end.getTime() / 1000)
      return start > 0 && end >= start && end - start <= 31 * 86400
    }, 'Choose a valid time range of at most 31 days.'),
  user_id: optionalId,
  channel_id: optionalId,
  model: z
    .string()
    .refine(
      (value) => new TextEncoder().encode(value).length <= 128,
      'Model filter must not exceed 128 bytes.'
    ),
  request_id: z
    .string()
    .refine(
      (value) => new TextEncoder().encode(value).length <= 64,
      'Request ID filter must not exceed 64 bytes.'
    ),
  kind: z.enum(['', 'text', 'image']),
  integrity: z.enum(['', 'complete', 'partial']),
  http_status: z
    .string()
    .refine(
      (value) =>
        value === '' ||
        (/^\d{3}$/.test(value) && Number(value) >= 100 && Number(value) <= 599),
      'HTTP status must be between 100 and 599.'
    ),
})

export type ContentAuditFilterValues = z.infer<typeof contentAuditFilterSchema>

export function defaultContentAuditFilters(): ContentAuditFilterValues & {
  range: { start: Date; end: Date }
} {
  const now = Math.floor(Date.now() / 1000)
  return {
    range: {
      start: new Date((now - 7 * 86400) * 1000),
      end: new Date(now * 1000),
    },
    user_id: '',
    channel_id: '',
    model: '',
    request_id: '',
    kind: '',
    integrity: '',
    http_status: '',
  }
}

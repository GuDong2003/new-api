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
import { z } from 'zod'

import type { GallerySettings } from '../types'

const error = 'Gallery settings are invalid.'
export const gallerySettingsSchema = z.object({
  enabled: z.boolean(),
  retention_days: z.number({ error }).int(error).min(1, error).max(3650, error),
  user_max_images: z
    .number({ error })
    .int(error)
    .min(1, error)
    .max(100000, error),
  user_max_mib: z.number({ error }).min(1, error).max(1048576, error),
  total_max_mib: z.number({ error }).min(1, error).max(1048576, error),
})
export type GallerySettingsFormValues = z.infer<typeof gallerySettingsSchema>

export function gallerySettingsToForm(
  settings: GallerySettings
): GallerySettingsFormValues {
  return {
    enabled: settings.enabled,
    retention_days: settings.retention_days,
    user_max_images: settings.user_max_images,
    user_max_mib: settings.user_max_bytes / 1048576,
    total_max_mib: settings.total_max_bytes / 1048576,
  }
}

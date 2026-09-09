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
import type { ModelOption } from '../../types'

export type ImageModelFamily =
  | 'dall-e-2'
  | 'dall-e-3'
  | 'gpt-image'
  | 'imagen'
  | 'flux'
  | 'seedream'

/**
 * Classify models that can be sent through the generic image-generation
 * playground. Native-only image channels (for example NovelAI) intentionally
 * remain outside this list and use their own playground.
 */
export function getImageModelFamily(model: string): ImageModelFamily | null {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return null

  if (
    normalized === 'dall-e' ||
    /(^|[/.:_-])dall-e-2(?:[/.:_-]|$)/.test(normalized)
  ) {
    return 'dall-e-2'
  }
  if (/(^|[/.:_-])dall-e-3(?:[/.:_-]|$)/.test(normalized)) {
    return 'dall-e-3'
  }
  if (/(^|[/.:_-])(?:gpt-image|chatgpt-image)(?:[/.:_-]|$)/.test(normalized)) {
    return 'gpt-image'
  }
  if (/(^|[/.:_-])imagen(?:[/.:_-]|$)/.test(normalized)) return 'imagen'
  if (/(^|[/._-])flux(?:[/._-]|$)/.test(normalized)) return 'flux'
  if (/(^|[/._-])seedream(?:[/._-]|$)/.test(normalized)) {
    return 'seedream'
  }

  return null
}

export function filterImageModels(
  models: readonly ModelOption[]
): ModelOption[] {
  return models.filter((model) => getImageModelFamily(model.value) !== null)
}

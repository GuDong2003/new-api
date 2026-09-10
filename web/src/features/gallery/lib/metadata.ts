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
// Matches service/gallery.go. Never copy whole settings/request objects: they
// may contain group names, credentials, references, URLs or binary image data.
const parameterKeys = new Set([
  'seed',
  'steps',
  'scale',
  'cfg_scale',
  'cfg_rescale',
  'width',
  'height',
  'n',
  'strength',
  'noise',
  'uncond_scale',
  'params_version',
  'n_samples',
  'tag_hint_qt',
  'qualityToggle',
  'sm',
  'sm_dyn',
  'dynamic_thresholding',
  'add_original_image',
  'deliberate_euler_ancestral_bug',
  'prefer_brownian',
  'legacy_v3_extend',
  'normalize_reference_strength_multiple',
  'variety_boost',
  'legacy',
  'sampler',
  'noise_schedule',
  'quality',
  'size',
  'style',
  'response_format',
  'ucPresetId',
  'qualityPresetId',
  'image_format',
])

export function safeGalleryParameters(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([key, value]) =>
        parameterKeys.has(key) &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean')
    )
  )
}

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
import { describe, it, expect } from 'vitest'

import {
  DEFAULT_IMAGE_SETTINGS,
  buildImagePayload,
  getImageModelFamily,
  getImageQualities,
  getImageSizes,
  settingsForImageModel,
  validateImageSettings,
} from '../image-settings'

const settings = {
  ...DEFAULT_IMAGE_SETTINGS,
  model: 'gpt-image-1',
  prompt: 'A blue ceramic cup',
}
describe('OpenAI image parameters', () => {
  it('preserves explicit zero compression and partial count with streaming enabled', () => {
    const payload = buildImagePayload({
      ...settings,
      outputFormat: 'webp',
      outputCompression: 0,
      stream: true,
      partialImages: 0,
    })
    expect(payload).toMatchObject({
      output_compression: 0,
      partial_images: 0,
      stream: true,
      n: 1,
      group: 'default',
    })
    expect(payload).not.toHaveProperty('response_format')
  })
  it('omits incompatible GPT parameters when generating with DALL·E 3', () => {
    const payload = buildImagePayload({
      ...settings,
      model: 'dall-e-3',
      quality: 'hd',
      style: 'natural',
    })
    expect(payload).toMatchObject({
      response_format: 'b64_json',
      style: 'natural',
      quality: 'hd',
    })
    for (const key of [
      'stream',
      'output_format',
      'output_compression',
      'background',
      'moderation',
      'input_fidelity',
    ]) {
      expect(payload).not.toHaveProperty(key)
    }
  })
  it('sends input fidelity only on image edits when explicitly configured', () => {
    expect(
      buildImagePayload({ ...settings, inputFidelity: 'high' })
    ).not.toHaveProperty('input_fidelity')
    expect(
      buildImagePayload({ ...settings, mode: 'edit', inputFidelity: 'high' })
        .input_fidelity
    ).toBe('high')
    expect(buildImagePayload({ ...settings, mode: 'edit' })).not.toHaveProperty(
      'input_fidelity'
    )
  })
  it.each([0, -1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid image count %s before a request',
    (n) => {
      expect(validateImageSettings({ ...settings, n }, 0)).toBe(
        'Check the image generation parameters.'
      )
    }
  )
  it('rejects unsupported edit references and transparent JPEG output', () => {
    expect(validateImageSettings({ ...settings, mode: 'edit' }, 0)).toBe(
      'Add a reference image before editing.'
    )
    expect(validateImageSettings({ ...settings, mode: 'edit' }, 17)).toBe(
      'Use one reference for DALL·E 2 or up to 16 for GPT Image.'
    )
    expect(
      validateImageSettings(
        { ...settings, background: 'transparent', outputFormat: 'jpeg' },
        0
      )
    ).toBe('Transparent backgrounds require PNG or WebP.')
  })
  it('rejects DALL·E 3 edits and counts greater than one', () => {
    expect(
      validateImageSettings({ ...settings, model: 'dall-e-3', n: 2 }, 0)
    ).toBe('DALL·E 3 supports one image per request.')
    expect(
      validateImageSettings({ ...settings, model: 'dall-e-3', mode: 'edit' }, 1)
    ).toBe('DALL·E 3 does not support image editing.')
  })
  it('accepts standard GPT settings and custom GPT Image 2 dimensions', () => {
    expect(validateImageSettings(settings, 0)).toBeNull()
    expect(
      validateImageSettings(
        { ...settings, model: 'gpt-image-2', size: '1536x864' },
        0
      )
    ).toBeNull()
    expect(
      validateImageSettings({ ...settings, size: '99999x99999' }, 0)
    ).not.toBeNull()
  })

  it('uses provider-specific image families and safe defaults', () => {
    expect(getImageModelFamily('imagen-4.0-generate-001')).toBe('imagen')
    expect(getImageModelFamily('black-forest-labs/flux-1.1-pro')).toBe('flux')
    expect(getImageModelFamily('doubao-seedream-4-0-250828')).toBe('seedream')
    expect(getImageSizes('imagen-4.0-generate-001')).toContain('1536x1024')
    expect(getImageQualities('imagen-4.0-generate-001')).toEqual([
      'standard',
      'hd',
    ])

    const next = settingsForImageModel(
      { ...settings, quality: 'auto', mode: 'edit' },
      'imagen-4.0-generate-001'
    )
    expect(next.quality).toBe('standard')
    expect(next.mode).toBe('generate')
    expect(buildImagePayload(next)).not.toHaveProperty('background')
    expect(validateImageSettings({ ...next, mode: 'edit' }, 1)).toBe(
      'This image model does not support image editing.'
    )
  })
})

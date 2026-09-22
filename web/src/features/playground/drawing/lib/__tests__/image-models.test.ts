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
import { describe, expect, it } from 'vitest'

import { filterImageModels, getImageModelFamily } from '../image-models'

describe('drawing image model classification', () => {
  it.each([
    ['dall-e-3', 'dall-e-3'],
    ['openai/dall-e-2', 'dall-e-2'],
    ['gpt-image-1', 'gpt-image'],
    ['chatgpt-image-latest', 'gpt-image'],
    ['grok-imagine', 'grok-imagine'],
    ['grok/grok-imagine-edit', 'grok-imagine'],
    ['nano-banana', 'nano-banana'],
    ['nano-banana-pro', 'nano-banana'],
    ['nano-banana-v2', 'nano-banana'],
    ['gemini-3.0-pro-image', 'nano-banana'],
    ['gemini-3.1-flash-image', 'nano-banana'],
    ['gemini-3-pro-image-preview', 'nano-banana'],
    ['gemini-2.5-flash-image-preview', 'nano-banana'],
    ['google/gemini-3-pro-image-preview', 'nano-banana'],
    ['imagen-4.0-generate-001', 'imagen'],
    ['google/imagen-4.0-generate-001', 'imagen'],
    ['black-forest-labs/flux-1.1-pro', 'flux'],
    ['doubao-seedream-4-0-250828', 'seedream'],
    ['recraft-v3', 'recraft'],
    ['kolors', 'kolors'],
    ['janus-pro', 'janus'],
  ])('recognizes %s as a %s model', (model, family) => {
    expect(getImageModelFamily(model)).toBe(family)
  })

  it('does not treat NAI or text models as generic drawing models', () => {
    expect(getImageModelFamily('nai-diffusion-4-5-full')).toBeNull()
    expect(getImageModelFamily('gpt-5.6')).toBeNull()
    expect(getImageModelFamily('grok-imagine-video')).toBeNull()
  })

  it('does not mistake Gemini text or embedding models for image models', () => {
    for (const model of [
      'gemini-3.5-flash',
      'gemini-3.6-flash-high',
      'gemini-3.1-pro-preview',
      'gemini-3-flash',
      'gemini-2.5-pro',
      'gemini-embedding-001',
      'gemini-embedding-2',
      'gemini-3.1-flash-lite',
    ]) {
      expect(getImageModelFamily(model)).toBeNull()
    }
  })

  it('filters the drawing selector to supported image model families', () => {
    const models = [
      { label: 'gpt-5.6', value: 'gpt-5.6' },
      { label: 'gpt-image-1', value: 'gpt-image-1' },
      { label: 'Grok Imagine', value: 'grok-imagine' },
      { label: 'Grok Video', value: 'grok-imagine-video' },
      { label: 'Nano Banana', value: 'nano-banana' },
      { label: 'Imagen 4', value: 'imagen-4.0-generate-001' },
      { label: 'Flux', value: 'black-forest-labs/flux-1.1-pro' },
      { label: 'Recraft', value: 'recraft-v3' },
      { label: 'Kolors', value: 'kolors' },
      { label: 'Janus', value: 'janus-pro' },
      { label: 'NAI', value: 'nai-diffusion-4-5-full' },
    ]

    expect(filterImageModels(models).map((model) => model.value)).toEqual([
      'gpt-image-1',
      'grok-imagine',
      'nano-banana',
      'imagen-4.0-generate-001',
      'black-forest-labs/flux-1.1-pro',
      'recraft-v3',
      'kolors',
      'janus-pro',
    ])
  })
})

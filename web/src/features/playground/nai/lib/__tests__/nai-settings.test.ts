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

import {
  buildNaiImagePayload,
  DEFAULT_NAI_SETTINGS,
  validateNaiSettings,
} from '../nai-settings'

describe('NovelAI settings', () => {
  it('builds a numeric native request without converting n to a string', () => {
    const payload = buildNaiImagePayload({
      ...DEFAULT_NAI_SETTINGS,
      model: 'nai-diffusion-4-5-full',
      group: 'default',
      prompt: 'a white fox',
      n: 2,
      width: 832,
      height: 1216,
      steps: 28,
      scale: 5,
      seed: 42,
    })

    expect(payload.n).toBe(2)
    expect(payload.nai).toEqual({
      action: 'generate',
      parameters: expect.objectContaining({
        width: 832,
        height: 1216,
        n_samples: 2,
        steps: 28,
        scale: 5,
        seed: 42,
      }),
    })
  })

  it('rejects dimensions that are not aligned to the NovelAI grid', () => {
    const message = validateNaiSettings({
      ...DEFAULT_NAI_SETTINGS,
      model: 'nai-diffusion-4-5-full',
      group: 'default',
      prompt: 'a white fox',
      width: 800,
      height: 1216,
    })

    expect(message).toContain('multiples of 64')
  })
})

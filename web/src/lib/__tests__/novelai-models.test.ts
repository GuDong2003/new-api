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

import { filterNovelAIModels } from '../novelai-models'

describe('NovelAI model filtering', () => {
  it('keeps only supported NovelAI image models', () => {
    expect(
      filterNovelAIModels([
        'gpt-4o',
        'nai-diffusion-4-5-full',
        'claude-3-7-sonnet',
        'nai-diffusion-furry-3',
      ])
    ).toEqual(['nai-diffusion-4-5-full', 'nai-diffusion-furry-3'])
  })
})

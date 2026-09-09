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

import type { NaiSettings } from '../types'

export const naiSettingsSchema = z.object({
  group: z.string().trim().default('default'),
  model: z.string().trim().default(''),
  prompt: z.string().max(32000).default(''),
  negativePrompt: z.string().max(32000).default(''),
  width: z.number().int().min(64).max(2048).default(832),
  height: z.number().int().min(64).max(2048).default(1216),
  steps: z.number().int().min(1).max(50).default(28),
  scale: z.number().min(0).max(30).default(5),
  sampler: z
    .enum([
      'k_euler_ancestral',
      'k_euler',
      'k_dpmpp_2s_ancestral',
      'k_dpmpp_2m',
      'k_dpmpp_sde',
      'ddim_v3',
    ])
    .default('k_euler_ancestral'),
  noiseSchedule: z
    .enum(['native', 'karras', 'exponential', 'polyexponential'])
    .default('karras'),
  cfgRescale: z.number().min(0).max(1).default(0),
  seed: z.number().int().min(0).max(4294967295).nullable().default(null),
  n: z.number().int().min(1).max(8).default(1),
  qualityToggle: z.boolean().default(false),
  qualityTier: z.enum(['standard', 'light']).default('standard'),
  ucPreset: z.enum(['heavy', 'light', 'humanFocus', 'none']).default('none'),
  smea: z.boolean().default(false),
  smeaDyn: z.boolean().default(false),
  decrisp: z.boolean().default(false),
})

export const DEFAULT_NAI_SETTINGS = naiSettingsSchema.parse({})

export function validateNaiSettings(settings: NaiSettings): string | null {
  if (!naiSettingsSchema.safeParse(settings).success) {
    return 'Check the NovelAI generation parameters.'
  }
  if (!settings.prompt.trim()) return 'Enter a prompt to generate an image.'
  if (!settings.model.trim()) return 'Select a NovelAI model.'
  if (!settings.group.trim()) return 'Select a group.'
  if (settings.width % 64 || settings.height % 64) {
    return 'Image dimensions must be multiples of 64.'
  }
  if (settings.width * settings.height > 3145728) {
    return 'The image resolution exceeds the NovelAI limit.'
  }
  return null
}

export function buildNaiImagePayload(
  settings: NaiSettings
): Record<string, unknown> {
  let qualityTagHint = 0
  if (settings.qualityToggle) {
    qualityTagHint = settings.qualityTier === 'light' ? 3 : 1
  }
  const parameters: Record<string, unknown> = {
    params_version: 4,
    width: settings.width,
    height: settings.height,
    steps: settings.steps,
    scale: settings.scale,
    sampler: settings.sampler,
    noise_schedule: settings.noiseSchedule,
    cfg_rescale: settings.cfgRescale,
    n_samples: settings.n,
    negative_prompt: settings.negativePrompt.trim(),
    ucPresetId: settings.ucPreset,
    qualityPresetId: settings.qualityToggle ? settings.qualityTier : 'none',
    tag_hint_qt: qualityTagHint,
    legacy: false,
    dynamic_thresholding: settings.decrisp,
    add_original_image: false,
    sm: settings.smea,
    sm_dyn: settings.smeaDyn,
    image_format: 'png',
  }
  if (settings.seed !== null) parameters.seed = settings.seed
  return {
    model: settings.model.trim(),
    prompt: settings.prompt.trim(),
    size: `${settings.width}x${settings.height}`,
    n: settings.n,
    response_format: 'b64_json',
    group: settings.group.trim(),
    nai: { action: 'generate', parameters },
  }
}

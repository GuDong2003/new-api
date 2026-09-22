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

import enLocale from '@/i18n/locales/en.json'
import { STATIC_I18N_KEYS } from '@/i18n/static-keys'

import {
  DEFAULT_IMAGE_SETTINGS,
  buildImagePayload,
  getImageModelFamily,
  getImagePresetSize,
  getImageQualities,
  getImageResolutionTier,
  getImageSizePreset,
  getImageAspectRatios,
  IMAGE_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageResolution,
  getImageSizes,
  normalizeStoredImageSettings,
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
        { ...settings, model: 'gpt-image-2', size: '1536x864', quality: 'standard' },
        0
      )
    ).toBeNull()
    expect(
      validateImageSettings({ ...settings, size: '99999x99999' }, 0)
    ).not.toBeNull()
  })

  // The official ceiling is 3840 per side, so these are the real 4K presets.
  it.each(['2480x2480', '3328x1872', '1872x3328'])(
    'accepts and preserves a 4K request size of %s for custom-size models',
    (size) => {
      const next = {
        ...settings,
        model: 'gpt-image-2.5',
        size,
        quality: '4k' as const,
      }
      expect(validateImageSettings(next, 0)).toBeNull()
      const restored = normalizeStoredImageSettings(next)
      expect(buildImagePayload(restored).size).toBe(size)
    }
  )

  it.each(['3856x2048', '8192x8192', '1024x128', '0x1024', 'x1024'])(
    'rejects invalid custom dimensions %s',
    (size) => {
      expect(
        validateImageSettings(
          { ...settings, model: 'gpt-image-2.5', size, quality: 'standard' },
          0
        )
      ).not.toBeNull()
    }
  )

  // The gateway behind these models renders one image per call and ignores a
  // larger `n`, so asking for a batch would leave empty nodes behind.
  it.each(['nano-banana', 'nano-banana-pro', 'gpt-image-2', 'gpt-image-2.5'])(
    'caps %s at one image per request',
    (model) => {
      expect(settingsForImageModel({ ...settings, n: 4 }, model).n).toBe(1)
      expect(
        validateImageSettings(
          { ...settingsForImageModel(settings, model), n: 4 },
          0
        )
      ).toBe('This model supports one image per request.')
    }
  )

  it.each(['gpt-image-1', 'dall-e-2'])(
    'still allows a batch on %s, which returns them',
    (model) => {
      const next = settingsForImageModel({ ...settings, n: 4 }, model)

      expect(next.n).toBe(4)
      expect(validateImageSettings(next, 0)).toBeNull()
    }
  )

  it.each(['nano-banana', 'gpt-image-2'])(
    'rejects a prompt the gateway would truncate on %s',
    (model) => {
      const next = settingsForImageModel(
        { ...settings, prompt: 'a'.repeat(4001) },
        model
      )

      expect(validateImageSettings(next, 0)).toBe(
        'Prompts for this model must be 4,000 characters or fewer.'
      )
    }
  )

  // The cap upstream counts runes, so a surrogate pair is one character even
  // though `String.length` reports two.
  it('measures the prompt cap in code points rather than UTF-16 units', () => {
    const next = settingsForImageModel(
      { ...settings, prompt: '𝄞'.repeat(2001) },
      'nano-banana'
    )

    expect(next.prompt.length).toBeGreaterThan(4000)
    expect(validateImageSettings(next, 0)).toBeNull()
  })

  // These messages are returned as plain strings, so the t('...') scanner cannot
  // find them; they only reach the locale files via the static key registry.
  it('registers the out-of-range size message for translation', () => {
    const message = validateImageSettings(
      {
        ...settings,
        model: 'gpt-image-2.5',
        size: '3856x2048',
        quality: 'standard',
      },
      0
    )

    expect(message).not.toBeNull()
    expect(STATIC_I18N_KEYS).toContain(message)
    expect(enLocale.translation).toHaveProperty([message as string])
  })

  it.each(['gpt-image-1', 'gpt-image-1.5', 'chatgpt-image-latest', 'dall-e-3'])(
    'keeps fixed-size restrictions for %s',
    (model) => {
      const next = settingsForImageModel(settings, model)
      expect(validateImageSettings({ ...next, size: '4096x4096' }, 0)).toBe(
        'Choose a size supported by this model.'
      )
      expect(
        settingsForImageModel({ ...next, size: '4096x4096' }, model).size
      ).toBe('1024x1024')
    }
  )

  // The gateway reads quality as the billed tier, so it is derived from the
  // chosen size rather than picked separately.
  it.each([
    ['1024x1024', 'standard'],
    ['2048x2048', '2k'],
    ['2480x2480', '4k'],
    ['3328x1872', '4k'],
  ])('bills %s as the %s tier', (size, quality) => {
    const next = settingsForImageModel(
      { ...settings, size },
      'gpt-image-2.5-flare'
    )
    expect(buildImagePayload(next).quality).toBe(quality)
  })

  it('reads the tier of a custom pixel size from its longest side', () => {
    expect(getImageResolutionTier('1280x720')).toBe('1K')
    expect(getImageResolutionTier('1600x1600')).toBe('1K')
    expect(getImageResolutionTier('2560x1440')).toBe('2K')
    expect(getImageResolutionTier('2800x1400')).toBe('2K')
    expect(getImageResolutionTier('3328x1872')).toBe('4K')
  })

  it.each(['gpt-image-1', 'openai/gpt-image-1', 'chatgpt-image-latest'])(
    'keeps the original quality ladder for %s',
    (model) => {
      expect(getImageQualities(model)).toEqual([
        'auto',
        'high',
        'medium',
        'low',
      ])
      expect(
        validateImageSettings({ ...settings, model, quality: 'max' }, 0)
      ).toBe('Choose a quality supported by this model.')
      expect(
        settingsForImageModel({ ...settings, quality: 'max' }, model).quality
      ).toBe('auto')
    }
  )

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

describe('Grok NSFW switch', () => {
  const grok = { ...settings, model: 'grok-imagine-image-2.0' }

  it('sends nsfw for a Grok model when the switch is on', () => {
    expect(buildImagePayload({ ...grok, nsfw: true })).toMatchObject({
      nsfw: true,
    })
  })

  it('sends nsfw false for a Grok model when the switch is off', () => {
    expect(buildImagePayload({ ...grok, nsfw: false })).toMatchObject({
      nsfw: false,
    })
  })

  it('sends nsfw when editing a Grok image', () => {
    expect(
      buildImagePayload({
        ...grok,
        model: 'grok-imagine-image-edit',
        mode: 'edit',
        nsfw: true,
      })
    ).toMatchObject({ nsfw: true })
  })

  it('omits nsfw for a non-Grok model even when the switch is on', () => {
    expect(buildImagePayload({ ...settings, nsfw: true })).not.toHaveProperty(
      'nsfw'
    )
  })

  it('defaults the switch to off', () => {
    expect(DEFAULT_IMAGE_SETTINGS.nsfw).toBe(false)
  })
})

describe('Nano Banana size and resolution', () => {
  const nano = { ...settings, model: 'gemini-3-pro-image-preview' }

  // Verified against the provider: it rejects `1k` and reads the tier from the
  // pixel size, so quality keeps its ordinary picture-quality meaning here.
  // `1k` is documented but rejected upstream, so its synonym carries 1K.
  it('never sends the tier value the provider rejects', () => {
    const next = settingsForImageModel(
      { ...settings, size: '1024x1024' },
      'nano-banana-pro'
    )
    expect(buildImagePayload(next).quality).toBe('standard')
  })

  it('carries the ratio and tier in the pixel size', () => {
    expect(
      buildImagePayload({ ...nano, size: '2752x1536', quality: 'auto' })
    ).toMatchObject({ size: '2752x1536', quality: '2k' })
  })

  it('accepts auto and preset sizes for this family', () => {
    expect(
      validateImageSettings({ ...nano, size: 'auto', quality: 'standard' }, 1)
    ).toBeNull()
    expect(
      validateImageSettings({ ...nano, size: '2048x2048', quality: 'standard' }, 0)
    ).toBeNull()
  })

})

describe('stored settings stay valid for their model', () => {
  it('repairs a Nano Banana quality saved before the tier steps existed', () => {
    const restored = normalizeStoredImageSettings({
      ...DEFAULT_IMAGE_SETTINGS,
      model: 'nano-banana',
      prompt: 'A blue ceramic cup',
      quality: 'auto',
    })
    expect(getImageQualities('nano-banana')).toContain(restored.quality)
    expect(validateImageSettings(restored, 0)).toBeNull()
  })

  it('leaves a quality that the model still supports untouched', () => {
    const restored = normalizeStoredImageSettings({
      ...DEFAULT_IMAGE_SETTINGS,
      model: 'dall-e-3',
      prompt: 'A blue ceramic cup',
      quality: 'hd',
      size: '1792x1024',
    })
    expect(restored.quality).toBe('hd')
    expect(restored.size).toBe('1792x1024')
  })
})

describe('preset sizes follow the provider recommendations', () => {
  it.each([
    ['1:1', '1K', '1024x1024'],
    ['16:9', '1K', '1280x720'],
    ['9:16', '1K', '720x1280'],
    ['3:2', '1K', '1536x1024'],
    ['2:3', '1K', '1024x1536'],
    ['4:3', '1K', '1152x864'],
    ['3:4', '1K', '864x1152'],
    ['1:1', '2K', '2048x2048'],
    ['16:9', '2K', '2560x1440'],
    ['3:2', '2K', '2496x1664'],
    ['4:3', '2K', '2304x1728'],
    ['5:4', '1K', '1120x896'],
    ['4:5', '1K', '896x1120'],
    ['21:9', '1K', '1456x624'],
    ['5:4', '2K', '2240x1792'],
    ['4:5', '2K', '1792x2240'],
    ['21:9', '2K', '3024x1296'],
    ['5:4', '4K', '2784x2224'],
    ['4:5', '4K', '2224x2784'],
    ['21:9', '4K', '3808x1632'],
    ['1:1', '4K', '2480x2480'],
    ['16:9', '4K', '3328x1872'],
    ['9:16', '4K', '1872x3328'],
    ['3:4', '4K', '2160x2880'],
  ])('renders %s at %s as %s', (ratio, resolution, size) => {
    expect(
      getImagePresetSize(
        ratio as ImageAspectRatio,
        resolution as ImageResolution,
        'gpt-image-2'
      )
    ).toBe(size)
    expect(getImageSizePreset(size, 'gpt-image-2')).toEqual({
      aspectRatio: ratio,
      resolution,
    })
  })

  it('covers every published ratio', () => {
    expect([...getImageAspectRatios('gpt-image-2')]).toEqual([
      '1:1',
      '2:3',
      '3:2',
      '3:4',
      '4:3',
      '4:5',
      '5:4',
      '9:16',
      '16:9',
      '21:9',
    ])
  })

  it('never exceeds the largest recommended dimension', () => {
    for (const ratio of getImageAspectRatios('gpt-image-2')) {
      for (const resolution of IMAGE_RESOLUTIONS) {
        const [width, height] = getImagePresetSize(
          ratio,
          resolution,
          'gpt-image-2'
        )
          .split('x')
          .map(Number)
        expect(Math.max(width, height)).toBeLessThanOrEqual(3808)
      }
    }
  })
})

describe('Nano Banana runs its own size table', () => {
  // The provider documents a separate table and returns 422 when the GPT Image
  // sizes are sent to it.
  it.each([
    ['1:1', '1K', '1024x1024'],
    ['16:9', '1K', '1360x768'],
    ['16:9', '2K', '2752x1536'],
    ['16:9', '4K', '5504x3072'],
    ['3:2', '1K', '1264x848'],
    ['21:9', '2K', '3168x1344'],
    ['1:1', '4K', '4096x4096'],
  ])('renders %s at %s as %s', (ratio, tier, size) => {
    expect(
      getImagePresetSize(
        ratio as ImageAspectRatio,
        tier as ImageResolution,
        'nano-banana-pro'
      )
    ).toBe(size)
  })

  // The two upstream paths keep separate whitelists; sending one path's size to
  // the other is rejected with a 422, so these ratios must not converge.
  it.each([
    ['16:9', '1K'],
    ['16:9', '2K'],
    ['16:9', '4K'],
    ['2:3', '1K'],
    ['3:2', '2K'],
    ['21:9', '4K'],
    ['1:1', '4K'],
  ])('keeps the %s %s size distinct from the GPT Image table', (ratio, tier) => {
    expect(
      getImagePresetSize(
        ratio as ImageAspectRatio,
        tier as ImageResolution,
        'nano-banana-pro'
      )
    ).not.toBe(
      getImagePresetSize(
        ratio as ImageAspectRatio,
        tier as ImageResolution,
        'gpt-image-2'
      )
    )
  })

  // Panoramas exist only in the Nano Banana table, so every other model has to
  // resolve to a real size rather than an undefined one.
  it.each(['1:4', '4:1', '1:8', '8:1'])(
    'falls back to a square size when %s is missing from the model table',
    (ratio) => {
      const size = getImagePresetSize(
        ratio as ImageAspectRatio,
        '2K',
        'gpt-image-2'
      )

      expect(size).toBe('2048x2048')
    }
  )

  it('offers the panoramas only on Nano Banana v2', () => {
    for (const model of ['nano-banana-v2', 'gemini-3.1-flash-image']) {
      expect(getImageAspectRatios(model)).toContain('8:1')
      expect(getImageAspectRatios(model)).toHaveLength(14)
    }
    for (const model of ['nano-banana-pro', 'nano-banana', 'gpt-image-2']) {
      expect(getImageAspectRatios(model)).not.toContain('8:1')
      expect(getImageAspectRatios(model)).toHaveLength(10)
    }
  })
})

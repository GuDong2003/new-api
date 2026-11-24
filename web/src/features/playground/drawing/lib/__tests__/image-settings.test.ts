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
  getAllowedImageSize,
  getAutomaticImageAspectRatio,
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
  imageSettingsSchema,
  nearestOfferedResolution,
  normalizeStoredImageSettings,
  resolveImageRequestSize,
  settingsForImageModel,
  validateImageSettings,
} from '../image-settings'

const settings = {
  ...DEFAULT_IMAGE_SETTINGS,
  model: 'gpt-image-1',
  prompt: 'A blue ceramic cup',
}
describe('OpenAI image parameters', () => {
  it('sends transparent GIF timing without still-image compression', () => {
    const animated = imageSettingsSchema.parse({
      ...settings,
      model: 'gpt-image-2.6-sunburst',
      outputFormat: 'gif',
      background: 'transparent',
      frameCount: 12,
      frameDurationMs: 120,
    })
    const payload = buildImagePayload(animated)
    expect(payload).toMatchObject({
      output_format: 'gif',
      background: 'transparent',
      frame_count: 12,
      frame_duration_ms: 120,
      n: 1,
    })
    expect(payload).not.toHaveProperty('output_compression')
    expect(payload).not.toHaveProperty('partial_images')
    expect(payload).not.toHaveProperty('stream')
    expect(validateImageSettings(animated, 0)).toBeNull()
  })

  it('preserves transparent GIF settings when restoring and switching between 2.6 models', () => {
    const animated = {
      ...settings,
      model: 'gpt-image-2.6',
      background: 'transparent' as const,
      outputFormat: 'gif' as const,
      frameCount: 12,
      frameDurationMs: 120,
    }
    const restored = normalizeStoredImageSettings(animated)
    const switched = settingsForImageModel(restored, 'gpt-image-2.6-sunburst')
    expect(restored).toMatchObject({
      model: 'gpt-image-2.6',
      background: 'transparent',
      outputFormat: 'gif',
      frameCount: 12,
      frameDurationMs: 120,
    })
    expect(switched).toMatchObject({
      background: 'transparent',
      outputFormat: 'gif',
      frameCount: 12,
      frameDurationMs: 120,
    })
  })

  it('resets GIF output when switching to a model without animation', () => {
    const animated = {
      ...settings,
      model: 'gpt-image-2.6',
      outputFormat: 'gif' as const,
    }
    expect(settingsForImageModel(animated, 'gpt-image-2.5').outputFormat).toBe(
      'png'
    )
  })

  it.each([
    { frameCount: 1 },
    { frameCount: 17 },
    { frameCount: 2.5 },
    { frameDurationMs: 19 },
    { frameDurationMs: 2001 },
  ])('rejects invalid GIF timing %j', (timing) => {
    expect(
      imageSettingsSchema.safeParse({ ...settings, ...timing }).success
    ).toBe(false)
  })

  it('starts new image generation with an opaque PNG background', () => {
    expect(DEFAULT_IMAGE_SETTINGS).toMatchObject({
      background: 'opaque',
      outputFormat: 'png',
    })
    expect(buildImagePayload(settings)).toMatchObject({
      background: 'opaque',
      output_format: 'png',
    })
  })

  it('sends an opaque background when an older caller still uses auto', () => {
    expect(
      buildImagePayload({
        ...settings,
        background: 'auto',
        outputFormat: 'jpeg',
      })
    ).toMatchObject({ background: 'opaque', output_format: 'jpeg' })
  })

  it('preserves explicit zero compression for WebP output', () => {
    const payload = buildImagePayload({
      ...settings,
      outputFormat: 'webp',
      outputCompression: 0,
    })
    expect(payload).toMatchObject({
      output_compression: 0,
      n: 1,
      group: 'default',
    })
    expect(payload).not.toHaveProperty('response_format')
  })

  it.each(['gpt-image-2', 'nano-banana-pro', 'dall-e-3'])(
    'omits retired stream, partial preview and user fields from legacy %s requests',
    (model) => {
      const legacy = {
        ...settings,
        model,
        stream: true,
        partialImages: 2,
        user: 'legacy-user',
      }
      const payload = buildImagePayload(legacy)
      expect(payload).toMatchObject({ model, prompt: settings.prompt })
      for (const field of ['stream', 'partial_images', 'user']) {
        expect(payload).not.toHaveProperty(field)
      }
    }
  )

  it.each(['auto', 'low'] as const)(
    'sends the selected moderation level %s',
    (moderation) => {
      expect(buildImagePayload({ ...settings, moderation })).toMatchObject({
        moderation,
      })
    }
  )
  it('omits incompatible GPT parameters when generating with DALL·E 3', () => {
    const payload = buildImagePayload({
      ...settings,
      model: 'dall-e-3',
      quality: 'hd',
      style: 'natural',
      background: 'transparent',
      outputFormat: 'webp',
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
    ).toBe('JPEG does not support transparent backgrounds.')
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
        {
          ...settings,
          model: 'gpt-image-2',
          size: '1536x864',
          quality: 'auto',
        },
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
        quality: 'max' as const,
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
          { ...settings, model: 'gpt-image-2.5', size, quality: 'auto' },
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
        quality: 'auto',
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

  it.each([
    ['gpt-image-2', '1280x720', '1K'],
    ['gpt-image-2', '1536x1024', '1K'],
    ['gpt-image-2', '1024x1536', '1K'],
    ['gpt-image-2', '1536x1008', '1K'],
    ['gpt-image-2', '1536x1040', '1K'],
    ['gpt-image-2', '1040x1536', '1K'],
    ['gpt-image-2', '1536x1536', '1K'],
    ['gpt-image-2', '1600x1600', '2K'],
    ['gpt-image-2', '2000x1024', '2K'],
    ['gpt-image-2', '1024x2000', '2K'],
    ['gpt-image-2', '2001x1024', '2K'],
    ['gpt-image-2', '1024x2001', '2K'],
    ['gpt-image-2', '2560x1440', '2K'],
    ['gpt-image-2', '2800x1400', '2K'],
    ['gpt-image-2', '1024x2800', '2K'],
    ['gpt-image-2', '2801x1024', '4K'],
    ['gpt-image-2', '1024x2801', '4K'],
    ['gpt-image-2', '3328x1872', '4K'],
    ['dall-e-3', '1792x1024', '2K'],
  ])('classifies %s size %s as %s', (model, size, tier) => {
    expect(getImageResolutionTier(size, model)).toBe(tier)
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

describe('Seedream model sizes', () => {
  it.each([
    'doubao-seedream-4-5-251128',
    'doubao-seedream-5-0-260128',
    'doubao-seedream-5-0-lite-260128',
  ])('restores old canvas settings to a supported size for %s', (model) => {
    expect(getImageSizes(model)).toEqual([
      '2048x2048',
      '2560x1440',
      '1440x2560',
      '2304x1728',
      '1728x2304',
    ])
    const restored = settingsForImageModel(
      { ...settings, size: '1024x1024' },
      model
    )
    expect(restored.size).toBe('2048x2048')
    expect(validateImageSettings(restored, 0)).toBeNull()
    expect(buildImagePayload(restored)).toMatchObject({
      model,
      size: '2048x2048',
      n: 1,
    })
    expect(validateImageSettings({ ...restored, size: '1024x1024' }, 0)).toBe(
      'Choose a size supported by this model.'
    )
    expect(
      settingsForImageModel({ ...restored, size: '2560x1440' }, model).size
    ).toBe('2560x1440')
  })

  it.each([
    'doubao-seedream-4-0-250828',
    'doubao-seedream-5-0-pro-260628',
    'doubao-seedream-5-0-flash-260915',
  ])('keeps existing one-megapixel canvas sizes for %s', (model) => {
    const next = settingsForImageModel(
      { ...settings, size: '1536x1024' },
      model
    )
    expect(next.size).toBe('1536x1024')
    expect(validateImageSettings(next, 0)).toBeNull()
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
  // GPT Image 2 is an OpenAI-shaped model: the ladder is the rendering quality
  // and the resolution comes from the size, so the two stay independent.
  it.each(['gpt-image-2', 'gpt-image-2.5-flare'])(
    'offers the official quality ladder on %s',
    (model) => {
      expect(getImageQualities(model)).toEqual([
        'auto',
        'max',
        'xhigh',
        'high',
        'medium',
        'low',
      ])
    }
  )

  it('sends the chosen quality next to the tier size on GPT Image 2', () => {
    const next = settingsForImageModel(
      { ...settings, quality: 'max' },
      'gpt-image-2'
    )
    const payload = buildImagePayload({ ...next, size: '2560x1440' })

    expect(payload.quality).toBe('max')
    expect(payload.size).toBe('2560x1440')
  })

  // Gemini defines no quality of its own, so the request carries none and the
  // size is what says how large the result should be.
  it.each(['nano-banana', 'nano-banana-pro', 'nano-banana-v2'])(
    'sends no quality at all on %s',
    (model) => {
      expect(getImageQualities(model)).toEqual([])

      const next = settingsForImageModel(
        { ...settings, size: getImagePresetSize('16:9', '4K', model) },
        model
      )
      const payload = buildImagePayload(next)

      expect(payload).not.toHaveProperty('quality')
      expect(payload.size).toBe('5504x3072')
      expect(validateImageSettings(next, 0)).toBeNull()
    }
  )

  it('carries the ratio and tier in the pixel size', () => {
    expect(
      buildImagePayload({ ...nano, size: '2752x1536', quality: 'auto' })
    ).toMatchObject({ size: '2752x1536' })
  })

  it('accepts auto and preset sizes for this family', () => {
    expect(
      validateImageSettings({ ...nano, size: 'auto', quality: '1k' }, 1)
    ).toBeNull()
    expect(
      validateImageSettings({ ...nano, size: '2048x2048', quality: '1k' }, 0)
    ).toBeNull()
  })
})

describe('stored settings stay valid for their model', () => {
  it('drops retired streaming and user fields when parsing and restoring an older canvas', () => {
    const legacy = {
      ...settings,
      stream: true,
      partialImages: 3,
      user: 'legacy-user',
    }
    for (const restored of [
      imageSettingsSchema.parse(legacy),
      normalizeStoredImageSettings(legacy),
    ]) {
      expect(restored).toMatchObject({
        model: settings.model,
        prompt: settings.prompt,
      })
      for (const field of ['stream', 'partialImages', 'user']) {
        expect(restored).not.toHaveProperty(field)
      }
    }
  })

  it.each([
    ['gpt-image-2', 1],
    ['nano-banana-pro', 1],
    ['nai-diffusion-4-5-full', 8],
    ['qwen-image-2.0', 6],
  ] as const)(
    'drops retired runtime fields when switching to %s while preserving its count normalization to %s',
    (model, count) => {
      const legacy = {
        ...settings,
        n: 12,
        stream: true,
        partialImages: 3,
        user: 'legacy-user',
      }
      const next = settingsForImageModel(legacy, model)
      expect(next.n).toBe(count)
      for (const field of ['stream', 'partialImages', 'user']) {
        expect(next).not.toHaveProperty(field)
      }
      // Normalizing a copy must not mutate a saved node's original settings.
      expect(legacy).toMatchObject({
        n: 12,
        stream: true,
        partialImages: 3,
        user: 'legacy-user',
      })
    }
  )

  it.each([
    ['auto', 'jpeg', 'opaque', 'jpeg'],
    ['transparent', 'jpeg', 'transparent', 'png'],
    ['transparent', 'webp', 'transparent', 'webp'],
    ['opaque', 'jpeg', 'opaque', 'jpeg'],
  ] as const)(
    'restores GPT background %s and format %s as %s and %s',
    (background, outputFormat, expectedBackground, expectedFormat) => {
      const restored = normalizeStoredImageSettings({
        ...settings,
        background,
        outputFormat,
      })
      expect(restored).toMatchObject({
        background: expectedBackground,
        outputFormat: expectedFormat,
      })
      expect(validateImageSettings(restored, 0)).toBeNull()
    }
  )

  it('keeps transparency by choosing PNG when switching a saved JPEG configuration to GPT', () => {
    const next = settingsForImageModel(
      {
        ...settings,
        model: 'nano-banana-pro',
        background: 'transparent',
        outputFormat: 'jpeg',
      },
      'gpt-image-2'
    )
    expect(next).toMatchObject({
      background: 'transparent',
      outputFormat: 'png',
    })
    expect(validateImageSettings(next, 0)).toBeNull()
  })

  // A document saved while the field still carried a tier keeps that value in
  // storage; the request simply stops carrying it.
  it('drops a Nano Banana quality saved before the field was removed', () => {
    const restored = normalizeStoredImageSettings({
      ...DEFAULT_IMAGE_SETTINGS,
      model: 'nano-banana',
      prompt: 'A blue ceramic cup',
      quality: '2k',
    })

    expect(buildImagePayload(restored)).not.toHaveProperty('quality')
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

describe('GPT Image uses the canvas ratio and resolution presets', () => {
  it.each([
    ['1:1', '1K', '1024x1024'],
    ['2:3', '1K', '1024x1536'],
    ['3:2', '1K', '1536x1024'],
    ['4:3', '1K', '1024x768'],
    ['3:4', '1K', '768x1024'],
    ['16:9', '1K', '1536x864'],
    ['9:16', '1K', '864x1536'],
    ['21:9', '1K', '1456x624'],
    ['9:21', '1K', '624x1456'],
    ['1:1', '2K', '2048x2048'],
    ['2:3', '2K', '1360x2048'],
    ['3:2', '2K', '2048x1360'],
    ['4:3', '2K', '2048x1536'],
    ['3:4', '2K', '1536x2048'],
    ['16:9', '2K', '2048x1152'],
    ['9:16', '2K', '1152x2048'],
    ['21:9', '2K', '2688x1152'],
    ['9:21', '2K', '1152x2688'],
    ['1:1', '4K', '2880x2880'],
    ['2:3', '4K', '2336x3520'],
    ['3:2', '4K', '3520x2336'],
    ['4:3', '4K', '3312x2480'],
    ['3:4', '4K', '2480x3312'],
    ['16:9', '4K', '3840x2160'],
    ['9:16', '4K', '2160x3840'],
    ['21:9', '4K', '3840x1648'],
    ['9:21', '4K', '1648x3840'],
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
    expect(
      validateImageSettings({ ...settings, model: 'gpt-image-2', size }, 0)
    ).toBeNull()
  })

  it.each([
    ['2016x864', '1456x624'],
    ['864x2016', '624x1456'],
    ['1904x816', '1456x624'],
    ['816x1904', '624x1456'],
  ])(
    'keeps panorama %s and adapts it to %s when 2K is withheld',
    (size, expected) => {
      const saved = { ...settings, model: 'gpt-image-2.5-sunburst', size }
      const restored = normalizeStoredImageSettings(saved)

      expect(restored.size).toBe(size)
      expect(buildImagePayload(saved).size).toBe(size)
      expect(buildImagePayload(restored).size).toBe(size)
      expect(getAllowedImageSize(size, saved.model, [])).toBe(size)
      expect(getAllowedImageSize(size, saved.model, ['2K', '4K'])).toBe(
        expected
      )
    }
  )

  it('keeps every GPT Image 1K ratio within the verified request envelope', () => {
    for (const ratio of getImageAspectRatios('gpt-image-2')) {
      const size = getImagePresetSize(ratio, '1K', 'gpt-image-2')
      const [width, height] = size.split('x').map(Number)
      expect(Math.max(width, height)).toBeLessThanOrEqual(1536)
    }
  })

  it.each([
    ['1:1', '2K', '2480x2480'],
    ['16:9', '4K', '3328x1872'],
    ['21:9', '4K', '3024x1296'],
    ['5:4', '1K', '1120x896'],
    ['4:5', '1K', '896x1120'],
    ['5:4', '2K', '2240x1792'],
    ['4:5', '2K', '1792x2240'],
    ['5:4', '2K', '2784x2224'],
    ['4:5', '2K', '2224x2784'],
  ])('classifies saved %s as %s from size %s', (ratio, resolution, size) => {
    expect(getImageSizePreset(size, 'gpt-image-2')).toEqual({
      aspectRatio: ratio,
      resolution,
    })
    const restored = normalizeStoredImageSettings({
      ...settings,
      model: 'gpt-image-2',
      size,
    })
    expect(validateImageSettings(restored, 0)).toBeNull()
    expect(buildImagePayload(restored).size).toBe(size)
  })

  it.each([
    ['4:5', '2K', '1792x2240'],
    ['5:4', '4K', '3200x2560'],
  ])(
    'retains %s at %s when a saved ratio changes resolution',
    (ratio, resolution, size) => {
      expect(
        getImagePresetSize(
          ratio as ImageAspectRatio,
          resolution as ImageResolution,
          'gpt-image-2'
        )
      ).toBe(size)
    }
  )

  it('offers the nine current canvas ratios in order', () => {
    expect([...getImageAspectRatios('gpt-image-2')]).toEqual([
      '1:1',
      '2:3',
      '3:2',
      '4:3',
      '3:4',
      '16:9',
      '9:16',
      '21:9',
      '9:21',
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
        expect(Math.max(width, height)).toBeLessThanOrEqual(3840)
      }
    }
  })
})

describe('automatic resolution keeps a model-supported ratio', () => {
  it.each([
    ['nano-banana-v2', 'gpt-image-2', '1:8', '1024x1024'],
    ['gpt-image-2', 'nano-banana-pro', '9:21', '1024x1024'],
    ['nano-banana-pro', 'gpt-image-2', '16:9', '16:9'],
    ['gpt-image-2', 'gpt-image-2.5', '4:5', '4:5'],
    ['gpt-image-2', 'gpt-image-2.5', '5:4', '5:4'],
    ['nano-banana-pro', 'gpt-image-2', '1600x1024', '1600x1024'],
  ])(
    'switching from %s to %s restores %s as the valid size %s',
    (sourceModel, model, size, expected) => {
      const next = settingsForImageModel(
        { ...settings, model: sourceModel, size },
        model
      )
      expect(next.size).toBe(expected)
      expect(validateImageSettings(next, 0)).toBeNull()
    }
  )

  it.each([
    ['gpt-image-2', '16:9', '1536x864'],
    ['gpt-image-2', '21:9', '1456x624'],
    ['gpt-image-2', '9:21', '624x1456'],
    ['gpt-image-2', '4:5', '896x1120'],
    ['gpt-image-2', '5:4', '1120x896'],
    ['nano-banana-pro', '16:9', '1360x768'],
    ['nano-banana-v2', '1:8', '368x2944'],
  ])('submits %s at automatic %s as its 1K size %s', (model, size, pixels) => {
    const next = { ...settings, model, size }
    expect(getAutomaticImageAspectRatio(size, model)).toBe(size)
    expect(resolveImageRequestSize(size, model)).toBe(pixels)
    expect(validateImageSettings(next, 0)).toBeNull()
    expect(buildImagePayload(next).size).toBe(pixels)
    const restored = normalizeStoredImageSettings(next)
    expect(restored.size).toBe(size)
    expect(buildImagePayload(restored).size).toBe(pixels)
  })

  it.each([
    ['gpt-image-1', '16:9'],
    ['gpt-image-2', '1:8'],
    ['nano-banana-pro', '9:21'],
    ['nano-banana-pro', '1:8'],
    ['gpt-image-2', '16:0'],
  ])(
    'rejects automatic %s ratio %s when the model does not offer it',
    (model, size) => {
      expect(getAutomaticImageAspectRatio(size, model)).toBeUndefined()
      expect(resolveImageRequestSize(size, model)).toBe(size)
      expect(
        validateImageSettings({ ...settings, model, size }, 0)
      ).not.toBeNull()
    }
  )

  it.each(['auto', '2480x2480'])(
    'preserves an existing size %s at the request boundary',
    (size) => {
      expect(getAutomaticImageAspectRatio(size, 'gpt-image-2')).toBeUndefined()
      expect(resolveImageRequestSize(size, 'gpt-image-2')).toBe(size)
    }
  )
})

describe('canvas resolution restrictions normalize every size representation', () => {
  it.each([
    ['2480x2480', 'gpt-image-2', ['4K'], '2480x2480'],
    ['3328x1872', 'gpt-image-2', ['4K'], '2048x1152'],
    ['2784x2224', 'gpt-image-2', ['4K'], '2784x2224'],
    ['3024x1296', 'gpt-image-2', ['4K'], '2688x1152'],
    ['auto', 'gpt-image-2', ['1K'], '2048x2048'],
    ['16:9', 'gpt-image-2', ['1K'], '2048x1152'],
    ['4:5', 'gpt-image-2', ['1K'], '1792x2240'],
    ['16:9', 'gpt-image-2', ['4K'], '1536x864'],
    ['16:9', 'nano-banana-pro', ['1K'], '2752x1536'],
    ['auto', 'nano-banana-pro', ['1K', '2K'], '4096x4096'],
    ['auto', 'gpt-image-2', [], 'auto'],
    ['16:9', 'gpt-image-2', [], '16:9'],
    ['2480x2480', 'gpt-image-2', ['1K'], '2480x2480'],
    ['1024x1024', 'dall-e-3', ['1K'], '1024x1024'],
    ['1792x1024', 'gpt-image-2', ['2K'], '1024x1024'],
    ['1536x1008', 'gpt-image-2', ['2K', '4K'], '1536x1008'],
    ['2000x1024', 'gpt-image-2', ['2K', '4K'], '1024x1024'],
    ['1024x2000', 'gpt-image-2', ['2K', '4K'], '1024x1024'],
    ['1536x1536', 'gpt-image-2', ['2K', '4K'], '1536x1536'],
    ['2001x1024', 'gpt-image-2', ['2K', '4K'], '1024x1024'],
    ['1024x2001', 'gpt-image-2', ['2K', '4K'], '1024x1024'],
    ['2800x1024', 'gpt-image-2', ['4K'], '2800x1024'],
    ['1024x2800', 'gpt-image-2', ['4K'], '1024x2800'],
    ['2801x1024', 'gpt-image-2', ['4K'], '2048x2048'],
    ['1024x2801', 'gpt-image-2', ['4K'], '2048x2048'],
  ] as const)(
    'normalizes %s on %s with %j withheld to %s',
    (size, model, withheld, expected) => {
      expect(getAllowedImageSize(size, model, withheld)).toBe(expected)
    }
  )
})

describe('a withheld tier gives way to the nearest one offered', () => {
  it.each([
    ['4K', ['4K'], '2K'],
    ['1K', ['1K', '2K'], '4K'],
    // Equally near both ways, the cheaper tier wins.
    ['2K', ['2K'], '1K'],
    ['2K', ['4K'], '2K'],
  ] as const)('moves %s withholding %j to %s', (tier, withheld, expected) => {
    expect(nearestOfferedResolution(tier, withheld)).toBe(expected)
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
  ])(
    'keeps the %s %s size distinct from the GPT Image table',
    (ratio, tier) => {
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
    }
  )

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
    for (const model of ['nano-banana-pro', 'nano-banana']) {
      expect(getImageAspectRatios(model)).not.toContain('8:1')
      expect(getImageAspectRatios(model)).not.toContain('9:21')
      expect(getImageAspectRatios(model)).toHaveLength(10)
    }
    expect(getImageAspectRatios('gpt-image-2')).not.toContain('8:1')
  })
})

describe('tag-prompted models', () => {
  const novelai = settingsForImageModel(
    {
      ...DEFAULT_IMAGE_SETTINGS,
      prompt: '1girl, fox ears',
      negativePrompt: ' lowres ',
    },
    'nai-diffusion-4-5-full'
  )

  it('sends NovelAI sampling controls in its native parameters object', () => {
    const payload = buildImagePayload({
      ...novelai,
      width: 832,
      height: 1216,
      seed: 42,
      qualityToggle: true,
      qualityTier: 'light',
      n: 2,
    })

    expect(payload).toMatchObject({
      model: 'nai-diffusion-4-5-full',
      prompt: '1girl, fox ears',
      size: '832x1216',
      n: 2,
      response_format: 'b64_json',
      group: 'default',
      nai: {
        action: 'generate',
        parameters: {
          width: 832,
          height: 1216,
          n_samples: 2,
          seed: 42,
          negative_prompt: 'lowres',
          qualityPresetId: 'light',
          tag_hint_qt: 3,
        },
      },
    })
  })

  it('leaves the NovelAI seed to the provider when none is set', () => {
    const payload = buildImagePayload({ ...novelai, seed: null })
    expect(
      (payload.nai as { parameters: Record<string, unknown> }).parameters
    ).not.toHaveProperty('seed')
  })

  it.each([
    [
      'qwen-image',
      {
        size: '1328*1328',
        negative_prompt: 'blurry',
        prompt_extend: false,
        seed: 7,
      },
      [],
    ],
    [
      'qwen-image-edit-plus',
      { negative_prompt: 'blurry', seed: 7 },
      ['size', 'prompt_extend'],
    ],
    [
      'wanx2.1-imageedit',
      { seed: 7 },
      ['size', 'negative_prompt', 'prompt_extend'],
    ],
  ])('sends only the fields %s accepts', (model, expected, absent) => {
    const payload = buildImagePayload({
      ...settingsForImageModel(
        { ...DEFAULT_IMAGE_SETTINGS, prompt: 'lanterns' },
        model
      ),
      negativePrompt: 'blurry',
      promptExtend: false,
      seed: 7,
    })

    expect(payload).toMatchObject({
      model,
      prompt: 'lanterns',
      response_format: 'b64_json',
      ...expected,
    })
    for (const field of absent) expect(payload).not.toHaveProperty(field)
  })

  it.each([
    [
      { mode: 'edit' as const },
      'This image model does not support image editing.',
    ],
    [{ width: 830 }, 'Image dimensions must be multiples of 64.'],
    [
      { width: 2048, height: 2048 },
      'The image resolution exceeds the NovelAI limit.',
    ],
    [{ n: 9 }, 'NovelAI generates up to 8 images per request.'],
  ])('rejects NovelAI settings %o', (change, message) => {
    expect(validateImageSettings({ ...novelai, ...change }, 0)).toBe(message)
    expect(STATIC_I18N_KEYS).toContain(message)
    expect(enLocale.translation).toHaveProperty([message])
  })

  it.each([
    ['qwen-image', { n: 2 }, 0, 'This model supports one image per request.'],
    ['qwen-image-2.0', { n: 7 }, 0, 'Reduce the image count for this model.'],
    [
      'qwen-image',
      { mode: 'edit' as const },
      1,
      'This image model does not support image editing.',
    ],
    [
      'qwen-image-edit',
      { mode: 'generate' as const },
      0,
      'This model edits images. Add a reference image first.',
    ],
    ['qwen-image-edit', {}, 4, 'Too many reference images for this model.'],
    [
      'qwen-image',
      { size: '1024x1024' },
      0,
      'Choose a size supported by this model.',
    ],
    [
      'wan2.7-image-pro',
      { size: '4K', mode: 'edit' as const },
      1,
      '4K is only available when generating from text.',
    ],
    [
      'qwen-image',
      { seed: 2147483648 },
      0,
      'Enter a seed between 0 and 2147483647.',
    ],
  ])(
    'holds %s to its limits: %o with %i references',
    (model, change, references, message) => {
      const next = {
        ...settingsForImageModel(
          { ...DEFAULT_IMAGE_SETTINGS, prompt: 'lanterns' },
          model
        ),
        ...change,
      }
      expect(validateImageSettings(next, references)).toBe(message)
      expect(STATIC_I18N_KEYS).toContain(message)
      expect(enLocale.translation).toHaveProperty([message])
    }
  )

  it('accepts the Alibaba models within their limits', () => {
    for (const [model, references] of [
      ['qwen-image', 0],
      ['qwen-image-edit-plus', 3],
      ['wan2.7-image-pro', 0],
      ['z-image-turbo', 0],
    ] as const) {
      const next = settingsForImageModel(
        { ...DEFAULT_IMAGE_SETTINGS, prompt: 'lanterns' },
        model
      )
      expect(validateImageSettings(next, references)).toBeNull()
    }
  })

  it('adapts the settings to the tag model that is chosen', () => {
    expect(novelai).toMatchObject({
      generationMode: 'tags',
      mode: 'generate',
      size: '832x1216',
    })
    expect(
      settingsForImageModel({ ...DEFAULT_IMAGE_SETTINGS }, 'qwen-image-edit')
        .mode
    ).toBe('edit')
    expect(
      settingsForImageModel(
        { ...DEFAULT_IMAGE_SETTINGS, mode: 'edit' },
        'wan2.6-t2i'
      )
    ).toMatchObject({ mode: 'generate', size: '1024*1024' })
    // Z-Image bills prompt rewriting as a second image.
    expect(
      settingsForImageModel(
        { ...DEFAULT_IMAGE_SETTINGS, model: 'qwen-image', promptExtend: true },
        'z-image-turbo'
      ).promptExtend
    ).toBe(false)
    expect(settingsForImageModel(novelai, 'gpt-image-1').generationMode).toBe(
      'description'
    )
  })

  it('stores tag settings only on images prompted with tags', () => {
    const description = normalizeStoredImageSettings({
      ...DEFAULT_IMAGE_SETTINGS,
      model: 'gpt-image-1',
      prompt: 'A blue ceramic cup',
    })
    const tags = normalizeStoredImageSettings({ ...novelai, seed: 42 })

    for (const field of ['generationMode', 'negativePrompt', 'seed', 'steps']) {
      expect(description).not.toHaveProperty(field)
    }
    expect(tags).toMatchObject({
      generationMode: 'tags',
      negativePrompt: ' lowres ',
      seed: 42,
      steps: 28,
    })
  })
})

describe('Reference mentions at the request boundary', () => {
  // A retry sends a canvas image's own prompt, which only Reuse prompt and
  // settings can edit, so the message names both ways out.
  const MENTION_ERROR =
    "The prompt mentions a reference image that this request does not send. Remove the mention or insert the image again; to change a canvas image's prompt, use Reuse prompt and settings."
  const edit = { ...settings, mode: 'edit' as const }

  it('rejects an unbound mention before the request is sent', () => {
    expect(
      validateImageSettings(
        { ...edit, prompt: '把@? (B.png)的角色放进@1 (A.png)' },
        1
      )
    ).toBe(MENTION_ERROR)
  })

  it('rejects a mention numbered past the references an edit sends', () => {
    expect(
      validateImageSettings({ ...edit, prompt: '@1 (A.png) 和 @2 (B.png)' }, 1)
    ).toBe(MENTION_ERROR)
  })

  it('rejects mentions when text-to-image sends no references', () => {
    expect(
      validateImageSettings({ ...settings, prompt: '参考 @1 (A.png)' }, 1)
    ).toBe(MENTION_ERROR)
  })

  it('accepts mentions of every reference an edit sends', () => {
    expect(
      validateImageSettings({ ...edit, prompt: '@1 (A.png) 和 @2 (B.png)' }, 2)
    ).toBeNull()
  })

  // Returned as a plain string, so only the static key registry carries it to
  // the locale files.
  it('registers the mention message for translation', () => {
    const message = validateImageSettings({ ...edit, prompt: '@? (B.png)' }, 1)

    expect(STATIC_I18N_KEYS).toContain(message)
    expect(enLocale.translation).toHaveProperty([message as string])
  })
})

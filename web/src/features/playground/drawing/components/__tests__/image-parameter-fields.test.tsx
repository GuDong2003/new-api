import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import i18next, { createInstance } from 'i18next'
import { FormProvider, useForm } from 'react-hook-form'
import { initReactI18next, I18nextProvider, setI18n } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDrawingStore } from '@/stores/drawing-store'

import {
  buildImagePayload,
  DEFAULT_IMAGE_SETTINGS,
  settingsForImageModel,
} from '../../lib/image-settings'
import type { ImageSettings } from '../../types'
import { DrawingSettings } from '../DrawingSettings'
import { ImageParameterFields } from '../ImageParameterFields'

const zhTranslations = {
  'Image quality': '图片质量',
  Low: '低',
  'Image output format': '输出格式',
  'Image background': '背景',
  Transparent: '透明',
}

function ParameterFieldsWithChinese() {
  const form = useForm<ImageSettings>({
    defaultValues: { ...DEFAULT_IMAGE_SETTINGS, model: 'gpt-image-1' },
  })
  return (
    <FormProvider {...form}>
      <ImageParameterFields />
    </FormProvider>
  )
}

function ResolutionForm(props: {
  settings?: Partial<ImageSettings>
  onSubmit?: (payload: ReturnType<typeof buildImagePayload>) => void
}) {
  // Mirror production, where picking a model runs its settings through
  // settingsForImageModel before the form ever sees them.
  const form = useForm<ImageSettings>({
    defaultValues: settingsForImageModel(
      { ...DEFAULT_IMAGE_SETTINGS, ...props.settings },
      props.settings?.model ?? 'gpt-image-2.5'
    ),
  })
  return (
    <FormProvider {...form}>
      <form
        onSubmit={form.handleSubmit((settings) =>
          props.onSubmit?.(buildImagePayload(settings))
        )}
      >
        <ImageParameterFields />
        <button type='submit'>Generate</button>
      </form>
    </FormProvider>
  )
}

describe('Image parameter fields', () => {
  afterEach(() => setI18n(i18next))
  it('renders image labels and options using the active locale', async () => {
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'zh',
      fallbackLng: 'zh',
      resources: { zh: { translation: zhTranslations } },
    })

    render(
      <I18nextProvider i18n={i18n}>
        <ParameterFieldsWithChinese />
      </I18nextProvider>
    )

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Advanced settings' }))
    const quality = screen.getByLabelText('图片质量')
    expect(quality).toBeVisible()
    expect(within(quality).getByRole('option', { name: '低' })).toBeVisible()
    expect(screen.getByLabelText('输出格式')).toBeVisible()
    expect(screen.getByLabelText('背景')).toBeVisible()
    expect(screen.getByRole('option', { name: '透明' })).toBeVisible()
  })

  // GPT Image keeps the OpenAI meaning of the two fields: the resolution comes
  // from the size and the ladder is how finely that size is rendered.
  it('offers the resolution toggles and the quality ladder together', () => {
    render(<ResolutionForm />)
    expect(screen.getByLabelText('Image quality')).toBeVisible()
    expect(
      screen.getByRole('group', { name: 'Image resolution' })
    ).toBeVisible()
  })

  it('changes only the size when the resolution changes', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm settings={{ quality: 'max' }} onSubmit={onSubmit} />)
    const user = userEvent.setup()
    await user.click(
      within(screen.getByRole('group', { name: 'Image resolution' })).getByRole(
        'button',
        { name: '4K' }
      )
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 'max', size: '2480x2480' })
    )
  })

  // A count that can only be one, or a ladder a model does not define, is a
  // control that cannot do anything, so the panel leaves it out.
  it.each(['gpt-image-2.5', 'nano-banana-pro', 'dall-e-3'])(
    'hides the image count on %s, which returns one',
    (model) => {
      render(<ResolutionForm settings={{ model }} />)
      expect(screen.queryByLabelText('Image count')).toBeNull()
    }
  )

  it.each(['gpt-image-1', 'dall-e-2'])(
    'keeps the image count on %s, which returns a batch',
    (model) => {
      render(<ResolutionForm settings={{ model }} />)
      expect(screen.getByLabelText('Image count')).toBeVisible()
    }
  )

  it('offers streaming previews on Nano Banana', async () => {
    render(<ResolutionForm settings={{ model: 'nano-banana-pro' }} />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Advanced settings' }))

    expect(screen.getByLabelText('Stream image previews')).toBeVisible()
    expect(screen.queryByLabelText('User identifier')).toBeNull()
  })

  it('keeps the OpenAI quality ladder for GPT Image 1', () => {
    render(<ResolutionForm settings={{ model: 'gpt-image-1' }} />)
    const quality = screen.getByLabelText('Image quality')
    expect(
      within(quality).queryByRole('option', { name: 'Maximum' })
    ).toBeNull()
    expect(
      within(quality)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Auto', 'High', 'Medium', 'Low'])
  })

  it('starts with a 1K square and does not deselect an active preset', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const square = screen.getByRole('button', { name: '1:1' })
    expect(square).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '1K' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(
      screen.getByRole('group', { name: 'Image aspect ratio' })
    ).toHaveClass('grid-cols-4')
    await userEvent.setup().click(square)
    expect(square).toHaveAttribute('aria-pressed', 'true')
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ size: '1024x1024' })
    )
  })

  it.each([
    ['2:3', '1024x1536'],
    ['3:2', '1536x1024'],
    ['3:4', '864x1152'],
    ['4:3', '1152x864'],
    ['9:16', '720x1280'],
    ['16:9', '1280x720'],
  ])('submits the 1K %s preset as %s', async (ratio, size) => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: ratio }))
    expect(screen.getByRole('status')).toHaveTextContent(
      size.replace('x', ' × ')
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ size }))
  })

  it('keeps the selected ratio when changing resolution with the keyboard', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '16:9' }))
    const resolution = screen.getByRole('button', { name: '1K' })
    resolution.focus()
    await user.keyboard('{ArrowRight} ')
    expect(screen.getByRole('button', { name: '2K' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('status')).toHaveTextContent('2560 × 1440')
    await user.click(screen.getByRole('button', { name: '4K' }))
    expect(screen.getByRole('status')).toHaveTextContent('3328 × 1872')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ size: '3328x1872' })
    )
  })

  it('hides the automatic ratio for a model that falls back to 1:1', () => {
    render(<ResolutionForm />)
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull()
  })

  it('keeps fixed-size model options selectable without offering unsupported 4K', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ model: 'dall-e-3', size: '1792x1024' }}
        onSubmit={onSubmit}
      />
    )
    const size = screen.getByLabelText('Image size')
    expect(size).toHaveValue('1792x1024')
    // The tier row stays on screen but cannot be used to change the size.
    expect(screen.getByRole('button', { name: '4K' })).toBeDisabled()
    const user = userEvent.setup()
    await user.selectOptions(size, '1024x1792')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ size: '1024x1792' })
    )
  })

  it('retains a selected resolution after editing another setting and reopening the settings panel', async () => {
    useDrawingStore.getState().initialize(914)
    useDrawingStore.getState().hydrate(null)
    useDrawingStore.getState().updateSettings({ model: 'gpt-image-2.5' })
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    client.setQueryData(
      ['drawing-groups', 914],
      [{ value: 'default', label: 'default', ratio: 1 }]
    )
    client.setQueryData(
      ['drawing-models', 914, 'default'],
      [{ value: 'gpt-image-2.5', label: 'gpt-image-2.5' }]
    )
    const panel = (
      <QueryClientProvider client={client}>
        <DrawingSettings
          userId={914}
          pendingCount={0}
          onGenerate={vi.fn()}
          onCancel={vi.fn()}
          onUploadReferences={vi.fn()}
          onMaskUpload={vi.fn()}
          onClearMask={vi.fn()}
          onDrawMask={vi.fn()}
        />
      </QueryClientProvider>
    )
    const first = render(panel)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '16:9' }))
    await user.click(screen.getByRole('button', { name: '4K' }))
    expect(useDrawingStore.getState().settings.size).toBe('3328x1872')
    await user.selectOptions(
      screen.getByLabelText('Image output format'),
      'webp'
    )
    first.unmount()

    const reopened = render(panel)
    expect(screen.getByRole('button', { name: '16:9' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: '4K' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('status')).toHaveTextContent('3328 × 1872')
    reopened.unmount()
    client.clear()
    useDrawingStore.getState().initialize(914)
  })
})

describe('Grok NSFW switch', () => {
  it('submits nsfw true after the switch is turned on for a Grok model', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ model: 'grok-imagine-image-2.0' }}
        onSubmit={onSubmit}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Advanced settings' }))

    const nsfw = screen.getByRole('switch', { name: 'Allow NSFW content' })
    expect(nsfw).toHaveAttribute('aria-checked', 'false')

    await user.click(nsfw)
    expect(nsfw).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ nsfw: true })
    )
  })

  it('hides the switch for a model that is not Grok', async () => {
    render(<ResolutionForm settings={{ model: 'gpt-image-2.5' }} />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Advanced settings' }))
    expect(
      screen.queryByRole('switch', { name: 'Allow NSFW content' })
    ).toBeNull()
  })
})

describe('Nano Banana size controls', () => {
  const nano = { model: 'gemini-3-pro-image-preview' as const }

  it('offers the aspect ratio and resolution toggles like GPT Image does', () => {
    render(<ResolutionForm settings={nano} />)
    expect(
      screen.getByRole('group', { name: 'Image aspect ratio' })
    ).toBeVisible()
    expect(
      screen.getByRole('group', { name: 'Image resolution' })
    ).toBeVisible()
  })

  it('omits the custom size option for a model without free-form sizes', () => {
    render(<ResolutionForm settings={nano} />)
    expect(
      within(
        screen.getByRole('group', { name: 'Image resolution' })
      ).queryByRole('button', { name: 'Custom' })
    ).toBeNull()
  })

  // The provider reads the ratio from the pixel size and renders at its own
  // native resolution for that tier, so the tier rides along in the size.
  // Nano Banana has its own size table; the GPT Image 16:9 2K size (2560x1440)
  // would be rejected upstream.
  it('submits preset pixels for the chosen ratio and tier', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm settings={nano} onSubmit={onSubmit} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '16:9' }))
    await user.click(
      within(screen.getByRole('group', { name: 'Image resolution' })).getByRole(
        'button',
        { name: '2K' }
      )
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ size: '2752x1536' })
    )
  })

  // `auto` takes its ratio from the reference image, and the provider rejects
  // it outright for text-to-image.
  it('hides the automatic ratio until a reference image is being edited', () => {
    render(<ResolutionForm settings={{ ...nano, mode: 'generate' }} />)
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull()
  })

  it('offers the automatic ratio while editing a reference image', () => {
    render(<ResolutionForm settings={{ ...nano, mode: 'edit' }} />)
    expect(screen.getByRole('button', { name: 'Auto' })).toBeVisible()
  })
})

describe('the resolution tiers stay on screen for every model', () => {
  it.each([
    ['dall-e-3', '1024x1024', '1K'],
    ['dall-e-3', '1792x1024', '2K'],
    ['black-forest-labs/flux-1.1-pro', '1024x1024', '1K'],
    ['gpt-image-1', '1024x1024', '1K'],
  ])('shows %s at %s as a locked %s tier', (model, size, tier) => {
    render(<ResolutionForm settings={{ model, size }} />)
    const tiers = screen.getByRole('group', { name: 'Image resolution' })
    for (const step of ['1K', '2K', '4K']) {
      const button = within(tiers).getByRole('button', { name: step })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute(
        'aria-pressed',
        step === tier ? 'true' : 'false'
      )
    }
  })

  it('still offers the exact sizes the model supports', () => {
    render(<ResolutionForm settings={{ model: 'dall-e-3' }} />)
    const sizes = screen.getByLabelText('Image size')
    expect(
      within(sizes)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['1024 × 1024', '1792 × 1024', '1024 × 1792'])
  })

  it('keeps the tiers selectable for a model that bills by tier', () => {
    render(<ResolutionForm />)
    const tiers = screen.getByRole('group', { name: 'Image resolution' })
    expect(within(tiers).getByRole('button', { name: '4K' })).toBeEnabled()
  })
})

describe('custom pixel dimensions are gone', () => {
  // Verified against the provider: an exact size is discarded and the model
  // renders at its own size for the tier, so free-form pixels promised control
  // that never existed.
  it.each(['gpt-image-2.5', 'gpt-image-2', 'gemini-3-pro-image-preview'])(
    'offers only ratios and tiers for %s',
    (model) => {
      render(<ResolutionForm settings={{ model }} />)
      const tiers = screen.getByRole('group', { name: 'Image resolution' })
      expect(within(tiers).queryByRole('button', { name: 'Custom' })).toBeNull()
      expect(screen.queryByLabelText('Width')).toBeNull()
      expect(screen.queryByLabelText('Height')).toBeNull()
      for (const step of ['1K', '2K', '4K']) {
        expect(within(tiers).getByRole('button', { name: step })).toBeEnabled()
      }
    }
  )
})

describe('the published ultrawide and 5:4 ratios are offered', () => {
  it('renders every ratio the provider publishes', () => {
    render(<ResolutionForm />)
    const ratios = screen.getByRole('group', { name: 'Image aspect ratio' })
    for (const ratio of ['1:1', '4:5', '5:4', '16:9', '21:9']) {
      expect(within(ratios).getByRole('button', { name: ratio })).toBeVisible()
    }
  })

  it.each([
    ['21:9', '1K', '1456x624'],
    ['5:4', '2K', '2240x1792'],
    ['4:5', '4K', '2224x2784'],
  ])('submits %s at %s as %s', async (ratio, tier, size) => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const user = userEvent.setup()
    await user.click(
      within(screen.getByRole('group', { name: 'Image resolution' })).getByRole(
        'button',
        { name: tier }
      )
    )
    await user.click(
      within(
        screen.getByRole('group', { name: 'Image aspect ratio' })
      ).getByRole('button', { name: ratio })
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      // Quality is untouched by the tier: it is a separate control.
      expect.objectContaining({ size })
    )
  })
})

describe('the tier row fills its grid', () => {
  it.each(['gpt-image-2.5', 'gemini-3-pro-image-preview', 'dall-e-3'])(
    'lays the three tiers out in three columns for %s',
    (model) => {
      render(<ResolutionForm settings={{ model }} />)
      const tiers = screen.getByRole('group', { name: 'Image resolution' })
      expect(tiers).toHaveClass('grid-cols-3')
      expect(within(tiers).getAllByRole('button')).toHaveLength(3)
    }
  )
})

describe('the model selector groups by vendor', () => {
  it('labels each vendor and lists its image models under it', async () => {
    useDrawingStore.getState().initialize(915)
    useDrawingStore.getState().hydrate(null)
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    client.setQueryData(
      ['drawing-groups', 915],
      [{ value: 'default', label: 'default', ratio: 1 }]
    )
    client.setQueryData(
      ['drawing-models', 915, 'default'],
      [
        { value: 'gpt-image-2', label: 'gpt-image-2' },
        { value: 'dall-e-3', label: 'dall-e-3' },
        { value: 'nano-banana-pro', label: 'nano-banana-pro' },
        { value: 'grok-imagine-image-2.0', label: 'grok-imagine-image-2.0' },
      ]
    )
    const view = render(
      <QueryClientProvider client={client}>
        <DrawingSettings
          userId={915}
          pendingCount={0}
          onGenerate={vi.fn()}
          onCancel={vi.fn()}
          onUploadReferences={vi.fn()}
          onMaskUpload={vi.fn()}
          onClearMask={vi.fn()}
          onDrawMask={vi.fn()}
        />
      </QueryClientProvider>
    )
    await userEvent
      .setup()
      .click(screen.getByPlaceholderText('Search models...'))

    for (const vendor of ['OpenAI', 'Gemini', 'xAI']) {
      expect(screen.getByText(vendor)).toBeVisible()
    }
    const openai = screen
      .getByText('OpenAI')
      .closest('[data-slot="combobox-group"]') as HTMLElement
    expect(within(openai).getByText('gpt-image-2')).toBeVisible()
    expect(within(openai).getByText('dall-e-3')).toBeVisible()
    expect(within(openai).queryByText('nano-banana-pro')).toBeNull()

    view.unmount()
    client.clear()
    useDrawingStore.getState().initialize(915)
  })
})

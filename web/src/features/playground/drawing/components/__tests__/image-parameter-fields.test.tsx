import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
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
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import enLocale from '@/i18n/locales/en.json'
import zhLocale from '@/i18n/locales/zh.json'
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
  Auto: '自动',
  Low: '低',
  Medium: '中',
  High: '高',
  'Extra high': '极高',
  Maximum: '最高',
  'Image output format': '输出格式',
  'Image background': '背景',
  'Transparent background': '透明背景',
  'Image moderation': '内容审核',
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
  disabledResolutions?: string[]
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
        <ImageParameterFields disabledResolutions={props.disabledResolutions} />
        <button type='submit'>Generate</button>
      </form>
    </FormProvider>
  )
}

describe('Image parameter fields', () => {
  afterEach(() => setI18n(i18next))
  it('offers GIF timing on 2.6 and removes animation-only controls for PNG', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ model: 'gpt-image-2.6' }}
        onSubmit={onSubmit}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'GIF' }))
    const frames = screen.getByRole('spinbutton', { name: 'GIF frame count' })
    const duration = screen.getByRole('spinbutton', {
      name: 'Frame duration (ms)',
    })
    expect(frames).toHaveValue(9)
    expect(duration).toHaveValue(200)
    expect(frames).toHaveAccessibleDescription(
      'Frame count, frame duration and dimensions are request values. The provider may return different animation settings.'
    )
    expect(duration).toHaveAccessibleDescription(
      'Frame count, frame duration and dimensions are request values. The provider may return different animation settings.'
    )
    expect(
      screen.getByRole('group', { name: 'Image output format' })
    ).toHaveAccessibleDescription(
      'GPT Image 2.6 offers PNG, JPEG, WebP and GIF output. GIF availability depends on the model and provider.'
    )
    expect(
      screen.getByText(
        'Preview or download the original GIF to view the animation. Thumbnails may show a still frame.'
      )
    ).toBeVisible()
    expect(
      screen.queryByRole('spinbutton', { name: 'Output compression' })
    ).not.toBeInTheDocument()
    await user.clear(frames)
    await user.type(frames, '12')
    await user.clear(duration)
    await user.type(duration, '120')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        output_format: 'gif',
        frame_count: 12,
        frame_duration_ms: 120,
      })
    )
    expect(onSubmit.mock.lastCall?.[0]).not.toHaveProperty('output_compression')
    await user.click(screen.getByRole('button', { name: 'PNG' }))
    expect(
      screen.queryByRole('spinbutton', { name: 'GIF frame count' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'Frame count, frame duration and dimensions are request values. The provider may return different animation settings.'
      )
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit.mock.lastCall?.[0]).not.toHaveProperty('frame_count')
  })

  it('keeps GIF unavailable on a 2.5 model', () => {
    render(<ResolutionForm settings={{ model: 'gpt-image-2.5' }} />)
    expect(
      screen.queryByRole('button', { name: 'GIF' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: 'Image output format' })
    ).not.toHaveAccessibleDescription()
  })

  it('updates GIF request guidance when the interface language changes', async () => {
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'zhCN',
      fallbackLng: 'en',
      resources: { en: enLocale, zhCN: zhLocale },
    })
    render(
      <I18nextProvider i18n={i18n}>
        <ResolutionForm
          settings={{ model: 'gpt-image-2.6', outputFormat: 'gif' }}
        />
      </I18nextProvider>
    )
    const frames = screen.getByRole('spinbutton', { name: 'GIF 帧数' })
    expect(frames).toHaveAccessibleDescription(
      '帧数、每帧时长和画面尺寸都是请求值，上游实际返回的动画参数可能不同。'
    )
    await act(() => i18n.changeLanguage('en'))
    expect(frames).toHaveAccessibleDescription(
      'Frame count, frame duration and dimensions are request values. The provider may return different animation settings.'
    )
  })

  it('keeps transparency enabled when selecting GIF and submits both choices', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ model: 'gpt-image-2.6', background: 'transparent' }}
        onSubmit={onSubmit}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'GIF' }))
    expect(
      screen.getByRole('switch', { name: 'Transparent background' })
    ).toBeChecked()
    expect(screen.getByRole('button', { name: 'GIF' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        background: 'transparent',
        output_format: 'gif',
        frame_count: 9,
        frame_duration_ms: 200,
      })
    )
  })

  it('keeps GIF and its timing controls when toggling transparency', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ model: 'gpt-image-2.6', outputFormat: 'gif' }}
        onSubmit={onSubmit}
      />
    )
    const user = userEvent.setup()
    const background = screen.getByRole('switch', {
      name: 'Transparent background',
    })
    await user.click(background)
    expect(background).toBeChecked()
    expect(screen.getByRole('button', { name: 'GIF' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(
      screen.getByRole('spinbutton', { name: 'GIF frame count' })
    ).toHaveValue(9)
    expect(background).toHaveAccessibleDescription(
      'Transparent GIF availability depends on the upstream provider.'
    )
    await user.click(background)
    expect(
      screen.getByRole('spinbutton', { name: 'GIF frame count' })
    ).toHaveValue(9)
    expect(background).not.toHaveAccessibleDescription()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ background: 'opaque', output_format: 'gif' })
    )
  })

  it('renders image labels and options using the active locale', async () => {
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'zh',
      fallbackLng: 'en',
      resources: { zh: { translation: zhTranslations } },
    })

    render(
      <I18nextProvider i18n={i18n}>
        <ParameterFieldsWithChinese />
      </I18nextProvider>
    )

    const quality = screen.getByLabelText('图片质量')
    expect(quality).toBeVisible()
    expect(
      within(quality)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['自动', '低', '中', '高', '极高', '最高'])
    expect(screen.getByLabelText('输出格式')).toBeVisible()
    expect(screen.getByRole('switch', { name: '透明背景' })).toBeVisible()
    expect(
      within(screen.getByRole('group', { name: '内容审核' }))
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['自动', '低'])
    await act(() => i18n.changeLanguage('en'))
    expect(
      within(screen.getByRole('group', { name: 'Image quality' })).getByRole(
        'button',
        { name: 'Low' }
      )
    ).toBeVisible()
  })

  // GPT Image keeps the OpenAI meaning of the two fields: the resolution comes
  // from the size and the ladder is how finely that size is rendered.
  it('offers the resolution toggles and the quality ladder together', () => {
    render(<ResolutionForm />)
    const quality = screen.getByRole('group', { name: 'Image quality' })
    expect(quality).toBeVisible()
    expect(
      within(quality)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Auto', 'Low', 'Medium', 'High', 'Extra high', 'Maximum'])
    expect(
      quality.compareDocumentPosition(
        screen.getByRole('group', { name: 'Image aspect ratio' })
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen.getByRole('group', { name: 'Image resolution' })
    ).toBeVisible()
  })

  it.each([
    ['Auto', 'auto'],
    ['Low', 'low'],
    ['Medium', 'medium'],
    ['High', 'high'],
    ['Extra high', 'xhigh'],
    ['Maximum', 'max'],
  ])(
    'submits %s quality as %s without changing the size',
    async (label, value) => {
      const onSubmit = vi.fn()
      render(<ResolutionForm onSubmit={onSubmit} />)
      const user = userEvent.setup()
      const quality = screen.getByRole('group', { name: 'Image quality' })
      const option = within(quality).getByRole('button', { name: label })
      await user.click(option)
      expect(option).toHaveAttribute('aria-pressed', 'true')
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ quality: value, size: '1024x1024' })
      )
    }
  )

  it('selects quality with the keyboard and keeps an active selection when clicked again', async () => {
    render(<ResolutionForm />)
    const user = userEvent.setup()
    const quality = screen.getByRole('group', { name: 'Image quality' })
    within(quality).getByRole('button', { name: 'Auto' }).focus()
    await user.keyboard('{ArrowRight} ')
    const low = within(quality).getByRole('button', { name: 'Low' })
    expect(low).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(quality).getByRole('button', { name: 'Auto' })
    ).toHaveAttribute('aria-pressed', 'false')
    await user.click(low)
    expect(low).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the standard and HD options for DALL-E instead of sending GPT quality values', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm settings={{ model: 'dall-e-3' }} onSubmit={onSubmit} />
    )
    const quality = screen.getByRole('group', { name: 'Image quality' })
    expect(
      within(quality)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Standard', 'High definition'])
    await userEvent.click(
      within(quality).getByRole('button', { name: 'High definition' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 'hd' })
    )
  })

  it('omits quality controls and the request field for a model without quality settings', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ model: 'nano-banana-pro' }}
        onSubmit={onSubmit}
      />
    )
    expect(screen.queryByRole('group', { name: 'Image quality' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('quality')
  })

  it('restores saved quality, saves changes immediately, and resets unsupported quality when switching models', async () => {
    const store = useDrawingStore.getState()
    store.initialize(916)
    store.hydrate(null)
    store.updateSettings({ model: 'gpt-image-2', quality: 'xhigh' })
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    client.setQueryData(
      ['drawing-groups', 916],
      [{ value: 'default', label: 'default', ratio: 1 }]
    )
    client.setQueryData(
      ['drawing-models', 916, 'default'],
      [
        { value: 'gpt-image-2', label: 'gpt-image-2' },
        { value: 'gpt-image-1', label: 'gpt-image-1' },
      ]
    )
    client.setQueryData(['canvas-setting', 916], {
      default_model: '',
      disabled_resolutions: [],
    })
    const view = render(
      <QueryClientProvider client={client}>
        <DrawingSettings
          userId={916}
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
    const quality = screen.getByRole('group', { name: 'Image quality' })
    expect(
      screen
        .getByRole('button', { name: 'Upload reference images' })
        .compareDocumentPosition(quality) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      within(quality).getByRole('button', { name: 'Extra high' })
    ).toHaveAttribute('aria-pressed', 'true')
    const user = userEvent.setup()
    await user.click(within(quality).getByRole('button', { name: 'Maximum' }))
    expect(useDrawingStore.getState().settings.quality).toBe('max')
    await user.click(screen.getByPlaceholderText('Search models...'))
    await user.click(screen.getByRole('option', { name: 'gpt-image-1' }))
    expect(useDrawingStore.getState().settings.quality).toBe('auto')
    expect(
      within(quality).getByRole('button', { name: 'Auto' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(quality).getByRole('button', { name: 'Maximum' })
    ).toBeDisabled()
    view.unmount()
    client.clear()
    useDrawingStore.getState().initialize(916)
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
      expect.objectContaining({ quality: 'max', size: '2880x2880' })
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

  it.each(['gpt-image-1', 'gpt-image-2', 'nano-banana-pro'])(
    'removes retired streaming and user controls without leaving an empty advanced section for %s',
    (model) => {
      const legacy = {
        model,
        stream: true,
        partialImages: 2,
        user: 'saved-user',
      }
      render(<ResolutionForm settings={legacy} />)
      expect(screen.queryByLabelText('Stream image previews')).toBeNull()
      expect(screen.queryByLabelText('Partial images')).toBeNull()
      expect(screen.queryByLabelText('User identifier')).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Advanced settings' })
      ).toBeNull()
    }
  )

  it('disables unsupported GPT Image 1 quality levels without changing the selected quality', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm settings={{ model: 'gpt-image-1' }} onSubmit={onSubmit} />
    )
    const quality = screen.getByRole('group', { name: 'Image quality' })
    for (const label of ['Auto', 'Low', 'Medium', 'High']) {
      expect(within(quality).getByRole('button', { name: label })).toBeEnabled()
    }
    for (const label of ['Extra high', 'Maximum']) {
      const option = within(quality).getByRole('button', { name: label })
      expect(option).toBeDisabled()
      await userEvent.click(option)
    }
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 'auto' })
    )
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
    ['3:4', '768x1024'],
    ['4:3', '1024x768'],
    ['9:16', '864x1536'],
    ['16:9', '1536x864'],
  ])('submits the 1K %s preset as %s', async (ratio, size) => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: ratio }))
    expect(screen.queryByRole('status')).toBeNull()
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
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: '2048x1152' })
    )
    await user.click(screen.getByRole('button', { name: '4K' }))
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ size: '3840x2160' })
    )
  })

  it('selects the nearest ratio for a saved custom size and lets the user select a square', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm settings={{ size: '1792x1024' }} onSubmit={onSubmit} />
    )
    const ratios = screen.getByRole('group', { name: 'Image aspect ratio' })
    expect(
      within(ratios).getByRole('button', { name: '16:9' })
    ).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(within(ratios).getByRole('button', { name: '1:1' }))
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ size: '2048x2048' })
    )
  })

  it('places resolution above aspect ratio and offers automatic sizing without a pixel readout', () => {
    render(<ResolutionForm />)
    const tiers = screen.getByRole('group', { name: 'Image resolution' })
    const ratios = screen.getByRole('group', { name: 'Image aspect ratio' })
    expect(
      tiers.compareDocumentPosition(ratios) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      within(tiers)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['1K', '2K', '4K', 'Auto'])
    expect(within(ratios).getByRole('button', { name: 'Auto' })).toBeEnabled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('retains the ratio for automatic resolution and restores a square when leaving fully automatic sizing', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const user = userEvent.setup()
    const tiers = screen.getByRole('group', { name: 'Image resolution' })
    const ratios = screen.getByRole('group', { name: 'Image aspect ratio' })
    await user.click(within(ratios).getByRole('button', { name: '16:9' }))
    await user.click(within(tiers).getByRole('button', { name: 'Auto' }))
    expect(
      within(ratios).getByRole('button', { name: '16:9' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(within(tiers).getByRole('button', { name: 'Auto' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: '1536x864' })
    )
    await user.click(within(ratios).getByRole('button', { name: 'Auto' }))
    expect(within(tiers).getByRole('button', { name: 'Auto' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: 'auto' })
    )
    await user.click(within(tiers).getByRole('button', { name: '2K' }))
    expect(within(ratios).getByRole('button', { name: '1:1' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: '2048x2048' })
    )
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
    expect(screen.getByLabelText('Image style')).toBeVisible()
    await user.selectOptions(screen.getByLabelText('Image style'), 'natural')
    await user.selectOptions(size, '1024x1792')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ size: '1024x1792', style: 'natural' })
    )
  })

  it('retains size, output, and moderation settings after reopening the settings panel', async () => {
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
    client.setQueryData(['canvas-setting', 914], {
      default_model: '',
      disabled_resolutions: [],
    })
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
    expect(useDrawingStore.getState().settings.size).toBe('3840x2160')
    await user.click(
      within(
        screen.getByRole('group', { name: 'Image output format' })
      ).getByRole('button', { name: 'WebP' })
    )
    expect(useDrawingStore.getState().settings.outputFormat).toBe('webp')
    await user.click(
      screen.getByRole('switch', { name: 'Transparent background' })
    )
    expect(useDrawingStore.getState().settings).toMatchObject({
      background: 'transparent',
      outputFormat: 'webp',
    })
    await user.click(
      within(screen.getByRole('group', { name: 'Image moderation' })).getByRole(
        'button',
        { name: 'Low' }
      )
    )
    expect(useDrawingStore.getState().settings.moderation).toBe('low')
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
    expect(useDrawingStore.getState().settings.size).toBe('3840x2160')
    expect(
      screen.getByRole('switch', { name: 'Transparent background' })
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      within(
        screen.getByRole('group', { name: 'Image output format' })
      ).getByRole('button', { name: 'WebP' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(screen.getByRole('group', { name: 'Image moderation' })).getByRole(
        'button',
        { name: 'Low' }
      )
    ).toHaveAttribute('aria-pressed', 'true')
    reopened.unmount()
    client.clear()
    useDrawingStore.getState().initialize(914)
  })
})

describe('Image moderation', () => {
  it('shows image editing options directly before moderation and submits their selected values', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ mode: 'edit', outputFormat: 'webp' }}
        onSubmit={onSubmit}
      />
    )
    const compression = screen.getByLabelText('Output compression')
    const fidelity = screen.getByLabelText('Image input fidelity')
    expect(compression).toBeVisible()
    expect(fidelity).toBeVisible()
    const moderation = screen.getByRole('group', { name: 'Image moderation' })
    expect(moderation).toBeVisible()
    expect(
      within(moderation)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Auto', 'Low'])
    expect(
      within(moderation).getByRole('button', { name: 'Auto' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen
        .getByRole('group', { name: 'Image output format' })
        .compareDocumentPosition(moderation) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      fidelity.compareDocumentPosition(moderation) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Advanced settings' })
    ).toBeNull()
    const user = userEvent.setup()
    await user.clear(compression)
    await user.type(compression, '0')
    await user.selectOptions(fidelity, 'high')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        moderation: 'auto',
        output_compression: 0,
        input_fidelity: 'high',
      })
    )
  })

  it('selects low moderation with the keyboard without allowing the current choice to be cleared', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const user = userEvent.setup()
    const moderation = screen.getByRole('group', { name: 'Image moderation' })
    within(moderation).getByRole('button', { name: 'Auto' }).focus()
    await user.keyboard('{ArrowRight} ')
    const low = within(moderation).getByRole('button', { name: 'Low' })
    expect(low).toHaveAttribute('aria-pressed', 'true')
    await user.click(low)
    expect(low).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        moderation: 'low',
        quality: 'auto',
        output_format: 'png',
      })
    )
  })

  it.each(['dall-e-3', 'nano-banana-pro'])(
    'does not offer or send unsupported moderation on %s',
    async (model) => {
      const onSubmit = vi.fn()
      render(<ResolutionForm settings={{ model }} onSubmit={onSubmit} />)
      expect(
        screen.queryByRole('group', { name: 'Image moderation' })
      ).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
      expect(onSubmit).toHaveBeenCalledOnce()
      expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('moderation')
    }
  )
})

describe('Image background and output format', () => {
  it('shows independent background and format controls after the ratio and starts with opaque PNG', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const background = screen.getByRole('switch', {
      name: 'Transparent background',
    })
    const format = screen.getByRole('group', { name: 'Image output format' })
    expect(background).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByLabelText('Output compression')).toBeNull()
    expect(screen.queryByLabelText('Image input fidelity')).toBeNull()
    expect(
      within(format)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['PNG', 'JPEG', 'WebP'])
    expect(within(format).getByRole('button', { name: 'PNG' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(
      screen
        .getByRole('group', { name: 'Image aspect ratio' })
        .compareDocumentPosition(background) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      background.compareDocumentPosition(format) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ background: 'opaque', output_format: 'png' })
    )
  })

  it.each([
    ['PNG', 'png'],
    ['JPEG', 'jpeg'],
    ['WebP', 'webp'],
  ])(
    'allows opaque %s without enabling transparency',
    async (label, outputFormat) => {
      const onSubmit = vi.fn()
      render(<ResolutionForm onSubmit={onSubmit} />)
      await userEvent.click(
        within(
          screen.getByRole('group', { name: 'Image output format' })
        ).getByRole('button', { name: label })
      )
      expect(
        screen.getByRole('switch', { name: 'Transparent background' })
      ).toHaveAttribute('aria-checked', 'false')
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          background: 'opaque',
          output_format: outputFormat,
        })
      )
    }
  )

  it('switches JPEG to PNG when transparency is enabled and keeps PNG when transparency is turned off', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm settings={{ outputFormat: 'jpeg' }} onSubmit={onSubmit} />
    )
    const user = userEvent.setup()
    const background = screen.getByRole('switch', {
      name: 'Transparent background',
    })
    background.focus()
    await user.keyboard(' ')
    const formats = screen.getByRole('group', { name: 'Image output format' })
    expect(
      within(formats).getByRole('button', { name: 'PNG' })
    ).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        background: 'transparent',
        output_format: 'png',
      })
    )
    await user.click(background)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ background: 'opaque', output_format: 'png' })
    )
  })

  it.each([
    ['PNG', 'png'],
    ['WebP', 'webp'],
  ])(
    'explains an incompatible JPEG selection and preserves transparent %s',
    async (label, outputFormat) => {
      const onSubmit = vi.fn()
      render(
        <ResolutionForm
          settings={{
            background: 'transparent',
            outputFormat: outputFormat as ImageSettings['outputFormat'],
          }}
          onSubmit={onSubmit}
        />
      )
      const user = userEvent.setup()
      const formats = screen.getByRole('group', { name: 'Image output format' })
      await user.click(within(formats).getByRole('button', { name: 'JPEG' }))
      expect(screen.getByRole('alert')).toHaveTextContent(
        'JPEG does not support transparent backgrounds. Use PNG or WebP, or turn off transparency.'
      )
      expect(
        screen.getByRole('switch', { name: 'Transparent background' })
      ).toHaveAttribute('aria-checked', 'true')
      expect(
        within(formats).getByRole('button', { name: label })
      ).toHaveAttribute('aria-pressed', 'true')
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      expect(onSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          background: 'transparent',
          output_format: outputFormat,
        })
      )
      await user.click(within(formats).getByRole('button', { name: label }))
      expect(screen.queryByRole('alert')).toBeNull()
      await user.click(within(formats).getByRole('button', { name: 'JPEG' }))
      expect(screen.getByRole('alert')).toBeVisible()
      await user.click(
        screen.getByRole('switch', { name: 'Transparent background' })
      )
      expect(screen.queryByRole('alert')).toBeNull()
      await user.click(within(formats).getByRole('button', { name: 'JPEG' }))
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      expect(onSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({ background: 'opaque', output_format: 'jpeg' })
      )
    }
  )

  it('keeps WebP selected when enabling transparency', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm settings={{ outputFormat: 'webp' }} onSubmit={onSubmit} />
    )
    await userEvent.click(
      screen.getByRole('switch', { name: 'Transparent background' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        background: 'transparent',
        output_format: 'webp',
      })
    )
  })

  it.each(['dall-e-3', 'nano-banana-pro'])(
    'keeps unsupported background and file-format controls hidden for %s',
    (model) => {
      render(<ResolutionForm settings={{ model }} />)
      expect(
        screen.queryByRole('switch', { name: 'Transparent background' })
      ).toBeNull()
      expect(
        screen.queryByRole('group', { name: 'Image output format' })
      ).toBeNull()
    }
  )
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
    const nsfw = screen.getByRole('switch', { name: 'Allow NSFW content' })
    expect(nsfw).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Advanced settings' })
    ).toBeNull()
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
  // Nano Banana has its own size table; the GPT Image 16:9 2K size (2048x1152)
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
    expect(
      within(
        screen.getByRole('group', { name: 'Image aspect ratio' })
      ).queryByRole('button', { name: 'Auto' })
    ).toBeNull()
  })

  it('offers the automatic ratio while editing a reference image', () => {
    render(<ResolutionForm settings={{ ...nano, mode: 'edit' }} />)
    expect(
      within(
        screen.getByRole('group', { name: 'Image aspect ratio' })
      ).getByRole('button', { name: 'Auto' })
    ).toBeVisible()
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

describe('pixel dimensions between quality and resolution', () => {
  it('shows width and height with alignment enabled, before resolution', () => {
    render(<ResolutionForm />)
    const dimensions = screen.getByRole('group', { name: 'Image size' })
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(1024)
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(1024)
    expect(
      screen.getByRole('switch', { name: 'Align to multiples of 16' })
    ).toBeChecked()
    expect(
      screen
        .getByRole('group', { name: 'Image quality' })
        .compareDocumentPosition(dimensions) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      dimensions.compareDocumentPosition(
        screen.getByRole('group', { name: 'Image resolution' })
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen.queryByText(
        'Supported resolutions and aspect ratios depend on the selected model.'
      )
    ).toBeNull()
  })

  it('aligns width on Tab and keeps height focused for the next edit', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const user = userEvent.setup()
    const width = screen.getByRole('spinbutton', { name: 'Width' })
    await user.clear(width)
    await user.type(width, '1025')
    await user.tab()
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(1040)
    const height = screen.getByRole('spinbutton', { name: 'Height' })
    expect(height).toHaveFocus()
    await user.clear(height)
    await user.type(height, '1537')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: '1040x1552' })
    )
  })

  it('commits height on Enter without generating an image', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm onSubmit={onSubmit} />)
    const user = userEvent.setup()
    const height = screen.getByRole('spinbutton', { name: 'Height' })
    await user.clear(height)
    await user.type(height, '1537{Enter}')
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(1552)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('preserves an unsnapped input when alignment is switched off', async () => {
    render(<ResolutionForm />)
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('switch', { name: 'Align to multiples of 16' })
    )
    const width = screen.getByRole('spinbutton', { name: 'Width' })
    await user.clear(width)
    await user.type(width, '1025')
    await user.tab()
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(1025)
  })

  it('restores the saved dimension when the input is cleared', async () => {
    render(<ResolutionForm />)
    const user = userEvent.setup()
    await user.clear(screen.getByRole('spinbutton', { name: 'Width' }))
    await user.tab()
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(1024)
  })

  it('updates the dimension inputs when choosing resolution and ratio', async () => {
    render(<ResolutionForm />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '16:9' }))
    await user.click(screen.getByRole('button', { name: '2K' }))
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(2048)
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(1152)
  })

  it('keeps the inferred custom ratio when changing resolution', async () => {
    render(<ResolutionForm settings={{ size: '1792x1024' }} />)
    await userEvent.click(screen.getByRole('button', { name: '2K' }))
    // Switching tiers applies the preset for the inferred ratio.
    await userEvent.click(screen.getByRole('button', { name: '4K' }))
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(3840)
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(2160)
  })

  it('disables manual dimensions while the aspect ratio is automatic', async () => {
    render(<ResolutionForm />)
    await userEvent.click(
      within(
        screen.getByRole('group', { name: 'Image aspect ratio' })
      ).getByRole('button', { name: 'Auto' })
    )
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toBeDisabled()
  })

  it('keeps automatic resolution when visiting dimensions without editing them', async () => {
    render(<ResolutionForm settings={{ size: '16:9' }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('spinbutton', { name: 'Width' }))
    await user.tab()
    expect(
      within(screen.getByRole('group', { name: 'Image resolution' })).getByRole(
        'button',
        { name: 'Auto' }
      )
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveFocus()
  })

  it('shows Gemini native dimensions without enabling arbitrary pixels', async () => {
    render(
      <ResolutionForm settings={{ model: 'gemini-3-pro-image-preview' }} />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '16:9' }))
    await user.click(screen.getByRole('button', { name: '2K' }))
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(2752)
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(1536)
    expect(screen.getByRole('spinbutton', { name: 'Width' })).toBeDisabled()
    expect(
      screen.getByRole('switch', { name: 'Align to multiples of 16' })
    ).toHaveAttribute('aria-disabled', 'true')
  })

  it.each([['2K', '1024x1024', '2001', 1024]])(
    'rejects dimensions that align into disabled %s and retains %s',
    async (disabledTier, size, enteredWidth, originalWidth) => {
      const onSubmit = vi.fn()
      render(
        <ResolutionForm
          settings={{ size }}
          disabledResolutions={[disabledTier]}
          onSubmit={onSubmit}
        />
      )
      const user = userEvent.setup()
      const width = screen.getByRole('spinbutton', { name: 'Width' })
      await user.clear(width)
      await user.type(width, enteredWidth)
      await user.tab()
      expect(screen.getByRole('spinbutton', { name: 'Width' })).toHaveValue(
        originalWidth
      )
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      expect(onSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({ size })
      )
    }
  )

  it.each([
    ['Width', '1535', true, 1536, '1536x1024', ['2K', '4K'], 1536],
    ['Height', '1535', true, 1536, '1024x1536', ['2K', '4K'], 1536],
    ['Width', '1537', true, 1537, '1024x1024', ['2K', '4K'], 1536],
    ['Height', '1537', true, 1537, '1024x1024', ['2K', '4K'], 1536],
    ['Width', '1537', false, 1537, '1024x1024', ['2K', '4K'], 1536],
    ['Height', '1537', false, 1537, '1024x1024', ['2K', '4K'], 1536],
    ['Width', '2799', true, 2800, '2800x1024', ['4K'], 2800],
    ['Height', '2799', true, 2800, '1024x2800', ['4K'], 2800],
    ['Width', '2801', true, 2801, '1024x1024', ['4K'], 2800],
    ['Height', '2801', true, 2801, '1024x1024', ['4K'], 2800],
  ] as const)(
    'bounds %s entered as %s with alignment %s to the enabled tiers',
    async (dimension, value, aligned, expected, size, disabled, maximum) => {
      const error = vi.spyOn(toast, 'error')
      const onSubmit = vi.fn()
      render(
        <ResolutionForm
          settings={{ size: '1024x1024' }}
          disabledResolutions={[...disabled]}
          onSubmit={onSubmit}
        />
      )
      const user = userEvent.setup()
      const input = screen.getByRole('spinbutton', { name: dimension })
      expect(input).toHaveAttribute('max', String(maximum))
      if (!aligned) {
        await user.click(
          screen.getByRole('switch', { name: 'Align to multiples of 16' })
        )
      }
      await user.clear(input)
      await user.type(input, value)
      await user.tab()
      expect(screen.getByRole('spinbutton', { name: dimension })).toHaveValue(
        expected
      )
      if (Number(value) > maximum) {
        expect(error).toHaveBeenCalledWith(
          maximum === 1536
            ? 'Width and height must each be at most 1,536 pixels.'
            : 'Width and height must each be at most 2,800 pixels.'
        )
      } else {
        expect(error).not.toHaveBeenCalled()
      }
      await user.click(screen.getByRole('button', { name: 'Generate' }))
      if (Number(value) > maximum) {
        expect(onSubmit).not.toHaveBeenCalled()
        const correction = screen.getByRole('spinbutton', { name: dimension })
        await user.clear(correction)
        await user.type(correction, '1024')
        await user.click(screen.getByRole('button', { name: 'Generate' }))
      }
      expect(onSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({ size })
      )
    }
  )

  it('allows a 1536x1536 square when only 1K is enabled', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ size: '1024x1024' }}
        disabledResolutions={['2K', '4K']}
        onSubmit={onSubmit}
      />
    )
    const user = userEvent.setup()
    for (const dimension of ['Width', 'Height']) {
      const input = screen.getByRole('spinbutton', { name: dimension })
      expect(input).toHaveAttribute('max', '1536')
      await user.clear(input)
      await user.type(input, '1536')
      await user.tab()
    }
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: '1536x1536' })
    )
  })

  it('allows custom dimensions inside an enabled tier', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ size: '2048x1440' }}
        disabledResolutions={['4K']}
        onSubmit={onSubmit}
      />
    )
    const user = userEvent.setup()
    const width = screen.getByRole('spinbutton', { name: 'Width' })
    await user.clear(width)
    await user.type(width, '2560')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: '2560x1440' })
    )
  })
})

describe('the reference canvas ratios and saved legacy ratios', () => {
  it.each([
    ['4:5', '896x1120'],
    ['5:4', '1120x896'],
  ])(
    'keeps a saved %s ratio valid when switching to automatic resolution',
    async (ratio, size) => {
      const onSubmit = vi.fn()
      render(<ResolutionForm settings={{ size }} onSubmit={onSubmit} />)
      const tiers = screen.getByRole('group', { name: 'Image resolution' })
      await userEvent.click(within(tiers).getByRole('button', { name: 'Auto' }))
      expect(
        within(tiers).getByRole('button', { name: 'Auto' })
      ).toHaveAttribute('aria-pressed', 'true')
      expect(
        within(
          screen.getByRole('group', { name: 'Image aspect ratio' })
        ).getByRole('button', { name: ratio })
      ).toHaveAttribute('aria-pressed', 'true')
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
      expect(onSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({ size })
      )
    }
  )

  it('renders the reference canvas ratio choices in order', () => {
    render(<ResolutionForm />)
    const ratios = screen.getByRole('group', { name: 'Image aspect ratio' })
    expect(
      within(ratios)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual([
      '1:1',
      '2:3',
      '3:2',
      '4:3',
      '3:4',
      '16:9',
      '9:16',
      '21:9',
      '9:21',
      'Auto',
    ])
  })

  it('gives every ratio tile including automatic the same fixed height', () => {
    render(<ResolutionForm />)
    const ratios = screen.getByRole('group', { name: 'Image aspect ratio' })
    for (const button of within(ratios).getAllByRole('button')) {
      expect(button).toHaveClass('h-18')
    }
  })

  it.each([
    ['21:9', '1K', '1456x624', '1024x1024'],
    ['9:21', '1K', '624x1456', '1024x1024'],
    ['9:21', '4K', '1648x3840', '1024x1024'],
    ['5:4', '2K', '2240x1792', '1120x896'],
    ['4:5', '4K', '2560x3200', '896x1120'],
  ])('submits %s at %s as %s', async (ratio, tier, size, initialSize) => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm settings={{ size: initialSize }} onSubmit={onSubmit} />
    )
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
    'lays the three tiers and auto out in four columns for %s',
    (model) => {
      render(<ResolutionForm settings={{ model }} />)
      const tiers = screen.getByRole('group', { name: 'Image resolution' })
      expect(tiers).toHaveClass('grid-cols-4')
      expect(within(tiers).getAllByRole('button')).toHaveLength(4)
    }
  )
})

describe('a group can withhold resolution tiers', () => {
  it('offers only the tiers left on, filling the row with them', () => {
    render(<ResolutionForm disabledResolutions={['4K']} />)
    const tiers = screen.getByRole('group', { name: 'Image resolution' })
    expect(
      within(tiers)
        .getAllByRole('button')
        .map((tier) => tier.textContent)
    ).toEqual(['1K', '2K', 'Auto'])
    expect(tiers).toHaveClass('grid-cols-3')
    expect(within(tiers).getByRole('button', { name: 'Auto' })).toBeDisabled()
    expect(
      within(
        screen.getByRole('group', { name: 'Image aspect ratio' })
      ).getByRole('button', { name: 'Auto' })
    ).toBeDisabled()
  })
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
    client.setQueryData(['canvas-setting', 915], {
      default_model: '',
      disabled_resolutions: [],
    })
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

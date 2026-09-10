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

import zh from '@/i18n/locales/zh.json'
import { useDrawingStore } from '@/stores/drawing-store'

import {
  buildImagePayload,
  DEFAULT_IMAGE_SETTINGS,
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
  const form = useForm<ImageSettings>({
    defaultValues: {
      ...DEFAULT_IMAGE_SETTINGS,
      model: 'gpt-image-2.5',
      ...props.settings,
    },
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
    ['2:3', '688x1024'],
    ['3:2', '1024x688'],
    ['3:4', '768x1024'],
    ['4:3', '1024x768'],
    ['9:16', '576x1024'],
    ['16:9', '1024x576'],
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
    expect(screen.getByRole('status')).toHaveTextContent('2048 × 1152')
    await user.click(screen.getByRole('button', { name: '4K' }))
    expect(screen.getByRole('status')).toHaveTextContent('4096 × 2304')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ size: '4096x2304' })
    )
  })

  it('shows Chinese custom inputs without rewriting existing canvas dimensions', async () => {
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'zh',
      fallbackLng: 'zh',
      resources: { zh },
    })
    const onSubmit = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ResolutionForm settings={{ size: '1536x1024' }} onSubmit={onSubmit} />
      </I18nextProvider>
    )
    const user = userEvent.setup()
    expect(screen.getByRole('group', { name: '画面比例' })).toBeVisible()
    expect(screen.getByRole('group', { name: '分辨率' })).toBeVisible()
    expect(screen.getByRole('button', { name: '自定义' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByLabelText('宽度')).toHaveValue(1536)
    expect(screen.getByLabelText('高度')).toHaveValue(1024)
    expect(screen.getByPlaceholderText('输入宽度')).toBeVisible()
    expect(screen.getByPlaceholderText('输入高度')).toBeVisible()
    expect(screen.getByText('支持的分辨率和比例以所选模型为准。')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: '1536x1024' })
    )
    await user.clear(screen.getByLabelText('宽度'))
    expect(screen.getByLabelText('宽度')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    await user.type(screen.getByLabelText('宽度'), '2048')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: '2048x1024' })
    )
  })

  it('keeps custom inputs open even when typed dimensions match a preset', async () => {
    render(<ResolutionForm />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Custom' }))
    const width = screen.getByLabelText('Width')
    await user.clear(width)
    await user.type(width, '1024')
    expect(width).toBeVisible()
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('preserves automatic size and does not imply a fixed resolution is being sent', async () => {
    const onSubmit = vi.fn()
    render(<ResolutionForm settings={{ size: 'auto' }} onSubmit={onSubmit} />)
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    for (const name of ['1K', '2K', '4K']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
      expect(screen.getByRole('button', { name })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    }
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: 'auto' })
    )
    await user.click(screen.getByRole('button', { name: '1:1' }))
    expect(screen.getByRole('button', { name: '1K' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('1024 × 1024')
  })

  it('keeps fixed-size model options selectable without offering unsupported 4K', async () => {
    const onSubmit = vi.fn()
    render(
      <ResolutionForm
        settings={{ model: 'dall-e-3', size: '1792x1024' }}
        onSubmit={onSubmit}
      />
    )
    const size = screen.getByLabelText('Image resolution')
    expect(size).toHaveValue('1792x1024')
    expect(screen.queryByRole('button', { name: '4K' })).not.toBeInTheDocument()
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
    expect(useDrawingStore.getState().settings.size).toBe('4096x2304')
    await user.selectOptions(screen.getByLabelText('Image quality'), 'low')
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
    expect(screen.getByRole('status')).toHaveTextContent('4096 × 2304')
    reopened.unmount()
    client.clear()
    useDrawingStore.getState().initialize(914)
  })
})

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
import { createInstance } from 'i18next'
import { initReactI18next, I18nextProvider } from 'react-i18next'
import { FormProvider, useForm } from 'react-hook-form'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ImageParameterFields } from '../ImageParameterFields'
import { DEFAULT_IMAGE_SETTINGS } from '../../lib/image-settings'
import type { ImageSettings } from '../../types'

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

describe('Image parameter fields', () => {
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

    await userEvent.setup().click(
      screen.getByRole('button', { name: 'Advanced settings' })
    )
    const quality = screen.getByLabelText('图片质量')
    expect(quality).toBeVisible()
    expect(within(quality).getByRole('option', { name: '低' })).toBeVisible()
    expect(screen.getByLabelText('输出格式')).toBeVisible()
    expect(screen.getByLabelText('背景')).toBeVisible()
    expect(screen.getByRole('option', { name: '透明' })).toBeVisible()
  })
})

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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MaskEditor } from '../MaskEditor'

describe('Image mask editor', () => {
  it('preserves unpainted pixels as soon as the dialog opens and after resetting', async () => {
    // happy-dom has no raster engine. Model the browser's alpha buffer at the Canvas API boundary.
    let alpha = 0
    const context = {
      fillStyle: '',
      globalCompositeOperation: 'source-over',
      fillRect: () => {
        alpha = 166
      },
      clearRect: () => {
        alpha = 0
      },
      getImageData: () => ({
        data: new Uint8ClampedArray([20, 20, 20, alpha]),
      }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    )
    render(
      <MaskEditor
        image={{
          id: 'reference',
          name: 'cup.png',
          src: 'data:image/png;base64,YWJj',
          width: 512,
          height: 512,
          mimeType: 'image/png',
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )
    const canvas = await screen.findByLabelText<HTMLCanvasElement>(
      'Paint the area to edit'
    )
    await waitFor(() =>
      expect(
        canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data[3]
      ).toBeGreaterThan(0)
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit entire image' }))
    expect(canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data[3]).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Reset mask' }))
    expect(
      canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data[3]
    ).toBeGreaterThan(0)
  })
})

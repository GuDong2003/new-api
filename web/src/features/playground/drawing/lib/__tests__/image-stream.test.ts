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

import { parseImageResponse, readImageStream } from '../image-stream'

const encoder = new TextEncoder()
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('OpenAI image responses', () => {
  it('uses the returned MIME type for base64 images and preserves revised prompts', () => {
    expect(
      parseImageResponse(
        {
          output_format: 'webp',
          data: [{ b64_json: 'YWJj', revised_prompt: 'Revised' }],
        },
        'png'
      )[0]
    ).toEqual({
      src: 'data:image/webp;base64,YWJj',
      mimeType: 'image/webp',
      revisedPrompt: 'Revised',
    })
  })
  it('rejects an empty result, a provider error and an unsafe image URL', () => {
    expect(() => parseImageResponse({ data: [] }, 'png')).toThrow(
      'The server returned no images.'
    )
    expect(() =>
      parseImageResponse({ error: { message: 'Insufficient quota' } }, 'png')
    ).toThrow('Insufficient quota')
    expect(() =>
      parseImageResponse({ data: [{ url: 'javascript:alert(1)' }] }, 'png')
    ).toThrow('The image response is invalid.')
  })
  it('assembles chunked CRLF events, previews partials and keeps completed images in order', async () => {
    const partials: string[] = []
    const input =
      ': keepalive\r\n\r\nevent: image_generation.partial_image\r\ndata: {"type":"image_generation.partial_image","b64_json":"YWJj"}\r\n\r\ndata: {"type":"image_generation.completed","b64_json":"ZGVm","output_format":"jpeg"}\r\n\r\ndata: {"type":"image_generation.completed","b64_json":"Z2hp","usage":{"total_tokens":42}}\r\n\r\ndata: [DONE]\r\n\r\n'
    const result = await readImageStream(
      streamOf([
        input.slice(0, 24),
        input.slice(24, 39),
        input.slice(39, 108),
        input.slice(108),
      ]),
      'png',
      (image) => partials.push(image.src)
    )
    expect(partials).toEqual(['data:image/png;base64,YWJj'])
    expect(result.images.map((image) => image.src)).toEqual([
      'data:image/jpeg;base64,ZGVm',
      'data:image/png;base64,Z2hp',
    ])
    expect(result.usage).toEqual({ total_tokens: 42 })
  })
  it('does not treat an interrupted stream containing only a preview as a completed result', async () => {
    await expect(
      readImageStream(
        streamOf([
          'data: {"type":"image_generation.partial_image","b64_json":"YWJj"}\n\n',
        ]),
        'png',
        () => undefined
      )
    ).rejects.toThrow('The image stream ended before generation completed.')
  })
  it('surfaces an error event instead of silently returning a partial result', async () => {
    await expect(
      readImageStream(
        streamOf(['data: {"type":"error","message":"Content rejected"}\n\n']),
        'png',
        () => undefined
      )
    ).rejects.toThrow('Content rejected')
  })
  it('releases a pending stream when the request is cancelled', async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>()
    const promise = readImageStream(
      stream,
      'png',
      () => undefined,
      controller.signal
    )
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(stream.locked).toBe(false)
  })
})

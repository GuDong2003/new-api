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

type ResponseRecord = Record<string, unknown>
type PreviewTool = { id: string; name: string; arguments: string }

export type ChannelTestPreview = {
  text: string
  tools: PreviewTool[]
  images: string[]
}

function responseRecord(value: unknown): ResponseRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ResponseRecord)
    : {}
}

function responseRecords(value: unknown): ResponseRecord[] {
  return Array.isArray(value) ? value.map(responseRecord) : []
}

function responseText(value: unknown): string {
  if (typeof value === 'string') return value
  return responseRecords(value)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
}

// This is a presentation parser, not a second capability validator. Malformed or
// unfamiliar payloads remain available in full in the collapsed raw response.
export function parseChannelTestPreview(
  raw: string,
  endpoint: string
): ChannelTestPreview {
  const stream = /^\s*(?:data:|event:|:)/.test(raw)
  const payloads = stream
    ? raw
        .replaceAll(/\r\n?/g, '\n')
        .split(/\n\s*\n/)
        .map((frame) =>
          frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n')
        )
    : [raw]
  const texts = new Map<string, string>()
  const tools = new Map<string, PreviewTool>()
  const toolAliases = new Map<string, string>()
  const images = new Set<string>()

  const addText = (key: string, value: unknown, replace = false) => {
    const text = responseText(value)
    if (text) texts.set(key, replace ? text : (texts.get(key) ?? '') + text)
  }
  const addTool = (
    key: string,
    name: unknown,
    args: unknown,
    append = false,
    id?: unknown
  ) => {
    if (typeof id === 'string' && id) {
      const existing = toolAliases.get(id)
      if (existing) key = existing
      else toolAliases.set(id, key)
    }
    const previous = tools.get(key) ?? { id: key, name: '', arguments: '' }
    const nextName = typeof name === 'string' ? name : ''
    if (nextName && previous.name !== nextName) {
      previous.name = append ? previous.name + nextName : nextName
    }
    const nextArgs = typeof args === 'string' ? args : JSON.stringify(args)
    if (nextArgs !== undefined) {
      previous.arguments = append ? previous.arguments + nextArgs : nextArgs
    }
    tools.set(key, previous)
  }

  for (const data of payloads) {
    let payload: ResponseRecord
    try {
      payload = responseRecord(JSON.parse(data))
    } catch {
      continue
    }
    if (endpoint === 'openai') {
      for (const [index, choice] of responseRecords(
        payload.choices
      ).entries()) {
        const prefix = String(choice.index ?? index)
        const message = responseRecord(stream ? choice.delta : choice.message)
        addText(prefix, message.content ?? choice.text)
        for (const [toolIndex, call] of responseRecords(
          message.tool_calls
        ).entries()) {
          const fn = responseRecord(call.function)
          addTool(
            `${prefix}:${String(call.index ?? toolIndex)}`,
            fn.name,
            fn.arguments,
            stream,
            call.id
          )
        }
      }
    } else if (endpoint === 'openai-response') {
      const kind = payload.type
      const key = String(payload.output_index ?? 0)
      if (kind === 'response.output_text.delta') addText(key, payload.delta)
      if (kind === 'response.output_text.done') addText(key, payload.text, true)
      if (kind === 'response.function_call_arguments.delta') {
        addTool(key, undefined, payload.delta, true)
      }
      if (kind === 'response.function_call_arguments.done') {
        addTool(key, undefined, payload.arguments)
      }
      const item = responseRecord(payload.item)
      if (item.type === 'function_call') addTool(key, item.name, item.arguments)
      const response = stream ? responseRecord(payload.response) : payload
      if (Array.isArray(response.output) && response.output.length > 0) {
        texts.clear()
        tools.clear()
        for (const [index, output] of responseRecords(
          response.output
        ).entries()) {
          if (output.type === 'message') addText(String(index), output.content)
          if (output.type === 'function_call') {
            addTool(String(index), output.name, output.arguments)
          }
        }
      }
    } else if (endpoint === 'anthropic') {
      if (!stream || payload.type === 'message_start') {
        const message = stream ? responseRecord(payload.message) : payload
        for (const [index, block] of responseRecords(
          message.content
        ).entries()) {
          if (block.type === 'text') addText(String(index), block.text)
          if (block.type === 'tool_use') {
            addTool(String(index), block.name, block.input)
          }
        }
      }
      const key = String(payload.index ?? 0)
      const block = responseRecord(payload.content_block)
      if (payload.type === 'content_block_start') {
        if (block.type === 'text') addText(key, block.text)
        if (block.type === 'tool_use') {
          addTool(
            key,
            block.name,
            Object.keys(responseRecord(block.input)).length ? block.input : ''
          )
        }
      }
      const delta = responseRecord(payload.delta)
      if (delta.type === 'text_delta') addText(key, delta.text)
      if (delta.type === 'input_json_delta') {
        addTool(key, undefined, delta.partial_json, true)
      }
    } else if (endpoint === 'gemini') {
      for (const [index, candidate] of responseRecords(
        payload.candidates
      ).entries()) {
        const prefix = String(candidate.index ?? index)
        for (const [partIndex, part] of responseRecords(
          responseRecord(candidate.content).parts
        ).entries()) {
          if (!part.thought) addText(prefix, part.text)
          const call = responseRecord(part.functionCall)
          if (call.name) {
            addTool(
              `${prefix}:${partIndex}`,
              call.name,
              call.args,
              false,
              call.id
            )
          }
        }
      }
    } else if (endpoint === 'image-generation') {
      const items = stream ? [payload] : responseRecords(payload.data)
      for (const item of items) {
        if (
          stream &&
          item.type !== 'image_generation.completed' &&
          item.type !== 'image_edit.completed'
        ) {
          continue
        }
        if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
          images.add(item.url)
        }
        if (
          typeof item.b64_json === 'string' &&
          /^[A-Za-z0-9+/\s]+={0,2}$/.test(item.b64_json)
        ) {
          const format = item.output_format ?? payload.output_format
          let mime = 'image/png'
          if (format === 'jpeg' || format === 'jpg') mime = 'image/jpeg'
          if (format === 'webp') mime = 'image/webp'
          images.add(`data:${mime};base64,${item.b64_json}`)
        }
      }
    }
  }
  return {
    text: [...texts.values()].join('\n\n'),
    tools: [...tools.values()],
    images: [...images],
  }
}

import { describe, expect, test } from 'vitest'

import { buildDetailedChannelTestPayload } from '../channel-actions'

describe('detailed channel test message payload', () => {
  test('includes a non-empty one-run message in the test request', () => {
    expect(
      buildDetailedChannelTestPayload({
        testModel: 'gpt-5.6-sol',
        endpointType: 'openai-response',
        stream: false,
        message: 'Reply with a short greeting.',
      })
    ).toEqual({
      model: 'gpt-5.6-sol',
      endpoint_type: 'openai-response',
      stream: false,
      message: 'Reply with a short greeting.',
    })
  })

  test('omits a blank one-run message so the server uses the global default', () => {
    expect(
      buildDetailedChannelTestPayload({
        testModel: 'gpt-5.6-sol',
        endpointType: 'openai-response',
        stream: false,
        message: '  \n  ',
      })
    ).toEqual({
      model: 'gpt-5.6-sol',
      endpoint_type: 'openai-response',
      stream: false,
    })
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { ZedStreamError, zedFrames } from '../lib/frames.js'
import { buildResponsesRequest, parseZedResponsesStream } from '../lib/responses.js'

/** Serve NDJSON frames as a web ReadableStream, chunked to exercise the line splitter. */
function ndjson(frames, splitAt = 7) {
  const text = frames.map((frame) => `${JSON.stringify(frame)}\n`).join('')
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < text.length; offset += splitAt) {
        controller.enqueue(encoder.encode(text.slice(offset, offset + splitAt)))
      }
      controller.close()
    },
  })
}

async function collect(frames, options) {
  const chunks = []
  for await (const chunk of parseZedResponsesStream(ndjson(frames), options)) chunks.push(chunk)
  return chunks
}

const ended = { status: 'stream_ended' }

test('frames decode both event wrappings and the ended status', async () => {
  const records = []
  const stream = ndjson([{ type: 'response.created' }, { event: { type: 'response.done' } }, ended])
  for await (const record of zedFrames(stream)) records.push(record)
  assert.deepEqual(records, [
    { kind: 'event', event: { type: 'response.created' } },
    { kind: 'event', event: { type: 'response.done' } },
    { kind: 'ended' },
  ])
})

test('emits text blocks, usage and a stop finish', async () => {
  const chunks = await collect([
    { event: { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } } },
    { event: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Hel' } },
    { event: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'lo' } },
    { event: { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0 } },
    {
      event: {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          usage: {
            input_tokens: 120,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 20 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      },
    },
    ended,
  ])

  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta'), [
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
  ])
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'block-end'),
    [{ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } }],
  )
  assert.deepEqual(chunks.at(-2), {
    type: 'usage',
    usage: { inputTokens: 100, outputTokens: 7, totalTokens: 127, cacheReadTokens: 20 },
  })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.deepEqual(chunks.at(-1).replayState, { response: { backend: 'open_ai' }, blocks: [null] })
})

test('assembles reasoning and a tool call, replaying the whole reasoning item', async () => {
  const reasoningItem = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: 'plan' }],
    encrypted_content: 'enc-1',
  }
  const chunks = await collect([
    { event: { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } } },
    { event: { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'pla' } },
    { event: { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'n' } },
    { event: { type: 'response.output_item.done', output_index: 0, item: reasoningItem } },
    {
      event: {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
      },
    },
    { event: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path"' } },
    { event: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: ':"a.txt"}' } },
    {
      event: {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      },
    },
    ended,
  ])

  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
    [
      { type: 'reasoning', text: 'plan' },
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
    ],
  )
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool-call-delta'), [
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'read', argumentsDelta: '{"path"' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'read', argumentsDelta: ':"a.txt"}' },
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
  assert.deepEqual(chunks.at(-1).replayState, { response: { backend: 'open_ai' }, blocks: [reasoningItem, null] })
})

test('fails loudly on a function call whose final arguments are not JSON', async () => {
  const frames = [
    {
      event: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
      },
    },
    { event: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' } },
    { event: { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":' } },
    ended,
  ]

  // The block still streams (this harness assembles blocks from their deltas,
  // so a suppressed block-end would drop nothing and desynchronise replay), and
  // the turn fails with the adapter-level code instead of reaching a tool with
  // arguments it cannot read.
  const streamed = []
  await assert.rejects(
    (async () => {
      for await (const chunk of parseZedResponsesStream(ndjson(frames))) streamed.push(chunk)
    })(),
    (error) => error.code === 'MALFORMED_RESPONSE',
  )
  assert.equal(streamed.filter((chunk) => chunk.type === 'block-start').length, 1)
  assert.deepEqual(
    streamed.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
    [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":' }],
  )
})

test('leaves a truncated turn alone: the harness drops its tool calls', async () => {
  const chunks = await collect([
    {
      event: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
      },
    },
    { event: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' } },
    { status: { incomplete: { reason: 'max_output_tokens' } } },
    ended,
  ])

  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
  assert.equal(chunks.filter((chunk) => chunk.type === 'block-end').length, 1)
})

test('rejects a stream that ends without the stream_ended status', async () => {
  await assert.rejects(
    collect([
      { event: { type: 'response.output_text.delta', delta: 'partial' } },
      { event: { type: 'response.completed', response: { status: 'completed' } } },
    ]),
    (error) => error instanceof ZedStreamError && error.code === 'INCOMPLETE_STREAM',
  )
})

test('surfaces a failed turn envelope', async () => {
  await assert.rejects(
    collect([{ status: { failed: { message: 'upstream exploded' } } }, ended]),
    (error) =>
      error instanceof ZedStreamError &&
      error.code === 'PROVIDER_ERROR' &&
      error.message === 'Zed Cloud reported a failed turn: upstream exploded',
  )
})

test('finishes as max-tokens on an incomplete status and blocks content filters', async () => {
  const chunks = await collect([
    { event: { type: 'response.output_text.delta', delta: 'partial' } },
    { status: { incomplete: { reason: 'max_output_tokens' } } },
    ended,
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })

  await assert.rejects(
    collect([{ status: { incomplete: { reason: 'content_filter' } } }]),
    (error) => error instanceof ZedStreamError && error.code === 'CONTENT_BLOCKED',
  )
  await assert.rejects(
    collect([
      {
        event: {
          type: 'response.incomplete',
          response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
        },
      },
      ended,
    ]),
    (error) => error instanceof ZedStreamError && error.code === 'CONTENT_BLOCKED',
  )
})

test('surfaces an error event as a provider error', async () => {
  await assert.rejects(
    collect([{ event: { type: 'error', error: { code: 'rate_limited', message: 'slow down' } } }]),
    (error) =>
      error instanceof ZedStreamError &&
      error.code === 'PROVIDER_ERROR' &&
      error.message === 'Error Code rate_limited: slow down',
  )
})

test('a late output_item.done only refreshes the replayed reasoning item', async () => {
  const doneItem = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: 'plan' }],
    encrypted_content: 'enc-1',
  }
  const chunks = await collect([
    { event: { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } } },
    { event: { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'plan' } },
    { event: { type: 'response.reasoning_summary_text.done', item_id: 'rs_1' } },
    { event: { type: 'response.output_item.done', output_index: 0, item: doneItem } },
    ended,
  ])

  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
    [{ type: 'reasoning', text: 'plan' }],
  )
  assert.deepEqual(chunks.at(-1).replayState.blocks, [doneItem])
})

test('a tool call with no arguments at all ends up as an empty object', async () => {
  const chunks = await collect([
    {
      event: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'now' },
      },
    },
    { event: { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1' } } },
    ended,
  ])

  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block), [
    { type: 'tool-call', id: 'call_1', name: 'now', arguments: '{}' },
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('honours an aborted signal', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled by caller'))
  await assert.rejects(
    collect([ended], { signal: controller.signal }),
    (error) => error.message === 'cancelled by caller',
  )
})

test('builds a Responses request: instructions, input items and tools', () => {
  const request = buildResponsesRequest(
    {
      model: 'gpt-5',
      system: 'be terse',
      messages: [
        { role: 'system', content: 'and kind' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
      ],
      tools: [
        { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: {} } } },
      ],
      maxTokens: 256,
      temperature: 0.3,
    },
    { max_output_tokens: 8192 },
  )

  assert.deepEqual(request, {
    model: 'gpt-5',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
    ],
    stream: true,
    max_output_tokens: 256,
    instructions: 'be terse\n\nand kind',
    tools: [
      { type: 'function', name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: {} } } },
    ],
    temperature: 0.3,
  })
})

test('replays stored reasoning only for the same provider and model', () => {
  const item = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: 'plan' }],
    encrypted_content: 'enc-1',
  }
  const assistant = (source) => ({
    role: 'assistant',
    source,
    content: [
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'done' },
    ],
  })
  const textOnly = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]

  assert.deepEqual(
    buildResponsesRequest(
      {
        model: 'gpt-5',
        messages: [
          assistant({ provider: 'zed-agent', model: 'gpt-5', replayState: { blocks: [item, null] } }),
        ],
      },
      undefined,
    ).input,
    [{ ...item }, ...textOnly],
  )

  for (const source of [
    { provider: 'zed-agent', model: 'gpt-4.1', replayState: { blocks: [item, null] } },
    { provider: 'someone-else', model: 'gpt-5', replayState: { blocks: [item, null] } },
    { provider: 'zed-agent', model: 'gpt-5', replayState: { blocks: [null, null] } },
    { provider: 'zed-agent', model: 'gpt-5' },
  ]) {
    assert.deepEqual(buildResponsesRequest({ model: 'gpt-5', messages: [assistant(source)] }, undefined).input, textOnly)
  }
})

test('reasoning effort travels only when the entry supports thinking', () => {
  const options = {
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'hi' }],
    reasoningEffort: 'high',
    temperature: 0.5,
  }

  assert.deepEqual(buildResponsesRequest(options, { supports_thinking: true }).reasoning, {
    effort: 'medium',
    summary: 'auto',
  })
  assert.equal(buildResponsesRequest(options, { supports_thinking: true }).temperature, undefined)
  assert.deepEqual(buildResponsesRequest({ ...options, reasoningEffort: 'low' }, { supports_thinking: true }).reasoning, {
    effort: 'low',
    summary: 'auto',
  })
  assert.deepEqual(buildResponsesRequest({ ...options, reasoningEffort: 'max' }, { supports_thinking: true }).reasoning, {
    effort: 'high',
    summary: 'auto',
  })
  assert.equal(buildResponsesRequest({ ...options, reasoningEffort: 'off' }, { supports_thinking: true }).reasoning, undefined)
  assert.equal(buildResponsesRequest(options, {}).reasoning, undefined)
  assert.equal(buildResponsesRequest(options, {}).temperature, 0.5)
  assert.equal(buildResponsesRequest({ model: 'gpt-5', messages: [] }, { max_output_tokens: 4096 }).max_output_tokens, 4096)
})

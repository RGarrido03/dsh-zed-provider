import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmStreamError, parseZedAnthropicStream } from '../lib/parse.js'

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

async function collect(frames) {
  const chunks = []
  for await (const chunk of parseZedAnthropicStream(ndjson(frames))) chunks.push(chunk)
  return chunks
}

const ended = { status: 'stream_ended' }

test('emits text blocks, usage and a stop finish', async () => {
  const chunks = await collect([
    { event: { type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 20 } } } },
    { event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
    { event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
    { event: { type: 'content_block_stop' } },
    { event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } } },
    ended,
  ])

  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta'), [
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
  ])
  assert.deepEqual(chunks.at(-2), {
    type: 'usage',
    usage: { inputTokens: 120, outputTokens: 7, totalTokens: 147, cacheReadTokens: 20 },
  })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.equal(chunks.at(-1).replayState.blocks.length, 1)
})

test('assembles a signed thinking block and a tool call', async () => {
  const chunks = await collect([
    { event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
    { event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'plan' } } },
    { event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig-1' } } },
    { event: { type: 'content_block_stop' } },
    { event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } } },
    { event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path"' } } },
    { event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: ':"a.txt"}' } } },
    { event: { type: 'content_block_stop' } },
    { event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
    ended,
  ])

  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
    [
      { type: 'reasoning', text: 'plan' },
      { type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"path":"a.txt"}' },
    ],
  )
  assert.deepEqual(chunks.at(-1).replayState.blocks, [{ kind: 'reasoning', signature: 'sig-1' }, null])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('redacted thinking emits no harness block', async () => {
  const chunks = await collect([
    { event: { type: 'content_block_start', content_block: { type: 'redacted_thinking', data: 'x' } } },
    { event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
    { event: { type: 'content_block_stop' } },
    ended,
  ])
  assert.equal(chunks.filter((chunk) => chunk.type === 'block-start').length, 1)
  assert.equal(chunks.at(-1).replayState.blocks.length, 1)
})

test('rejects a stream that ends without the stream_ended status', async () => {
  await assert.rejects(
    collect([
      { event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } },
    ]),
    (error) => error instanceof LlmStreamError && error.code === 'INCOMPLETE_STREAM',
  )
})

test('surfaces a failed turn envelope', async () => {
  await assert.rejects(
    collect([{ status: { failed: { message: 'upstream exploded' } } }, ended]),
    (error) => error instanceof LlmStreamError && error.code === 'PROVIDER_ERROR',
  )
})

test('fails loudly on tool input that is not a JSON object', async () => {
  const frames = [
    { event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } } },
    { event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
    { event: { type: 'content_block_stop' } },
    { event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
    ended,
  ]
  await assert.rejects(
    collect(frames),
    (error) => error instanceof LlmStreamError && error.code === 'MALFORMED_RESPONSE',
  )
})

test('leaves a truncated turn alone: the harness drops its tool calls', async () => {
  const chunks = await collect([
    { event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } } },
    { event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
    { event: { type: 'content_block_stop' } },
    { event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } } },
    ended,
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

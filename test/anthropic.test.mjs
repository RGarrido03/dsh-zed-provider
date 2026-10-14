import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAnthropicRequest, buildMessages } from '../lib/anthropic.js'

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

test('system-role text moves into the system field, in order', () => {
  // Cache markers off: this case is about where text lands, not about caching.
  const request = buildAnthropicRequest(
    {
      model: 'claude-sonnet-5',
      system: 'one-shot preamble',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'session prompt' }] }, user('hi')],
    },
    undefined,
    'budget',
    false,
  )
  assert.equal(request.system, 'one-shot preamble\n\nsession prompt')
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
})

test('consecutive tool results merge into one user turn', () => {
  const messages = buildMessages(
    [
      {
        role: 'assistant',
        source: { kind: 'model', provider: 'zed-agent', model: 'claude-sonnet-5' },
        content: [
          { type: 'tool-call', id: 'toolu_a', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'toolu_b', name: 'read', arguments: '{"path":"b"}' },
        ],
      },
      { role: 'tool', toolCallId: 'toolu_a', content: [{ type: 'text', text: 'A' }] },
      { role: 'tool', toolCallId: 'toolu_b', isError: true, content: [{ type: 'text', text: 'boom' }] },
      user('carry on'),
    ],
    'claude-sonnet-5',
  )

  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0].content[0], { type: 'tool_use', id: 'toolu_a', name: 'read', input: { path: 'a' } })
  // `is_error` is always present, including on successful results: Anthropic
  // treats it as optional, Zed's request parser requires it.
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'A', is_error: false },
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'boom', is_error: true },
    ],
  })
})

test('replays thinking only with a same-model signature', () => {
  const signed = {
    role: 'assistant',
    source: {
      kind: 'model',
      provider: 'zed-agent',
      model: 'claude-sonnet-5',
      replayState: { response: {}, blocks: [{ kind: 'reasoning', signature: 'sig-1' }, null] },
    },
    content: [
      { type: 'reasoning', text: 'weighing options' },
      { type: 'text', text: 'answer' },
    ],
  }
  assert.deepEqual(buildMessages([signed], 'claude-sonnet-5')[0].content, [
    { type: 'thinking', thinking: 'weighing options', signature: 'sig-1' },
    { type: 'text', text: 'answer' },
  ])

  // Another model's unsigned thinking is dropped, not sent as an unsigned block.
  assert.deepEqual(buildMessages([signed], 'claude-haiku-4-5')[0].content, [{ type: 'text', text: 'answer' }])
  assert.deepEqual(buildMessages([{ ...signed, source: { ...signed.source, replayState: undefined } }], 'claude-sonnet-5')[0].content, [
    { type: 'text', text: 'answer' },
  ])
})

test('maps tools, thinking budget and sampling parameters', () => {
  const options = {
    model: 'claude-sonnet-5',
    messages: [user('hi')],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
    maxTokens: 4096,
    temperature: 0.5,
    stop: ['a', 'b', 'c', 'd', 'e'],
  }
  const entry = { supports_thinking: true }

  const withThinking = buildAnthropicRequest({ ...options, reasoningEffort: 'high' }, entry)
  assert.deepEqual(withThinking.thinking, { type: 'enabled', budget_tokens: 4095 })
  assert.equal(withThinking.temperature, undefined, 'thinking rejects sampling parameters')
  assert.deepEqual(withThinking.tools[0], {
    name: 'read',
    description: 'Read a file',
    input_schema: { type: 'object', properties: {} },
  })
  assert.deepEqual(withThinking.stop_sequences, ['a', 'b', 'c', 'd'])

  const noThinking = buildAnthropicRequest({ ...options, reasoningEffort: 'off' }, entry)
  assert.equal(noThinking.thinking, undefined)
  assert.equal(noThinking.temperature, 0.5)
  assert.equal(noThinking.max_tokens, 4096)

  // A cap that cannot host Anthropic's 1024-token minimum stays valid: thinking
  // is omitted rather than sent as a request the API would reject.
  const tinyCap = buildAnthropicRequest({ ...options, maxTokens: 1024, reasoningEffort: 'high' }, entry)
  assert.equal(tinyCap.thinking, undefined)
  assert.equal(tinyCap.temperature, 0.5)
})

test('falls back to the advertised output cap when the caller sets none', () => {
  const request = buildAnthropicRequest({ model: 'claude-haiku-4-5', messages: [user('hi')] }, {
    max_output_tokens: 64_000,
  })
  assert.equal(request.max_tokens, 64_000)
})

test('the adaptive dialect carries effort in output_config, never a budget', () => {
  const options = {
    model: 'claude-sonnet-5-5',
    messages: [user('hi')],
    maxTokens: 4096,
    temperature: 0.5,
  }
  const entry = { supports_thinking: true }

  const on = buildAnthropicRequest({ ...options, reasoningEffort: 'high' }, entry, 'adaptive')
  assert.deepEqual(on.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(on.output_config, { effort: 'high' })
  assert.equal(on.temperature, undefined, 'effort lives in output_config, so sampling still has to stay out')

  // The adaptive generation cannot stop thinking, so `off` pins the lowest
  // effort instead of sending a directive it would refuse.
  const off = buildAnthropicRequest({ ...options, reasoningEffort: 'off' }, entry, 'adaptive')
  assert.equal(off.thinking, undefined)
  assert.deepEqual(off.output_config, { effort: 'low' })
  assert.equal(off.temperature, undefined)

  // No thinking capability at all: no directive, and sampling is welcome.
  const none = buildAnthropicRequest({ ...options, reasoningEffort: 'high' }, {}, 'adaptive')
  assert.equal(none.thinking, undefined)
  assert.equal(none.output_config, undefined)
  assert.equal(none.temperature, 0.5)
})

test('marks the end of the conversation as a cache breakpoint', () => {
  const request = buildAnthropicRequest(
    {
      model: 'claude-sonnet-5-5',
      system: 'preamble',
      messages: [user('first'), { role: 'user', content: [{ type: 'text', text: 'second' }] }],
      tools: [{ name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: {} } }],
    },
    undefined,
  )

  // One marker, on the last block: it caches tools, system and every message
  // before it, and moves forward as the history grows.
  const blocks = request.messages.at(-1).content
  assert.deepEqual(blocks.at(-1).cache_control, { type: 'ephemeral' })
  assert.equal(request.messages[0].content[0].cache_control, undefined)
  // `system` and `tools` keep the shapes the gateway has already accepted.
  assert.equal(typeof request.system, 'string')
  assert.equal(JSON.stringify(request.tools).includes('cache_control'), false)

  const uncached = buildAnthropicRequest({ model: 'claude-sonnet-5-5', messages: [user('hi')] }, undefined, 'budget', false)
  assert.equal(JSON.stringify(uncached).includes('cache_control'), false)
})

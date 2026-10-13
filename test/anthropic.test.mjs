import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAnthropicRequest, buildMessages } from '../lib/anthropic.js'

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

test('system-role text moves into the system field, in order', () => {
  const request = buildAnthropicRequest(
    {
      model: 'claude-sonnet-5',
      system: 'one-shot preamble',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'session prompt' }] }, user('hi')],
    },
    undefined,
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
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' },
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

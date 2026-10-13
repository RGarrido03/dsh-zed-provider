import { ZedStreamError, zedFrames } from './frames.js'

/**
 * Zed Cloud `/completions` NDJSON -> harness `StreamChunk` translation for the
 * Anthropic wire backend. Framing lives in ./frames.js, shared with the OpenAI
 * Responses backend.
 *
 * Zed streams line-delimited JSON, not SSE: each line is either a status
 * envelope (`{"status":"stream_ended"}`, `{"status":{"failed":{...}}}`,
 * `{"status":{"incomplete":{...}}}`) or one event, bare or wrapped in
 * `{"event":{...}}`. The Anthropic events inside are the standard
 * `content_block_*` / `message_*` shapes.
 *
 * Pure data in, plain chunk objects out: no harness imports, so this file is
 * runnable under plain node (see test/parse.test.mjs).
 */

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function addUsage(usage, partial) {
  if (!partial || typeof partial !== 'object') return
  const take = (key) => (typeof partial[key] === 'number' && Number.isFinite(partial[key]) ? partial[key] : undefined)
  const input = take('inputTokens')
  const output = take('outputTokens')
  const cacheRead = take('cacheReadTokens')
  const cacheWrite = take('cacheWriteTokens')
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
}

/**
 * Map an Anthropic `stop_reason` onto a harness finish kind.
 * @returns `{ kind, wire }` — the harness kind plus the raw wire reason.
 */
function finishKindOf(stopReason) {
  switch (stopReason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return { kind: 'max-tokens', wire: stopReason }
    case 'tool_use':
      return { kind: 'tool-calls', wire: stopReason }
    default:
      return { kind: 'stop', wire: stopReason }
  }
}

/**
 * Translate one Zed `/completions` response body into harness chunks.
 *
 * @param body - response body stream.
 * @param options.signal - caller cancellation; aborting mid-read throws.
 * @param options.onEvent - optional observer for chunk-level wiring tests.
 * @returns async iterable of StreamChunk values, ending with `finish`.
 */
export async function* parseZedAnthropicStream(body, options = {}) {
  const { signal } = options
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  /** One replay entry per emitted block, aligned by position. */
  const replayBlocks = []
  let index = -1
  let open = null
  let stopReason = 'stop'
  let sawToolCall = false
  /** Tool calls whose final arguments never became a JSON object. */
  const unusable = []
  let sawStreamEnded = false

  const closeOpen = () => {
    if (open === null) return null
    const closing = open
    open = null
    if (closing.kind === 'text') {
      replayBlocks.push(null)
      return { type: 'block-end', index, block: { type: 'text', text: closing.text } }
    }
    if (closing.kind === 'reasoning') {
      replayBlocks.push({ kind: 'reasoning', signature: closing.signature })
      return { type: 'block-end', index, block: { type: 'reasoning', text: closing.text } }
    }
    replayBlocks.push(null)
    const raw = closing.args || '{}'
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) unusable.push(closing)
    return {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: closing.id, name: closing.name, arguments: raw },
    }
  }

  for await (const frame of zedFrames(body, signal)) {
    if (frame.kind === 'ended') {
      sawStreamEnded = true
      break
    }
    if (frame.kind === 'incomplete') {
      stopReason = 'max_tokens'
      continue
    }
    const event = frame.event

    const eventType = event.type

    if (eventType === 'error') {
      const error = event.error ?? {}
      throw new ZedStreamError(
        `Zed Cloud stream error ${error.code ?? 'unknown'}: ${error.message ?? 'no message'}`,
        'PROVIDER_ERROR',
      )
    }

    if (eventType === 'message_start') {
      const messageUsage = event.message?.usage
      addUsage(usage, {
        inputTokens: messageUsage?.input_tokens,
        outputTokens: messageUsage?.output_tokens,
        cacheReadTokens: messageUsage?.cache_read_input_tokens,
        cacheWriteTokens: messageUsage?.cache_creation_input_tokens,
      })
      continue
    }

    if (eventType === 'message_delta') {
      if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason
      addUsage(usage, { outputTokens: event.usage?.output_tokens })
      continue
    }

    if (eventType === 'content_block_start') {
      const closed = closeOpen()
      if (closed !== null) yield closed
      const block = event.content_block ?? {}
      if (block.type === 'text') {
        index += 1
        open = { kind: 'text', text: '' }
        yield { type: 'block-start', index, blockType: 'text' }
      } else if (block.type === 'thinking') {
        index += 1
        open = { kind: 'reasoning', text: '', signature: '' }
        yield { type: 'block-start', index, blockType: 'reasoning' }
      } else if (block.type === 'tool_use') {
        index += 1
        sawToolCall = true
        open = {
          kind: 'tool-call',
          id: textOf(block.id) || randomId(),
          name: textOf(block.name),
          args: '',
        }
        yield { type: 'block-start', index, blockType: 'tool-call' }
      } else {
        // redacted_thinking (and anything unknown) has no harness block; the
        // turn stays readable, its opaque payload is simply not replayed.
        open = null
      }
      continue
    }

    if (eventType === 'content_block_delta') {
      const delta = event.delta ?? {}
      if (open === null) continue // deltas never open a block
      if (delta.type === 'text_delta' && open.kind === 'text') {
        open.text += textOf(delta.text)
        yield { type: 'text-delta', index, text: textOf(delta.text) }
      } else if (delta.type === 'thinking_delta' && open.kind === 'reasoning') {
        open.text += textOf(delta.thinking)
        yield { type: 'reasoning-delta', index, text: textOf(delta.thinking) }
      } else if (delta.type === 'signature_delta' && open.kind === 'reasoning') {
        open.signature += textOf(delta.signature)
      } else if (delta.type === 'input_json_delta' && open.kind === 'tool-call') {
        open.args += textOf(delta.partial_json)
        yield {
          type: 'tool-call-delta',
          index,
          id: open.id,
          name: open.name,
          argumentsDelta: textOf(delta.partial_json),
        }
      }
      continue
    }

    if (eventType === 'content_block_stop') {
      const closed = closeOpen()
      if (closed !== null) yield closed
      continue
    }
  }

  if (!sawStreamEnded) {
    throw new ZedStreamError('Zed stream closed before the stream_ended status arrived', 'INCOMPLETE_STREAM')
  }

  const closed = closeOpen()
  if (closed !== null) yield closed

  if (stopReason === 'refusal' || stopReason === 'sensitive') {
    throw new ZedStreamError(`Anthropic stop reason: ${stopReason}`, 'PROVIDER_ERROR')
  }

  const finish = finishKindOf(stopReason)
  // A truncated turn keeps its tool calls; the harness drops those itself. Any
  // other turn whose tool input never became a JSON object is unrunnable, so it
  // fails loudly rather than reaching a tool with arguments it cannot read.
  if (finish.kind !== 'max-tokens' && unusable.length > 0) {
    throw new ZedStreamError(
      `Zed Cloud returned tool input that is not valid JSON for ${unusable
        .map((block) => block.name || block.id || 'a tool call')
        .join(', ')}`,
      'MALFORMED_RESPONSE',
    )
  }
  // A turn that produced tool calls is a tool-calls turn even when the wire
  // reported a plain stop.
  const kind = finish.kind === 'stop' && sawToolCall ? 'tool-calls' : finish.kind

  const usageChunk = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
  }
  if (usage.cacheReadTokens > 0) usageChunk.cacheReadTokens = usage.cacheReadTokens
  if (usage.cacheWriteTokens > 0) usageChunk.cacheWriteTokens = usage.cacheWriteTokens
  yield { type: 'usage', usage: usageChunk }

  yield {
    type: 'finish',
    reason: { kind },
    replayState: { response: { backend: 'anthropic', stopReason: finish.wire }, blocks: replayBlocks },
  }
}

function randomId() {
  return `toolu_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/** Historical name this module exported; both backends throw frames.js's class. */
export const LlmStreamError = ZedStreamError

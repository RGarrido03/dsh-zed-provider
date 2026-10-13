/**
 * Zed Cloud `open_ai` backend (OpenAI Responses wire format): harness
 * `GenerateOptions` -> `provider_request`, and response NDJSON -> harness
 * `StreamChunk`.
 *
 * Pure data in, plain chunk objects out: no harness imports, so
 * test/responses.test.mjs runs this exact code under plain node.
 * `options.messages` must already be projected onto this route's modalities
 * (index.js calls `projectImagesForTextModel` first); every message and block
 * is read-only here.
 */

import { ZedStreamError, zedFrames } from './frames.js'

/** The one provider route this bundle owns. */
const PROVIDER = 'zed-agent'
const DEFAULT_MAX_OUTPUT_TOKENS = 8192
/** Harness reasoning effort -> Responses `reasoning.effort`. */
const REASONING_EFFORTS = { low: 'low', high: 'medium', max: 'high' }
const EMPTY_ARGS = '{}'

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/** Concatenate every system-role message plus a one-shot `system` prompt. */
function collectSystem(options) {
  const parts = []
  if (typeof options.system === 'string' && options.system.trim().length > 0) parts.push(options.system)
  for (const message of options.messages ?? []) {
    if (message?.role !== 'system') continue
    for (const block of blocksOf(message.content)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/**
 * The Responses `reasoning` item this adapter stored for one assistant block,
 * or undefined when there is none to replay. Accepts the parsed item this
 * parser writes into `replayState.blocks` (and, defensively, its JSON text:
 * the PR stores the item as a string signature).
 */
function replayItem(entry) {
  let item = entry
  if (typeof item === 'string') {
    try {
      item = JSON.parse(item)
    } catch {
      return undefined
    }
  }
  if (item === null || typeof item !== 'object') return undefined
  // An unsigned or foreign item would be rejected (or worse, accepted) by the
  // provider as a different reasoning turn; only a real reasoning item replays.
  if (item.type !== 'reasoning') return undefined
  if (typeof item.id !== 'string' || item.id.length === 0) return undefined
  return item
}

/** Replay metadata this adapter stores per assistant message, same route only. */
function replayOf(message, model) {
  const source = message?.source
  if (source?.provider !== PROVIDER || source?.model !== model) return undefined
  const state = source?.replayState
  if (state === null || typeof state !== 'object' || !Array.isArray(state.blocks)) return undefined
  return state.blocks
}

function toolResultOutput(message) {
  return blocksOf(message.content)
    .map((block) => (block.type === 'text' ? textOf(block.text) : '[content omitted]'))
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * Project one assistant message onto Responses input items. Text accumulates
 * into a single `message` item that flushes before any non-text item, tool
 * calls become `function_call` items, and reasoning replays only as the item
 * this same provider+model stored for that exact block.
 */
function assistantItems(message, model) {
  const replayed = replayOf(message, model)
  const items = []
  let parts = null

  const flush = () => {
    if (parts !== null && parts.length > 0) items.push({ type: 'message', role: 'assistant', content: parts })
    parts = null
  }

  blocksOf(message.content).forEach((block, position) => {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) {
        parts ??= []
        parts.push({ type: 'output_text', text: block.text })
      }
      return
    }
    if (block.type === 'reasoning') {
      const item = replayItem(replayed?.[position])
      // never send unsigned reasoning: without the stored item the block is dropped.
      if (item === undefined) return
      flush()
      items.push({ ...item })
      return
    }
    if (block.type === 'tool-call') {
      flush()
      items.push({
        type: 'function_call',
        call_id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
      })
    }
  })
  flush()
  return items
}

/**
 * Harness history -> OpenAI Responses `provider_request`, as Zed Cloud's
 * `open_ai` backend receives it.
 */
export function buildResponsesRequest(options, entry) {
  const requested = typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) ? options.maxTokens : 0
  const advertised = typeof entry?.max_output_tokens === 'number' ? entry.max_output_tokens : 0
  const maxOutputTokens =
    requested > 0 ? Math.trunc(requested) : advertised > 0 ? Math.trunc(advertised) : DEFAULT_MAX_OUTPUT_TOKENS

  const input = []
  for (const message of options.messages ?? []) {
    const role = message?.role
    if (role === 'system') continue
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.toolCallId ?? message.source?.callId ?? ''),
        output: toolResultOutput(message),
      })
      continue
    }
    if (role === 'assistant') {
      for (const item of assistantItems(message, options.model)) input.push(item)
      continue
    }
    if (role === 'user' || role === 'developer') {
      const content = blocksOf(message.content)
        .map((block) => (block.type === 'text' ? { type: 'input_text', text: textOf(block.text) } : undefined))
        .filter((part) => part !== undefined && part.text.length > 0)
      if (content.length > 0) input.push({ type: 'message', role, content })
    }
  }

  const request = {
    model: options.model,
    input,
    stream: true,
    max_output_tokens: maxOutputTokens,
  }

  const instructions = collectSystem(options)
  if (instructions.length > 0) request.instructions = instructions

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    request.tools = options.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }

  const effort = REASONING_EFFORTS[options.reasoningEffort]
  if (entry?.supports_thinking === true && effort !== undefined) {
    request.reasoning = { effort, summary: 'auto' }
  }
  // Reasoning rejects sampling parameters, so they only travel without it.
  if (request.reasoning === undefined && typeof options.temperature === 'number') {
    request.temperature = options.temperature
  }
  return request
}

/** The Responses summary text of one reasoning item, if it carries any. */
function reasoningSeed(item) {
  if (item === null || typeof item !== 'object') return ''
  if (Array.isArray(item.summary)) {
    return item.summary
      .map((part) => (part !== null && typeof part === 'object' ? textOf(part.text) : ''))
      .filter((text) => text.length > 0)
      .join('\n\n')
  }
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) =>
        part !== null && typeof part === 'object' && part.type === 'reasoning_text' ? textOf(part.text) : '',
      )
      .filter((text) => text.length > 0)
      .join('\n\n')
  }
  return ''
}

function wholeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/**
 * Translate one Zed `/completions` response body from the `open_ai` backend
 * into harness chunks.
 *
 * @param body - response body stream.
 * @param options.signal - caller cancellation; aborting mid-read throws.
 * @returns async iterable of StreamChunk values, ending with `finish`.
 */
export async function* parseZedResponsesStream(body, options = {}) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  /** One `{ index, state }` per emitted block; the replay entry is read at the end. */
  const emitted = []
  /** Chunks produced while handling one frame, yielded once that frame settles. */
  const pending = []
  const reasoningByKey = new Map()
  const toolCallByKey = new Map()
  const reasonings = []
  const toolCalls = []
  let index = -1
  let text = null
  let incomplete = false
  let sawToolCall = false
  /** Tool calls whose final arguments never became a JSON object. */
  const unusable = []

  const emit = (chunk) => pending.push(chunk)

  /** Wire identity of one Responses item event, as its `item_id`/`output_index` keys. */
  const identityOf = (event) => {
    const item = event.item ?? event.output_item
    const itemId =
      typeof event.item_id === 'string' ? event.item_id : typeof item?.id === 'string' ? item.id : undefined
    const callId =
      typeof event.call_id === 'string' ? event.call_id : typeof item?.call_id === 'string' ? item.call_id : undefined
    const outputIndex = wholeNumber(event.output_index) ?? wholeNumber(item?.output_index)
    const keys = []
    if (itemId !== undefined) keys.push(`item:${itemId}`)
    if (callId !== undefined) keys.push(`call:${callId}`)
    if (outputIndex !== undefined) keys.push(`output:${outputIndex}`)
    return { item, itemId, callId, outputIndex, keys }
  }

  const matchByKey = (table, event) => {
    for (const key of identityOf(event).keys) {
      const found = table.get(key)
      if (found !== undefined) return found
    }
    return null
  }

  const mostRecentOpen = (states) => {
    for (let position = states.length - 1; position >= 0; position -= 1) {
      if (!states[position].closed) return states[position]
    }
    return null
  }

  const closeState = (state, item) => {
    if (state === null || state === undefined) return
    // A `done` item can land after the block was closed by its own `*_text.done`
    // event: keep the freshest item for replay either way.
    if (item !== null && item !== undefined) {
      if (state.kind === 'reasoning') state.item = item
      else if (state.kind === 'tool-call' && typeof item.arguments === 'string') state.args = item.arguments
    }
    if (state.closed) return
    state.closed = true
    if (state === text) text = null
    if (state.kind === 'text') {
      emit({ type: 'block-end', index: state.index, block: { type: 'text', text: state.body } })
    } else if (state.kind === 'reasoning') {
      emit({ type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.body } })
    } else {
      const raw = state.args.trim().length > 0 ? state.args : EMPTY_ARGS
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
      // The block is emitted either way: this harness assembles blocks from
      // their deltas, so suppressing block-end would not drop it and would
      // desynchronise the replay array. Unusable arguments are reported at the
      // terminal step instead, exactly as the DeepSeek adapter does.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) unusable.push(state)
      else sawToolCall = true
      emit({ type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: raw } })
    }
    emitted.push({ index: state.index, state })
  }

  const closeOpenBlocks = () => {
    const open = [text, ...reasonings, ...toolCalls].filter((state) => state !== null && !state.closed)
    open.sort((left, right) => left.index - right.index)
    for (const state of open) closeState(state)
  }

  const startText = () => {
    if (text !== null) return text
    closeState(mostRecentOpen(reasonings))
    index += 1
    text = { kind: 'text', index, body: '' }
    emit({ type: 'block-start', index, blockType: 'text' })
    return text
  }

  const startReasoning = (event, seed, item) => {
    closeState(text)
    closeState(mostRecentOpen(reasonings))
    index += 1
    const state = {
      kind: 'reasoning',
      index,
      body: seed,
      item: item ?? null,
      closed: false,
      keys: identityOf(event).keys,
    }
    for (const key of state.keys) reasoningByKey.set(key, state)
    reasonings.push(state)
    emit({ type: 'block-start', index, blockType: 'reasoning' })
    return state
  }

  const startToolCall = (event, item) => {
    closeState(text)
    closeState(mostRecentOpen(reasonings))
    index += 1
    const identity = identityOf(event)
    const state = {
      kind: 'tool-call',
      index,
      id: textOf(item?.call_id) || textOf(item?.id) || textOf(identity.callId) || textOf(identity.itemId),
      name: textOf(item?.name),
      args: typeof item?.arguments === 'string' ? item.arguments : '',
      closed: false,
      keys: identity.keys,
    }
    for (const key of state.keys) toolCallByKey.set(key, state)
    toolCalls.push(state)
    emit({ type: 'block-start', index, blockType: 'tool-call' })
    return state
  }

  const applyUsage = (event) => {
    const partial = event.usage ?? event.response?.usage
    if (partial === null || typeof partial !== 'object') return
    const cached = wholeNumber(partial.input_tokens_details?.cached_tokens)
    const input = wholeNumber(partial.input_tokens)
    const output = wholeNumber(partial.output_tokens)
    if (input !== undefined) usage.inputTokens = Math.max(0, input - (cached ?? 0))
    if (output !== undefined) usage.outputTokens = output
    if (cached !== undefined && cached > 0) usage.cacheReadTokens = cached
  }

  for await (const frame of zedFrames(body, options.signal)) {
    if (frame.kind === 'ended') break
    if (frame.kind === 'incomplete') {
      incomplete = true
      continue
    }

    const event = frame.event
    applyUsage(event)
    const eventType = event.type
    const item = event.item ?? event.output_item

    if (eventType === 'error') {
      const error = event.error ?? event
      throw new ZedStreamError(
        `Error Code ${error.code ?? 'unknown'}: ${error.message ?? 'no message'}`,
        'PROVIDER_ERROR',
      )
    }

    if (eventType === 'response.output_item.added') {
      if (item?.type === 'reasoning') startReasoning(event, reasoningSeed(item), item)
      else if (item?.type === 'function_call') startToolCall(event, item)
    } else if (
      eventType === 'response.output_text.delta' ||
      eventType === 'response.text.delta' ||
      eventType === 'response.refusal.delta'
    ) {
      if (typeof event.delta === 'string') {
        const block = startText()
        block.body += event.delta
        emit({ type: 'text-delta', index: block.index, text: event.delta })
      }
    } else if (
      eventType === 'response.reasoning_summary_text.delta' ||
      eventType === 'response.reasoning.delta' ||
      eventType === 'response.reasoning_text.delta'
    ) {
      if (typeof event.delta === 'string') {
        closeState(text)
        const matched = matchByKey(reasoningByKey, event)
        const block =
          matched !== null && !matched.closed ? matched : (mostRecentOpen(reasonings) ?? startReasoning(event, '', item))
        block.body += event.delta
        emit({ type: 'reasoning-delta', index: block.index, text: event.delta })
      }
    } else if (eventType === 'response.function_call_arguments.delta') {
      if (typeof event.delta === 'string') {
        closeState(text)
        closeState(mostRecentOpen(reasonings))
        const matched = matchByKey(toolCallByKey, event)
        const block = matched !== null && !matched.closed ? matched : mostRecentOpen(toolCalls)
        if (block !== null) {
          block.args += event.delta
          emit({
            type: 'tool-call-delta',
            index: block.index,
            id: block.id,
            name: block.name,
            argumentsDelta: event.delta,
          })
        }
      }
    } else if (eventType === 'response.output_item.done' || eventType === 'response.function_call_arguments.done') {
      if (item?.type === 'reasoning') {
        closeState(matchByKey(reasoningByKey, event) ?? mostRecentOpen(reasonings), item)
      } else if (item?.type === 'function_call' || eventType === 'response.function_call_arguments.done') {
        const done = item ?? (typeof event.arguments === 'string' ? event : undefined)
        closeState(matchByKey(toolCallByKey, event) ?? mostRecentOpen(toolCalls), done)
      } else {
        // A message/refusal item (or an unknown one) ends whatever text and
        // reasoning the turn still had open.
        closeState(text)
        closeState(mostRecentOpen(reasonings))
      }
    } else if (
      eventType === 'response.output_text.done' ||
      eventType === 'response.text.done' ||
      eventType === 'response.refusal.done'
    ) {
      closeState(text)
    } else if (eventType === 'response.reasoning_summary_text.done' || eventType === 'response.reasoning.done') {
      closeState(matchByKey(reasoningByKey, event) ?? mostRecentOpen(reasonings))
    } else if (eventType === 'response.completed' || eventType === 'response.done') {
      const response = event.response ?? event
      if (response.status === 'incomplete') {
        incomplete = true
        if (response.incomplete_details?.reason === 'content_filter') {
          throw new ZedStreamError('incomplete: content_filter', 'CONTENT_BLOCKED')
        }
      } else if (response.status === 'failed' || response.status === 'cancelled') {
        const error = response.error
        throw new ZedStreamError(
          error
            ? `${error.code || 'unknown'}: ${error.message || 'no message'}`
            : `Response ${response.status}`,
          'PROVIDER_ERROR',
        )
      }
      closeOpenBlocks()
    } else if (eventType === 'response.incomplete') {
      incomplete = true
      const reason = (event.response ?? event).incomplete_details?.reason
      if (reason === 'content_filter') {
        throw new ZedStreamError('incomplete: content_filter', 'CONTENT_BLOCKED')
      }
    } else if (eventType === 'response.failed') {
      const response = event.response ?? event
      const error = response.error ?? response.status_details?.error
      const details = response.incomplete_details
      const statusReason = response.status_details?.reason
      const message = error
        ? `${error.code || 'unknown'}: ${error.message || 'no message'}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : statusReason
            ? `status_details: ${statusReason}`
            : 'Unknown error (no error details in response)'
      throw new ZedStreamError(message, 'PROVIDER_ERROR')
    }

    while (pending.length > 0) yield pending.shift()
  }

  closeState(text)
  closeOpenBlocks()
  while (pending.length > 0) yield pending.shift()

  // A truncated turn keeps its tool calls; the harness drops those itself. Any
  // other turn whose tool input never became a JSON object is unrunnable, so it
  // fails loudly rather than reaching a tool with arguments it cannot read.
  if (!incomplete && unusable.length > 0) {
    throw new ZedStreamError(
      `Zed Cloud returned tool input that is not valid JSON for ${unusable.map((state) => state.name || state.id || 'a tool call').join(', ')}`,
      'MALFORMED_RESPONSE',
    )
  }

  // Exactly one replay entry per emitted block, in first-seen order: the whole
  // stored reasoning item for reasoning blocks, null for everything else.
  const replayBlocks = emitted
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((entry) => (entry.state.kind === 'reasoning' ? entry.state.item ?? null : null))

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
    reason: { kind: incomplete ? 'max-tokens' : sawToolCall ? 'tool-calls' : 'stop' },
    replayState: { response: { backend: 'open_ai' }, blocks: replayBlocks },
  }
}

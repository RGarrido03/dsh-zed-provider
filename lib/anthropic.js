/**
 * Harness history -> Anthropic Messages `provider_request`, as Zed Cloud's
 * `anthropic` backend receives it.
 *
 * Harness types arrive through `import type` only: the emitted module has no
 * imports at all, so test/anthropic.test.mjs runs it under plain node.
 *
 * Pure data in, plain JSON out: no harness imports, so test/anthropic.test.mjs
 * runs this exact code under plain node. `options.messages` must already be
 * projected onto this route's modalities (index.js calls
 * `projectImagesForTextModel` first).
 */
/** The one provider route this bundle owns. */
const PROVIDER = 'zed-agent';
const THINKING_BUDGETS = { low: 4096, high: 16384, max: 32768 };
const MIN_THINKING_BUDGET = 1024;
const DEFAULT_MAX_TOKENS = 8192;
function blocksOf(content) {
    if (typeof content === 'string')
        return [{ type: 'text', text: content }];
    return Array.isArray(content) ? content : [];
}
/** Concatenate every system-role message plus a one-shot `system` prompt. */
function collectSystem(options) {
    const parts = [];
    if (typeof options.system === 'string' && options.system.trim().length > 0)
        parts.push(options.system);
    for (const message of options.messages ?? []) {
        if (message?.role !== 'system')
            continue;
        for (const block of blocksOf(message.content)) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
                parts.push(block.text);
        }
    }
    return parts.join('\n\n');
}
function toolResultContent(message) {
    const blocks = blocksOf(message.content);
    if (blocks.every((block) => block.type === 'text')) {
        return blocks
            .filter((block) => typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n');
    }
    return blocks
        .map((block) => (block.type === 'text' ? String(block.text ?? '') : '[content omitted]'))
        .filter((text) => text.length > 0)
        .map((text) => ({ type: 'text', text }));
}
/** Replay metadata this adapter stores per assistant message, same route only. */
function replayOf(message, model) {
    // Hand-built requests may carry an assistant message with no source at all
    // (the durable log always has one), so the whole chain stays optional.
    const source = message.source;
    if (source?.provider !== PROVIDER || source?.model !== model)
        return undefined;
    const replayState = source.replayState;
    if (replayState === null || typeof replayState !== 'object')
        return undefined;
    const blocks = replayState.blocks;
    return Array.isArray(blocks) ? blocks : undefined;
}
function assistantContent(message, model) {
    const replayed = replayOf(message, model);
    const content = [];
    blocksOf(message.content).forEach((block, position) => {
        if (block.type === 'text') {
            if (typeof block.text === 'string' && block.text.length > 0)
                content.push({ type: 'text', text: block.text });
            return;
        }
        if (block.type === 'reasoning') {
            const signature = replayed?.[position]?.signature;
            // Anthropic only accepts thinking back with its signature; an unsigned
            // block (another model, or a lost envelope) is dropped instead of sent.
            if (typeof signature === 'string' && signature.length > 0 && typeof block.text === 'string') {
                content.push({ type: 'thinking', thinking: block.text, signature });
            }
            return;
        }
        if (block.type === 'tool-call') {
            let input = {};
            try {
                input = block.arguments ? JSON.parse(block.arguments) : {};
            }
            catch {
                input = {};
            }
            content.push({ type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input });
        }
    });
    return content;
}
function userContent(message) {
    const content = [];
    for (const block of blocksOf(message.content)) {
        if (block.type === 'text') {
            if (typeof block.text === 'string' && block.text.length > 0)
                content.push({ type: 'text', text: block.text });
        }
        else if (block.type === 'image') {
            content.push({ type: 'text', text: '[image omitted]' });
        }
    }
    return content;
}
/**
 * Project harness history onto Anthropic Messages: system-role text moves into
 * `system`, and consecutive tool results merge into one user turn (Anthropic
 * requires every `tool_result` to answer the preceding `tool_use` turn).
 */
export function buildMessages(source, model) {
    const messages = [];
    let pendingToolResults = null;
    const flushToolResults = () => {
        if (pendingToolResults === null)
            return;
        messages.push({ role: 'user', content: pendingToolResults });
        pendingToolResults = null;
    };
    for (const message of source) {
        const role = message?.role;
        if (role === 'system')
            continue;
        if (role === 'tool') {
            pendingToolResults ??= [];
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: String(message.toolCallId ?? message.source?.callId ?? ''),
                content: toolResultContent(message),
                ...(message.isError === true ? { is_error: true } : {}),
            });
            continue;
        }
        flushToolResults();
        if (role === 'assistant') {
            const content = assistantContent(message, model);
            if (content.length > 0)
                messages.push({ role: 'assistant', content });
            continue;
        }
        if (role === 'user' || role === 'developer') {
            const content = userContent(message);
            if (content.length > 0)
                messages.push({ role: 'user', content });
        }
    }
    flushToolResults();
    return messages;
}
export function buildAnthropicRequest(options, entry) {
    const requested = typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) ? options.maxTokens : 0;
    const advertised = typeof entry?.max_output_tokens === 'number' ? entry.max_output_tokens : 0;
    const maxTokens = requested > 0 ? Math.trunc(requested) : advertised > 0 ? Math.trunc(advertised) : DEFAULT_MAX_TOKENS;
    const request = {
        model: options.model,
        messages: buildMessages(options.messages ?? [], options.model),
        max_tokens: maxTokens,
    };
    const system = collectSystem(options);
    if (system.length > 0)
        request.system = system;
    if (Array.isArray(options.tools) && options.tools.length > 0) {
        request.tools = options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            input_schema: tool.parameters ?? { type: 'object', properties: {} },
        }));
    }
    const effort = options.reasoningEffort;
    const budget = typeof effort === 'string' ? THINKING_BUDGETS[effort] : undefined;
    if (entry?.supports_thinking === true && budget !== undefined) {
        const clamped = Math.min(budget, maxTokens - 1);
        if (clamped >= MIN_THINKING_BUDGET)
            request.thinking = { type: 'enabled', budget_tokens: clamped };
    }
    // Extended thinking rejects sampling parameters, so they only travel without it.
    if (request.thinking === undefined && typeof options.temperature === 'number') {
        request.temperature = options.temperature;
    }
    if (Array.isArray(options.stop) && options.stop.length > 0) {
        request.stop_sequences = options.stop.slice(0, 4);
    }
    return request;
}

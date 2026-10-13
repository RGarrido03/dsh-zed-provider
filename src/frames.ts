/**
 * Shared NDJSON framing for Zed Cloud `/completions`, used by every wire
 * backend this bundle speaks.
 *
 * Zed streams line-delimited JSON, not SSE: each line is either a status
 * envelope (`{"status":"stream_ended"}`, `{"status":{"failed":{...}}}`,
 * `{"status":{"incomplete":{...}}}`) or one event, bare or wrapped in
 * `{"event":{...}}`. The status envelope is decoded here so the per-backend
 * parsers only ever see events plus the two terminal signals.
 *
 * Pure data in, plain records out: no harness imports, so this file is
 * runnable under plain node (see test/responses.test.mjs).
 */

const STATUS = {
  ENDED: 'stream_ended',
}

/** Stream failure carrying a harness-routable code; index.ts re-wraps it as LlmError. */
export class ZedStreamError extends Error {
  /** Stable provider-neutral code the adapter maps onto an `LlmError`. */
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ZedStreamError'
    this.code = code
  }
}

/**
 * One decoded framing record.
 *
 * `event` keeps the wire object as `unknown` values on purpose: the per-backend
 * parsers narrow exactly the fields they read rather than trusting a schema the
 * server never promised.
 */
export type ZedFrame =
  | { kind: 'event'; event: Record<string, unknown> }
  | { kind: 'incomplete'; reason: unknown }
  | { kind: 'ended' }

/** Split one web ReadableStream of bytes into text lines. */
export async function* splitLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        yield line
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) yield buffer
  } finally {
    // A consumer that stops at `stream_ended` must still release the socket.
    await reader.cancel().catch(() => {})
  }
}

/**
 * Decode one Zed `/completions` body into framing records.
 *
 * @param body - response body stream.
 * @param signal - caller cancellation; aborting mid-read throws its reason.
 * @returns async iterable yielding `{kind:'event', event}` for one wire event,
 *   `{kind:'incomplete', reason}` for a terminal-but-cut turn, and
 *   `{kind:'ended'}` once `stream_ended` has been seen. A body that ends
 *   without `stream_ended` throws `ZedStreamError('INCOMPLETE_STREAM')`.
 */
export async function* zedFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ZedFrame> {
  for await (const rawLine of splitLines(body)) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
    const line = rawLine.trim()
    if (line.length === 0) continue

    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      continue // Zed interleaves nothing else; an unparsable line carries no chunk.
    }
    if (frame === null || typeof frame !== 'object') continue
    const record = frame as Record<string, unknown>

    const status = record.status
    if (status) {
      if (status === STATUS.ENDED) {
        yield { kind: 'ended' }
        return
      }
      if (typeof status === 'object' && status !== null) {
        const detail = status as Record<string, unknown>
        const failed = detail.failed as { message?: unknown } | null | undefined
        if (failed !== null && typeof failed === 'object' && typeof failed.message === 'string') {
          throw new ZedStreamError(`Zed Cloud reported a failed turn: ${failed.message}`, 'PROVIDER_ERROR')
        }
        const incomplete = detail.incomplete as { reason?: unknown; message?: unknown } | null | undefined
        if (incomplete !== null && typeof incomplete === 'object') {
          const reason = incomplete.reason ?? incomplete.message
          if (reason === 'content_filter') {
            throw new ZedStreamError('Zed Cloud stopped the turn: content filter', 'CONTENT_BLOCKED')
          }
          yield { kind: 'incomplete', reason }
        }
      }
      // Any other truthy status carries no chunk; the backend ignores it too.
      continue
    }

    // A bare event, or one wrapped in `{"event":{...}}`. An `error` event
    // stays an event: both backends decide how to surface it.
    const wrapped = record.event
    yield {
      kind: 'event',
      event: (wrapped !== null && typeof wrapped === 'object' ? wrapped : record) as Record<string, unknown>,
    }
  }

  throw new ZedStreamError('Zed stream closed before the stream_ended status arrived', 'INCOMPLETE_STREAM')
}

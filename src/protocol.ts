/**
 * Trae's SOLO wire protocol, implemented from the observed contract.
 *
 * Request  : POST {gateway}/api/agent/v3/llm_utils_chat   (headers in catalog.ts)
 * Request  : { messages, model, config_name, function, stream: true, tools?, reasoning_effort? }
 *            - a plain-string message content becomes [{ type: "text", text }]
 *            - assistant tool_calls become the wire's `function_call` shape
 *            - a tool's JSON-Schema `parameters` is sent as a JSON *string*
 * Response : named SSE. `event:` carries the kind, `data:` the payload:
 *              request_wait_in_queue / progress_notice / token_usage / output /
 *              done / error  (see decodeTraeEvent)
 * Emit     : OpenAI chat-completion chunks with delta.content,
 *            delta.reasoning_content and delta.tool_calls, then [DONE]
 *            (the shape pi-ai's openai-completions parser reads:
 *             reasoning fields are tried in the order reasoning_content,
 *             reasoning, reasoning_text — pi-ai/dist/api/openai-completions.js:399).
 *
 * ---------------------------------------------------------------------------
 * NOT IMPLEMENTED — image input (deliberate; found 2026-10-14)
 *
 * pi-ai sends an OpenAI-style content array, and an attached picture arrives as an
 * `image_url` content part next to the `text` parts. `buildTraeBody` below clones
 * `messages` and only rewrites plain-string content into `[{ type: 'text' }]`, so
 * such a part would travel to Trae untranslated: Trae does not read that shape, and
 * the user's picture would vanish with no error anywhere.
 *
 * That is why catalog.ts records `display_config.multimodal` but keeps every
 * model's `input` at `['text']`. To finish image support, in this order:
 *   1. establish the shape `llm_utils_chat` accepts for an image (a real IDE
 *      request, or how dsh-connect-trae does it — it uploads attachments rather
 *      than inlining base64 in the message);
 *   2. translate the `image_url` parts here, honouring the size/pixel budgets pi-ai
 *      applies upstream;
 *   3. only then let catalog.ts add 'image' to `input`.
 * Advertising images before step 3 is worse than not supporting them at all.
 * ---------------------------------------------------------------------------
 */
import type { TraeModel } from './catalog.ts'

export interface OpenAiChatRequest {
  model?: string
  messages?: unknown[]
  tools?: unknown[]
  reasoning_effort?: string
  stream?: boolean
  /** pi-ai asks for this; Trae always reports usage, so it is accepted and ignored. */
  stream_options?: unknown
  [key: string]: unknown
}

/** One model's wire target: the `config_name` chat accepts, plus the listing function. */
export interface TraeWireTarget {
  configName: string
  fn: string
}

export function wireTargetOf(model: TraeModel): TraeWireTarget {
  return { configName: model.id, fn: model.directoryFunction }
}

/**
 * Translate an OpenAI chat request into the Trae SOLO body.
 *
 * Throws on structurally impossible input instead of sending a request Trae will
 * reject with a vague code: the caller turns this into a 400.
 */
export function buildTraeBody(request: OpenAiChatRequest, target: TraeWireTarget, defaultFunction = 'solo_work_lite'): string {
  const messages = Array.isArray(request.messages) ? structuredClone(request.messages) : undefined
  if (messages === undefined || messages.length === 0) throw new Error('at least one message is required')
  const model = typeof request.model === 'string' && request.model.trim() !== '' ? request.model.trim() : target.configName
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) throw new Error('every message must be an object')
    const message = raw as Record<string, unknown>
    if (message['role'] === 'developer') message['role'] = 'system'
    if (typeof message['content'] === 'string') message['content'] = [{ type: 'text', text: message['content'] }]
    if (message['role'] === 'assistant' && Array.isArray(message['tool_calls'])) {
      for (const rawCall of message['tool_calls']) {
        if (typeof rawCall !== 'object' || rawCall === null) continue
        const call = rawCall as Record<string, unknown>
        if (typeof call['function'] === 'object' && call['function'] !== null) {
          call['function_call'] = call['function']
          delete call['function']
        }
      }
    }
    if (message['role'] === 'tool' && (typeof message['tool_call_id'] !== 'string' || message['tool_call_id'] === '')) {
      throw new Error('a tool message requires tool_call_id')
    }
  }
  const tools = Array.isArray(request.tools) ? structuredClone(request.tools) : undefined
  if (tools !== undefined) {
    for (const raw of tools) {
      if (typeof raw !== 'object' || raw === null) continue
      const fn = (raw as Record<string, unknown>)['function']
      if (typeof fn !== 'object' || fn === null) continue
      const record = fn as Record<string, unknown>
      if (typeof record['parameters'] === 'object' && record['parameters'] !== null) record['parameters'] = JSON.stringify(record['parameters'])
    }
  }
  return JSON.stringify({
    messages,
    model,
    config_name: model,
    function: target.fn === '' ? defaultFunction : target.fn,
    stream: true,
    ...(tools === undefined ? {} : { tools }),
    ...(typeof request.reasoning_effort === 'string' && request.reasoning_effort !== '' ? { reasoning_effort: request.reasoning_effort } : {})
  })
}

export interface SseEvent {
  event?: string
  data: string
}

/**
 * Split a Trae SSE byte stream into named events (multi-line `data:` joined by \n).
 *
 * ---------------------------------------------------------------------------
 * THE END OF THE STREAM IS A LINE BOUNDARY TOO (fixed 2026-10-15, D11)
 *
 * A socket closes wherever it closes. When the last line arrives WITHOUT its
 * trailing newline — an aborted connection, or any proxy that does not append the
 * final CRLF — a parser that only ever consumes `\n`-terminated lines leaves that
 * line in the buffer forever, and the event it belonged to is never dispatched.
 * The loss is silent and it is the worst possible event to lose: the closing
 * `done` carrying the finish reason, which is exactly what makes a reply look
 * "unfinished" to the user.
 *
 * So the residual buffer is now consumed through the SAME line routine before the
 * trailing dispatch — the pinned upstream does this in `SseDecoder.finish()`, and
 * byte-for-byte the outcome is identical to the stream having ended with a newline.
 *
 * THE `\r` IS STILL STRIPPED, deliberately: upstream hands `finish()` the raw
 * leftover, so a residual ending in a lone `\r` keeps it and hides the value behind
 * a trailing carriage return. That upstream behaviour is a defect, not the contract
 * (nothing Trae sends has one), so it is not copied. See tools/test-sse.ts for the
 * assertions and tools/test-contract.ts D11 for the ledger entry this closes.
 *
 * ---------------------------------------------------------------------------
 * THE HALF-CUT JSON RULE — WHAT A RESIDUAL IS *NOT* ALLOWED TO BECOME
 *
 * The residual is framed like any other line: a trailing `data: {"response":"po"`
 * becomes ONE event whose payload is that unparseable text. It is NOT repaired, NOT
 * split into "the complete part" and NOT guessed at: the framing layer decides
 * boundaries, and `decodeTraeEvent` above turns unparseable data into
 * `{ type: 'unknown' }`. The exact same bytes arriving WITH a newline already behave
 * that way today, so this is one rule for both spellings of the same input, not a
 * second one for the truncated case.
 *
 * Consequence, stated plainly because it is the visible one: a stream cut mid-JSON
 * now yields a final `unknown` event instead of yielding nothing. `unknown` is not
 * emittable — pumpTraeStream below drops it — so the client receives no truncated
 * content, no fabricated chunk and no error; the stream simply ends. (An earlier
 * draft considered "dispatch residual data only when it parses", which would have
 * required a JSON parse inside the framing layer, made the parser depend on the
 * payload vocabulary, and STILL lost the boundary for a half-cut payload. Rejected.)
 * ---------------------------------------------------------------------------
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined
      return undefined
    }
    const event: SseEvent = { data: dataLines.join('\n'), ...(eventName === undefined ? {} : { event: eventName }) }
    eventName = undefined
    dataLines = []
    return event
  }
  /**
   * One line of the wire. Returns the event it COMPLETED, if any.
   *
   * `data` with no colon is the field `data` with an empty value, so it dispatches an
   * empty payload rather than being ignored (this is D5, fixed 2026-10-15). A line
   * that is neither a comment nor one of the four fields is ignored.
   */
  const consumeLine = (line: string): SseEvent | undefined => {
    if (line === '') return flush()
    if (line.startsWith(':')) return undefined
    // `data` (no colon) is the `data` field with an empty value — D5: it used to be
    // ignored whole, which dropped a whole event boundary a proxy's keep-alive creates.
    if (line === 'data' || line.startsWith('data:')) dataLines.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''))
    else if (line.startsWith('event:')) eventName = line.slice(6).trim()
    return undefined
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const rawLine = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const event = consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
        if (event !== undefined) yield event
        index = buffer.indexOf('\n')
      }
    }
    // The end of the body is a line boundary: whatever arrived without a newline is
    // the last line, and the dispatch that follows closes the event it belonged to.
    buffer += decoder.decode()
    if (buffer !== '') {
      const residual = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      buffer = ''
      const event = consumeLine(residual)
      if (event !== undefined) yield event
    }
    // A last event whose data arrived but never met a blank line: still one event.
    const tail = flush()
    if (tail !== undefined) yield tail
  } finally {
    reader.releaseLock()
  }
}

export type TraeDecoded =
  | { type: 'queue'; position?: number }
  | { type: 'progress' }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cacheReadTokens?: number }
  | { type: 'done'; finishReason: string }
  | { type: 'delta'; text: string; reasoning?: string; toolCalls?: unknown }
  | { type: 'error'; code?: number; message: string; extra?: unknown }
  | { type: 'unknown'; event?: string; data: unknown }

/** Decode one named Trae event. Unknown events are preserved, never guessed at. */
export function decodeTraeEvent(event: SseEvent): TraeDecoded {
  if (event.data === '[DONE]') return { type: 'done', finishReason: 'stop' }
  let payload: unknown
  try {
    payload = JSON.parse(event.data)
  } catch {
    return { type: 'unknown', ...(event.event === undefined ? {} : { event: event.event }), data: event.data }
  }
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  if (event.event === 'request_wait_in_queue') {
    return { type: 'queue', ...(typeof record['position'] === 'number' ? { position: record['position'] } : {}) }
  }
  if (event.event === 'progress_notice') return { type: 'progress' }
  if (event.event === 'token_usage') {
    const num = (key: string): number | undefined => (typeof record[key] === 'number' ? (record[key] as number) : undefined)
    return {
      type: 'usage',
      ...(num('prompt_tokens') === undefined ? {} : { inputTokens: num('prompt_tokens') }),
      ...(num('completion_tokens') === undefined ? {} : { outputTokens: num('completion_tokens') }),
      ...(num('total_tokens') === undefined ? {} : { totalTokens: num('total_tokens') }),
      ...(num('reasoning_tokens') === undefined ? {} : { reasoningTokens: num('reasoning_tokens') }),
      ...(num('cache_read_input_tokens') === undefined ? {} : { cacheReadTokens: num('cache_read_input_tokens') })
    }
  }
  if (event.event === 'error' || typeof record['code'] === 'number') {
    const code = typeof record['code'] === 'number' ? record['code'] : undefined
    if (event.event === 'error' || (code !== undefined && code >= 4000)) {
      return {
        type: 'error',
        ...(code === undefined ? {} : { code }),
        message: typeof record['message'] === 'string' ? record['message'] : '',
        ...(record['extra'] === undefined ? {} : { extra: record['extra'] })
      }
    }
  }
  if (event.event === 'done' || (typeof record['finish_reason'] === 'string' && record['response'] === undefined)) {
    return { type: 'done', finishReason: typeof record['finish_reason'] === 'string' ? record['finish_reason'] : 'stop' }
  }
  if (event.event === 'output' || record['response'] !== undefined || record['reasoning_content'] !== undefined) {
    return {
      type: 'delta',
      text: typeof record['response'] === 'string' ? record['response'] : '',
      ...(typeof record['reasoning_content'] === 'string' ? { reasoning: record['reasoning_content'] } : {}),
      ...(record['tool_calls'] === undefined || record['tool_calls'] === null ? {} : { toolCalls: record['tool_calls'] })
    }
  }
  return { type: 'unknown', ...(event.event === undefined ? {} : { event: event.event }), data: payload }
}

export interface OpenAiToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

function normalizeToolCalls(value: unknown): OpenAiToolCallDelta[] {
  if (!Array.isArray(value)) return []
  const calls: OpenAiToolCallDelta[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const rawFunction =
      typeof record['function_call'] === 'object' && record['function_call'] !== null
        ? (record['function_call'] as Record<string, unknown>)
        : typeof record['function'] === 'object' && record['function'] !== null
          ? (record['function'] as Record<string, unknown>)
          : {}
    const fn: { name?: string; arguments?: string } = {
      ...(typeof rawFunction['name'] === 'string' ? { name: rawFunction['name'] } : {}),
      ...(typeof rawFunction['arguments'] === 'string' ? { arguments: rawFunction['arguments'] } : {})
    }
    calls.push({
      index: typeof record['index'] === 'number' ? record['index'] : calls.length,
      ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
      ...(record['type'] === 'function' ? { type: 'function' as const } : {}),
      ...(Object.keys(fn).length === 0 ? {} : { function: fn })
    })
  }
  return calls
}

/** Trae's in-stream error codes, as measured upstream and reproduced in 进展.md. */
export const TRAE_ERROR_HINTS: Readonly<Record<number, string>> = {
  1005: "Trae requires a paid plan for this model; the current account's plan does not cover it",
  4001: 'Trae does not serve this model under the SOLO function the request used (config_name rejected)',
  4011: 'Trae refused this model under the SOLO function the request used'
}

export function describeTraeError(error: { code?: number; message: string }): string {
  const head = error.code === undefined ? 'Trae refused the request' : (TRAE_ERROR_HINTS[error.code] ?? 'Trae refused the request')
  const detail = error.message.trim()
  return [head, ...(error.code === undefined ? [] : [`Trae code ${error.code}`]), ...(detail === '' ? [] : [`upstream: ${detail}`])].join(' · ')
}

/** `1005` is a subscription gate: 402 makes a client stop instead of retrying. */
export function statusForTraeError(code: number | undefined): number {
  return code === 1005 ? 402 : 400
}

export interface ChunkWriter {
  /** Emit one OpenAI SSE data payload. */
  write(payload: unknown): void
}

/**
 * Drive one Trae stream into OpenAI chunks.
 *
 * Returns the finish reason the stream ended with, or throws when Trae reported an
 * in-stream failure — the caller decides whether that is still an answerable HTTP
 * status (nothing has been written yet at that point only if it failed early; a
 * mid-stream failure is appended as an error chunk and the stream simply ends).
 */
export async function pumpTraeStream(
  events: AsyncGenerator<SseEvent>,
  writer: ChunkWriter,
  options: { model: string; onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void }
): Promise<{ finishReason: string; text: string; toolCalls: number }> {
  let text = ''
  let toolCalls = 0
  let finishReason = 'stop'
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
    writer.write({
      id: `chatcmpl-trae-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: options.model,
      choices: [{ index: 0, delta, finish_reason: null, ...extra }]
    })
  }
  for await (const event of events) {
    const decoded = decodeTraeEvent(event)
    if (decoded.type === 'delta') {
      if (decoded.reasoning !== undefined && decoded.reasoning !== '') chunk({ reasoning_content: decoded.reasoning })
      if (decoded.text !== '') {
        text += decoded.text
        chunk({ content: decoded.text })
      }
      if (decoded.toolCalls !== undefined) {
        const calls = normalizeToolCalls(decoded.toolCalls)
        if (calls.length > 0) {
          toolCalls += calls.length
          chunk({ tool_calls: calls })
          finishReason = 'tool_calls'
        }
      }
      continue
    }
    if (decoded.type === 'usage') {
      options.onUsage?.({ inputTokens: decoded.inputTokens, outputTokens: decoded.outputTokens })
      writer.write({
        id: `chatcmpl-trae-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: options.model,
        choices: [],
        usage: {
          prompt_tokens: decoded.inputTokens ?? 0,
          completion_tokens: decoded.outputTokens ?? 0,
          total_tokens: decoded.totalTokens ?? (decoded.inputTokens ?? 0) + (decoded.outputTokens ?? 0),
          ...(decoded.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: decoded.reasoningTokens } }),
          ...(decoded.cacheReadTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: decoded.cacheReadTokens } })
        }
      })
      continue
    }
    if (decoded.type === 'done') {
      if (decoded.finishReason === 'tool_calls' || decoded.finishReason === 'tool_call') finishReason = 'tool_calls'
      break
    }
    if (decoded.type === 'error') {
      writer.write({ error: { message: describeTraeError(decoded), type: 'trae_error', code: decoded.code ?? 'trae_error' } })
      finishReason = 'error'
      break
    }
    // queue / progress / unknown: nothing user-visible to emit
  }
  writer.write({
    id: `chatcmpl-trae-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason === 'error' ? 'stop' : finishReason }]
  })
  return { finishReason, text, toolCalls }
}

/**
 * `parseSseStream` / `pumpTraeStream` self-test — OFFLINE. No network, no credentials,
 * no gateway, no clock. Every byte below is constructed here and fed through a real
 * `ReadableStream`, exactly the way `src/shim.ts:243` and `src/api.ts:406` feed it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS — a boundary bug has no failing test until you write one
 *
 * `test-contract.ts` compares this parser against the pinned upstream `SseDecoder`
 * and it is the reason the two defects below were found. But it reports a DIVERGENCE
 * in a ledger; it does not assert what OUR parser must do on its own. So the two
 * behaviours that were wrong now have direct assertions here:
 *
 *   D11 — a stream whose last line has NO trailing newline lost that line, and with
 *         it the whole event. The worst event to lose is the closing `done` that
 *         carries `finish_reason`, because the reply then looks "unfinished" to the
 *         user and nothing anywhere said so. `src/protocol.ts:206-216` consumes the
 *         residual buffer now.
 *   D5  — a bare `data` line (the whole line, no colon) was ignored whole. Per the SSE
 *         specification it is the field `data` with an empty value, so it dispatches an
 *         event with an empty payload — an event BOUNDARY. `src/protocol.ts:186-188`.
 *
 * EVERYTHING IN GROUP 1 IS A REGRESSION GUARD: the same bytes as before, asserted
 * byte for byte. The fix may not move a single character of a stream that ends with a
 * newline, and the last assertions of group 1 are what says so.
 *
 * ---------------------------------------------------------------------------
 * KNOWN DIFFERENCES AGAINST THE PINNED UPSTREAM — NOT FIXED, DELIBERATELY
 *
 * The two defects this file was written for are FIXED (D11 and D5 above). Four
 * differences of the same parser are still open, written down here so the next pass does
 * not rediscover them as bugs. Three have a ledger entry in `test-contract.ts`, which
 * asserts each is STILL observed — so none can be forgotten, and none can be fixed
 * silently either; the fourth has no ledger entry, and its only trace is the comment
 * left in that ledger's place plus the assertion named below.
 *
 *   D4  `event:`/`data:` values are `.trim()`ed here; upstream strips ONE leading space
 *       and nothing else, so a padded event name is unknown upstream. Ledger: D4.
 *       Assertion: [3] "`event:` with an empty value keeps the documented empty name".
 *   D6  an empty event name is kept as `event: ""`; upstream omits the key entirely.
 *       Ledger: D6. Same assertion as D4.
 *   D7  `id:` and `retry:` are dropped; upstream keeps them on the event — and keeps
 *       `id` FOREVER (its dispatch() clears event/retry/data but never id), so one `id:`
 *       rides on every later event. Ledger: D7, observed on the canonical stream.
 *       Nothing in this file asserts either side of it.
 *   --  FIELD NAMES ARE MATCHED WITH `startsWith` where upstream splits on the first
 *       colon and compares the field exactly. So `datafoo: x` is NOT read as `data`
 *       (harmless, and asserted) but `eventfoo: x` IS read as an event name (upstream
 *       ignores it). No ledger entry: unreachable from Trae, which writes only
 *       `event:`/`data:`/`id:`/`retry:`/comment lines.
 *       Assertion: [3] "a field whose name merely starts with `data` is still ignored"
 *       covers the `datafoo` half; the `eventfoo` half is documented, not asserted.
 *
 * None of the four changes a payload we emit today. Recommended next round: converge the
 * field matcher on exact field names first, then decide D4/D6 — but move each ledger
 * entry in the same commit as its fix, or the ledger's own stale rule fails the run.
 *
 * ---------------------------------------------------------------------------
 * HOW TO READ A FAILURE HERE (each group has at least one line the old code failed)
 *
 *   1. framing, byte for byte         — unchanged, and asserted unchanged
 *   2. the stream's end               — D11: 13 assertions, 6 of them red pre-fix
 *   3. the bare `data` line           — D5:  10 assertions, 5 of them red pre-fix
 *   4. end to end: finish_reason      — is the closing event delivered, and is a
 *                                       half-cut payload still NOT content?
 *   5. empty and degenerate input     — the empty answer is still an empty answer
 *
 * Run:  <dsh-node> tools/test-sse.ts        exit 0 = every check passed
 *                                           exit 3 = every check that COULD run passed,
 *                                                    but an input was missing (see SKIP below)
 *
 * ---------------------------------------------------------------------------
 * MISSING vs STALE — the two are NOT the same thing and must not look alike
 *
 *   MISSING (`tools/fixtures/trae-stream.json` is not in this tree — e.g. unpacked from
 *   a release that was packed with `--no-fixtures`) ⇒ SKIP the one group that needs it,
 *   and say how to put it back. Nothing about the parser is in doubt; the input simply
 *   is not here, and on a machine without the pinned upstream snapshot
 *   (`~/.dsh/trae-pin`) it cannot be rebuilt offline either.
 *
 *   STALE (the file IS here but no longer matches what the current `src/` produces)
 *   ⇒ FAIL. That is the freshness gate, and it is deliberate: a fixture that quietly
 *   drifts away from the code turns this whole suite into a proof of nothing. `SKIP`
 *   must never be reachable for a file that exists.
 */
import { existsSync, readFileSync } from 'node:fs'

import { decodeTraeEvent, parseSseStream, pumpTraeStream } from '../src/protocol.ts'
import type { SseEvent } from '../src/protocol.ts'

/**
 * Exit code for "ran, but one group had no input". `tools/_run-suites.mjs` reads it and
 * counts the suite as skipped — never as a pass, and never as a failure.
 */
const SKIP_EXIT = 3
/** The fixture this file and `test-contract.ts` share, and where it is told to live. */
const CANONICAL_FIXTURE = new URL('./fixtures/trae-stream.json', import.meta.url)
const CANONICAL_FIXTURE_LABEL = 'tools/fixtures/trae-stream.json'

let failures = 0
let passed = 0
/** Groups that did not run because their input is absent. Not a pass, not a failure. */
const skipped: string[] = []
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failures += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
}

/** The framing of one event has exactly these two keys (an absent name is absent, not ""). */
function eventKeys(event: SseEvent): string[] {
  return Object.keys(event).sort()
}

/**
 * Feed `chunks` as separate writes — a socket does that at every boundary — and collect
 * every event. This is the only way the parser is driven in this file: no test reaches
 * into internals, so every assertion is about observable output.
 */
async function eventsOf(chunks: string[]): Promise<SseEvent[]> {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  const found: SseEvent[] = []
  for await (const event of parseSseStream(body)) found.push(event)
  return found
}

/** Raw bytes, for the input a TextEncoder cannot express (a cut multi-byte caractère). */
async function eventsOfBytes(bytes: Uint8Array[]): Promise<SseEvent[]> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk)
      controller.close()
    }
  })
  const found: SseEvent[] = []
  for await (const event of parseSseStream(body)) found.push(event)
  return found
}

interface Emitted {
  payloads: Record<string, unknown>[]
  result: { finishReason: string; text: string; toolCalls: number }
}

/** Drive the real pump over real bytes and keep what would have been written to pi-ai. */
async function pumpOf(chunks: string[]): Promise<Emitted> {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  const payloads: Record<string, unknown>[] = []
  const result = await pumpTraeStream(parseSseStream(body), { write: (payload: unknown) => payloads.push(payload as Record<string, unknown>) }, { model: 'glm-5.2' })
  return { payloads, result }
}

/** The one field of an emitted chunk a client actually reads. */
function firstChoice(payload: Record<string, unknown>): Record<string, unknown> {
  const choices = payload['choices']
  return Array.isArray(choices) && choices.length > 0 ? (choices[0] as Record<string, unknown>) : {}
}

/**
 * Two runs of the pump can never be compared whole: `id` and `created` are the clock
 * (`chatcmpl-trae-${Date.now()}`), so a run that straddles a millisecond differs by
 * construction. Everything else IS the output under test — the deltas a client reads
 * and the finish reason it ends on — so that is what gets compared.
 */
function emittedShape(payloads: Record<string, unknown>[]): string {
  return JSON.stringify(payloads.map((payload) => ({
    object: payload['object'],
    model: payload['model'],
    choices: payload['choices'],
    usage: payload['usage'],
    error: payload['error']
  })))
}

// ------------------------------------------------------------------ 1. framing
console.log('\n[1] framing: newline-terminated streams are unchanged, byte for byte')
{
  const chunks = [
    'event: request_wait_in_queue\ndata: {"position":2}\n\n',
    'event: progress_notice\ndata: {"notice":"still working"}\n\n',
    'event: output\ndata: {"response":"po",\ndata: "reasoning_content":"split"}\n\n',
    'data: [DONE]\n\n'
  ]
  const events = await eventsOf(chunks)
  check('an SSE event per blank line, in order: 4 events, none merged, none lost', events.length === 4, events.map((event) => event.event ?? '(unnamed)').join(',') + ` len=${events.length}`)
  check('the event name and the payload are exactly the bytes on the wire', events[0]?.event === 'request_wait_in_queue' && events[0]?.data === '{"position":2}' && events[1]?.event === 'progress_notice' && events[1]?.data === '{"notice":"still working"}', JSON.stringify(events.slice(0, 2)))
  check('multi-line data is joined with \\n, never concatenated', events[2]?.data === '{"response":"po",\n"reasoning_content":"split"}', JSON.stringify(events[2]?.data))
  check('framing keys are exactly {event, data} — no third key grew on the event object', events.every((event) => JSON.stringify(eventKeys(event)) === JSON.stringify(['data', 'event'])) || (events[3] !== undefined && JSON.stringify(eventKeys(events[3])) === JSON.stringify(['data'])), events.map((event) => eventKeys(event).join('+')).join(' | '))
  check('an unnamed event stays unnamed (no `event: ""` is invented)', events[3]?.event === undefined && events[3]?.data === '[DONE]', JSON.stringify(events[3]))
}
{
  // The same stream, one byte per write: an event split across writes must reassemble
  // identically. This is the property that makes the two defects above possible at all.
  const whole = 'event: output\ndata: {"response":"pong"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n'
  const oneByteAtATime = await eventsOf([...whole])
  const wholeAtOnce = await eventsOf([whole])
  check('one write per byte and one write for everything produce the same two events', oneByteAtATime.length === 2 && JSON.stringify(wholeAtOnce) === JSON.stringify(oneByteAtATime), JSON.stringify(oneByteAtATime))
  const splitMidEvent = await eventsOf(['event: out', 'put\ndata: {"resp', 'onse":"pong"}\n', '\ndata: [DONE]\n\n'])
  check('a split through the name, the payload AND the blank line still yields both events', splitMidEvent.length === 2 && splitMidEvent[0]?.event === 'output' && splitMidEvent[0]?.data === '{"response":"pong"}' && splitMidEvent[1]?.data === '[DONE]', JSON.stringify(splitMidEvent))
  const crlf = await eventsOf(['event: done\r\ndata: {"finish_reason":"stop"}\r\n\r\n'])
  check('CRLF terminators are stripped from the name and the payload alike', crlf.length === 1 && crlf[0]?.event === 'done' && crlf[0]?.data === '{"finish_reason":"stop"}', JSON.stringify(crlf))
  const crlfSplit = await eventsOf(['event: done\r', '\ndata: {"finish_reason":"stop"}\r\n\r\n'])
  check('a write boundary between the CR and the LF of a CRLF pair is invisible', JSON.stringify(crlfSplit) === JSON.stringify(crlf), JSON.stringify(crlfSplit))
}
const fixturePresent = existsSync(CANONICAL_FIXTURE)
if (!fixturePresent) {
  // MISSING, not stale: skip this one group and say how to restore it. (`test-contract.ts`
  // reads the same file and skips for the same reason, instead of failing.)
  skipped.push(
    `[1] the 12-event canonical fixture (${CANONICAL_FIXTURE_LABEL}) is not present in this tree — ` +
      `regenerate it with \`<dsh-node> tools/emit-turn-bodies.mjs\`, which needs the pinned upstream snapshot ~/.dsh/trae-pin`
  )
}
if (fixturePresent) {
  // The fixture `test-contract.ts` also reads. Asserting it here means a change to the
  // parser breaks THIS suite even if the contract suite is not run.
  const fixture = JSON.parse(readFileSync(CANONICAL_FIXTURE, 'utf8')) as { canonical: { chunks: string[] } }
  const events = await eventsOf(fixture.canonical.chunks)
  check('the 12-event canonical fixture is still read as exactly those 12 events', events.length === 12, `len=${events.length}`)
  const expected = JSON.stringify([
    { event: 'request_wait_in_queue', data: '{"position":2}' },
    { event: 'progress_notice', data: '{"notice":"still working","stage":"planning"}' },
    { event: 'token_usage', data: '{"prompt_tokens":12,"completion_tokens":15,"total_tokens":27,"reasoning_tokens":9,"cache_read_input_tokens":128,"cache_creation_input_tokens":64}' },
    { event: 'output', data: '{"reasoning_content":"The user wants exactly \\"pong\\"."}' },
    { event: 'output', data: '{"response":"po"}' },
    { event: 'output', data: '{"response":"ng"}' },
    { event: 'output', data: '{"tool_calls":[{"index":0,"id":"call_1","type":"function","function_call":{"name":"get_time","arguments":"{}"}}]}' },
    { event: 'done', data: '{"finish_reason":"tool_calls"}' },
    { event: 'heartbeat', data: '{"ts":1}' },
    { event: 'output', data: '{"response":"first",\n"reasoning_content":"split across lines"}' },
    { event: 'error', data: '{"code":1005,"message":"","extra":"{\\"plan\\":1}"}' },
    { event: null, data: '[DONE]' }
  ])
  // Key ORDER is the parser's business (it builds `data` first), the name and the bytes
  // are not — so the comparison normalises the shape and compares exactly that.
  const named = (event: SseEvent): { event: string | null; data: string } => ({ event: event.event ?? null, data: event.data })
  check('...as those 12 events with those exact names and payloads (fixture regression)', JSON.stringify(events.map(named)) === expected, JSON.stringify(events.map(named)).slice(0, 200))
}

// ------------------------------------------- 2. D11: the end of the stream IS a line
console.log('\n[2] D11: a last line with no trailing newline is still a line')
{
  const events = await eventsOf(['event: output\ndata: {"response":"pong"}\n\nevent: done\ndata: {"finish_reason":"stop"}'])
  check('the unterminated last event IS delivered (old code: 1 event, this one lost)', events.length === 2, `len=${events.length}`)
  check('...with its name and payload exactly as if the newline had been there', events[1]?.event === 'done' && events[1]?.data === '{"finish_reason":"stop"}', JSON.stringify(events[1]))
  const withNewline = await eventsOf(['event: output\ndata: {"response":"pong"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n'])
  check('...and identical to the same stream that DID end with a newline', JSON.stringify(events) === JSON.stringify(withNewline), JSON.stringify(withNewline))
}
{
  const noBlankLine = await eventsOf(['event: done\ndata: {"finish_reason":"tool_calls"}'])
  check('a residual event with no blank line at all is dispatched too', noBlankLine.length === 1 && noBlankLine[0]?.event === 'done' && noBlankLine[0]?.data === '{"finish_reason":"tool_calls"}', JSON.stringify(noBlankLine))
  const nameOnly = await eventsOf(['data: {"finish_reason":"stop"}\n\nevent: done'])
  check('an `event:` residual that never got its data closes nothing (the name is not an event)', nameOnly.length === 1 && nameOnly[0]?.event === undefined, JSON.stringify(nameOnly))
  const crOnly = await eventsOf(['event: done\ndata: {"finish_reason":"stop"}\r'])
  check('a residual ending in a lone CR has it stripped, not folded into the payload', crOnly.length === 1 && crOnly[0]?.data === '{"finish_reason":"stop"}', JSON.stringify(crOnly))
}
{
  // The residual is framed, never repaired — one rule for both spellings of the same
  // truncated bytes. This is the trap: a fix that "only dispatches a residual that
  // parses" would drop this payload's boundary silently, and an `unknown` event is
  // already what the SAME bytes produce when they arrive with a newline.
  const truncated = await eventsOf(['event: output\ndata: {"resp'])
  check('a half-cut JSON residual yields ONE event (its boundary is not dropped)', truncated.length === 1, `len=${truncated.length}`)
  check('...and its payload is the raw text, unrepaired and unsplit', truncated[0]?.event === 'output' && truncated[0]?.data === '{"resp', JSON.stringify(truncated[0]))
  const decoded = decodeTraeEvent(truncated[0] as SseEvent)
  check('...and it decodes as `unknown` (a framing layer never invents a payload)', decoded.type === 'unknown' && (decoded as { data: unknown }).data === '{"resp', JSON.stringify(decoded))
  const withNewline = await eventsOf(['event: output\ndata: {"resp\n'])
  check('...so truncated bytes ending WITH a newline behave identically (one rule, not two)', JSON.stringify(withNewline) === JSON.stringify(truncated.map((event) => ({ ...event, data: event.data }))), JSON.stringify(withNewline))
}
{
  // A residual after a blank line is not a new event: the blank line already closed the
  // previous one, so these bytes belong to a SECOND event, not to the first.
  const afterBlank = await eventsOf(['data: {"response":"first"}\n\ndata: {"response":"last"}'])
  check('a residual that follows a blank line starts its own event', afterBlank.length === 2 && afterBlank[0]?.data === '{"response":"first"}' && afterBlank[1]?.data === '{"response":"last"}', JSON.stringify(afterBlank))
  const crlfResidual = await eventsOf(['event: done\r\ndata: {"finish_reason":"stop"}\r\n\r\nevent: token_usage\r\ndata: {"prompt_tokens":3}\r'])
  check('a CRLF stream cut mid-way keeps both events and both payloads clean', crlfResidual.length === 2 && crlfResidual[1]?.event === 'token_usage' && crlfResidual[1]?.data === '{"prompt_tokens":3}', JSON.stringify(crlfResidual))
  // A cut multi-byte sequence: TextDecoder must not throw, and must not swallow the line.
  const cutEmoji = await eventsOfBytes([
    new TextEncoder().encode('event: output\ndata: {"response":"ok \u{1f600}'),
    new Uint8Array([0xe2, 0x82]) // the first two bytes of a 3-byte character, then EOF
  ])
  check('a stream cut inside a multi-byte character still delivers its event', cutEmoji.length === 1 && cutEmoji[0]?.event === 'output' && (cutEmoji[0]?.data ?? '').startsWith('{"response":"ok '), JSON.stringify(cutEmoji))
}

// ------------------------------------------------- 3. D5: the bare `data` line
console.log('\n[3] D5: a bare `data` line is the data field with an empty value')
{
  const events = await eventsOf(['event: output\ndata\n\n'])
  check('a bare `data` line dispatches an event with an empty payload (old code: 0 events)', events.length === 1, `len=${events.length}`)
  check('...the payload is the empty string, not "undefined" and not a missing key', events[0]?.data === '' && 'data' in (events[0] as object), JSON.stringify(events[0]))
  check('...and the event name it carried is kept', events[0]?.event === 'output', JSON.stringify(events[0]))
  check('...and it decodes as `unknown` with that empty payload, never as content', JSON.stringify(decodeTraeEvent(events[0] as SseEvent)) === JSON.stringify({ type: 'unknown', event: 'output', data: '' }), JSON.stringify(decodeTraeEvent(events[0] as SseEvent)))
  const alone = await eventsOf(['data\n\n'])
  check('a bare `data` with no name is still an event boundary (empty payload, no name)', alone.length === 1 && alone[0]?.data === '' && alone[0]?.event === undefined, JSON.stringify(alone))
  const asResidual = await eventsOf(['event: output\ndata'])
  check('a bare `data` as the residual (no newline anywhere) is an event too', asResidual.length === 1 && asResidual[0]?.event === 'output' && asResidual[0]?.data === '', JSON.stringify(asResidual))
  const twoEvents = await eventsOf(['data: {"response":"a"}\n\ndata\n\ndata: {"response":"b"}\n\n'])
  check('a keep-alive between two real events does not merge or reorder them', twoEvents.length === 3 && twoEvents[0]?.data === '{"response":"a"}' && twoEvents[1]?.data === '' && twoEvents[2]?.data === '{"response":"b"}', JSON.stringify(twoEvents.map((event) => event.data)))
}
{
  // Containment: only the exact field name counts. `datafoo` is not `data`, and the
  // four fields we read must behave the way the pinned upstream SseDecoder behaves —
  // checked against hand-written expectations, never against our own decoder.
  const containment = await eventsOf(['datafoo: x\nfoo\n: comment\ndata: {"response":"y"}\n\n'])
  check('a field whose name merely starts with `data` is still ignored', containment.length === 1 && containment[0]?.data === '{"response":"y"}', JSON.stringify(containment))
  const comments = await eventsOf([': keep-alive\n\n: another\n\n'])
  check('comment lines and empty dispatches emit nothing at all', comments.length === 0, `len=${comments.length}`)
  const emptyValue = await eventsOf(['event:\ndata: {"response":"x"}\n\n'])
  check('`event:` with an empty value keeps the documented empty name (unchanged)', emptyValue.length === 1 && emptyValue[0]?.event === '' && emptyValue[0]?.data === '{"response":"x"}', JSON.stringify(emptyValue))
}

// ------------------------------------------------------- 4. end to end: finish_reason
console.log('\n[4] end to end: the closing event decides what the client is told')
{
  // The user-visible defect D11 caused: the reply had content but never ended.
  const terminated = await pumpOf(['event: output\ndata: {"response":"pong"}\n\nevent: done\ndata: {"finish_reason":"stop"}'])
  const withNewline = await pumpOf(['event: output\ndata: {"response":"pong"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n'])
  check('the residual `done` is read: the reply carries its text (old code: text lost to a dropped event)', terminated.result.text === 'pong', JSON.stringify(terminated.result))
  check('...and the final chunk says finish_reason "stop", not a default', firstChoice(terminated.payloads[terminated.payloads.length - 1] ?? {})['finish_reason'] === 'stop', JSON.stringify(terminated.payloads[terminated.payloads.length - 1]))
  check('...so the unterminated stream and the terminated one emit the SAME payloads', emittedShape(terminated.payloads) === emittedShape(withNewline.payloads), `${terminated.payloads.length} vs ${withNewline.payloads.length} payloads`)
  const toolCalls = await pumpOf(['event: output\ndata: {"tool_calls":[{"index":0,"id":"call_1","type":"function","function_call":{"name":"get_time","arguments":"{}"}}]}\n\nevent: done\ndata: {"finish_reason":"tool_calls"}'])
  check('a residual `done` with finish_reason "tool_calls" still closes a tool call as tool_calls', toolCalls.result.finishReason === 'tool_calls' && firstChoice(toolCalls.payloads[toolCalls.payloads.length - 1] ?? {})['finish_reason'] === 'tool_calls', JSON.stringify(toolCalls.result))
}
{
  // The other half of the D11 fix: what a half-cut payload must NOT become.
  const truncated = await pumpOf(['event: output\ndata: {"response":"pong"}\n\nevent: output\ndata: {"response":"po'])
  check('a half-cut residual payload emits NO text chunk (nothing truncated reaches the client)', truncated.result.text === 'pong', JSON.stringify(truncated.result))
  check('...and no error chunk either: the truncated event is unknown, not a failure', truncated.payloads.every((payload) => payload['error'] === undefined), JSON.stringify(truncated.payloads.map((payload) => Object.keys(payload))))
  const lastChunk = truncated.payloads[truncated.payloads.length - 1] ?? {}
  check('...the stream simply ends, with the finish reason it already had ("stop")', truncated.payloads.length === 2 && firstChoice(lastChunk)['finish_reason'] === 'stop', JSON.stringify(lastChunk))
}
{
  const keepAlive = await pumpOf(['data\n\nevent: output\ndata: {"response":"hi"}\n\nevent: done\ndata: {"finish_reason":"stop"}'])
  check('a bare `data` keep-alive on the wire does not disturb the answer around it', keepAlive.result.text === 'hi' && keepAlive.payloads.length === 2, JSON.stringify(keepAlive.result))
  const done = await pumpOf(['event: output\ndata: {"response":"x"}\n\ndata: [DONE]'])
  check('a residual `[DONE]` sentinel is honoured as the end of the stream', done.result.finishReason === 'stop' && firstChoice(done.payloads[done.payloads.length - 1] ?? {})['finish_reason'] === 'stop', JSON.stringify(done.result))
  const error = await pumpOf(['event: error\ndata: {"code":1005,"message":"need plan"}'])
  check('the error path still wins over a missing newline (no regression on failures)', error.result.finishReason === 'error' && error.payloads.some((payload) => typeof payload['error'] === 'object' && payload['error'] !== null), JSON.stringify(error.result))
}
{
  // What the lone-CR strip above is worth, end to end. Hand the residual its `\r` and the
  // payload becomes `{...}\r`, which no longer parses — so a perfectly readable `done`
  // degrades into an unknown event, and (see D9) a code-less error event reads as a
  // FAILURE. One kept carriage return would turn "the answer ended" into "Trae refused
  // the request". That is why the residual strips it even though upstream does not.
  const withCr = await pumpOf(['event: error\ndata: {"code":1005,"message":"need plan"}\r'])
  check('an error residual ending in a lone CR is still read as a Trae error, not a refusal', withCr.result.finishReason === 'error' && withCr.payloads.some((payload) => (payload['error'] as Record<string, unknown> | undefined)?.['code'] === 1005), JSON.stringify(withCr.payloads.map((payload) => payload['error'] ?? firstChoice(payload)['finish_reason'])))
  const doneCr = await pumpOf(['event: error\ndata: {"code":1005,"message":"need plan"}\r\n\r\nevent: done\ndata: {"finish_reason":"stop"}\r'])
  check('...so a CR-terminated stream keeps its error AND its closing finish reason', doneCr.result.finishReason === 'error' && doneCr.payloads.some((payload) => (payload['error'] as Record<string, unknown> | undefined)?.['code'] === 1005), JSON.stringify(doneCr.payloads.map((payload) => payload['error'] ?? firstChoice(payload)['finish_reason'])))
}
{
  // THE TRAP, asserted rather than argued: "close the half-cut payload by guessing what
  // it was cut from" is the tempting way to satisfy D11, and it is wrong in the one
  // place it matters. If the parser ever repairs `{"finish_reason":"stop"` (a cut-off
  // `done`) into a real event, the client is told the reply ENDED — a claim backed only
  // by bytes that never arrived. The honest outcome is the one below: content that
  // arrived is delivered, the fragment is not, and the finish reason stays the default.
  const repaired = await pumpOf(['event: output\ndata: {"response":"pong"}\n\nevent: done\ndata: {"finish_reason":"stop"'])
  check('a HALT-CUT `done` is never invented into a finish reason', repaired.result.finishReason === 'stop' && firstChoice(repaired.payloads[repaired.payloads.length - 1] ?? {})['finish_reason'] === 'stop', JSON.stringify(repaired.result))
  check('...and unparseable residual text never reaches the client as content', repaired.result.text === 'pong' && repaired.payloads.length === 2, JSON.stringify(repaired.result))
  check('...the truncation is visible to the framing layer only (one unknown event, no error chunk)', repaired.payloads.every((payload) => payload['error'] === undefined), JSON.stringify(repaired.payloads.map((payload) => Object.keys(payload))))
}

// -------------------------------------------------------- 5. empty and degenerate
console.log('\n[5] empty and degenerate input: an empty answer is still an empty answer')
{
  const empty = await eventsOf([])
  check('an empty stream yields no events at all (not an empty-data event)', empty.length === 0, `len=${empty.length}`)
  const blankOnly = await eventsOf(['\n\n\n'])
  check('blank lines alone yield no events', blankOnly.length === 0, `len=${blankOnly.length}`)
  const commentOnly = await eventsOf([': keep-alive\n', ': keep-alive\n\n'])
  check('keep-alive comments alone yield no events', commentOnly.length === 0, `len=${commentOnly.length}`)
  const emptyPump = await pumpOf([])
  check('an empty stream pumps to exactly one chunk: the closing one, with no text', emptyPump.payloads.length === 1 && emptyPump.result.text === '' && firstChoice(emptyPump.payloads[0] ?? {})['finish_reason'] === 'stop', JSON.stringify(emptyPump.result))
  const spaced = await eventsOf(['data:  {"response":"x"}\n\n'])
  check('exactly one leading space is stripped from a value, the rest is the payload', spaced.length === 1 && spaced[0]?.data === ' {"response":"x"}', JSON.stringify(spaced[0]?.data))
}

console.log('-'.repeat(72))
console.log(`${passed} passed · ${failures} failed${skipped.length === 0 ? '' : ` · ${skipped.length} skipped`}`)
for (const group of skipped) console.log(`SKIP  ${group}`)
if (skipped.length > 0 && failures === 0) {
  console.log('SSE SKIPPED (exit 3) — nothing failed; the group above had no input. This is NOT a pass.')
  process.exit(SKIP_EXIT)
}
if (failures === 0) console.log('SSE OK — framing, the end of the stream, and the bare `data` line all behave as specified')
process.exit(failures === 0 ? 0 : 1)

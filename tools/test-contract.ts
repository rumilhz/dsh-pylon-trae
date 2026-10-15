/**
 * Cross-implementation wire contract, against the PINNED upstream client.
 *
 *   <dsh-node> tools/test-contract.ts     exit 0 = every check passed
 *                                         exit 3 = an input is missing (see MISSING below),
 *                                                  so sections [1]..[6] did not run
 *
 * MISSING vs STALE. A missing `tools/fixtures/turn-bodies.json` is not a defect in this
 * repo: it is the absence of an input that cannot be rebuilt without the pinned snapshot,
 * so it is a SKIP with instructions. A fixture that EXISTS but disagrees with the current
 * `src/` is a stale artefact and stays a FAILURE — and so does a pinned snapshot that is
 * present but damaged. "Not checked" is never reported as "checked and correct".
 *
 * OFFLINE. No network, no quota, no credential, no DSH process. It reads one
 * directory read-only: the pinned snapshot at `~/.dsh/trae-pin/` (override with
 * DSH_TRAE_PIN). Nothing is written anywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — the gap the other suites cannot close
 *
 * `test-api.ts` builds a Trae body and checks it against the shape `test-api.ts`
 * believes in; `test-reasoning.ts` checks that mapping against its own rules. Both
 * are self-consistency proofs: if the belief is wrong, the assertion is wrong in
 * exactly the same way, and every test stays green. The plugin has been bitten by
 * precisely that class of bug before (see 进展.md on `verifyPatch` and the seed
 * present-assertions).
 *
 * So the expected values here do not come from this repo at all. They come from a
 * second, independent implementation of the same protocol, pinned byte-for-byte:
 *
 *   dsh-connect-trae@3.4.0, tarball sha256
 *   440f94db13df07d93daec417689dc8bb918a3c77995c34d6762091ec4a03e085
 *   unpacked at ~/.dsh/trae-pin/dsh-connect-trae-3.4.0/
 *
 * Two things are contracted, because they are the two things that break silently:
 *
 *   1. the REQUEST BODY we send. Every body in tools/fixtures/turn-bodies.json —
 *      produced by the real `buildTraeBody`, not by hand — is fed to the upstream's
 *      own `prepareSoloBody`, and the two bodies are compared field by field. We
 *      may not omit a field it sets, and we may not invent one it does not know.
 *   2. the NAMED SSE EVENTS we understand and the CHUNKS we emit. Every event name
 *      either side recognises is probed on both, and the bytes we write to the
 *      pi-ai-facing socket are parsed by the upstream's own `SseDecoder`.
 *
 * ---------------------------------------------------------------------------
 * HOW THE UPSTREAM CONTRACT IS READ (and why not by importing it)
 *
 * Importing the pinned module for real is attempted first and reported: it FAILS,
 * because its DSH-internal peer dependencies are not resolvable from the pin
 * directory (`ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`). Even if it loaded,
 * only `SseDecoder` is exported — `prepareSoloBody` and `decodeTraeEvent` are not.
 *
 * So the four pieces we need are CUT OUT OF THE FILE BYTE-FOR-BYTE (anchored, with
 * the anchor count asserted, with the line range printed) and evaluated verbatim in
 * a `node:vm` context. Nothing is retyped and no logic is reimplemented: what runs
 * is the pinned file's own text. The file's sha256 is checked against the pin's own
 * `manifest.json` first, and the extraction's sha256 is printed, so the evidence
 * chain is: tarball digest -> manifest -> lib/index.js -> extracted region.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE FOLLOWS: A DIFFERENCE IS NEVER SILENT
 *
 * Every observed divergence is listed in KNOWN_DIVERGENCES with a reason. A
 * divergence that shows up without an entry fails the run; an entry whose
 * divergence no longer shows up also fails it (a stale exception is how a test
 * quietly stops testing). `kind: 'gap'` marks a place where the pinned reference is
 * right and we are wrong — reported, NOT fixed here, because src/ belongs to its
 * owner.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

import { buildTraeBody, decodeTraeEvent, parseSseStream, pumpTraeStream, statusForTraeError, TRAE_ERROR_HINTS } from '../src/protocol.ts'
import type { SseEvent } from '../src/protocol.ts'
import { buildTurnBodies, serialize, targetOf, FIXTURE_PATH, PLUGIN_ROOT, VERIFIED_SOURCES } from './emit-turn-bodies.mjs'

const HERE = import.meta.dirname
const STREAM_FIXTURE_PATH = join(HERE, 'fixtures', 'trae-stream.json')
const PIN_ROOT = process.env['DSH_TRAE_PIN'] ?? join(homedir(), '.dsh', 'trae-pin')
const PIN_TGZ = join(PIN_ROOT, 'dsh-connect-trae-3.4.0.tgz')
const PIN_TARBALL_NOTE = join(PIN_ROOT, 'manifest-tarball.txt')
const PIN_MANIFEST = join(PIN_ROOT, 'manifest.json')
const PIN_INDEX = join(PIN_ROOT, 'dsh-connect-trae-3.4.0', 'lib', 'index.js')

/** The pin record's own digest for the tarball; corroborated against manifest-tarball.txt below. */
const EXPECTED_TARBALL_SHA256 = '440f94db13df07d93daec417689dc8bb918a3c77995c34d6762091ec4a03e085'

/**
 * Exit code for "an input is missing, so some sections did not run". `tools/_run-suites.mjs`
 * maps it to SKIP. Kept distinct from 0 on purpose: a skipped suite must never be countable
 * as a pass by a caller that only looks at the exit code.
 */
const SKIP_EXIT = 3

let passed = 0
let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failures += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys.filter((key) => canonical(a[key]) !== canonical(b[key]))
}

// --------------------------------------------------------------------------- divergences
interface Divergence {
  id: string
  area: 'request-body' | 'trae-stream' | 'downstream-chunk'
  kind: 'intentional' | 'noted' | 'structural' | 'gap'
  ours: string
  upstream: string
  reason: string
  evidence: string
}

/**
 * Every divergence this test is allowed to observe. Anything not here fails the
 * run; anything here that stops showing up also fails it.
 */
const KNOWN_DIVERGENCES: readonly Divergence[] = [
  {
    id: 'D1',
    area: 'request-body',
    kind: 'intentional',
    ours: 'an empty `reasoning_effort` is dropped',
    upstream: '`reasoning_effort: ""` is forwarded (it only checks typeof string)',
    reason: 'An empty string is not a level any model declared. src/catalog.ts:109-111 already sets this policy for a spelling we cannot map ("a level we cannot spell correctly is worse than one we do not offer"), and a parameter the gateway cannot match is a rejection we would have to debug. Fixture case is marked synthetic: pi-ai only sends a level the directory declared.',
    evidence: 'fixture case reasoning-effort-empty'
  },
  {
    id: 'D2',
    area: 'request-body',
    kind: 'intentional',
    ours: '`function` always comes from the resolved wire target',
    upstream: 'a caller-supplied `input.function` wins when it is a non-empty string',
    reason: 'In our path the caller is pi-ai\'s openai-completions, which sends no top-level `function`. Honouring one would let any loopback caller pick a Trae function other than the one that listed the model — the exact failure 4001/4011 exist to report. Fixture case is marked synthetic for the same reason.',
    evidence: 'fixture case function-passthrough'
  },
  {
    id: 'D3',
    area: 'request-body',
    kind: 'noted',
    ours: 'an absent model falls back to the wire target\'s configName',
    upstream: 'an absent model falls back to the literal default "glm-5.2" (called as prepareSoloBody(body, void 0, fn) at lib/index.js:2649)',
    reason: 'Not reachable in our path: src/shim.ts:196-197 answers 400 `missing_model` before buildTraeBody runs, so the fallback only decides a body we never send. Recorded because the two builders disagree about what "no model" means, and a future caller reaching buildTraeBody directly would inherit our spelling (the target), not theirs.',
    evidence: 'inline probe: model absent'
  },
  {
    id: 'D4',
    area: 'trae-stream',
    kind: 'intentional',
    ours: 'the event name is trimmed ("event: token_usage " -> token_usage)',
    upstream: 'one optional leading space is removed and nothing else, so a trailing space makes the name unknown',
    reason: 'Ours is strictly more forgiving on a line the SSE spec says carries no meaning in trailing whitespace. Nothing observed from Trae has one; this only matters if the gateway ever pads the field.',
    evidence: 'stream probe event-name-trailing-space'
  },
  // D5 (a bare `data` line ignored whole) used to live here as kind:'gap'. FIXED
  // 2026-10-15 in src/protocol.ts:186-188 — the line is now the `data` field with an
  // empty value, so the stream below reports ours=1/reference=1 with an identical
  // payload and this entry would have failed its own stale-exception rule. It is
  // guarded now by tools/test-sse.ts [3] (7 assertions: dispatch, empty payload, the
  // name it carried, `unknown` decoding, residual spelling) and by the stream probes
  // below, where the two parsers must agree with nothing left to explain.
  {
    id: 'D6',
    area: 'trae-stream',
    kind: 'noted',
    ours: 'an empty event name is kept as `event: ""`',
    upstream: 'an empty event name is omitted from the event object',
    reason: 'Cosmetic: both decode the payload identically, and neither the name nor its absence is read anywhere downstream.',
    evidence: 'stream probe empty-event-name'
  },
  {
    id: 'D7',
    area: 'trae-stream',
    kind: 'noted',
    ours: 'the `id:` and `retry:` fields are dropped',
    upstream: 'keeps them on the event object — and keeps `id` FOREVER, because SseDecoder.dispatch() clears `this.event`, `this.retry` and `this.data` but never `this.id`, so an `id:` seen once rides on every later event (observed on the error event and again on [DONE])',
    reason: 'We never reconnect or resume a stream (no Last-Event-ID handling anywhere in src/), so the two fields would be carried and never read. The reference\'s own behaviour here is a reason to keep it that way: its stale-id leak is what carrying an unused connection-level field buys you.',
    evidence: 'canonical stream, error event carries id:42 retry:5000'
  },
  {
    id: 'D8',
    area: 'trae-stream',
    kind: 'noted',
    ours: '`cache_creation_input_tokens` is not read',
    upstream: 'maps it to cacheWriteTokens and forwards it as prompt_tokens_details.cache_write_tokens',
    reason: 'We surface the OpenAI-standard `prompt_tokens_details.cached_tokens` only, and OpenAI\'s usage schema has no cache-write field to put the other number in. Cost: a cache-write count Trae may report is dropped. Deliberate rather than repaired, because inventing a non-standard field in a client-facing payload is worse than not reporting a number nothing reads.',
    evidence: 'canonical stream, token_usage event'
  },
  {
    id: 'D9',
    area: 'trae-stream',
    kind: 'structural',
    ours: '`event: error` (and any code >= 4000) is recognised INSIDE decodeTraeEvent',
    upstream: 'its decodeTraeEvent has no error branch at all; traeFailureOf() inspects the raw event afterwards',
    reason: 'Different structure, identical outcome on every code tested. Recorded because a naive name-set comparison reports this as a difference in both directions and it is not one.',
    evidence: 'inline probe: event vocabulary'
  },
  {
    id: 'D10',
    area: 'downstream-chunk',
    kind: 'noted',
    ours: 'chunk ids look like `chatcmpl-trae-<epoch ms>`',
    upstream: '`chatcmpl-<24 hex of a UUID>`',
    reason: 'Both carry the `chatcmpl-` prefix an OpenAI-compatible parser expects; neither pi-ai nor our own writer parses the rest of the id. Recorded so the value difference is not mistaken for a shape difference.',
    evidence: 'inline probe: emitted chunk shape'
  },
  // D11 (a final line with no trailing newline never consumed) used to live here as
  // kind:'gap'. FIXED 2026-10-15 in src/protocol.ts:206-214 — the residual buffer goes
  // through the same line routine before the trailing dispatch, so the stream below
  // reports ours=1/reference=1 with an identical payload and this entry would have
  // failed its own stale-exception rule. Guarded by tools/test-sse.ts [2] (13
  // assertions: the delivered event, equality with the newline-terminated spelling, a
  // half-cut payload that must NOT become content, a lone CR, a cut multi-byte
  // character) and [4] (the closing `done` decides `finish_reason` end to end).
  //
  // ONE LEFTOVER OF THAT SAME PARSER PASS HAS NO LEDGER ENTRY, so it is written down
  // here rather than left to be rediscovered: field names are matched with
  // `startsWith`, so `datafoo: x` is not read as `data` (harmless) BUT `eventfoo: x`
  // IS read as an event name — the reference splits on the first colon and compares
  // the field exactly. Unreachable from Trae, which writes `event:`/`data:` only.
  // Fold it into the next parser pass; tools/test-sse.ts [3] ("a field whose name
  // merely starts with `data`") is where the assertion already lives. The other three
  // leftovers (D4 trailing whitespace, D6 empty name, D7 id/retry) stay ledger entries
  // and are deliberately unchanged this round.
]

const witnessed = new Map<string, string>()
function witness(id: string, observation: string): void {
  if (witnessed.has(id)) throw new Error(`divergence ${id} witnessed twice`)
  witnessed.set(id, observation)
  console.log(`  ....  ${id} observed: ${observation}`)
}

// --------------------------------------------------------------------------- truth source
console.log(`truth source: dsh-connect-trae@3.4.0 pinned at ${PIN_ROOT}`)
const missing = [PIN_TGZ, PIN_MANIFEST, PIN_INDEX].filter((path) => !existsSync(path))
if (missing.length > 0) {
  console.log(`\nFAIL  the pinned upstream snapshot is not readable, so NOTHING was verified:`)
  for (const path of missing) console.log(`        missing ${path}`)
  console.log('      A missing truth source is a FAILURE, never a skip: "not checked" and "checked and correct" must not look alike.')
  process.exit(1)
}
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const indexSource = readFileSync(PIN_INDEX, 'utf8')

const tarballDigest = sha256(PIN_TGZ)
check('the pinned tarball still hashes to the digest this test was written against', tarballDigest === EXPECTED_TARBALL_SHA256, tarballDigest)
if (existsSync(PIN_TARBALL_NOTE)) {
  const noted = /sha256=([0-9a-f]{64})/.exec(readFileSync(PIN_TARBALL_NOTE, 'utf8'))?.[1]
  check('manifest-tarball.txt names the same tarball digest (the constant is corroborated, not assumed)', noted === EXPECTED_TARBALL_SHA256, String(noted))
}

const manifest = JSON.parse(readFileSync(PIN_MANIFEST, 'utf8')) as {
  package?: string
  version?: string
  snapshot?: string
  digests?: Record<string, { sha256: string; bytes: number }>
}
check('the pin manifest describes dsh-connect-trae@3.4.0', manifest.package === 'dsh-connect-trae' && manifest.version === '3.4.0', `${String(manifest.package)}@${String(manifest.version)}`)

// The whole snapshot, not just the file we read: rule ② of the handover (integrity
// before comparison). A partial snapshot is a failed snapshot.
const digestEntries = Object.entries(manifest.digests ?? {})
check('the pin manifest records digests for the snapshot', digestEntries.length > 0, `${digestEntries.length} entries`)
let verifiedFiles = 0
const badFiles: string[] = []
for (const [relative, recorded] of digestEntries) {
  const path = join(PIN_ROOT, 'dsh-connect-trae-3.4.0', relative)
  if (!existsSync(path)) {
    badFiles.push(`${relative}: missing`)
    continue
  }
  const bytes = readFileSync(path)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== recorded.sha256 || bytes.byteLength !== recorded.bytes) badFiles.push(`${relative}: ${digest}/${bytes.byteLength} != ${recorded.sha256}/${recorded.bytes}`)
  else verifiedFiles += 1
}
check(`every file in the pin manifest matches its recorded sha256 and byte count (${verifiedFiles}/${digestEntries.length})`, badFiles.length === 0, badFiles.join(' · '))
check('lib/index.js matches the pin manifest (this is the file the contract is read from)', sha256(PIN_INDEX) === manifest.digests?.['lib/index.js']?.sha256)

// --------------------------------------------------------------------------- how it is read
console.log('\nhow the upstream contract is read')
const importProbe = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import(${JSON.stringify(pathToFileURL(PIN_INDEX).href)}).then((m)=>{console.log('OK exports='+Object.keys(m).join(','))}).catch((e)=>{console.log('FAILED '+(e&&e.code?e.code:'-')+' '+String(e&&e.message?e.message:e).split(String.fromCharCode(10))[0])})`
  ],
  { encoding: 'utf8', timeout: 30000 }
)
const importLine = `${importProbe.stdout ?? ''}`.trim().split(/\r?\n/).filter((line) => line !== '').pop() ?? '(no output)'
console.log(`  import('lib/index.js') -> ${importLine}`)
// This asserts a NEGATIVE, which is why the label says what to do if it ever flips:
// the vm fallback is only the right path while importing really is impossible. If a
// future environment resolves those packages, this fails and the header must be
// rewritten to use the real import instead of silently keeping a weaker oracle.
check('the documented reason for the vm fallback still holds (if this ever fails, re-read the header)', importLine.startsWith('FAILED ERR_MODULE_NOT_FOUND'))

interface Region {
  text: string
  start: number
  end: number
}

/** Cut one region out of the pinned file, asserting the anchor is unambiguous. */
function cut(source: string, anchor: string, end: string, base = 0): Region {
  const count = source.split(anchor).length - 1
  if (count !== 1) throw new Error(`anchor must appear exactly once in the pinned file, saw ${count}: ${JSON.stringify(anchor)}`)
  const start = source.indexOf(anchor)
  const stop = source.indexOf(end, start + anchor.length)
  if (stop === -1) throw new Error(`end marker ${JSON.stringify(end)} not found after ${JSON.stringify(anchor)}`)
  return { text: source.slice(start, stop + end.length), start: start + base, end: stop + end.length + base }
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1
  return line
}

const prepareSoloBody = cut(indexSource, 'function prepareSoloBody(', '\n}')
const bodyLiteral = cut(prepareSoloBody.text, 'const body = {', '\n\t};', prepareSoloBody.start)
const sseDecoder = cut(indexSource, 'var SseDecoder = class {', '\n};')
const decodeUpstream = cut(indexSource, 'function decodeTraeEvent(event) {', '\n}')
const traeFailureOf = cut(indexSource, 'function traeFailureOf(decoded) {', '\n}')
const classifyTraeFailure = cut(indexSource, 'function classifyTraeFailure(failure) {', '\n}')
const upstreamErrorHints = cut(indexSource, 'const TRAE_ERROR_HINTS = {', '\n};')

// The upstream's own downstream chunk literal (bridgeTraeSource's `chunk()`).
const chunkAnchor = 'const chunk = (delta, finishReason = null) =>'
if (indexSource.split(chunkAnchor).length - 1 !== 1) throw new Error(`expected exactly one ${JSON.stringify(chunkAnchor)}`)
const chunkRegionStart = indexSource.indexOf(chunkAnchor)
const chunkWindow = indexSource.slice(chunkRegionStart, chunkRegionStart + 900)
const chunkOpen = chunkWindow.indexOf('JSON.stringify({')
const chunkClose = chunkWindow.indexOf('})}', chunkOpen)
const chunkLiteral = chunkWindow.slice(chunkOpen + 'JSON.stringify('.length, chunkClose + 1)
if (!chunkLiteral.includes('chat.completion.chunk')) throw new Error('the extracted downstream chunk literal does not look like a chunk')

/**
 * Keys declared at the shallowest indentation, plus keys hidden behind a
 * conditional spread. A spread can be written either way round on the wire —
 * `...cond ? { tools: input } : {}` (key in the consequent) or
 * `...cond ? {} : { usage }` (key in the alternate) — so per spread line the LAST
 * `{ identifier` group is the one that carries the key.
 */
function declaredKeys(text: string): string[] {
  const found: Array<{ indent: number; key: string }> = []
  const optional: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const withValue = /^(\s*)([A-Za-z_$][\w$]*)\s*:/.exec(line)
    if (withValue !== null) {
      found.push({ indent: withValue[1].length, key: withValue[2] })
      continue
    }
    const shorthand = /^(\s*)([A-Za-z_$][\w$]*),$/.exec(line)
    if (shorthand !== null) {
      found.push({ indent: shorthand[1].length, key: shorthand[2] })
      continue
    }
    if (!/^\s*\.\.\./.test(line)) continue
    const groups = [...line.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*[:}]/g)]
    const last = groups[groups.length - 1]
    if (last !== undefined) optional.push(last[1])
  }
  if (found.length === 0) return [...new Set(optional)].sort()
  const shallowest = Math.min(...found.map((entry) => entry.indent))
  return [...new Set([...found.filter((entry) => entry.indent === shallowest).map((entry) => entry.key), ...optional])].sort()
}

const declaredBodyKeys = declaredKeys(bodyLiteral.text)
const declaredChunkKeys = declaredKeys(chunkLiteral)
const regionDigest = createHash('sha256')
  .update([prepareSoloBody.text, sseDecoder.text, decodeUpstream.text, traeFailureOf.text, classifyTraeFailure.text, upstreamErrorHints.text, chunkLiteral].join('\n'))
  .digest('hex')

const anchorLine = (region: Region): string => `${lineOf(indexSource, region.start)}-${lineOf(indexSource, region.end)}`
console.log(`  (fallback) 7 byte-verbatim regions evaluated in node:vm, concatenation sha256 ${regionDigest}`)
console.log(`  declared request-body keys   lib/index.js:${anchorLine(bodyLiteral)}  ${declaredBodyKeys.join(', ')}`)
console.log(`  declared downstream keys     lib/index.js (chunk literal)         ${declaredChunkKeys.join(', ')}`)
console.log(`  declared event names         lib/index.js:${anchorLine(decodeUpstream)}  ${[...indexSource.slice(decodeUpstream.start, decodeUpstream.end).matchAll(/event\.event === "([^"]+)"/g)].map((match) => match[1]).join(', ')}`)
console.log(`  declared event names         lib/index.js:${anchorLine(traeFailureOf)}  error (recognised outside the decoder — see D9)`)
check('the anchored extraction found a request-body literal with all seven fields', declaredBodyKeys.length === 7 && declaredBodyKeys.includes('config_name') && declaredBodyKeys.includes('reasoning_effort'), declaredBodyKeys.join(','))

const ORACLE_SOURCE = [prepareSoloBody.text, sseDecoder.text, decodeUpstream.text, traeFailureOf.text, classifyTraeFailure.text, upstreamErrorHints.text].join('\n\n')
const oracle = runInNewContext(
  `${ORACLE_SOURCE}\n\n;({ prepareSoloBody, SseDecoder, decodeTraeEvent, traeFailureOf, classifyTraeFailure, TRAE_ERROR_HINTS })`,
  Object.create(null),
  { filename: 'pinned-upstream-regions.js' }
) as {
  prepareSoloBody(source: string, defaultModel: string | undefined, functionName: string | undefined): string
  SseDecoder: new () => { push(chunk: string): Array<Record<string, unknown>>; finish(): Array<Record<string, unknown>> }
  decodeTraeEvent(event: { event?: string; data: string }): { type: string } & Record<string, unknown>
  traeFailureOf(decoded: unknown): { code?: number; message: string } | undefined
  classifyTraeFailure(failure: { code?: number }): { status: number; kind: string }
  TRAE_ERROR_HINTS: Record<string, string>
}
check('the pinned functions survived extraction and are callable', typeof oracle.prepareSoloBody === 'function' && typeof oracle.decodeTraeEvent === 'function' && typeof oracle.SseDecoder === 'function')

// --------------------------------------------------------------------------- fixture freshness
console.log('\nfixtures')
if (!existsSync(FIXTURE_PATH)) {
  // MISSING, not stale — and the difference decides the exit code.
  //
  // The fixture is the backbone of every section below, so its absence is not one lost
  // assertion: sections [1]..[6] cannot run at all. That is a SKIP (exit 3, counted as
  // skipped by tools/_run-suites.mjs), because nothing about this repo is in doubt —
  // the input is simply not in this tree (a release packed with `--no-fixtures`).
  //
  // What stays a FAILURE: the file being PRESENT but no longer what the current `src/`
  // produces (the checks further down), or the pinned snapshot below being damaged. A
  // file that exists and disagrees is a stale artefact; a file that is absent is a
  // missing input. Only the second is excusable, and neither is ever a pass.
  console.log(`\nSKIP  ${FIXTURE_PATH} is not present in this tree — sections [1]..[6] did not run, nothing was verified.`)
  console.log(`      regenerate it with: <dsh-node> tools/emit-turn-bodies.mjs`)
  console.log(`      that script needs the pinned upstream snapshot (${PIN_ROOT}) to exist; without it the`)
  console.log(`      fixture cannot be rebuilt offline, which is why a release may legitimately ship without it.`)
  console.log(`      exit ${SKIP_EXIT} = skipped (not a pass, not a failure); the checks above DID run.`)
  process.exit(SKIP_EXIT)
}
const fixtureText = readFileSync(FIXTURE_PATH, 'utf8')
const fixture = JSON.parse(fixtureText) as ReturnType<typeof buildTurnBodies>
const regenerated = buildTurnBodies(fixture.generatedAt)
check('the emitted fixture is exactly what the current src/ produces (regenerate with tools/emit-turn-bodies.mjs)', serialize(regenerated) === fixtureText)
for (const relative of VERIFIED_SOURCES) {
  check(`${relative} still matches the digest recorded in the fixture`, regenerated.verificationTarget.digests[relative] === fixture.verificationTarget.digests[relative], fixture.verificationTarget.digests[relative])
}
check('the verification target is documented as source, with the reason', fixture.verificationTarget.kind === 'source' && fixture.verificationTarget.why.length > 40)
check('every fixture body is a real buildTraeBody product', fixture.cases.every((one) => one.body === buildTraeBody(one.request, targetOf(one.targetFrom).target)))

const streamFixture = JSON.parse(readFileSync(STREAM_FIXTURE_PATH, 'utf8')) as {
  provenance: string
  canonical: { chunks: string[] }
  emitProbe: { chunks: string[]; expectedPayloads: number }
  probes: Array<{ id: string; why: string; chunks: string[] }>
}
check('the stream fixture declares itself synthetic (it is not a live capture)', streamFixture.provenance === 'synthetic')

// --------------------------------------------------------------------------- 1. request-body field set
console.log('\n[1] request body: field set vs the pinned prepareSoloBody')
const ourFieldUnion = new Set<string>()
const referenceFieldUnion = new Set<string>()
const BODY_CASE_DIVERGENCE: Readonly<Record<string, { keys: string[]; id: string }>> = {
  'reasoning-effort-empty': { keys: ['reasoning_effort'], id: 'D1' },
  'function-passthrough': { keys: ['function'], id: 'D2' }
}
for (const one of fixture.cases) {
  const { target } = targetOf(one.targetFrom)
  check(`case ${one.id}: the wire target is re-derived through wireTargetOf(), not trusted from the file`, canonical(target) === canonical(one.target), one.targetSource)
  const ours = JSON.parse(buildTraeBody(one.request, target)) as Record<string, unknown>
  // lib/index.js:2649 calls it as prepareSoloBody(bodyJson, void 0, functionName) — same call shape here.
  const theirs = JSON.parse(oracle.prepareSoloBody(JSON.stringify(one.request), undefined, target.fn)) as Record<string, unknown>
  for (const key of Object.keys(ours)) ourFieldUnion.add(key)
  for (const key of Object.keys(theirs)) referenceFieldUnion.add(key)
  const declared = BODY_CASE_DIVERGENCE[one.id]
  const allowed = new Set(declared?.keys ?? [])
  const absent = Object.keys(theirs).filter((key) => !(key in ours) && !allowed.has(key))
  const invented = Object.keys(ours).filter((key) => !(key in theirs) && !allowed.has(key))
  const excused = [...Object.keys(theirs).filter((key) => !(key in ours)), ...Object.keys(ours).filter((key) => !(key in theirs))].filter((key) => allowed.has(key))
  check(`case ${one.id}: we send no field the reference omits and omit none it sends`, absent.length === 0 && invented.length === 0, `absent=${absent.join(',')} invented=${invented.join(',')}${excused.length === 0 ? '' : ` declared=${excused.join(',')}`}`)

  const differing = diffKeys(ours, theirs)
  if (declared === undefined) {
    check(`case ${one.id}: the body is byte-identical to the reference's`, differing.length === 0, differing.join(','))
  } else {
    check(`case ${one.id}: the only difference is the declared one (${declared.keys.join(',')})`, canonical(differing) === canonical(declared.keys), `observed=${differing.join(',')}`)
    if (canonical(differing) === canonical(declared.keys)) witness(declared.id, `case ${one.id} differs on ${differing.join(',')} (ours: ${canonical(ours[differing[0] ?? ''])} vs reference: ${canonical(theirs[differing[0] ?? ''])})`)
  }
}
const ourFields = [...ourFieldUnion].sort()
const referenceFields = [...referenceFieldUnion].sort()
check('the union of our fields equals the union of the reference\'s, case by case', canonical(ourFields) === canonical(referenceFields), `${ourFields.join(',')} vs ${referenceFields.join(',')}`)
check('that union equals what the pinned literal declares (the static read and the run agree)', canonical(ourFields) === canonical(declaredBodyKeys), `${ourFields.join(',')} vs ${declaredBodyKeys.join(',')}`)

// The one body shape the fixture cannot carry: an absent model.
{
  const target = { configName: 'kimi-k2.6', fn: 'solo_work_lite' }
  const ours = JSON.parse(buildTraeBody({ messages: [{ role: 'user', content: 'no model named' }] }, target)) as Record<string, unknown>
  const theirs = JSON.parse(oracle.prepareSoloBody(JSON.stringify({ messages: [{ role: 'user', content: 'no model named' }] }), undefined, 'solo_work_lite')) as Record<string, unknown>
  check('D3: an absent model resolves to the wire target here and to "glm-5.2" upstream', ours['model'] === 'kimi-k2.6' && theirs['model'] === 'glm-5.2', `ours=${String(ours['model'])} reference=${String(theirs['model'])}`)
  if (ours['model'] !== theirs['model']) witness('D3', `absent model -> ours ${String(ours['model'])}, reference ${String(theirs['model'])}`)
}

// --------------------------------------------------------------------------- 2. event vocabulary
console.log('\n[2] named SSE events: the vocabulary we recognise')
const ourStaticNames = [...readFileSync(join(PLUGIN_ROOT, 'src', 'protocol.ts'), 'utf8').matchAll(/event\.event === '([^']+)'/g)].map((match) => match[1])
const upstreamStaticNames = [...indexSource.slice(decodeUpstream.start, decodeUpstream.end).matchAll(/event\.event === "([^"]+)"/g)].map((match) => match[1])
const errorName = /decoded\.event !== "([^"]+)"/.exec(traeFailureOf.text)?.[1]
check('the reference recognises "error" outside its decoder (D9 exists)', errorName === 'error', String(errorName))

const candidates = [...new Set([...upstreamStaticNames, ...ourStaticNames, ...(errorName === undefined ? [] : [errorName]), 'heartbeat', 'token_usage_v2', 'done '])].sort()
const ourType = (name: string): string => decodeTraeEvent({ event: name, data: '{"probe":true}' }).type
/** What the reference's stream loop concludes, decoder plus its separate failure check. */
const referenceType = (name: string): string => {
  const decoded = oracle.decodeTraeEvent({ event: name, data: '{"probe":true}' })
  if (decoded.type !== 'unknown') return decoded.type
  return oracle.traeFailureOf(decoded) === undefined ? 'unknown' : 'error'
}
const disagreements = candidates.filter((name) => ourType(name) !== referenceType(name))
check('every candidate event name decodes to the same kind on both sides', disagreements.length === 0, disagreements.map((name) => `${name}: ours=${ourType(name)} reference=${referenceType(name)}`).join(' · '))
const ourRecognised = candidates.filter((name) => ourType(name) !== 'unknown')
const referenceRecognised = candidates.filter((name) => referenceType(name) !== 'unknown')
check('we recognise exactly the names the reference recognises — none invented, none missing', canonical(ourRecognised) === canonical(referenceRecognised), `ours=[${ourRecognised.join(',')}] reference=[${referenceRecognised.join(',')}]`)
check('we invent no name the pinned decoder does not know', ourRecognised.every((name) => upstreamStaticNames.includes(name) || name === errorName), ourRecognised.join(','))
check('the [DONE] sentinel still ends a stream on both sides', decodeTraeEvent({ data: '[DONE]' }).type === 'done' && oracle.decodeTraeEvent({ data: '[DONE]' }).type === 'done')
check('an unknown name is preserved as unknown on both sides, never guessed at', ourType('heartbeat') === 'unknown' && referenceType('heartbeat') === 'unknown')
check('all five names declared in the pinned decoder are recognised by us', upstreamStaticNames.length === 5 && upstreamStaticNames.every((name) => ourType(name) !== 'unknown'), upstreamStaticNames.join(','))
witness('D9', `reference decodeTraeEvent("error") -> ${oracle.decodeTraeEvent({ event: 'error', data: '{"probe":true}' }).type}, then traeFailureOf -> error; ours -> ${ourType('error')}`)

// --------------------------------------------------------------------------- 3. stream parity
console.log('\n[3] SSE framing: our parser vs the pinned SseDecoder, on the same bytes')
async function oursEvents(chunks: string[]): Promise<Array<Record<string, unknown>>> {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  const found: Array<Record<string, unknown>> = []
  for await (const event of parseSseStream(body) as AsyncGenerator<SseEvent>) {
    found.push({ ...(event.event === undefined ? {} : { event: event.event }), data: event.data })
  }
  return found
}
function referenceEvents(chunks: string[]): Array<Record<string, unknown>> {
  const decoder = new oracle.SseDecoder()
  const found: Array<Record<string, unknown>> = []
  for (const chunk of chunks) found.push(...decoder.push(chunk))
  return [...found, ...decoder.finish()]
}
const framingKeys = ['event', 'data']
interface StreamExpectation {
  ourCount: number
  referenceCount: number
  nameDiffAt: number[]
  referenceExtraKeysAt: number[]
  divergence: string | null
  note: string
}
const STREAM_EXPECTATIONS: Readonly<Record<string, StreamExpectation>> = {
  canonical: { ourCount: 12, referenceCount: 12, nameDiffAt: [], referenceExtraKeysAt: [10, 11], divergence: 'D7', note: 'every named event, an unknown one, an error and [DONE]; the reference leaks id:42 on from the error event onto [DONE]' },
  emitProbe: { ourCount: 6, referenceCount: 6, nameDiffAt: [], referenceExtraKeysAt: [], divergence: null, note: 'only the framing matters here; it drives [4]' },
  'event-name-trailing-space': { ourCount: 1, referenceCount: 1, nameDiffAt: [0], referenceExtraKeysAt: [], divergence: 'D4', note: '' },
  'comment-and-blank-line': { ourCount: 1, referenceCount: 1, nameDiffAt: [], referenceExtraKeysAt: [], divergence: null, note: '' },
  // The next two were ours=0 until 2026-10-15: the parser dropped the event outright, so
  // there was nothing to compare. Both now dispatch exactly what the reference does
  // (1/1, payloads byte-identical) and the assertions below say so with no exception.
  'bare-data-without-colon': { ourCount: 1, referenceCount: 1, nameDiffAt: [], referenceExtraKeysAt: [], divergence: null, note: 'was D5 (fixed): a bare `data` line is the field with an empty value, so BOTH parsers dispatch {data:""}' },
  'no-final-blank-line': { ourCount: 1, referenceCount: 1, nameDiffAt: [], referenceExtraKeysAt: [], divergence: null, note: '' },
  'unterminated-final-line': { ourCount: 1, referenceCount: 1, nameDiffAt: [], referenceExtraKeysAt: [], divergence: null, note: 'was D11 (fixed): the residual buffer is consumed in finish(), so the reference and we both keep the event' },
  'empty-event-name': { ourCount: 1, referenceCount: 1, nameDiffAt: [0], referenceExtraKeysAt: [], divergence: 'D6', note: '' },
  'crlf-split-between-cr-and-lf': { ourCount: 1, referenceCount: 1, nameDiffAt: [], referenceExtraKeysAt: [], divergence: null, note: '' }
}
const streams: Array<{ id: string; chunks: string[] }> = [
  { id: 'canonical', chunks: streamFixture.canonical.chunks },
  { id: 'emitProbe', chunks: streamFixture.emitProbe.chunks },
  ...streamFixture.probes.map((probe) => ({ id: probe.id, chunks: probe.chunks }))
]
const undeclared = streams.filter((one) => STREAM_EXPECTATIONS[one.id] === undefined).map((one) => one.id)
check('every stream in the fixture has a declared expectation (a new probe cannot run uncompared)', undeclared.length === 0, undeclared.join(','))
const stale = Object.keys(STREAM_EXPECTATIONS).filter((id) => !streams.some((one) => one.id === id))
check('every declared expectation still has a stream in the fixture', stale.length === 0, stale.join(','))

for (const one of streams) {
  const expected = STREAM_EXPECTATIONS[one.id]
  if (expected === undefined) continue
  const ours = await oursEvents(one.chunks)
  const theirs = referenceEvents(one.chunks)
  check(`stream ${one.id}: event count ours=${ours.length} reference=${theirs.length}`, ours.length === expected.ourCount && theirs.length === expected.referenceCount, expected.note)
  const payloadDiffs = ours.map((event, index) => (theirs[index] === undefined || canonical(event['data']) !== canonical(theirs[index]?.['data']) ? index : -1)).filter((index) => index >= 0)
  check(`stream ${one.id}: every shared payload is framed byte-identically`, payloadDiffs.length === 0, `differing indices ${payloadDiffs.join(',')}`)
  const nameDiffs = ours.map((event, index) => ((event['event'] ?? null) === (theirs[index]?.['event'] ?? null) ? -1 : index)).filter((index) => index >= 0)
  const extraKeys = theirs.map((event, index) => (Object.keys(event).filter((key) => !framingKeys.includes(key)).length > 0 ? index : -1)).filter((index) => index >= 0)
  check(`stream ${one.id}: framing shape differences are exactly the declared ones`, canonical(nameDiffs) === canonical(expected.nameDiffAt) && canonical(extraKeys) === canonical(expected.referenceExtraKeysAt), `names@${nameDiffs.join(',')} extraKeys@${extraKeys.join(',')}`)
  if (expected.divergence === null) {
    check(`stream ${one.id}: ours and the reference agree with nothing left to explain`, canonical(ours) === canonical(theirs))
  } else if (canonical(nameDiffs) === canonical(expected.nameDiffAt) && canonical(extraKeys) === canonical(expected.referenceExtraKeysAt) && (ours.length !== theirs.length || nameDiffs.length + extraKeys.length > 0)) {
    witness(expected.divergence, `stream ${one.id}: counts ${ours.length}/${theirs.length}, names differ at [${nameDiffs.join(',')}], reference carries extra keys at [${extraKeys.join(',')}]`)
  }
}

// The one place the two decoders differ on a PAYLOAD field rather than a name.
{
  const usageEvent = { event: 'token_usage', data: '{"prompt_tokens":12,"completion_tokens":15,"total_tokens":27,"reasoning_tokens":9,"cache_read_input_tokens":128,"cache_creation_input_tokens":64}' }
  const ours = decodeTraeEvent(usageEvent) as Record<string, unknown>
  const theirs = oracle.decodeTraeEvent(usageEvent) as Record<string, unknown>
  check('D8: a cache-write count in token_usage is read upstream and dropped here', theirs['cacheWriteTokens'] === 64 && ours['cacheWriteTokens'] === undefined, `ours=${String(ours['cacheWriteTokens'])} reference=${String(theirs['cacheWriteTokens'])}`)
  check('everything else in the same usage event agrees', ours['inputTokens'] === theirs['inputTokens'] && ours['outputTokens'] === theirs['outputTokens'] && ours['totalTokens'] === theirs['totalTokens'] && ours['reasoningTokens'] === theirs['reasoningTokens'] && ours['cacheReadTokens'] === theirs['cacheReadTokens'])
  if (theirs['cacheWriteTokens'] === 64 && ours['cacheWriteTokens'] === undefined) witness('D8', 'canonical token_usage: reference cacheWriteTokens=64, ours absent (cacheReadTokens agrees at 128)')
}

// --------------------------------------------------------------------------- 4. what we emit
console.log('\n[4] what we emit: chunk shape and the pinned decoder reading our bytes')
const emittedPayloads: unknown[] = []
await pumpTraeStream(parseSseStream(
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of streamFixture.emitProbe.chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
), { write: (payload: unknown) => emittedPayloads.push(payload) }, { model: 'glm-5.2' })
check(`the emit probe produced the expected ${streamFixture.emitProbe.expectedPayloads} payloads`, emittedPayloads.length === streamFixture.emitProbe.expectedPayloads, `got ${emittedPayloads.length}`)

/** Exactly the bytes src/shim.ts:239 and :248 write to the pi-ai-facing socket. */
const emittedBytes = `${emittedPayloads.map((payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`
const emittedEventLines = emittedBytes.split(/\r?\n/).filter((line) => line.startsWith('event:'))
const emittedNames = emittedEventLines.map((line) => line.slice(6).trim())
check('we name no SSE event we emit (so pi-ai reads plain data chunks, as the reference also writes them)', emittedEventLines.length === 0, emittedEventLines.join('|'))
check('any name we did emit would have to be one the reference knows', emittedNames.every((name) => upstreamStaticNames.includes(name) || name === errorName), emittedNames.join(','))

const chunkShape = emittedPayloads.map((payload) => payload as Record<string, unknown>)
const ourChunkKeys = [...new Set(chunkShape.flatMap((chunk) => Object.keys(chunk)))].sort()
check('our emitted chunk field set is the pinned literal\'s field set', canonical(ourChunkKeys) === canonical(declaredChunkKeys), `${ourChunkKeys.join(',')} vs ${declaredChunkKeys.join(',')}`)
const choicesKeys = [...new Set(chunkShape.flatMap((chunk) => (Array.isArray(chunk['choices']) ? (chunk['choices'] as Array<Record<string, unknown>>).flatMap((choice) => Object.keys(choice)) : [])))].sort()
const referenceChoices = /choices:\s*\[\{([\s\S]*?)\}\]/.exec(chunkLiteral)?.[1] ?? ''
check('our emitted choices[] entry exposes the same fields as the pinned chunk', canonical(choicesKeys) === canonical(declaredKeys(referenceChoices)), `${choicesKeys.join(',')} vs ${declaredKeys(referenceChoices).join(',')}`)

const referenceReadOurBytes = referenceEvents([emittedBytes])
const intendedPayloads = [...emittedPayloads.map((payload) => (typeof payload === 'string' ? payload : JSON.stringify(payload))), '[DONE]']
check(
  'the pinned SseDecoder reads our emitted bytes into exactly the payloads we intended, with no event name',
  referenceReadOurBytes.length === intendedPayloads.length && referenceReadOurBytes.every((event, index) => event['event'] === undefined && canonical(event['data']) === canonical(intendedPayloads[index])),
  `${referenceReadOurBytes.length} events vs ${intendedPayloads.length} payloads`
)
check('our own parser reads those same bytes back to the same payloads', canonical((await oursEvents([emittedBytes])).map((event) => event['data'])) === canonical(referenceReadOurBytes.map((event) => event['data'])))
const ourChunkIds = chunkShape.map((chunk) => String(chunk['id']))
check('chunk ids keep the OpenAI prefix the reference also uses', ourChunkIds.every((id) => /^chatcmpl-/.test(id)), ourChunkIds[0])
const referenceIdForm = /const id = `([^`]*)`;/.exec(indexSource)?.[1] ?? ''
check('the reference builds its chunk id the same way it is documented here', referenceIdForm.startsWith('chatcmpl-'), referenceIdForm)
if (referenceIdForm.startsWith('chatcmpl-') && ourChunkIds.every((id) => /^chatcmpl-trae-\d+$/.test(id))) {
  witness('D10', `our ids ${ourChunkIds[0]}… vs the reference's form ${referenceIdForm}`)
}

// --------------------------------------------------------------------------- 5. error contract
console.log('\n[5] in-stream failures: code -> HTTP status, and the hint table')
for (const code of [1005, 4001, 4011, 4000, undefined]) {
  const ours = statusForTraeError(code)
  const theirs = oracle.classifyTraeFailure(code === undefined ? {} : { code }).status
  check(`code ${String(code)}: we answer ${ours}, the reference answers ${theirs}`, ours === theirs)
}
const ourHintCodes = Object.keys(TRAE_ERROR_HINTS).map(Number).sort((a, b) => a - b)
const referenceHintCodes = Object.keys(oracle.TRAE_ERROR_HINTS).map(Number).sort((a, b) => a - b)
check('the hint table covers exactly the codes the reference documents', canonical(ourHintCodes) === canonical(referenceHintCodes), `${ourHintCodes.join(',')} vs ${referenceHintCodes.join(',')}`)
check('every hint matches the reference word for word where both explain the same code', ourHintCodes.every((code) => TRAE_ERROR_HINTS[code] === oracle.TRAE_ERROR_HINTS[String(code)]))

// --------------------------------------------------------------------------- 6. no silent divergence
console.log('\n[6] divergence ledger: nothing observed, nothing unexplained')
const ledgerIds = KNOWN_DIVERGENCES.map((entry) => entry.id)
for (const entry of KNOWN_DIVERGENCES) {
  check(`${entry.id} (${entry.kind}, ${entry.area}) is still a real, observed difference`, witnessed.has(entry.id), `${entry.evidence} — ${entry.ours} vs ${entry.upstream}`)
}
for (const id of witnessed.keys()) {
  check(`${id} was observed and is recorded in the ledger`, ledgerIds.includes(id))
}
const gaps = KNOWN_DIVERGENCES.filter((entry) => entry.kind === 'gap')
if (gaps.length > 0) {
  console.log('\n  REPORTED BUT NOT FIXED (src/ belongs to its owner):')
  for (const gap of gaps) console.log(`    ${gap.id} ${gap.ours}\n        vs reference: ${gap.upstream}\n        why it matters: ${gap.reason}`)
}

console.log('-'.repeat(72))
console.log(`${passed} passed · ${failures} failed`)
if (failures === 0) {
  console.log(`CONTRACT OK — verified against dsh-connect-trae@3.4.0 (tarball ${tarballDigest.slice(0, 12)}…, lib/index.js ${sha256(PIN_INDEX).slice(0, 12)}…)`)
  console.log(`  ${fixture.cases.length} request bodies · ${ourRecognised.length} recognised event names · ${streams.length} streams · ${KNOWN_DIVERGENCES.length} declared divergences, all observed`)
}
process.exit(failures === 0 ? 0 : 1)

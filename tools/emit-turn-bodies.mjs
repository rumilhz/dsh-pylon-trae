/**
 * Export the request bodies this plugin REALLY produces, as a fixture.
 *
 *   <dsh-node> tools/emit-turn-bodies.mjs            (re)write tools/fixtures/turn-bodies.json
 *   <dsh-node> tools/emit-turn-bodies.mjs --check    print, write nothing
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS — "expected values must not come from our own code"
 *
 * Every other suite in this repo asserts against numbers this repo chose:
 * `test-api.ts` builds a body and checks it against the shape `test-api.ts`
 * believes in. That can only ever prove the belief is self-consistent, never that
 * it is the contract Trae's own client speaks.
 *
 * So the bodies below are not written out by hand either — they come out of the
 * same `buildTraeBody` the shim calls (`src/shim.ts:205`, `src/api.ts:387`), with
 * the same `wireTargetOf()` derivation the shim uses for a roster model, and they
 * are then handed to the pinned upstream implementation of the same protocol
 * (`~/.dsh/trae-pin/dsh-connect-trae-3.4.0`, integrity checked in
 * `tools/test-contract.ts`) as the counterparty.
 *
 * ---------------------------------------------------------------------------
 * WHY THE VERIFICATION TARGET IS SOURCE, NOT A BUILD ARTIFACT
 *
 * The upstream sibling does this with `lib/gateway-adapter.js` precisely so the
 * object under test is the published artifact. This plugin has no equivalent:
 *   · `package.json` `main` is `./src/index.ts` — the host loads TypeScript and
 *     strips the types itself, so the source IS the shipped artifact;
 *   · `lib/` holds one file, `client.js`, which is the browser settings card and
 *     contains no protocol code at all (verified: nothing in it mentions
 *     `config_name` or `buildTraeBody`).
 * Inventing a build step just to have something to import would verify a second,
 * fresh artifact that nobody ships — worse than verifying the real one. The
 * digests below pin exactly which bytes were verified.
 * ---------------------------------------------------------------------------
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { FALLBACK_MODELS } from '../src/catalog.ts'
import { buildTraeBody, wireTargetOf } from '../src/protocol.ts'

export const FIXTURE_SCHEMA = 'dsh-pylon-trae/turn-bodies@1'

/** The bytes under verification: the module that builds bodies, plus what it pulls in. */
export const VERIFIED_SOURCES = ['src/protocol.ts', 'src/catalog.ts', 'src/format.ts']

export const HERE = import.meta.dirname
export const PLUGIN_ROOT = join(HERE, '..')
export const FIXTURE_PATH = join(HERE, 'fixtures', 'turn-bodies.json')

/**
 * The cases. Each one is an OpenAI-shaped body as pi-ai's `openai-completions`
 * parser would post it to the loopback shim, plus how the shim resolves its wire
 * target. `why` names the branch of `buildTraeBody` the case exists to cover —
 * a case with no branch is a case that proves nothing.
 */
const CASES = [
  {
    id: 'probe-ping',
    why: 'The model-probe body, verbatim from src/api.ts:387 — and the one case that sends no `stream`, so it also pins that `stream:true` is forced rather than copied.',
    targetFrom: { kind: 'roster', region: 'cn', index: 0 },
    request: { model: 'DeepSeek-V4-Flash-Official', messages: [{ role: 'user', content: 'ping' }] }
  },
  {
    id: 'plain-text-multi-turn',
    why: 'Ordinary chat: every string content becomes [{type:"text",text}], array content is left exactly as it arrived.',
    targetFrom: { kind: 'roster', region: 'cn', index: 2 },
    request: {
      model: 'glm-5.2',
      stream: true,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: [{ type: 'text', text: 'second question, already an array' }] }
      ]
    }
  },
  {
    id: 'developer-role',
    why: 'A `developer` message is renamed to `system` (the one role translation), while the text is translated independently — both must happen on the same message.',
    targetFrom: { kind: 'roster', region: 'ai', index: 0 },
    request: {
      model: 'gemini-3.1-pro',
      stream: true,
      messages: [
        { role: 'developer', content: 'Answer in one word.' },
        { role: 'user', content: 'capital of France?' }
      ]
    }
  },
  {
    id: 'thinking-replay',
    why: 'Replayed thinking: `reasoning_content` on an assistant turn must survive untouched — this builder translates shapes, never inspects model output.',
    targetFrom: { kind: 'roster', region: 'cn', index: 3 },
    request: {
      model: 'kimi-k2.6',
      stream: true,
      messages: [
        { role: 'user', content: 'why is the sky blue?' },
        {
          role: 'assistant',
          content: 'Rayleigh scattering.',
          reasoning_content: 'The user asks a physics question; answer in one line.'
        },
        { role: 'user', content: 'and at sunset?' }
      ]
    }
  },
  {
    id: 'tools-declared',
    why: 'Tool declarations: a JSON-Schema `parameters` object is sent as a JSON *string*; a malformed entry (no `function`) is skipped instead of throwing.',
    targetFrom: { kind: 'roster', region: 'cn', index: 2 },
    request: {
      model: 'glm-5.2',
      stream: true,
      messages: [{ role: 'user', content: 'what time is it?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_time',
            description: 'Current local time',
            parameters: { type: 'object', properties: { tz: { type: 'string' } }, required: [] }
          }
        },
        { type: 'function' }
      ]
    }
  },
  {
    id: 'tool-call-backfill',
    why: 'The tool loop closing: an assistant `tool_calls[].function` becomes the wire\'s `function_call`, and a `tool` result must carry a non-empty `tool_call_id`.',
    targetFrom: { kind: 'roster', region: 'cn', index: 2 },
    request: {
      model: 'glm-5.2',
      stream: true,
      messages: [
        { role: 'user', content: 'what time is it?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"iso":"2026-10-14T23:55:00+08:00"}' }
      ],
      tools: [
        { type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } }
      ]
    }
  },
  {
    id: 'reasoning-effort',
    why: 'A declared thinking level travels as `reasoning_effort` with the spelling the directory chose (src/seed.ts maps pi levels to Trae spellings).',
    targetFrom: { kind: 'roster', region: 'cn', index: 2 },
    request: {
      model: 'glm-5.2',
      stream: true,
      reasoning_effort: 'light',
      messages: [{ role: 'user', content: 'think briefly' }]
    }
  },
  {
    id: 'unknown-model-passthrough',
    why: 'A model id the roster does not know: src/shim.ts:202 targets it with the default function rather than refusing, so Trae\'s own 4001 is the answer.',
    targetFrom: { kind: 'shim-unknown', configName: 'some-model-typed-by-the-user' },
    request: {
      model: 'some-model-typed-by-the-user',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }]
    }
  },
  {
    id: 'reasoning-effort-empty',
    why: 'DOCUMENTED DIVERGENCE (see tools/test-contract.ts KNOWN_DIVERGENCES): an empty spelling is dropped here and forwarded upstream. Synthetic: pi-ai only sends a level the directory declared, so this shape should not occur in real traffic.',
    synthetic: true,
    targetFrom: { kind: 'roster', region: 'cn', index: 2 },
    request: {
      model: 'glm-5.2',
      stream: true,
      reasoning_effort: '',
      messages: [{ role: 'user', content: 'no level named' }]
    }
  },
  {
    id: 'function-passthrough',
    why: 'DOCUMENTED DIVERGENCE (see tools/test-contract.ts KNOWN_DIVERGENCES): a caller-supplied `function` is honoured upstream and ignored here. Synthetic: pi-ai\'s openai-completions request has no top-level `function`.',
    synthetic: true,
    targetFrom: { kind: 'roster', region: 'cn', index: 0 },
    request: {
      model: 'DeepSeek-V4-Flash-Official',
      stream: true,
      function: 'solo_coder',
      messages: [{ role: 'user', content: 'hello' }]
    }
  }
]

/** Resolve a case's wire target through the same code the shim runs. */
export function targetOf(targetFrom) {
  if (targetFrom.kind === 'roster') {
    const model = FALLBACK_MODELS[targetFrom.region][targetFrom.index]
    if (model === undefined) throw new Error(`no roster entry ${targetFrom.region}[${targetFrom.index}]`)
    return { target: wireTargetOf(model), targetSource: `wireTargetOf(FALLBACK_MODELS.${targetFrom.region}[${targetFrom.index}]) = ${model.id}` }
  }
  if (targetFrom.kind === 'shim-unknown') {
    // src/shim.ts:202 — the branch taken when the id is not in the roster.
    return { target: { configName: targetFrom.configName, fn: 'solo_work_lite' }, targetSource: 'src/shim.ts:202 unknown-model fallback' }
  }
  throw new Error(`unknown targetFrom.kind: ${String(targetFrom.kind)}`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Build the fixture in memory. Pure: no clock other than the injected stamp, no
 * writes — `tools/test-contract.ts` imports this so its assertions can never run
 * against a stale file.
 */
export function buildTurnBodies(generatedAt = new Date().toISOString()) {
  const cases = CASES.map((entry) => {
    const { target, targetSource } = targetOf(entry.targetFrom)
    const body = buildTraeBody(entry.request, target)
    return {
      id: entry.id,
      why: entry.why,
      ...(entry.synthetic === true ? { synthetic: true } : {}),
      targetFrom: entry.targetFrom,
      target,
      targetSource,
      request: entry.request,
      body,
      bodyKeys: Object.keys(JSON.parse(body))
    }
  })
  return {
    schema: FIXTURE_SCHEMA,
    generatedBy: 'tools/emit-turn-bodies.mjs',
    generatedAt,
    verificationTarget: {
      kind: 'source',
      module: 'src/protocol.ts',
      function: 'buildTraeBody',
      why: 'package.json main is ./src/index.ts (the host strips types, so source is the shipped artifact) and lib/ holds only the browser settings card',
      digests: Object.fromEntries(VERIFIED_SOURCES.map((relative) => [relative, sha256(join(PLUGIN_ROOT, relative))]))
    },
    cases
  }
}

export function serialize(fixture) {
  return `${JSON.stringify(fixture, null, 2)}\n`
}

const calledAsScript = process.argv[1] !== undefined && import.meta.filename === process.argv[1]
if (calledAsScript) {
  const fixture = buildTurnBodies()
  const text = serialize(fixture)
  const check = process.argv.includes('--check')
  if (!check) {
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true })
    writeFileSync(FIXTURE_PATH, text, 'utf8')
  }
  for (const one of fixture.cases) {
    console.log(`  ${one.id.padEnd(26)} ${one.bodyKeys.join(',')}`)
  }
  console.log(`\n${fixture.cases.length} case(s) from ${fixture.verificationTarget.module}  ${check ? '(not written: --check)' : `-> ${FIXTURE_PATH}`}`)
  for (const [file, digest] of Object.entries(fixture.verificationTarget.digests)) console.log(`  sha256 ${digest}  ${file}`)
}

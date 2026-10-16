/**
 * The plugin's own API: everything the operator can ask for, as transport-free
 * handlers.
 *
 * Two callers share these: the loopback shim exposes them behind its bearer token
 * (so a CLI can drive them today) and the settings card will call the same
 * functions over the host's web server later. Keeping the logic here — not in a
 * route table — is what makes both callers testable offline with a fake fetch.
 *
 * Every handler answers `{ ok: false, detail }` instead of throwing: a card that
 * prints a reason beats a 500 that prints nothing.
 */
import { isExpired, type TraeCredential } from './auth.ts'
import {
  buildTraeHeaders,
  partitionModels,
  REGION_GATEWAYS,
  TRAE_SOLO_CHAT_PATH,
  traeEndpoint,
  type DirectoryAttempt,
  type TraeModel
} from './catalog.ts'
import type { TraeIdentity } from './identity.ts'
import type { TraeRegion } from './paths.ts'
import { buildTraeBody, decodeTraeEvent, parseSseStream } from './protocol.ts'
import type { PruneOutcome, SeedOutcome } from './seed.ts'

export interface TraeAccountInfo {
  id: string
  userId: string
  accountName?: string
  edition: string
  source: string
  expiresAtMs: number
  active: boolean
}

/**
 * What a READ-ONLY directory reload reports back.
 *
 * `ok: false` is "the re-read did not happen" — no credential, every directory
 * function failed, the gateway unreachable — and never "the directory is empty".
 * The two must not be confused: a caller that reads a refusal as a count would
 * offer a Trae provider with zero models. The plugin's in-memory list is left
 * exactly as it was, which is the whole difference between this and `refresh`.
 */
export interface ReloadResult {
  ok: boolean
  /** Why the re-read failed; only read when `ok` is false. */
  detail?: string
  /** How many models the plugin holds AFTER the attempt (unchanged on failure). */
  modelCount: number
  /** One entry per directory function, in the wording `fetchDirectoryModels` used. */
  attempts: DirectoryAttempt[]
}

export interface ApiDeps {
  region: TraeRegion
  port: number
  credential(): Promise<TraeCredential>
  identity(): Promise<TraeIdentity>
  models(): readonly TraeModel[]
  accounts(): Promise<TraeAccountInfo[]>
  /**
   * A user-visible account problem, or `undefined` when there is none.
   *
   * Today's only producer is "the account selection we remembered cannot be
   * produced on this machine any more": `src/index.ts` falls back to the desktop
   * sign-in, and without this the user would keep a card that bills a different
   * account than the one they chose, with the fact recorded only in `boot.log`.
   *
   * A getter because the fact is discovered while `credential()` runs — which
   * `/status` does itself, so reading it after that is reading the current answer.
   * Optional: a composition without one simply has no warnings to report.
   */
  accountWarning?(): string | undefined
  /** Switch the account this plugin bills; persisted outside the profile. */
  selectAccount(accountId: string): Promise<{ ok: boolean; detail?: string }>
  /** Re-read the live directory and add only models never offered before. */
  refresh(): Promise<{ outcome: SeedOutcome; modelCount: number }>
  /**
   * Re-read the live directory and REPLACE the plugin's in-memory list — the
   * read-only half of `refresh`: no seed, no guard, no write to user
   * configuration. It is the only dep `POST /models/reload` may touch; that route
   * must never reach `refresh()`.
   *
   * Optional because the CLI harnesses in tools/ build an ApiDeps of their own; a
   * composition without it answers a readable refusal instead of throwing.
   */
  reload?(): Promise<ReloadResult>
  /**
   * The ids the user's provider entry still carries that the live directory judges
   * internal — the "there is junk in your entry" fact, read-only.
   *
   * Separate from {@link models} on purpose: the catalogue says what Trae OFFERS,
   * this says what the user's configuration currently CONTAINS, and they differ
   * exactly for an entry written before this plugin had a criterion. Optional, so
   * a composition without a settings face answers `[]` instead of throwing — and
   * `[]` here is honest: with no readable entry there is demonstrably nothing
   * this plugin can see to remove.
   */
  internalInEntry?(): Promise<string[]>
  /**
   * The DELETE half: remove the internal components from the entry. Optional for
   * the same reason `reload` is (the offline harnesses build their own ApiDeps);
   * without it `POST /models/prune-internal` answers a readable refusal and writes
   * nothing.
   */
  pruneInternal?(): Promise<PruneOutcome>
  fetchImpl?: typeof fetch
}

export interface ApiRequest {
  method: string
  /** Path relative to the plugin prefix, e.g. `/status`. */
  path: string
  body?: unknown
}

export interface ApiResponse {
  status: number
  body: Record<string, unknown>
}

const ok = (body: Record<string, unknown>): ApiResponse => ({ status: 200, body: { ok: true, ...body } })
const bad = (detail: string, status = 200): ApiResponse => ({ status, body: { ok: false, detail } })

/**
 * One catalogue row, as every model route answers with it.
 *
 * `kind` is on EVERY row, not only on the ones that are internal: a consumer that
 * filters on `kind === 'chat'` and one that filters on `kind !== 'chat'` must
 * both be able to, and "the field is missing" must never be a third answer to
 * "is this a conversation model". `internalReason` is added only where it exists
 * (see `classifyDirectoryEntry`) so the field's presence is itself meaningful.
 */
function describeModel(model: TraeModel): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    kind: model.kind,
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxTokens ?? null,
    input: [...model.input],
    directoryFunction: model.directoryFunction,
    ...(model.internalReason === undefined ? {} : { internalReason: model.internalReason })
  }
}

/**
 * The ids in the user's entry that the live directory judges internal — never a
 * throw.
 *
 * A missing dep and a failing read both answer `[]`, and both are honest: this
 * number is only ever used to decide whether to OFFER a clean-up and how many
 * rows it would touch, and a list this plugin failed to read must not become a
 * count of rows it claims are there.
 */
async function readInternalInEntry(deps: ApiDeps): Promise<string[]> {
  const read = deps.internalInEntry
  if (read === undefined) return []
  try {
    const ids = await read()
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : []
  } catch {
    return []
  }
}

/** A short, non-secret description of the active credential. */
function describeCredential(credential: TraeCredential): Record<string, unknown> {
  return {
    source: credential.source,
    edition: credential.edition,
    userId: credential.userId,
    accountName: credential.accountName ?? null,
    host: credential.host || null,
    expiresAtMs: credential.expiresAtMs
  }
}

/**
 * Why an account scan failed, as one bounded, never-empty line.
 *
 * A dep may reject with anything — an `Error`, a bare string, a value with no message
 * at all — and `accountsError: ''` would leave the card with a colon and nothing after
 * it. The line is flattened and cut to `ACCOUNT_ERROR_CHARS`; it is a diagnostic, and
 * only the scan's own text is ever quoted.
 */
function describeScanFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat === '' ? '账号扫描失败，但没有给出原因' : flat.slice(0, ACCOUNT_ERROR_CHARS)
}

/**
 * Flatten any value into ONE bounded, non-empty line.
 *
 * Every detail this module answers with is bounded for the same reason a
 * diagnostic is worthless unbounded: an exception message can be megabytes, and
 * a response that is one giant error string is not a diagnosis. Flattening comes
 * first so a multi-line message (the credential scan's candidate table is built
 * as lines) still renders as one card row.
 *
 * `DETAIL_CHARS` is larger than `ACCOUNT_ERROR_CHARS` on purpose: a scan failure
 * is a path plus a parse error, while a *credential* failure now carries the list
 * of candidates that were probed — the scene the user needs to tell "not
 * installed" from "not signed in" — and cutting that at 200 characters would keep
 * the first six candidates and drop the rest.
 */
function boundLine(value: unknown): string {
  const flat = (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
  return flat === '' ? '(服务端没有给出原因)' : flat.slice(0, DETAIL_CHARS)
}

/**
 * Read this much of an answer before giving up on it. It is a memory bound, so it
 * has to sit far above anything a gateway legitimately sends: the entitlements
 * envelope is already several KiB, and slicing at that scale cut real JSON in half
 * (see the note in `post`).
 */
const MAX_POST_BODY_CHARS = 1 << 20

/**
 * How much of an unexpected body a detail line may quote. Only ever used to build
 * the `text` a caller prints — never a parse input.
 */
const POST_EXCERPT_CHARS = 200

/**
 * How much of an account-scan failure a `/status` answer may quote. That scan reads
 * local credential files, so its failures are paths and parse errors; the bound is
 * here so a pathological message can never become the whole response.
 */
const ACCOUNT_ERROR_CHARS = 200

/**
 * How much of ANY other failure one answer may quote — the credential resolution
 * (whose "no credential" line names every probed candidate) and anything a dep
 * throws. Comfortably above the ~400-character candidate table, because a
 * diagnostic that is cut before the part that differs between the two causes it is
 * meant to separate ("Trae is not installed" vs "installed but not signed in") has
 * spent its length without buying anything.
 */
const DETAIL_CHARS = 700

/**
 * How many models ONE `/models/test` request may really probe.
 *
 * Every probe is a real request against the account's quota, sent one after another
 * with a 30 s timeout each, so an unbounded list is both a spend and a hang: 79 ids
 * used to mean 79 real probes inside a single call. Ten covers a card's normal
 * tick-boxes; everything past it is reported as NOT tested (`requested` / `tested` /
 * `truncated`) rather than silently probed.
 */
const MAX_PROBE_MODELS = 10

interface PostResult {
  status: number
  payload: Record<string, unknown>
  /** Bounded, never-empty excerpt of the body; for a detail line, not for parsing. */
  text: string
  /** The body was a complete JSON object (an envelope, not a proxy page / array / empty). */
  jsonObject: boolean
  /** The body was longer than `MAX_POST_BODY_CHARS`, so it was never parsed in full. */
  bodyTruncated: boolean
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<PostResult> {
  const response = await fetchImpl(traeEndpoint(base, path), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  })
  // Parse the body BEFORE shortening anything for display. The old code sliced the
  // text to 4096 characters and only then called JSON.parse, so a complete, honest
  // envelope larger than that was cut mid-string and reported as "not a JSON object"
  // — the gateway blamed for the plugin's own truncation. The cap below is a memory
  // bound and is reported as such (`bodyTruncated`), never as a malformed body.
  const raw = await response.text().catch(() => '')
  if (raw.length > MAX_POST_BODY_CHARS) {
    return {
      status: response.status,
      payload: {},
      text: excerptOf(raw.slice(0, POST_EXCERPT_CHARS)),
      jsonObject: false,
      bodyTruncated: true
    }
  }
  let payload: Record<string, unknown> = {}
  // `jsonObject` is what separates "the gateway answered an envelope" from "something
  // in between answered something else": both give an empty `payload`, and a route
  // that only looks at `payload` cannot tell the difference. An HTML proxy page, an
  // empty body and a JSON array all land here with `jsonObject: false`.
  let jsonObject = false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>
      jsonObject = true
    }
  } catch {
    // non-JSON answers are reported by their HTTP status and body excerpt
  }
  return { status: response.status, payload, text: excerptOf(raw), jsonObject, bodyTruncated: false }
}

/** A bounded, non-throwing JSON spelling of an unexpected value, for a detail line. */
function literalOf(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 80))
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value).slice(0, 80) : text.slice(0, 80)
  } catch {
    return String(value).slice(0, 80)
  }
}

/**
 * One line of body text for a detail string: never empty (an empty body would leave
 * the sentence dangling on a colon) and never unbounded.
 */
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat === '' ? '(empty body)' : flat.slice(0, POST_EXCERPT_CHARS)
}

/** How a gateway envelope spells its business code: usually a number, sometimes a string. */
type BusinessCode = { kind: 'ok' } | { kind: 'refused'; code: number } | { kind: 'unreadable'; literal: string }

/**
 * Read a gateway's business `code` without guessing.
 *
 * The pay gateway answers with a JSON number in most places, but the same family
 * has been seen spelling it as a numeric string (`"0"`, `"3001"`). The old
 * `typeof code === 'number' ? code : 0` turned every string form into 0, so a
 * refusal was read as success. Here a number is used as-is, a string of digits is
 * converted, and any other shape (`"abc"`, `null`, `{}`) is `unreadable` — the
 * caller must refuse that instead of inventing a 0.
 *
 * A missing `code` is not a refusal: the check-in status answer carries no code at
 * all and is understood from its own fields.
 */
function readBusinessCode(payload: Record<string, unknown>): BusinessCode {
  if (!('code' in payload)) return { kind: 'ok' }
  const raw = payload['code']
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw === 0 ? { kind: 'ok' } : { kind: 'refused', code: raw }
  }
  if (typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim())) {
    const value = Number(raw.trim())
    if (Number.isFinite(value)) return value === 0 ? { kind: 'ok' } : { kind: 'refused', code: value }
  }
  return { kind: 'unreadable', literal: literalOf(raw) }
}

/** The `: message` tail every refusal line shares (bounded, omitted when empty). */
function messageTail(payload: Record<string, unknown>): string {
  const message = String(payload['message'] ?? '').slice(0, 160)
  return message === '' ? '' : `: ${message}`
}

/** The line for a code whose shape this plugin cannot read at all. */
function unreadableCodeDetail(payload: Record<string, unknown>, what: string, literal: string): string {
  return `${what} answered a code this plugin cannot interpret (${literal})${messageTail(payload)}`
}

/**
 * A detail line for a business code that is present and not OK — or `null` when the
 * envelope carries no refusal (missing code, or code 0) and the caller may proceed.
 *
 * Shared by every route that reads an envelope so they cannot drift apart: the
 * check-in status GET used to skip this check entirely and report a refusal as
 * "not checked in today".
 */
function businessRefusal(payload: Record<string, unknown>, what: string): string | null {
  const verdict = readBusinessCode(payload)
  if (verdict.kind === 'ok') return null
  if (verdict.kind === 'refused') return `${what} refused with code ${verdict.code}${messageTail(payload)}`
  return unreadableCodeDetail(payload, what, verdict.literal)
}

/**
 * Pull the numbers a user recognises out of the entitlements payload.
 *
 * Deliberately tolerant and shallow-recursive: the CN pay gateway nests its
 * figures (`usage_summary`, `user_entitlement_pack_list`), and this plugin should
 * report what is really there under the gateway's own field names rather than
 * fabricate a "Work: 0" from a guessed schema.
 */
function extractNumbers(payload: Record<string, unknown>, depth = 0, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(payload)) {
    const name = prefix === '' ? key : `${prefix}.${key}`
    // Match on the LEAF name only: testing the dotted path made every field under
    // `…entitlement_base_info` look like a credit figure (timestamps included).
    if (typeof value === 'number' && Number.isFinite(value) && /credit|point|usage|quota|amount|balance/i.test(key)) {
      out[name] = value
      continue
    }
    if (depth < 2 && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, extractNumbers(value as Record<string, unknown>, depth + 1, name))
      continue
    }
    if (depth < 2 && Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
          Object.assign(out, extractNumbers(entry as Record<string, unknown>, depth + 1, `${name}[${index}]`))
        }
      }
    }
  }
  return out
}

/** Codes the gateways use for "you cannot call this model", as measured upstream. */
function classifyProbeStatus(status: number, firstErrorCode: number | undefined): { verdict: string; detail: string } {
  if (status === 200 && firstErrorCode === undefined) return { verdict: 'available', detail: 'answered 200' }
  if (firstErrorCode === 1005) return { verdict: 'needs-plan', detail: 'Trae requires a paid plan for this model' }
  if (firstErrorCode === 4001) return { verdict: 'not-served', detail: 'this function does not serve that config_name' }
  if (firstErrorCode === 4011) return { verdict: 'not-served', detail: 'refused under the SOLO function used' }
  if (status === 401 || status === 403) return { verdict: 'auth-rejected', detail: `HTTP ${status}` }
  if (status === 429) return { verdict: 'rate-limited', detail: 'HTTP 429' }
  if (firstErrorCode !== undefined) return { verdict: 'inconclusive', detail: `Trae code ${firstErrorCode}` }
  return { verdict: 'inconclusive', detail: `HTTP ${status}` }
}

/**
 * Send one minimal message and read only the first event — the cheapest real probe.
 *
 * A 200 is only `available` when the stream actually showed something (a delta or a
 * done); a 200 with nothing readable in the body is `inconclusive`.
 */
async function probeModel(
  model: TraeModel,
  credential: TraeCredential,
  identity: TraeIdentity,
  fetchImpl: typeof fetch
): Promise<{ id: string; verdict: string; detail: string }> {
  let body: string
  try {
    body = buildTraeBody({ model: model.id, messages: [{ role: 'user', content: 'ping' }] }, { configName: model.id, fn: model.directoryFunction })
  } catch (error) {
    return { id: model.id, verdict: 'inconclusive', detail: error instanceof Error ? error.message : String(error) }
  }
  try {
    const response = await fetchImpl(traeEndpoint(REGION_GATEWAYS[credential.region].chat, TRAE_SOLO_CHAT_PATH), {
      method: 'POST',
      headers: buildTraeHeaders(credential, identity),
      body,
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) return { id: model.id, ...classifyProbeStatus(response.status, undefined) }
    // What the stream DELIVERED decides a 200, not the status line. An answer that
    // carries no readable event (empty body, keep-alives only, usage without output)
    // proves nothing about the model, and the old code called it `available` — the one
    // verdict a caller acts on, awarded for saying nothing at all.
    let code: number | undefined
    let saw: 'content' | 'error' | undefined
    if (response.body !== null) {
      for await (const event of parseSseStream(response.body)) {
        const decoded = decodeTraeEvent(event)
        if (decoded.type === 'error') {
          code = decoded.code
          saw = 'error'
          break
        }
        if (decoded.type === 'delta' || decoded.type === 'done') {
          saw = 'content'
          break
        }
      }
    }
    if (saw === undefined) {
      return { id: model.id, verdict: 'inconclusive', detail: 'answered 200 but the stream carried no event this plugin recognises (empty body or keep-alives only)' }
    }
    // An error event that carries no code is still an error: `classifyProbeStatus(200,
    // undefined)` would read the missing code as a clean answer.
    if (saw === 'error' && code === undefined) {
      return { id: model.id, verdict: 'inconclusive', detail: 'Trae reported an error in the stream without a code' }
    }
    return { id: model.id, ...classifyProbeStatus(200, code) }
  } catch (error) {
    return { id: model.id, verdict: 'inconclusive', detail: error instanceof Error ? error.message : String(error) }
  }
}

export async function handleApi(request: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const path = request.path.replace(/\/+$/, '') || '/status'
  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>

  try {
    if (request.method === 'GET' && path === '/status') {
      // The credential is required; the account scan is a separate fact that can fail on
      // its own. It used to be `.catch(() => [])`, which spelled a FAILED scan and a
      // machine with no other account the same way (`accounts: []`) — and the card could
      // then state "没有账号", a claim about this machine that the plugin never verified.
      // The two cases now have different shapes: a real list (`[]` when the scan really
      // found none) or `null` plus the reason. `null` is deliberate — an empty array
      // cannot say "unknown", and a consumer that cannot read `null` reads "no answer"
      // (the CLI prints it verbatim), never "no accounts".
      const [credential, scan] = await Promise.all([
        deps.credential(),
        deps.accounts().then(
          (accounts) => ({ scanned: true as const, accounts }),
          (error: unknown) => ({ scanned: false as const, detail: describeScanFailure(error) })
        )
      ])
      // Read AFTER the two promises: `credential()` is where a dropped account
      // selection is discovered, so this is the first moment the answer exists.
      // Absent (not empty-string) when there is nothing to warn about, so
      // `'accountWarning' in body` is itself the question "is there a problem?".
      const warning = deps.accountWarning?.()
      // The catalogue's own split, computed ONCE here so the three counts on this
      // answer cannot disagree with each other or with `GET /models`.
      const catalogue = partitionModels(deps.models())
      const entryInternalIds = await readInternalInEntry(deps)
      return ok({
        region: deps.region,
        port: deps.port,
        modelCount: deps.models().length,
        /**
         * 「对话模型 N 个」and「另有 M 个内部组件已隐藏」.
         *
         * Both are on the answer the card already polls, because the alternative —
         * a second request on mount — is a request the card does not need to make
         * for two numbers that come from data this handler already holds.
         *
         * `entryInternalIds` answers a DIFFERENT question: how many internal
         * components are still sitting in the user's own provider entry (an entry
         * written before this plugin had a criterion). It is read from settings, so
         * a composition without them reports `[]` — "nothing I can see to remove",
         * never a fabricated count.
         */
        chatCount: catalogue.chat.length,
        internalCount: catalogue.internal.length,
        entryInternalIds,
        credential: describeCredential(credential),
        /**
         * The plugin's own verdict on the deadline, next to the deadline itself.
         *
         * Both are here on purpose. `credential.expiresAtMs` is the FACT (0 = this
         * document carried no expiry, which is not the same as "expired in 1970"),
         * and `credentialExpired` is the plugin's READING of it — which carries the
         * 60 s margin (see `isExpired`), a value no consumer could recompute without
         * a second copy of the rule. The boolean is ALWAYS present rather than
         * "present when true": `false` and "the field is missing" must never be the
         * same answer for the one fact that decides whether the account still works.
         *
         * The readable sentence does NOT live here — it goes out through
         * `accountWarning` below, which the card already renders verbatim in red.
         */
        credentialExpiresAtMs: credential.expiresAtMs,
        credentialExpired: isExpired(credential),
        accounts: scan.scanned ? scan.accounts : null,
        ...(typeof warning === 'string' && warning !== '' ? { accountWarning: boundLine(warning) } : {}),
        // Present ONLY when the scan failed, so `'accountsError' in body` is itself the
        // question "did the scan run?" — there is no third state to spell out.
        ...(scan.scanned ? {} : { accountsError: scan.detail })
      })
    }

    if (request.method === 'GET' && path === '/models') {
      // DEFAULT VIEW = the conversation models only, because that is what this
      // plugin is for: a row that is not a model is not something to offer. The
      // internal components are not hidden from the operator — they are COUNTED
      // here, LISTED by id, and shown in full (with the reason each one was judged)
      // by `GET /models/all` below.
      const catalogue = partitionModels(deps.models())
      return ok({
        models: catalogue.chat.map(describeModel),
        chatCount: catalogue.chat.length,
        internalCount: catalogue.internal.length,
        internalIds: catalogue.internalIds,
        entryInternalIds: await readInternalInEntry(deps)
      })
    }

    if (request.method === 'GET' && path === '/models/all') {
      // 🔎 DIAGNOSTIC ONLY — read-only, never written anywhere, and the one answer
      // that carries `internalReason`. It exists so "why is model X missing from my
      // list?" is a question with a printable answer instead of a guess.
      const catalogue = partitionModels(deps.models())
      return ok({
        models: [...catalogue.chat, ...catalogue.internal].map(describeModel),
        chatCount: catalogue.chat.length,
        internalCount: catalogue.internal.length,
        internalIds: catalogue.internalIds,
        entryInternalIds: await readInternalInEntry(deps)
      })
    }

    if (request.method === 'POST' && path === '/models/prune-internal') {
      // The ONE route that deletes from user configuration, and it only ever runs
      // because someone clicked a button: there is no timer, no boot hook and no
      // auto-repair path that reaches `deps.pruneInternal`. What may be removed is
      // decided by the LIVE catalogue's verdict (src/seed.ts intersects it with the
      // entry and refuses to touch anything else), and the write goes through the
      // same guard as seeding — snapshot, write, re-read, roll back.
      //
      // The answer names every id it removed. A delete the user cannot enumerate is
      // indistinguishable from a bug, and the backup path comes with it so the
      // exact previous file is reachable.
      const prune = deps.pruneInternal
      if (prune === undefined) {
        return bad('这个进程没有接上「移除内部组件」的实现（未注入 pruneInternal）：没有改动任何配置')
      }
      const outcome = await prune()
      return ok({
        kind: outcome.kind,
        ...(outcome.kind === 'pruned' || outcome.kind === 'nothing' ? { removed: outcome.kind === 'pruned' ? outcome.removed : [] } : {}),
        outcome
      })
    }

    if (request.method === 'POST' && path === '/models/refresh') {
      const { outcome, modelCount } = await deps.refresh()
      return ok({ kind: outcome.kind, modelCount, outcome })
    }

    if (request.method === 'POST' && path === '/models/reload') {
      // 🔴 READ-ONLY BY CONSTRUCTION — this route re-reads the gateway directory and
      // replaces the plugin's in-memory list, and it NEVER writes user configuration:
      // `deps.refresh()` (src/seed.ts + src/guard.ts) is the only dep that seeds, and
      // it is deliberately not called here. The two buttons on the card mean two
      // different things ("刷新目录" = re-read the gateway, "重建清单" = re-read and
      // write only-new models), so they are two different routes rather than one
      // route with a flag.
      //
      // A refusal carries NO `modelCount`: the plugin kept the list it had, and a
      // number in a failure body would let a caller read "0 models" out of a
      // re-read that never happened.
      const reload = deps.reload
      if (reload === undefined) {
        return bad('这个进程没有接上「重拉目录」的实现（只读端点未注入）：没有重拉，也没有改动配置')
      }
      const result = await reload()
      if (!result.ok) return bad(result.detail ?? '重新拉取目录失败（现有清单未改动）')
      // `at` is stamped HERE, when the answer is built: it is the moment the plugin's
      // in-memory list became this answer's `modelCount` — which is exactly what the
      // card's "上次读取" line claims.
      return ok({ modelCount: result.modelCount, at: Date.now(), attempts: result.attempts })
    }

    if (request.method === 'POST' && path === '/account') {
      const accountId = typeof body['accountId'] === 'string' ? body['accountId'] : ''
      if (accountId === '') return bad('body needs accountId')
      const result = await deps.selectAccount(accountId)
      return result.ok ? ok({ active: accountId }) : bad(result.detail ?? 'switch failed')
    }

    if (request.method === 'GET' && path === '/usage') {
      const [credential, identity] = await Promise.all([deps.credential(), deps.identity()])
      if (credential.region !== 'cn') return bad('usage credits are CN-only; the international region is subscription-based')
      const headers = buildTraeHeaders(credential, identity, 'application/json')
      const { status, payload, text, jsonObject, bodyTruncated } = await post(REGION_GATEWAYS.cn.pay, '/trae/api/v2/pay/web_user_ent_usage', { require_usage: true }, headers, fetchImpl)
      if (status !== 200) return bad(`pay gateway answered HTTP ${status}: ${text}`)
      // Truncated-for-memory comes first: parsing that prefix would only report the
      // plugin's own cap as a malformed gateway answer.
      if (bodyTruncated) return bad(`pay gateway answered more than ${MAX_POST_BODY_CHARS} characters; refusing to read it as an envelope: ${text}`)
      // A 200 whose body is not a JSON object (a proxy's HTML page, an empty body, a
      // bare array) carries no envelope at all; reading it as `payload = {}` used to
      // return `ok:true, credits: {}` — a success reporting zero numbers as if the
      // account really had none. The excerpt says what actually came back.
      if (!jsonObject) return bad(`pay gateway answered HTTP ${status} but the body is not a JSON object: ${text}`)
      // A string code ("0" / "3001") is read as the number it spells; a code that
      // cannot be read at all is refused rather than assumed to be 0.
      const refusal = businessRefusal(payload, 'pay gateway')
      if (refusal !== null) return bad(refusal)
      return ok({ region: 'cn', credits: extractNumbers(payload), payloadKeys: Object.keys(payload) })
    }

    if (path === '/checkin') {
      const [credential, identity] = await Promise.all([deps.credential(), deps.identity()])
      if (credential.region !== 'cn') return bad('check-in is CN-only')
      const headers = { ...buildTraeHeaders(credential, identity, 'application/json'), 'x-device-id': identity.deviceId }
      if (request.method === 'GET') {
        const { status, payload, text, jsonObject, bodyTruncated } = await post(REGION_GATEWAYS.cn.pay, '/trae/api/v2/ug/checkin_credits/status', {}, headers, fetchImpl)
        if (status !== 200) return bad(`check-in status answered HTTP ${status}: ${text}`)
        if (bodyTruncated) return bad(`check-in status answered more than ${MAX_POST_BODY_CHARS} characters; refusing to read it as an envelope: ${text}`)
        // Same criterion as `/usage`: a 200 whose body is not a JSON object (a proxy's
        // HTML page, an empty body, a bare array) is not a status answer. `payload` is
        // `{}` there, so `checked_in`/`did_checked_in` are absent, and the old code
        // reported `ok:true, checkedIn:false` — a proxy page read as the account's own
        // "you have not checked in today", a false statement about account state.
        //
        // A missing `code` is NOT this case: the check-in status answer legitimately
        // carries no business code, so it is only refused when the body is not an
        // object at all (or carries a refusal `businessRefusal` understands).
        if (!jsonObject) return bad(`check-in status answered HTTP ${status} but the body is not a JSON object: ${text}`)
        // Same criterion as the claim below: a non-zero business code is a refusal,
        // not "you have not checked in today" — swallowing it lost a real answer.
        const refusal = businessRefusal(payload, 'check-in status')
        if (refusal !== null) return bad(refusal)
        const result: Record<string, unknown> = {
          checkedIn: payload['checked_in'] === true,
          didCheckedIn: payload['did_checked_in'] === true
        }
        // Report `credits` only when the gateway sent a number. A fabricated 0 would
        // read as "you have no credits" — the same invention `extractNumbers` refuses.
        if (typeof payload['credits'] === 'number' && Number.isFinite(payload['credits'])) result['credits'] = payload['credits']
        result['enabled'] = payload['enable'] !== false
        return ok(result)
      }
      if (request.method === 'POST') {
        const { status, payload, text } = await post(REGION_GATEWAYS.cn.pay, '/trae/api/v2/ug/checkin_credits/claim', {}, headers, fetchImpl)
        if (status !== 200) return bad(`check-in claim answered HTTP ${status}: ${text.slice(0, 200)}`)
        // The claim is the one route whose whole answer IS the business code, so it
        // reads it with the same reader as the GET above. The old
        // `typeof payload['code'] === 'number' ? payload['code'] : 0` turned every
        // string spelling into 0, so `{code: "9004"}` — "already claimed today" — came
        // back as `claimed: true`: a refusal reported as a fresh claim.
        const verdict = readBusinessCode(payload)
        if (verdict.kind === 'unreadable') return bad(unreadableCodeDetail(payload, 'check-in claim', verdict.literal))
        // No code at all is not code 0 either: this route has no other field to read a
        // result from, so "granted" would be an invention.
        if (!('code' in payload)) return bad('check-in claim answered no business code; whether the reward was granted is unknown')
        const message = typeof payload['message'] === 'string' ? payload['message'].slice(0, 200) : ''
        // `claimed` is true only for a code that is really 0; an interpretable refusal
        // keeps its own code and message so the card can say what happened.
        return ok(verdict.kind === 'refused' ? { claimed: false, code: verdict.code, message } : { claimed: true, code: 0, message })
      }
      return bad(`method ${request.method} not allowed on /checkin`, 405)
    }

    if (request.method === 'POST' && path === '/models/test') {
      const [credential, identity] = await Promise.all([deps.credential(), deps.identity()])
      const all = deps.models()
      const wanted = Array.isArray(body['modelIds']) ? (body['modelIds'] as unknown[]).filter((id): id is string => typeof id === 'string') : []
      // Answer in the order the card asked for, not in directory order: a card that
      // ticked m6 first should read m6 first. Unknown ids are dropped, and a repeated
      // id is probed once — every probe is a real request against the account's quota.
      const byId = new Map<string, TraeModel>(all.map((model): [string, TraeModel] => [model.id, model]))
      const targets: TraeModel[] = []
      if (wanted.length === 0) targets.push(...all.slice(0, 5))
      else {
        const seen = new Set<string>()
        for (const id of wanted) {
          const model = byId.get(id)
          if (model === undefined || seen.has(id)) continue
          seen.add(id)
          targets.push(model)
        }
      }
      if (targets.length === 0) return bad('no model matched modelIds')
      // The cap is on the CANDIDATES, not on the raw `modelIds` array: `requested` counts
      // the distinct ids that actually matched a model, which is exactly the list the cap
      // bounds, so `requested > tested` can only mean truncation — an unknown or repeated
      // id never inflates it.
      const requested = targets.length
      const probed = requested > MAX_PROBE_MODELS ? targets.slice(0, MAX_PROBE_MODELS) : targets
      const results: { id: string; verdict: string; detail: string }[] = []
      for (const model of probed) results.push(await probeModel(model, credential, identity, fetchImpl))
      return ok({
        requested,
        tested: results.length,
        // Said out loud: a caller reading only `results.length` cannot tell a ten-model
        // answer from a seventy-nine-model request it never saw the rest of.
        truncated: results.length < requested,
        results
      })
    }

    return bad(`no such route: ${request.method} ${path}`, 404)
  } catch (error) {
    // Bounded, for the same reason `/status`'s two detail fields are: a dep may
    // reject with anything, and this is the only line the caller gets.
    return bad(boundLine(error))
  }
}

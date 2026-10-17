/**
 * The account's credit balance, as ONE reading shared by two callers.
 *
 * Two things need the same numbers, and they must never disagree:
 *
 *   1. `GET /usage` on the plugin's own API (the settings card's usage row), and
 *   2. the `traeQuota` Cordis service this plugin provides, which OTHER plugins
 *      (the router) inject to decide whether there is anything left to spend.
 *
 * So the gateway call, the envelope checks and the number extraction live here
 * exactly once. `/usage` keeps its own success rule ("the gateway answered a
 * readable envelope") while the service's snapshot is `ok` only when it really
 * got an amount — see `QuotaRead` — because a card that lists the fields it saw
 * is honest, and a service that reports `ok` with no number is not.
 *
 * Everything in this file follows the same discipline as `src/api.ts`:
 *   · no throw escapes a public function (`getQuota()` is sync and total);
 *   · `error` is never rounded up to `ok` — "别用 ok 糊弄";
 *   · nothing is fabricated: a field is written only when the payload carried it.
 *
 * The snapshot shape below is a CONTRACT with the workbuddy plugin's
 * `workbuddyQuota` service: same field names, same status semantics, same
 * `windows` keys. The service NAME differs on purpose (`traeQuota`), because two
 * plugins providing the same name in one process is a collision.
 */
import type { TraeCredential } from './auth.ts'
import type { TraeIdentity } from './identity.ts'
import { buildTraeHeaders, REGION_GATEWAYS, traeEndpoint } from './catalog.ts'

// ─────────────────────────────────────────────────────────── the public shape

export type QuotaStatus = 'ok' | 'off' | 'error'

/**
 * One quota window.
 *
 * `percent` is the **USED** percentage (0–100), the same polarity as
 * cost-meter's `goQuota` bars. When the payload gives `used` and `limit` but no
 * usable total, `percent` is omitted instead of invented.
 */
export interface QuotaWindow {
  /** 已用百分比 0–100；拿不到就留空，改给 used+limit. */
  percent?: number
  /** 已用量；与 limit 同单位. */
  used?: number
  /** 上限/总量；与 used 同单位. */
  limit?: number
  /** 重置时间 epoch 毫秒（UTC）；没有重置概念就留空. */
  resetsAt?: number
  /** 给人看的标签，如「本月积分」. */
  label?: string
}

/**
 * What a consumer sees. Field names are fixed by the contract — do not rename.
 *
 * `status`:
 *   · 'ok'    — at least one real amount was read;
 *   · 'off'   — the channel's precondition is missing (no credential, or not CN);
 *   · 'error' — there IS a credential, but the read failed. `message` is always
 *               present for a non-'ok' status, one user-facing sentence.
 */
export interface QuotaSnapshot {
  status: QuotaStatus
  message?: string
  /** 快照产生时间 epoch 毫秒. */
  fetchedAt?: number
  /** 来源标识，如 'trae'. */
  source?: string
  windows?: {
    rolling?: QuotaWindow
    weekly?: QuotaWindow
    monthly?: QuotaWindow
    /** 积分/余额型通道用这个（Trae 就是这种）. */
    total?: QuotaWindow
  }
}

/**
 * The service registered as `traeQuota`.
 *
 * `getQuota()` is SYNCHRONOUS and reads only the cache: it never touches the
 * network and never throws. `refresh()` is the only path that performs a real
 * read, and it also never throws.
 */
export interface QuotaService {
  getQuota(): QuotaSnapshot
  refresh?(): Promise<QuotaSnapshot>
}

// ────────────────────────────────────────────────────────────── constants

/** What `source` says on every snapshot. */
export const QUOTA_SOURCE = 'trae'

/** The label this channel's `total` window carries. */
export const QUOTA_TOTAL_LABEL = '积分（总额）'

/** The one gateway path this channel reads. */
export const QUOTA_USAGE_PATH = '/trae/api/v2/pay/web_user_ent_usage'

/**
 * How long a snapshot is considered fresh — ONE place, so a consumer and this
 * service can never disagree about the meaning of "过期".
 *
 * It NEVER makes `getQuota()` fetch: an expired cache is still returned as-is
 * (with its honest `fetchedAt`). Only `refresh()` performs a pull; the TTL exists
 * so a caller can decide for itself whether asking for a refresh is worth it.
 */
export const QUOTA_CACHE_TTL_MS = 60_000

/** How long the one-line `message` on a non-'ok' snapshot may be. */
const MESSAGE_CHARS = 240

/** How long the legacy `/usage` detail line may be (same bound as `src/api.ts`). */
const DETAIL_CHARS = 700

// ─────────────────────────────────────────────────── gateway envelope reader
//
// This block used to live in `src/api.ts`. It is here because BOTH readers
// (/usage and the service) need it, and keeping two copies is how the endpoint
// and the service would drift apart. `/checkin` and the probe route import it
// from here too.

/**
 * Read this much of an answer before giving up on it. It is a memory bound, so
 * it has to sit far above anything a gateway legitimately sends: the entitlements
 * envelope is already several KiB, and slicing at that scale cut real JSON in half.
 */
export const MAX_POST_BODY_CHARS = 1 << 20

/**
 * How much of an unexpected body a detail line may quote. Only ever used to build
 * the `text` a caller prints — never a parse input.
 */
const POST_EXCERPT_CHARS = 200

export interface PostResult {
  status: number
  payload: Record<string, unknown>
  /** Bounded, never-empty excerpt of the body; for a detail line, not for parsing. */
  text: string
  /** The body was a complete JSON object (an envelope, not a proxy page / array / empty). */
  jsonObject: boolean
  /** The body was longer than `MAX_POST_BODY_CHARS`, so it was never parsed in full. */
  bodyTruncated: boolean
}

/**
 * One POST against a Trae gateway, returning the parsed envelope instead of throwing.
 *
 * The body is parsed BEFORE it is shortened for display: the old code sliced the
 * text to 4096 characters and only then called `JSON.parse`, so a complete,
 * honest envelope larger than that was cut mid-string and reported as "not a
 * JSON object" — the gateway blamed for the plugin's own truncation. The cap
 * below is a memory bound and is reported as such (`bodyTruncated`), never as a
 * malformed body.
 */
export async function post(
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
  // `jsonObject` is what separates "the gateway answered an envelope" from
  // "something in between answered something else": both give an empty `payload`,
  // and a route that only looks at `payload` cannot tell the difference.
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
 * One line of body text for a detail string: never empty (an empty body would
 * leave the sentence dangling on a colon) and never unbounded.
 */
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat === '' ? '(empty body)' : flat.slice(0, POST_EXCERPT_CHARS)
}

/** How a gateway envelope spells its business code: usually a number, sometimes a string. */
export type BusinessCode = { kind: 'ok' } | { kind: 'refused'; code: number } | { kind: 'unreadable'; literal: string }

/**
 * Read a gateway's business `code` without guessing.
 *
 * A number is used as-is, a string of digits is converted, and any other shape
 * (`"abc"`, `null`, `{}`) is `unreadable` — the caller must refuse that instead
 * of inventing a 0. A missing `code` is not a refusal: some answers omit it.
 */
export function readBusinessCode(payload: Record<string, unknown>): BusinessCode {
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
export function unreadableCodeDetail(payload: Record<string, unknown>, what: string, literal: string): string {
  return `${what} answered a code this plugin cannot interpret (${literal})${messageTail(payload)}`
}

/**
 * A detail line for a business code that is present and not OK — or `null` when
 * the envelope carries no refusal (missing code, or code 0) and the caller may
 * proceed. Shared by every route that reads an envelope so they cannot drift.
 */
export function businessRefusal(payload: Record<string, unknown>, what: string): string | null {
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

// ────────────────────────────────────────────────────────────── the reading

/** Everything a read of the quota channel can see. Never thrown. */
export interface QuotaRead {
  /**
   * The gateway answered a readable envelope (HTTP 200, complete body, JSON
   * object, business code 0 / absent). This is `/usage`'s own success rule and it
   * is deliberately WEAKER than `snapshot.status === 'ok'`: a card may list the
   * fields it saw even when none of them is a usage amount.
   */
  ok: boolean
  /** The legacy one-line reason `/usage` answers with; present when `ok` is false. */
  detail?: string
  /** Every numeric figure `extractNumbers` found, under the gateway's own field names. */
  credits?: Record<string, number>
  /** Top-level envelope keys, for `/usage`'s diagnostic line. */
  payloadKeys?: string[]
  /** What the Cordis service hands out. `ok` only when at least one amount was read. */
  snapshot: QuotaSnapshot
}

/** What a read needs; structurally satisfied by `ApiDeps` and by the plugin entry. */
export interface QuotaDeps {
  credential(): Promise<TraeCredential>
  identity(): Promise<TraeIdentity>
  fetchImpl?: typeof fetch
  /** Injected clock (tests); defaults to `Date.now`. */
  now?: () => number
}

/** Flatten any value into ONE bounded, non-empty line. */
function oneLine(value: unknown, max: number): string {
  const flat = (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
  return flat === '' ? '(没有给出原因)' : flat.slice(0, max)
}

/** Round to two decimals without `toFixed` (the contract wants a NUMBER). */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * The `total` window, or `undefined` when the payload carried neither amount.
 *
 * Trae is a credit/balance channel, so there is exactly one window: `total`.
 * `used` and `limit` are taken from the gateway's own `usage_summary` fields —
 * `consumed_amount` and `total_amount` — and nothing is invented when one of
 * them is absent. The percentage is USED/total, and a `limit <= 0` is never
 * divided by: the window then carries the two numbers and no `percent`.
 */
function readTotalWindow(payload: Record<string, unknown>): QuotaWindow | undefined {
  const summary = payload['usage_summary']
  const fields = typeof summary === 'object' && summary !== null && !Array.isArray(summary) ? (summary as Record<string, unknown>) : undefined
  const numberAt = (key: string): number | undefined => {
    const raw = fields?.[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }
  const used = numberAt('consumed_amount')
  const limit = numberAt('total_amount')
  if (used === undefined && limit === undefined) return undefined
  // A percentage needs BOTH numbers and a positive denominator. No fallback, no
  // "0%" for an unknown total: that would read as "you have used nothing".
  const percent = used !== undefined && limit !== undefined && limit > 0 ? round2((used / limit) * 100) : undefined
  const resetsAt = readResetsAt(payload)
  return {
    ...(percent === undefined ? {} : { percent }),
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    label: QUOTA_TOTAL_LABEL
  }
}

/**
 * When the credits expire, if the payload REALLY says so.
 *
 * The only timestamp this channel has measured is each entitlement pack's
 * `expire_time`, in SECONDS. Nothing is guessed: no pack (or no such field) → no
 * `resetsAt` at all. When several packs carry one, the EARLIEST one is reported —
 * that is the next moment the balance changes, which is what "reset" means to a
 * consumer. A value that is already in milliseconds (>= 1e11) is kept as-is, so a
 * gateway that switches units cannot become "expired in 1970" or "in year 56000".
 */
function readResetsAt(payload: Record<string, unknown>): number | undefined {
  const packs = payload['user_entitlement_pack_list']
  if (!Array.isArray(packs)) return undefined
  let earliest: number | undefined
  for (const pack of packs) {
    if (typeof pack !== 'object' || pack === null || Array.isArray(pack)) continue
    const raw = (pack as Record<string, unknown>)['expire_time']
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue
    const ms = raw < 1e11 ? raw * 1000 : raw
    if (earliest === undefined || ms < earliest) earliest = ms
  }
  return earliest
}

/** Build a non-'ok' reading. `message` is required here by construction. */
function failed(status: 'off' | 'error', message: string, detail: string, fetchedAt: number): QuotaRead {
  return {
    ok: false,
    detail,
    snapshot: { status, message: oneLine(message, MESSAGE_CHARS), fetchedAt, source: QUOTA_SOURCE }
  }
}

/**
 * Read the credit balance once — never throws.
 *
 * Status mapping (the contract, in one place):
 *   · credential() rejects              → 'off'  (no credential: the precondition is missing)
 *   · credential.region !== 'cn'        → 'off'  (the usage API is CN-only)
 *   · identity() rejects                → 'error' (a credential exists; the read cannot be signed)
 *   · HTTP != 200 / truncated body /
 *     non-JSON body / business code≠0 /
 *     no amount at all                  → 'error'
 *   · at least one of used/limit read    → 'ok'
 *
 * `detail` keeps the legacy `/usage` wording for the cases that route had
 * already pinned by test; `snapshot.message` is the short user-facing sentence
 * and never quotes a raw body.
 */
export async function readQuota(deps: QuotaDeps): Promise<QuotaRead> {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    let credential: TraeCredential
    try {
      credential = await deps.credential()
    } catch (error) {
      // No credential is a MISSING PRECONDITION, not a failed read: the channel
      // cannot be asked at all. Never 'error' (which would claim a request failed)
      // and never 'ok'.
      const reason = oneLine(error, DETAIL_CHARS)
      return failed('off', `没有可用的 Trae 凭据，读不了额度：${reason}`, reason, now())
    }
    // A credential EXISTS from here on, so every later failure is 'error'.
    let identity: TraeIdentity
    try {
      identity = await deps.identity()
    } catch (error) {
      const reason = oneLine(error, DETAIL_CHARS)
      return failed('error', `读取额度失败（设备身份不可用）：${reason}`, reason, now())
    }
    // Known to be CN-only (measured): the international region is subscription
    // based, so asking it for a credit balance would be a request that can only
    // be refused. 'off' — not 'error' — because nothing failed; the channel is
    // simply not applicable here.
    if (credential.region !== 'cn') {
      return failed(
        'off',
        '当前凭据不是 CN 区域，Trae 额度接口仅 CN 可用（usage credits are CN-only；国际区是订阅制）',
        'usage credits are CN-only; the international region is subscription-based',
        now()
      )
    }
    const headers = buildTraeHeaders(credential, identity, 'application/json')
    let reading: PostResult
    try {
      reading = await post(REGION_GATEWAYS.cn.pay, QUOTA_USAGE_PATH, { require_usage: true }, headers, fetchImpl)
    } catch (error) {
      // A credential exists and the request was attempted: this is a read failure,
      // never 'off' and never silently 'ok'.
      const reason = oneLine(error, DETAIL_CHARS)
      return failed('error', `读取额度失败（网络层）：${reason}`, reason, now())
    }
    if (reading.status !== 200) {
      return failed('error', `额度接口返回 HTTP ${reading.status}，读不到额度数据`, `pay gateway answered HTTP ${reading.status}: ${reading.text}`, now())
    }
    // Truncated-for-memory comes first: parsing that prefix would only report the
    // plugin's own cap as a malformed gateway answer.
    if (reading.bodyTruncated) {
      return failed(
        'error',
        `额度响应超过 ${MAX_POST_BODY_CHARS} 字符上限，拒绝读取`,
        `pay gateway answered more than ${MAX_POST_BODY_CHARS} characters; refusing to read it as an envelope: ${reading.text}`,
        now()
      )
    }
    // A 200 whose body is not a JSON object (a proxy's HTML page, an empty body, a
    // bare array) carries no envelope at all; reading it as `payload = {}` used to
    // return a success reporting zero numbers as if the account really had none.
    if (!reading.jsonObject) {
      return failed(
        'error',
        `额度接口返回的不是 JSON 对象，读不到额度数据`,
        `pay gateway answered HTTP ${reading.status} but the body is not a JSON object: ${reading.text}`,
        now()
      )
    }
    // A string code ("0" / "3001") is read as the number it spells; a code that
    // cannot be read at all is refused rather than assumed to be 0.
    const refusal = businessRefusal(reading.payload, 'pay gateway')
    if (refusal !== null) {
      return failed('error', `额度接口拒绝了请求：${refusal}`, refusal, now())
    }
    const credits = extractNumbers(reading.payload)
    const payloadKeys = Object.keys(reading.payload)
    const total = readTotalWindow(reading.payload)
    if (total === undefined) {
      // The envelope was readable, so /usage still answers `ok:true` with the
      // numbers it saw (possibly none) — but the SERVICE must not: 'ok' with no
      // amount would tell a router "there is quota" without a single number.
      return {
        ok: true,
        detail: `pay gateway answered HTTP 200 but the payload carried no usage amount this plugin can read (${payloadKeys.join(', ')})`,
        credits,
        payloadKeys,
        snapshot: {
          status: 'error',
          message: oneLine(
            `额度响应里没有可读的积分数字（期望 usage_summary.consumed_amount / usage_summary.total_amount；实际字段：${payloadKeys.join(', ')}）`,
            MESSAGE_CHARS
          ),
          fetchedAt: now(),
          source: QUOTA_SOURCE
        }
      }
    }
    return {
      ok: true,
      credits,
      payloadKeys,
      snapshot: { status: 'ok', fetchedAt: now(), source: QUOTA_SOURCE, windows: { total } }
    }
  } catch (error) {
    // Last net: a dep or the payload did something no branch above expected.
    const reason = oneLine(error, MESSAGE_CHARS)
    return {
      ok: false,
      detail: oneLine(error, DETAIL_CHARS),
      snapshot: { status: 'error', message: oneLine(`读取额度时出现未预期的错误：${reason}`, MESSAGE_CHARS), fetchedAt: now(), source: QUOTA_SOURCE }
    }
  }
}

/** The service-facing read: the snapshot only, and no throw. */
export async function fetchQuotaSnapshot(deps: QuotaDeps): Promise<QuotaSnapshot> {
  try {
    const reading = await readQuota(deps)
    return reading.snapshot
  } catch (error) {
    // `readQuota` is total by construction; this exists so the published
    // function's "never throws" promise does not depend on that staying true.
    return {
      status: 'error',
      message: oneLine(`内部错误: ${oneLine(error, MESSAGE_CHARS)}`, MESSAGE_CHARS),
      fetchedAt: (deps.now ?? Date.now)(),
      source: QUOTA_SOURCE
    }
  }
}

// ────────────────────────────────────────────────────────────── the service

export interface QuotaServiceOptions {
  /**
   * `apply`'s own `enabled` switch. When false the channel is not started at all,
   * and every answer is 'off' — a consumer that injects `traeQuota` still gets a
   * truthful status instead of a service that silently never appears or, worse, a
   * network read the user disabled.
   */
  enabled?: boolean
  /** Injected clock (tests); defaults to `Date.now`. */
  now?: () => number
  /** How long a snapshot counts as fresh. Defaults to `QUOTA_CACHE_TTL_MS`. */
  ttlMs?: number
  /** Where the boot trace goes; defaults to silence. */
  log?: (message: string) => void
}

/** The cache's own state, exposed for diagnostics (never needed by consumers). */
export interface QuotaCacheState {
  ttlMs: number
  /** Age of the cached snapshot in ms, or `undefined` when nothing is cached yet. */
  ageMs?: number
  /** True when `ageMs` exceeds `ttlMs` (or nothing is cached). */
  stale: boolean
}

export interface QuotaServiceHandle extends QuotaService {
  cacheState(): QuotaCacheState
}

/**
 * Build the cached service registered as `traeQuota`.
 *
 * Cache semantics (the contract):
 *   · `getQuota()` is SYNCHRONOUS, total (nothing inside can throw out) and
 *     read-only: it NEVER performs a network request, not even when the cache is
 *     stale. It returns the last snapshot with its own `fetchedAt`, which is the
 *     age the caller reads.
 *   · `refresh()` is the ONLY path that really reads the gateway. It forces a
 *     pull regardless of the TTL, replaces the cache, and returns the new
 *     snapshot; a concurrent second call joins the in-flight read instead of
 *     doubling the spend. It never rejects.
 *   · Before the first fill (start-up prewarm still running) `getQuota()` answers
 *     'error' with a sentence saying so — never a fabricated empty/ok answer.
 */
export function createQuotaService(deps: QuotaDeps, options: QuotaServiceOptions = {}): QuotaServiceHandle {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? QUOTA_CACHE_TTL_MS
  const enabled = options.enabled !== false
  const log = options.log ?? (() => undefined)

  /** The last completed reading. `undefined` = nothing read yet. */
  let cached: QuotaSnapshot | undefined
  /** The one read in flight, so two refreshes cannot become two gateway calls. */
  let inFlight: Promise<QuotaSnapshot> | undefined

  if (!enabled) {
    // Seed the cache with the truthful answer instead of fetching: the user
    // switched this plugin off, and a service that quietly spends the account's
    // quota while switched off is exactly the surprise the switch exists to prevent.
    cached = { status: 'off', message: 'Trae 额度通道未启用（插件 enabled=false）', fetchedAt: now(), source: QUOTA_SOURCE }
  }

  async function readAndCache(): Promise<QuotaSnapshot> {
    let snapshot: QuotaSnapshot
    try {
      snapshot = await fetchQuotaSnapshot({ ...deps, now })
    } catch (error) {
      // Belt and braces: `fetchQuotaSnapshot` is total, but the contract's
      // "refresh() never throws" must not rest on that.
      snapshot = { status: 'error', message: oneLine(`内部错误: ${oneLine(error, MESSAGE_CHARS)}`, MESSAGE_CHARS), fetchedAt: now(), source: QUOTA_SOURCE }
    }
    cached = snapshot
    log(`refresh -> ${snapshot.status}${snapshot.message === undefined ? '' : ` (${snapshot.message})`}`)
    return snapshot
  }

  return {
    getQuota(): QuotaSnapshot {
      try {
        if (cached !== undefined) return cached
        // Not a read failure, but there is no third status to say "not yet": 'off'
        // would claim the channel is unconfigured, which is a different fact. A
        // non-'ok' answer with the reason is the honest one.
        return {
          status: 'error',
          message: '额度尚未读取：启动预热还没完成，稍后再试或调用 refresh()',
          fetchedAt: now(),
          source: QUOTA_SOURCE
        }
      } catch (error) {
        // Nothing in the branch above should throw; if it ever does, the caller
        // still gets an object and a reason instead of an exception.
        try {
          return {
            status: 'error',
            message: oneLine(`内部错误: ${oneLine(error, MESSAGE_CHARS)}`, MESSAGE_CHARS),
            fetchedAt: now(),
            source: QUOTA_SOURCE
          }
        } catch {
          return { status: 'error', message: '内部错误', source: QUOTA_SOURCE }
        }
      }
    },

    async refresh(): Promise<QuotaSnapshot> {
      try {
        if (!enabled) {
          // No gateway call: every refresh answers the same 'off' and leaves the
          // cache untouched, so a consumer polling refresh() cannot re-enable it.
          return cached as QuotaSnapshot
        }
        if (inFlight !== undefined) return await inFlight
        inFlight = readAndCache()
        try {
          return await inFlight
        } finally {
          inFlight = undefined
        }
      } catch (error) {
        // `readAndCache` catches, so this is only reachable for something like a
        // synchronous throw from the injected clock; still never reject.
        return {
          status: 'error',
          message: oneLine(`内部错误: ${oneLine(error, MESSAGE_CHARS)}`, MESSAGE_CHARS),
          fetchedAt: now(),
          source: QUOTA_SOURCE
        }
      }
    },

    cacheState(): QuotaCacheState {
      if (cached === undefined || typeof cached.fetchedAt !== 'number') return { ttlMs, stale: true }
      const ageMs = now() - cached.fetchedAt
      return { ttlMs, ageMs, stale: ageMs >= ttlMs }
    }
  }
}

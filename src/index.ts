/**
 * dsh-pylon-trae — plugin entry.
 *
 * One job: make the Trae account already installed on this machine usable from
 * DSH as an ORDINARY, USER-EDITABLE provider.
 *
 * Why it is built this way (evidence in 设计稿.md):
 *  - the Models page only renders an editor for a provider declared in the
 *    `llm-pi-ai` namespace, so we seed an entry there instead of registering a
 *    private adapter route (which would be forever uneditable);
 *  - that entry's baseURL must therefore be stable, so our OpenAI-compatible
 *    shim binds a FIXED loopback port rather than port 0;
 *  - pi-ai reaches our shim with no api key at all, proving its own
 *    Authorization header, which carries the shim's own token (never Trae's).
 *
 * Three conventions this file follows deliberately (all of them learned the hard
 * way in this workspace — see the router plugin's header comments):
 *   1. NO `inject` export. Services are taken inside `apply` with
 *      `ctx.inject([...], cb)`; a top-level inject list makes an entry wait for a
 *      service and silently do nothing if the shape is not what the host expects.
 *   2. `Config` is a STANDARD-SCHEMA object, not a schemastery schema, and it
 *      declares no volatile field — so dsh-settings builds no form for this entry
 *      and this plugin adds no consumer on the settings path.
 *   3. The shim token lives in a file of our own outside the profile, so
 *      persisting it cannot touch the profile patch and cannot need a form.
 *
 * Every write to USER configuration (the provider entry inside llm-pi-ai) goes
 * through src/guard.ts: snapshot outside the profile, write, re-read, roll back
 * if anything was lost.
 *
 * One thing this entry does NOT write, ever: Trae's own `storage.json`. A desktop
 * token that has expired is renewed through the pinned upstream's contract
 * (src/auth.ts, `refreshTraeCredential`) and the result lands in this plugin's own
 * `$DSH_HOME/.dsh-pylon-trae/credentials-<id>.json`; the writer refuses any path outside
 * that directory. `credential()` prefers that copy from memory, and falls back to
 * reading the desktop credential exactly as before when a refresh is impossible.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { handleApi, type ReloadResult, type TraeAccountInfo } from './api.ts'
import {
  canRefresh,
  credentialStorePath,
  describeCredentialExpiry,
  describeCredentialScan,
  ensureCredentialRef,
  isExpired,
  preferValidStoredCredential,
  readStorageDevice,
  readStoredCredential,
  refreshCredentialIntoStore,
  scanCredentials,
  tokenFingerprint,
  verifiedCredentialRef,
  type CredentialStoreFace,
  type TraeCredential,
  type TraeRefreshDevice
} from './auth.ts'
import { FALLBACK_MODELS, fetchDirectoryModels, partitionModels, type TraeModel } from './catalog.ts'
import { dshHome, explainPatchLookup } from './guard.ts'
import { readTraeIdentity, type TraeIdentity } from './identity.ts'
import { ownCopyPath, traeStorageCandidates } from './paths.ts'
import {
  buildProviderProfile,
  currentProviderModelIds,
  mergeNames,
  mergeOffered,
  pruneInternalModels,
  seedProvider,
  syncProviderEntry,
  TRAE_API_KEY_REF,
  type ProviderProfile,
  type SeedNameReport,
  type SeedOutcome,
  type SettingsServiceLike
} from './seed.ts'
import { createShim } from './shim.ts'

/**
 * The "was this module even loaded?" signal — and it answers exactly that, no more.
 *
 * `trace()` below writes `~/.dsh-pylon-trae/boot.log`, which answers "what did the
 * plugin DO"; it cannot answer "was the plugin IMPORTED", because a module that
 * is never imported never runs a line of it, so the absence of trace lines has
 * two completely different explanations and no way to tell them apart.
 *
 * This line sits at module scope, inside the module body, so it runs the moment
 * the file is evaluated — before `apply`, before any service is resolved, before
 * any inject callback could silently park the plugin in PENDING (cordis does that
 * without an error when an injected service is missing). Reading the two signals
 * together separates three states:
 *
 *   no line here, no trace lines   → the module was never imported (not mounted
 *                                    by this profile, wrong entry path, bad bundle)
 *   this line, no `apply:` trace   → imported but `apply` never ran (an `inject`
 *                                    dependency never arrived, plugin PENDING)
 *   both lines                     → `apply` ran; from here boot.log is the record
 *
 * `console.log` and not `ctx.logger` on purpose: this line exists to be visible
 * in the host's own stdout, where `ctx.logger` output has never appeared in this
 * workspace (measured — see the boot trace in `trace()`). No `ctx` is available
 * at module scope anyway; the point is that this line needs none.
 */
console.log('[dsh-pylon-trae] module loaded')

/* ────────────────────────── one-time data migration ──────────────────────────
 *
 * `.dsh-trae` → `.dsh-pylon-trae`, the directory rename that came with the package
 * rename. Runs at MODULE scope, before `apply()`, because it must be done before
 * the first `trace()` line, the first `loadOrCreateToken()`, or `guard.ts` picks a
 * backup directory — otherwise the first boot after an upgrade would look at an
 * empty home and start from nothing.
 *
 * 1. COPY, never move. The old directory is left exactly as it was, for the user to
 *    delete when they are satisfied: this plugin never destroys the only copy of
 *    anything.
 * 2. `state.json` is the one file that MUST survive. Its `lastOffered` is an
 *    append-only TOMBSTONE set — the memory of every model that has ever been
 *    offered, so a model the user pruned is not offered again. Lose it and pruned
 *    models come back to life on the Models page.
 * 3. `*-shim-token.json` is copied for a smaller but real reason: the token is the
 *    bearer this plugin wrote into its own seeded provider entry, so regenerating
 *    it would leave the stored `baseURL`+bearer pair out of step until the next
 *    seed. (It would self-heal — it is written every boot — this just avoids it.)
 * 4. Idempotent by per-file absence, not by a marker: a file already present in the
 *    destination is never overwritten. A half-finished copy therefore retries the
 *    missing files on the next boot instead of being recorded as "done".
 * 5. Failures are swallowed. A migration that cannot run is not a reason for the
 *    plugin not to load; the consequence is only that state starts empty.
 * 6. `boot.log` itself is copied LAST so that the `migrate:` line below is written
 *    into the migrated history rather than looking like the only thing that ever
 *    happened. Failures here are ignored on purpose.
 */
const LEGACY_HOME_DIR_NAME = '.dsh-trae'

/** Copy the previous data directory's files into the current one. Once. */
function migrateLegacyDataDir(): void {
  const home = dshHome()
  const next = join(home, '.dsh-pylon-trae')
  const legacy = join(home, LEGACY_HOME_DIR_NAME)
  if (!existsSync(legacy)) return
  let names: string[]
  try {
    names = readdirSync(legacy)
  } catch {
    return
  }
  // Recognized by name: the tombstone set, the shim bearer, and the boot history.
  const worth = (name: string): boolean => name === 'state.json' || name.endsWith('-shim-token.json') || name === 'boot.log'
  const copied: string[] = []
  const writeTrace = (line: string): void => {
    try {
      mkdirSync(next, { recursive: true })
      appendFileSync(join(next, 'boot.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
    } catch {
      // a migration we cannot record is still a migration that happened
    }
  }
  const carry = (name: string): void => {
    const from = join(legacy, name)
    const to = join(next, name)
    try {
      if (existsSync(to)) return // idempotent: never overwrite what the new home owns
      // `copyFileSync` does NOT create the parent, and on the first upgrade the new
      // directory does not exist yet — so every copy makes its own destination.
      mkdirSync(next, { recursive: true })
      copyFileSync(from, to)
      copied.push(name)
    } catch {
      // leave it; an empty state is survivable, a failed boot is not
    }
  }
  for (const name of names) if (worth(name) && name !== 'boot.log') carry(name)
  if (copied.length > 0) {
    writeTrace(`migrate: ${LEGACY_HOME_DIR_NAME} -> .dsh-pylon-trae copied ${copied.join(' ')} (the old directory was NOT touched; delete it yourself when satisfied)`)
  }
  carry('boot.log') // last, so the line above is part of the carried history
}

migrateLegacyDataDir()

export const name = 'dsh-pylon-trae'

export interface TraeConfig {
  enabled: boolean
  port: number
  providerId: string
  displayName: string
  seed: boolean
  authFile: string
  /** `refresh` re-reads the live directory and adds only genuinely new models. */
  mode: 'auto' | 'refresh'
  /**
   * Keep the seeded entry current on every boot: append model ids the live
   * directory offers that the entry has never held, and nothing else.
   *
   * Default TRUE, and that default is the whole point of the option existing:
   * "configure it once and it maintains itself" only holds if a new Trae model
   * arrives without the user remembering a button. The write is still
   * "only add" — a model the user deleted was offered once and is never
   * resurrected — and a boot with nothing new writes NOTHING (see
   * `syncProviderEntry`), so leaving this on does not mean "the config changes
   * on every start".
   */
  refreshOnBoot: boolean
  /**
   * Let a boot replace a display name this plugin wrote, and ONLY one it wrote.
   *
   * Default TRUE for the same reason `refreshOnBoot` defaults to true: an entry
   * written before the name computation existed carries `name` equal to each
   * row's id, and nothing else in the plugin would ever fix that — the user would
   * never see the improvement. It is safe because it is memory-gated: a name with
   * no record in our own `lastNames` is treated as the user's and left alone
   * (see `src/seed.ts`'s `SeedNameReport`). Turn it off and the entry's names are
   * never touched, exactly as before this option existed.
   */
  syncNamesOnBoot: boolean
}

export const DEFAULT_CONFIG: TraeConfig = {
  enabled: true,
  port: 7864,
  providerId: 'trae',
  displayName: 'Trae',
  seed: true,
  authFile: '',
  mode: 'auto',
  refreshOnBoot: true,
  syncNamesOnBoot: true
}

/**
 * Config as a Standard Schema: defaults are filled in, unknown keys are kept out,
 * and a wrong type is reported instead of silently coerced.
 */
export const Config = {
  '~standard': {
    vendor: 'dsh-pylon-trae',
    version: 1,
    validate(input: unknown): { value?: TraeConfig; issues?: { message: string; path?: (string | number)[] }[] } {
      const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
      const issues: { message: string; path?: (string | number)[] }[] = []
      const bool = (key: keyof TraeConfig, fallback: boolean): boolean => {
        const value = raw[key]
        if (value === undefined) return fallback
        if (typeof value !== 'boolean') {
          issues.push({ message: `${key} must be a boolean`, path: [key] })
          return fallback
        }
        return value
      }
      const text = (key: keyof TraeConfig, fallback: string): string => {
        const value = raw[key]
        if (value === undefined) return fallback
        if (typeof value !== 'string') {
          issues.push({ message: `${key} must be a string`, path: [key] })
          return fallback
        }
        return value
      }
      const port = ((): number => {
        const value = raw['port']
        if (value === undefined) return DEFAULT_CONFIG.port
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535) {
          issues.push({ message: 'port must be an integer between 1024 and 65535', path: ['port'] })
          return DEFAULT_CONFIG.port
        }
        return value
      })()
      const mode = raw['mode'] === 'refresh' ? 'refresh' : DEFAULT_CONFIG.mode
      const value: TraeConfig = {
        enabled: bool('enabled', DEFAULT_CONFIG.enabled),
        port,
        providerId: text('providerId', DEFAULT_CONFIG.providerId),
        displayName: text('displayName', DEFAULT_CONFIG.displayName),
        seed: bool('seed', DEFAULT_CONFIG.seed),
        authFile: text('authFile', DEFAULT_CONFIG.authFile),
        mode,
        refreshOnBoot: bool('refreshOnBoot', DEFAULT_CONFIG.refreshOnBoot),
        syncNamesOnBoot: bool('syncNamesOnBoot', DEFAULT_CONFIG.syncNamesOnBoot)
      }
      return issues.length > 0 ? { issues } : { value }
    }
  }
}

interface Logger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

interface SettingsFace extends SettingsServiceLike {
  update(ns: string, patch: Record<string, unknown>, revision?: number): Promise<unknown>
  configure?(options: Record<string, unknown>, fiber?: unknown): unknown
}

interface Ctx {
  logger: Logger
  get(name: string): unknown
  inject(names: string[], callback: (ctx: Ctx) => void): void
  effect(callback: () => void | (() => void)): void
  fiber?: { entry?: { options?: { id?: string } } }
}

/**
 * Our own boot trace, written beside the token file.
 *
 * The host's logger is not readable from a normal cold start (its output never
 * reached the redirected log in this workspace), and "the plugin did nothing"
 * has several very different causes. A five-line file turns that into a fact.
 * Best-effort by design: tracing must never be the reason a boot fails.
 */
export function trace(message: string): void {
  try {
    const path = join(dshHome(), '.dsh-pylon-trae', 'boot.log')
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()}  ${message}\n`, 'utf8')
  } catch {
    // ignored on purpose
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

/** Resolve one usable credential, preferring the desktop app's live sign-in. */
async function resolveCredential(authFile: string): Promise<{ credential?: TraeCredential; detail: string }> {
  const candidates = traeStorageCandidates()
  const scan = scanCredentials(authFile === '' ? candidates : candidates.map((candidate) => ({ ...candidate, path: candidate.path === authFile ? candidate.path : candidate.path })))
  const explicit = authFile === '' ? undefined : authFile
  const credential = explicit === undefined
    ? (scan.credentials.find((entry) => entry.source === 'desktop') ?? scan.credentials[0])
    : scan.credentials.find((entry) => entry.storagePath.toLowerCase() === explicit.toLowerCase())
  if (credential === undefined) {
    // The sentence names the whole probed scene, not just the reason: "Trae is not
    // installed" and "Trae is installed but nobody signed in" are the same
    // "no credential" from the outside, and only the second one is the user's to
    // fix. See `describeCredentialScan`.
    return { detail: describeCredentialScan(scan, candidates) }
  }
  return { credential, detail: `${credential.source}/${credential.edition}` }
}

/**
 * The shim token, kept in a file of our own OUTSIDE the profile.
 *
 * Deliberately not a setting: persisting it through the settings service would
 * make this plugin a consumer on the settings path (this workspace has already
 * crashed a cold start exactly that way), and the token is not a Trae secret —
 * it only stops another local process from borrowing the user's quota through
 * our loopback port.
 */
function loadOrCreateToken(region: string): { token: string; path: string; created: boolean } {
  const path = ownCopyPath(dshHome(), `${region}-shim-token`)
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim()
      if (existing !== '') return { token: existing, path, created: false }
    }
  } catch {
    // fall through to creating a fresh one
  }
  const token = randomToken()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // an unwritable home is not fatal: the token still works for this process
  }
  return { token, path, created: true }
}

/**
 * The two prefixes this plugin's own API answers on, on the HOST web server.
 *
 * Both are required, and the reason is measured (same conclusion the router plugin
 * recorded at src/index.ts:1754-1764): the bare path is what the host answers
 * directly, while the desktop app's UI layer forwards only `/api/*` to the host, so
 * a browser request through the app reaches the host on the `/api/...` spelling and
 * nothing else. `webServer` matches longest-prefix-first
 * (dsh-host-webserver/lib/index.js:322-332), and `/api/plugins/dsh-pylon-trae` is longer
 * than the connection's own `/api` route, so the pair cannot fight over a request.
 */
export const ROUTE_PREFIX = '/plugins/dsh-pylon-trae'
export const API_ROUTE_PREFIX = '/api'

interface RouteRequest {
  method?: string
  url?: string
  headers?: Record<string, unknown>
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
}

interface RouteResponse {
  writeHead: (code: number, headers?: Record<string, string>) => void
  end: (body?: string) => void
}

/** Cap on a card request body: every endpoint here takes a tiny JSON object. */
const ROUTE_BODY_LIMIT = 64 * 1024

/** Read one request header (Node's `req.headers` is a lower-cased plain object). */
function headerOf(req: unknown, name: string): string | undefined {
  const headers = (req as { headers?: Record<string, unknown> } | undefined)?.headers
  if (headers === undefined || headers === null || typeof headers !== 'object') return undefined
  const value = (headers as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : undefined
}

/** Loopback hostnames, spelled the way `dsh-client-connection` spells them. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/**
 * 🔴 2026-10-14 现场定位：栅栏的"端口跳转"例外 —— 与兄弟插件逐字同一口径。
 *
 * 症状：设置卡片所有请求 403（`HTTP 403: /plugins/dsh-pylon-trae 没有返回 JSON`），而
 * 模型页、回环 shim、宿主路由注册全部正常。
 *
 * 实测（对正在运行的 :19387 发真请求，同一组请求头逐个路径对比）：
 *   `/api/plugins/dsh-pylon-trae/status`         → 403 `forbidden`，且带我们的 Content-Type
 *   `/api/router-dispatch/dispatch.health` → 200              ← 兄弟插件同一条通道
 *   `/api/plugins/dsh-pylon-traeX/...`（不匹配我们，落到框架 /api）→ 401 `unauthorized`
 * 兄弟插件自己的日志把原因写死了（`~/.dsh/subagent-router.log`）：
 *   `dispatch: RPC fence tolerated a loopback port hop (host=127.0.0.1:19387 origin=?)`
 *   —— 同一个 `connection.requestRejection` 在 :19387 上**对回环请求也返回 403**
 *   （框架的 Host/Origin 栅栏要求 Origin 的 host 与 Host 完全一致，桌面 app 这一层
 *   把 Host 换成宿主端口、Origin 仍是 app 端口就是了；具体是哪一项判否由框架内部
 *   决定，此处不猜）。兄弟插件**容忍**这一种 403 才有 200；我们不容忍 ⇒ 请求在
 *   栅栏处就被自己判成 403，`handleApi` 一次都没被调用（POST 一个畸形 body 也照样
 *   403 —— 说明拒绝发生在读 body 之前，即栅栏那几行，不是 API）。
 *
 * 只放宽【Host 与 Origin 两边都是回环地址】这一种情况（端口可不同）：
 *   · 非回环 Host（`evil.example.com`、`0.0.0.0`）仍然 403 —— 实测三个变体全部拒绝
 *   · 非回环 Origin（`file://`、外部站点）仍然 403
 *   · 401（浏览器会话缺失/过期）**不放宽**：那是"你不是操作者"，不是端口跳转
 * 上级栅栏本身仍先跑：这里只是不再把它的端口跳转 403 当成终局。两个前缀共用这一个
 * 处理函数，所以"裸路径 + /api 前缀"的判定完全一致，不会出现按路径分叉的怪状。
 */
function isLoopbackPortHop(req: unknown): boolean {
  const host = headerOf(req, 'host')
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  const origin = headerOf(req, 'origin')
  if (origin === undefined) return true
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * The tolerated port hop is logged ONCE per process: it is a fact about how the card
 * is served (through the desktop app's proxy), not a per-request event — and boot.log
 * must stay readable. The operator reads this line to tell "the fence was relaxed for
 * me" apart from "the fence still blocks me".
 */
let portHopToleratedLogged = false

async function readRouteBody(req: RouteRequest): Promise<string> {
  const iterate = req[Symbol.asyncIterator]
  if (typeof iterate !== 'function') return ''
  let size = 0
  const chunks: string[] = []
  for await (const chunk of req as AsyncIterable<unknown>) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
    size += text.length
    if (size > ROUTE_BODY_LIMIT) throw new Error('request body too large')
    chunks.push(text)
  }
  return chunks.join('')
}

/** The plugin API, once a credential has been resolved (see `apiHandler` in apply). */
export type ApiHandler = (request: { method: string; path: string; body?: unknown }) => Promise<{ status: number; body: Record<string, unknown> }>

export interface HostRouteDeps {
  /**
   * The host's own fence, `connection.requestRejection`: Host/Origin first, then the
   * browser's session (dsh-client-connection/lib/index.js:585-589). REQUIRED — a
   * route that serves without it would publish the operator's Trae account to any
   * local page that can reach the port.
   *
   * Its 403 is NOT the last word: a 403 whose Host AND Origin are both loopback is a
   * port hop (the desktop app's proxy) and is tolerated, exactly as the router plugin
   * does. Its 401 is always final.
   */
  requestRejection: (req: unknown) => number | undefined
  /** The API itself; undefined while the plugin is still resolving its credential. */
  resolveApi: () => ApiHandler | undefined
}

/**
 * Build the host-route handler for this plugin's own endpoints.
 *
 * Kept as a factory (rather than inlined in the `ctx.inject` callback) so
 * tools/client-route-check.mjs can drive a real HTTP request through the exact
 * function the host would call, with no DSH process and no network: prefix
 * stripping, the fence, body parsing and the "not ready yet" answer are all
 * assertions instead of hopes.
 */
export function createHostRouteHandler(deps: HostRouteDeps): (req: unknown, res: unknown) => Promise<void> {
  return async (req: unknown, res: unknown): Promise<void> => {
    const request = req as RouteRequest
    const response = res as RouteResponse
    const write = (status: number, body: Record<string, unknown>): void => {
      const payload = JSON.stringify(body)
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(payload)),
        'Cache-Control': 'no-store'
      })
      response.end(payload)
    }

    // The host's fence, unchanged, with ONE documented exception: a 403 that is only
    // a loopback PORT HOP is tolerated (see `isLoopbackPortHop` above). Without it the
    // desktop app's own proxy — Host rewritten to the host port, Origin still the app
    // port — is answered 403 by us before `handleApi` ever runs, which is exactly the
    // failure this plugin shipped with. A 401 is NOT tolerated: that is "you are not
    // the operator", and the browser card has its own session for that case.
    let rejection: number | undefined
    try {
      rejection = deps.requestRejection(request)
    } catch {
      rejection = 403
    }
    if (rejection !== undefined && !(rejection === 403 && isLoopbackPortHop(request))) {
      response.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (rejection === 403 && !portHopToleratedLogged) {
      portHopToleratedLogged = true
      trace(
        `host route: fence 403 tolerated as a loopback port hop (host=${headerOf(request, 'host') ?? '?'} ` +
          `origin=${headerOf(request, 'origin') ?? '?'}) — the card is served through the desktop app's proxy`
      )
    }

    const method = (typeof request.method === 'string' ? request.method : 'GET').toUpperCase()
    const pathname = new URL(typeof request.url === 'string' ? request.url : '/', 'http://127.0.0.1').pathname
    // Strip whichever prefix caught this request. `/api` only comes off when it is
    // really our `/api/plugins/dsh-pylon-trae` spelling — never off a model id.
    const relative = pathname.replace(/^\/api(?=\/plugins\/dsh-pylon-trae(\/|$))/, '').replace(/^\/plugins\/dsh-pylon-trae/, '')

    let body: unknown
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        const raw = await readRouteBody(request)
        body = raw === '' ? {} : (JSON.parse(raw) as unknown)
      } catch (error) {
        write(200, { ok: false, detail: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}` })
        return
      }
    }

    const handle = deps.resolveApi()
    if (handle === undefined) {
      write(200, { ok: false, detail: '插件还在启动：尚未解析到 Trae 凭据，端点暂不可用（回环服务与供应商条目不受影响）' })
      return
    }
    try {
      const result = await handle({ method, path: relative, body })
      write(result.status, result.body)
    } catch (error) {
      // handleApi already answers instead of throwing; this is the last net.
      write(200, { ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * How several account troubles become ONE line for the card.
 *
 * `accountWarning` is a single `string | undefined` (`src/api.ts`), and that is
 * deliberate: the card prints it verbatim, in red, under the account row. There
 * are now two independent things that can be wrong with the account being billed
 * — the remembered selection is gone, or the token we hold is out of time — and
 * the second must not hide the first. Parts are joined with `；`, blank and
 * undefined parts drop out (so "nothing to say" stays `undefined`, never `''`),
 * and the whole line is bounded by `boundLine` on the way into `/status`.
 */
export function joinWarnings(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '')
  return kept.length === 0 ? undefined : kept.join('；')
}

function describeOutcome(outcome: SeedOutcome): string {
  // The hidden count is appended to EVERY outcome that could have written, from ONE
  // place: a write that silently wrote fewer models than the directory offered is
  // the shape this plugin has been bitten by before, and "47 models（隐藏 32 个内部
  // 组件）" is the difference between a deliberate filter and a bug.
  const hidden = 'skippedInternal' in outcome && outcome.skippedInternal.length > 0 ? `（另有 ${outcome.skippedInternal.length} 个内部组件没写：${outcome.skippedInternal.slice(0, 8).join('、')}${outcome.skippedInternal.length > 8 ? '…' : ''}）` : ''
  // Why a boot wrote nothing — the answer to "did it do its job?" without which
  // `present` would read as "the plugin did nothing" instead of "nothing needed doing".
  const why = (outcome: SeedOutcome): string =>
    'tokenState' in outcome && outcome.tokenState !== undefined
      ? `（token=${outcome.tokenState === 'same' ? '一致' : outcome.tokenState === 'rotated' ? '已轮换并同步' : '条目里原本没有'} apiKeyEnv=${outcome.apiKeyEnvState ?? 'skipped'}）`
      : ''
  // A rewrite of the user's file has to be enumerable, and a name rewrite is a
  // rewrite: `rotated` already carries model rows untouched, so the count of
  // renamed rows is what keeps that outcome from reading as "nothing happened".
  const renamed = (outcome: SeedOutcome): string =>
    'nameSync' in outcome && outcome.nameSync !== undefined && outcome.nameSync.renamed.length > 0 ? `、改名 ${outcome.nameSync.renamed.length} 行` : ''
  switch (outcome.kind) {
    case 'created':
      return `已生成可编辑供应商：${outcome.ns}.providers.<id>，${outcome.modelCount} 个模型${hidden}（备份 ${outcome.backupPath}）`
    case 'present':
      return `供应商已存在，未改动（${outcome.ns}${outcome.modelCount === undefined ? '' : `，${outcome.modelCount} 个模型`}）${why(outcome)}${hidden}`
    case 'rotated':
      return `条目已对账更新：token=${outcome.tokenState === 'same' ? '一致' : '已同步'}、apiKeyEnv=${outcome.apiKeyEnvState}，模型仍是用户那 ${outcome.keptModels} 个${renamed(outcome)}${hidden}（备份 ${outcome.backupPath}）`
    case 'rebuilt':
      return `重建清单：保留 ${outcome.keptModels} 个，新增 ${outcome.addedModels.length} 个${renamed(outcome)}${why(outcome)}${hidden}`
    case 'no-namespace':
      return `跳过写入：${outcome.detail}`
    case 'no-guard':
      return `跳过写入：${outcome.detail}`
    case 'rolled-back':
      return `🔴 写入导致配置丢失，已回滚：${outcome.reasons.join('；')}（备份 ${outcome.backupPath}）`
    case 'failed':
      return `🔴 写入失败：${outcome.detail}`
  }
}

/**
 * Start the shim and seed the provider entry.
 *
 * Order matters: the shim must be listening BEFORE the entry is written, because
 * a stored baseURL that answers nothing is worse than no entry at all.
 */
export function apply(ctx: Ctx, config: TraeConfig): void {
  if (!config.enabled) {
    ctx.logger.info('dsh-pylon-trae: 已停用（enabled=false），未启动回环服务、未写配置')
    return
  }
  trace(`apply: enabled=${config.enabled} port=${config.port} provider=${config.providerId} mode=${config.mode}`)
  let settings: SettingsServiceLike | undefined
  let shim: ReturnType<typeof createShim> | undefined
  let stopped = false

  ctx.effect(() => () => {
    stopped = true
    void shim?.close()
  })

  // No top-level `inject` export: services are taken here, inside apply. The
  // seeding half waits for `settings`; the shim half does not need it at all.
  ctx.inject(['settings'], (settingsCtx) => {
    // Property access first: that is the form the host's own plugins use
    // (`const settings = settingsCtx.settings`), with the getter as a fallback.
    const face = settingsCtx as unknown as { settings?: SettingsServiceLike }
    settings = face.settings ?? (settingsCtx.get('settings') as SettingsServiceLike | undefined)
    trace(`settings: ${settings === undefined ? 'MISSING (provider entry cannot be written)' : 'acquired'}`)
    if (settings === undefined) ctx.logger.warn('dsh-pylon-trae: settings 服务不可用，供应商条目将无法写入')
    void run().catch((error: unknown) => {
      trace(`run failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
      ctx.logger.error('dsh-pylon-trae: 启动失败', error)
    })
  })

  let credentialCache: TraeCredential | undefined
  let identityCache: TraeIdentity | undefined

  /**
   * The credential reference this boot PROVED is in the harness store, or
   * `undefined` when it could not be proven.
   *
   * One variable, and every profile builder reads it — because the two halves of
   * "the dot turns green" must never be able to disagree: a profile that names
   * `apiKeyEnv` while the store does not hold it is the RED dot, and the route
   * then dies with `MISSING_CREDENTIAL`
   * (`dsh-llm-pi-ai/lib/index.js:2564-2569`). Set from the verified answer of
   * `ensureCredentialRef` and from nothing else.
   */
  let verifiedApiKeyEnv: string | undefined

  /**
   * The harness credentials service, if this composition mounts one.
   *
   * `ctx.get` rather than `ctx.inject` on purpose: this is a READ of an optional
   * service, and a plugin whose boot depends on an injected service that a
   * composition does not provide simply never runs (which is the failure mode
   * this plugin's own header warns about).
   */
  function credentialsFace(): CredentialStoreFace | undefined {
    try {
      return ctx.get('credentials') as CredentialStoreFace | undefined
    } catch {
      return undefined
    }
  }

  /**
   * A user-visible account problem, or `undefined` when there is nothing to say.
   *
   * The first it exists for: a remembered account selection (`state.activeAccountId`)
   * that this machine can no longer produce. That case used to be a `trace()` line
   * — visible in `boot.log` and nowhere else — so the operator kept seeing a card
   * that billed a DIFFERENT account than the switcher remembered, with no
   * indication that their choice had been dropped. An account switch that silently
   * does not take effect is a wrong bill, so it belongs on the card; the trace line
   * stays, because a record of the fallback is worth keeping too.
   *
   * The second, added 2026-10-14: the credential we hold is out of time
   * (`expiryWarning`, set by `ensureUsableCredential`). Same channel on purpose —
   * both are facts about the account being billed, and the card already renders
   * `accountWarning` verbatim in red. Two parallel warning mechanisms would mean
   * two ways for the card to be wrong about the same account.
   */
  let selectionWarning: string | undefined
  let expiryWarning: string | undefined

  /**
   * The one refresh attempt this process gets, and its outcome.
   *
   * `/status` is polled by the card and every shim request re-reads the credential,
   * so "try to refresh when the token is expired" must not become "one network
   * round trip per request" — especially not when the network is what is broken.
   * Recorded once, reused forever, and the reason is kept so the warning line can
   * say what actually happened. `unavailable` separates "there is nothing to
   * refresh WITH" from "the refresh was tried and refused": only the user can fix
   * the first, and only a re-login fixes the second.
   */
  interface RefreshAttempt {
    ok: boolean
    unavailable?: boolean
    detail: string
    credential?: TraeCredential
  }
  let refreshAttempt: RefreshAttempt | undefined

  /**
   * Every reason the billed account may not work, as one line — see `joinWarnings`.
   *
   * A function, not a value: `src/api.ts` calls it AFTER `credential()` has run,
   * and that is where both facts are discovered.
   */
  const accountWarningText = (): string | undefined => joinWarnings(selectionWarning, expiryWarning)

  /**
   * The plugin's own API, once a credential has been resolved (it is built inside
   * `run`, because the region is only known then). The host route below reads this
   * on every request, so the card can be opened before, during or long after boot:
   * "there is no handler yet" has its own honest answer rather than a 500.
   */
  let apiHandler:
    | ((request: { method: string; path: string; body?: unknown }) => Promise<{ status: number; body: Record<string, unknown> }>)
    | undefined

  /**
   * Our own state, kept beside the token and NEVER inside the profile patch:
   * which account to bill, which model ids we have already offered (the
   * tombstone set that stops "rebuild the list" from resurrecting models the
   * user deleted), and which display names we have written (so a name the USER
   * typed can be told apart from one WE wrote, and is never overwritten).
   */
  interface PluginState {
    activeAccountId?: string
    lastOffered?: string[]
    /**
     * id → the display name this plugin wrote for that row, append-only.
     *
     * The exact counterpart of `lastOffered`, for the same reason: without a
     * record, "the user renamed this row" and "we renamed this row last boot"
     * are the same observation, and the only safe reading of that ambiguity
     * would be "never improve a name" — which is the gap this exists to close.
     */
    lastNames?: Record<string, string>
  }
  const statePath = join(dshHome(), '.dsh-pylon-trae', 'state.json')
  const readState = (): PluginState => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? (parsed as PluginState) : {}
    } catch {
      return {}
    }
  }
  const writeState = (patch: PluginState): void => {
    try {
      const next = { ...readState(), ...patch }
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (error) {
      trace(`state: write failed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let state = readState()

  /**
   * Remember what was offered, WITHOUT ever forgetting what was offered before.
   *
   * The single place `lastOffered` grows, and it grows by union — see
   * `mergeOffered` for why a replacement would make a user's deletion come back
   * two restarts later. A boot whose memory already covers everything writes
   * nothing at all, so "nothing changed" stays indistinguishable from "nothing
   * happened".
   */
  const rememberOffered = (offered: readonly string[]): void => {
    const merged = mergeOffered(state.lastOffered, offered)
    if (merged.length === (state.lastOffered ?? []).length && merged.every((id, index) => id === (state.lastOffered ?? [])[index])) return
    state = { ...state, lastOffered: merged }
    writeState({ lastOffered: merged })
  }

  /**
   * Remember the display names we wrote, WITHOUT ever forgetting a name we wrote
   * before — `mergeNames` is a union with value updates, never a replacement.
   *
   * The names handed in come from `SeedOutcome.nameSync.names`, which exists ONLY
   * on a write that really landed (or on a `present` outcome that had nothing to
   * change). A refusal, a throw or a rollback carries no `names` at all, so the
   * memory stays behind and the next boot retries the rename — "rather retry than
   * believe a name that never reached the file".
   *
   * A boot that records nothing new writes NOTHING: same discipline as
   * `rememberOffered`, so "nothing changed" also leaves no mtime behind.
   */
  const rememberNames = (names: Record<string, string> | undefined): void => {
    if (names === undefined) return
    const merged = mergeNames(state.lastNames, names)
    const before = state.lastNames ?? {}
    const keys = Object.keys(merged)
    if (keys.length === Object.keys(before).length && keys.every((id) => before[id] === merged[id])) return
    state = { ...state, lastNames: merged }
    writeState({ lastNames: merged })
  }

  // ── 宿主路由：设置卡片的数据通道 ──────────────────────────────────────────
  //
  // Why the host web server and not the loopback shim: the shim is bearer-guarded
  // and its token lives on disk, out of the browser's reach — and out of its
  // business. This route inherits the browser's own session instead, because the
  // fence is `connection.requestRejection`, the very function the shipped `/api`
  // transport runs (dsh-client-connection/lib/index.js:585-589, :640-656).
  //
  // The handler is the SAME `handleApi` the shim serves: the two transports differ,
  // the endpoints do not.
  //
  // `ctx.inject` callbacks can RUN AGAIN (the connection or webServer service being
  // replaced, a hot reload), and `webServer.register` THROWS on a duplicate
  // (kind, path) — so the registration is paired with a `ctx.effect` deregistration.
  // Without that pair the second run would throw and the card would lose its data
  // channel. `connection` is injected along with `webServer` on purpose: the
  // rejection fence comes from it (the router plugin's note at src/index.ts:1611-1622
  // is the same finding).
  //
  // Recorded BEFORE the inject, on purpose: a composition without `webServer` (a
  // headless boot, for instance) never runs the callback at all, and "the card has
  // no data" would otherwise have no explanation anywhere in the log.
  trace(
    `host route: deferred via ctx.inject(['connection','webServer']) — it registers the moment BOTH are present; ` +
      `in a composition without them the ${ROUTE_PREFIX} route is simply absent (the shim and the provider entry are unaffected)`
  )
  ctx.inject(['connection', 'webServer'], (routeCtx: Ctx) => {
    try {
      const face = routeCtx as unknown as {
        connection?: { requestRejection?: (req: unknown) => number | undefined }
        webServer?: { register?: (route: unknown) => unknown }
      }
      const connection = face.connection ?? (routeCtx.get('connection') as typeof face.connection)
      const webServer = face.webServer ?? (routeCtx.get('webServer') as typeof face.webServer)
      const register = webServer?.register
      const requestRejection = connection?.requestRejection
      // Both halves are required. Serving without the fence would publish the
      // operator's Trae account to any local page that can reach the port — an
      // unauthenticated route is strictly worse than no route.
      if (typeof register !== 'function' || typeof requestRejection !== 'function') {
        trace('host route: connection.requestRejection / webServer.register unavailable — the settings card will have no data (the shim is unaffected)')
        return
      }

      const handler = createHostRouteHandler({ requestRejection, resolveApi: () => apiHandler })

      const paths = [ROUTE_PREFIX, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}`]
      const disposers: (() => void)[] = []
      for (const path of paths) {
        try {
          const registered = register.call(webServer, { kind: 'prefix', path, handler })
          if (typeof registered === 'function') disposers.push(registered as () => void)
          else if (registered !== null && typeof (registered as Promise<unknown>)?.then === 'function') {
            const pending = registered as Promise<unknown>
            disposers.push(() => {
              void pending.then((dispose) => (typeof dispose === 'function' ? (dispose as () => void)() : undefined)).catch(() => undefined)
            })
          }
        } catch (error) {
          trace(`host route: ${path} NOT registered — ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (disposers.length === 0) {
        trace('host route: nothing registered — the settings card will have no data')
        return
      }

      routeCtx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* already gone */
          }
        }
      })
      trace(`host route: registered on ${paths.join(' and ')} (handleApi, ${disposers.length} path(s))`)
    } catch (error) {
      // Throwing inside an inject callback is swallowed by the loader and the card
      // would just show nothing; leave the reason in the boot trace instead.
      trace(`host route: FAILED — ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  /**
   * The credential this process can actually SPEND, given one that may already be
   * past its expiry. Three steps, cheapest first, each one recorded:
   *
   *   ① a copy THIS plugin wrote on an earlier run (same account, still valid) —
   *      no network, no new token, nothing to lose;
   *   ② one token refresh against Trae's own exchange endpoint
   *      (`refreshCredentialIntoStore`), written to this plugin's own file and used
   *      from memory;
   *   ③ neither worked → hand back the credential we already had. That is the
   *      OLD behaviour (the request fails honestly, with the gateway's own
   *      answer), now with the reason visible on the card instead of only in
   *      `boot.log`.
   *
   * 🔴 Nothing here writes into Trae's own data directory. The refreshed token
   * goes to `$DSH_HOME/.dsh-pylon-trae/credentials-<id>.json`, and the writer itself
   * refuses any path outside that directory (`assertOwnCredentialPath`).
   */
  async function ensureUsableCredential(current: TraeCredential): Promise<TraeCredential> {
    if (!isExpired(current)) {
      expiryWarning = undefined
      return current
    }
    let storePath: string
    try {
      storePath = credentialStorePath(dshHome(), current.id)
    } catch (error) {
      // An id we cannot turn into a path is not a reason to lose the credential.
      trace(`credential: 无法为 ${current.id} 构造本插件副本路径 —— ${error instanceof Error ? error.message : String(error)}`)
      storePath = ''
    }
    if (storePath !== '') {
      const stored = readStoredCredential(storePath, current.edition)
      const adopted = preferValidStoredCredential(current, stored)
      if (adopted !== undefined) {
        trace(`credential: 桌面凭据已过期，改用本插件自己的副本（${storePath}，fp=${tokenFingerprint(adopted)}）`)
        expiryWarning = undefined
        return adopted
      }
    }
    if (refreshAttempt === undefined) {
      refreshAttempt = canRefresh(current)
        ? await attemptRefresh(current, storePath)
        : { ok: false, unavailable: true, detail: '没有可用的 refreshToken 或网关地址' }
    }
    const refreshed = refreshAttempt.credential
    if (refreshAttempt.ok && refreshed !== undefined && !isExpired(refreshed)) {
      expiryWarning = undefined
      return refreshed
    }
    expiryWarning = describeCredentialExpiry(current, {
      action: refreshAttempt.unavailable === true ? 'refresh-unavailable' : 'refresh-failed',
      ...(refreshAttempt.detail === '' ? {} : { note: refreshAttempt.detail })
    })
    trace(`credential: 过期且未能续期（${refreshAttempt.detail}）—— 保持原凭据，原因已作为 accountWarning 暴露给 /status`)
    return current
  }

  /** One refresh, with everything it needs about this machine — and no exceptions. */
  async function attemptRefresh(current: TraeCredential, storePath: string): Promise<RefreshAttempt> {
    let device: TraeRefreshDevice | undefined
    try {
      const identityValue = readTraeIdentity(current.storagePath, current.edition)
      const storageDevice = readStorageDevice(current.storagePath)
      let deviceName: string | undefined
      try {
        deviceName = userInfo().username || undefined
      } catch {
        deviceName = undefined
      }
      device = {
        machineId: identityValue.machineId,
        // Same precedence as upstream (`:1903`): the device-centre id the install
        // registered outranks `telemetry.devDeviceId`, because the server matches
        // the DeviceID it is told against the device it already knows.
        deviceId: storageDevice.deviceId ?? identityValue.deviceId,
        ...(deviceName === undefined ? {} : { deviceName }),
        ...(identityValue.appVersion === undefined ? {} : { appVersion: identityValue.appVersion }),
        ...(identityValue.osVersion === undefined ? {} : { osVersion: identityValue.osVersion }),
        // Absent on an older install (or a CLI-only home); the refresh then skips
        // the signed contract rather than sending a request that must be refused.
        ...(storageDevice.keyPair === undefined ? {} : { deviceKeyPair: storageDevice.keyPair })
      }
    } catch (error) {
      trace(`credential: 读不出设备身份（${error instanceof Error ? error.message : String(error)}）—— 只走不带签名的旧契约`)
      device = undefined
    }
    const result = await refreshCredentialIntoStore(current, storePath, device === undefined ? {} : { device })
    trace(`credential: refresh ${result.ok ? 'ok' : 'failed'} — ${result.detail}`)
    if (!result.ok) return { ok: false, detail: result.detail }
    return { ok: true, detail: '', ...(result.credential === undefined ? {} : { credential: result.credential }) }
  }

  async function credential(): Promise<TraeCredential> {
    if (credentialCache !== undefined) {
      // The freshness check runs on EVERY call and is local (a number comparison):
      // a token that runs out mid-session must be noticed without a restart, and
      // the card polls `/status`. The refresh behind it is not — `refreshAttempt`
      // holds it to one attempt per process, so a broken network cannot turn a
      // polled endpoint into a request storm.
      if (isExpired(credentialCache)) credentialCache = await ensureUsableCredential(credentialCache)
      return credentialCache
    }
    const resolved = await resolveCredential(config.authFile)
    if (resolved.credential === undefined) throw new Error(resolved.detail)
    credentialCache = resolved.credential
    // One explicit selection wins over the default (desktop sign-in first).
    if (state.activeAccountId !== undefined && state.activeAccountId !== credentialCache.id) {
      const scan = scanCredentials(traeStorageCandidates())
      const picked = scan.credentials.find((entry) => entry.id === state.activeAccountId)
      if (picked !== undefined) {
        credentialCache = picked
        selectionWarning = undefined
      } else {
        // Say it in both places: boot.log keeps the record, the card keeps the user
        // informed. `detail` names which account is billed instead.
        const warning = `已选账号 ${state.activeAccountId} 在这台机器上不存在（本机可见 ${scan.credentials.length} 个），本次改用 ${resolved.detail}`
        selectionWarning = warning
        trace(`account: selected ${state.activeAccountId} not present, keeping ${resolved.detail} — 已作为 accountWarning 暴露给 /status`)
      }
    } else {
      selectionWarning = undefined
    }
    credentialCache = await ensureUsableCredential(credentialCache)
    return credentialCache
  }

  /** Every account this machine can see, with the one we would bill marked active. */
  async function listAccounts(): Promise<TraeAccountInfo[]> {
    const active = credentialCache?.id ?? state.activeAccountId
    return scanCredentials(traeStorageCandidates()).credentials.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      ...(entry.accountName === undefined ? {} : { accountName: entry.accountName }),
      edition: entry.edition,
      source: entry.source,
      expiresAtMs: entry.expiresAtMs,
      active: entry.id === active
    }))
  }

  async function selectAccount(accountId: string): Promise<{ ok: boolean; detail?: string }> {
    const scan = scanCredentials(traeStorageCandidates())
    const picked = scan.credentials.find((entry) => entry.id === accountId)
    if (picked === undefined) return { ok: false, detail: `找不到账号 ${accountId}（本机可见 ${scan.credentials.length} 个）` }
    state = { ...state, activeAccountId: accountId }
    writeState({ activeAccountId: accountId })
    credentialCache = picked
    identityCache = undefined
    // The previous warning was about the OLD selection; it is no longer true. The
    // expiry warning is recomputed by `ensureUsableCredential` on the next read of
    // this credential, which is exactly when it is known to be true again.
    selectionWarning = undefined
    expiryWarning = undefined
    refreshAttempt = undefined
    trace(`account: switched to ${accountId} (${picked.source}/${picked.edition}, fp=${tokenFingerprint(picked)})`)
    return { ok: true }
  }

  async function identity(): Promise<TraeIdentity> {
    if (identityCache !== undefined) return identityCache
    const current = await credential()
    identityCache = readTraeIdentity(current.storagePath, current.edition)
    return identityCache
  }

  async function run(): Promise<void> {
    const resolved = await resolveCredential(config.authFile)
    if (resolved.credential === undefined) {
      trace(`credential: none — ${resolved.detail}`)
      ctx.logger.warn(`dsh-pylon-trae: 没有可用凭据 —— ${resolved.detail}`)
      return
    }
    // Freshness BEFORE anything spends the token: the directory request below is a
    // real call against the account, and a token that expires while it is in flight
    // turns boot into "0 models" for a reason the user cannot see. An expired token
    // that cannot be renewed is NOT fatal here — the old path is kept, it fails
    // honestly, and the reason is on the card.
    credentialCache = await ensureUsableCredential(resolved.credential)
    const region = credentialCache.region
    trace(`credential: ${resolved.detail} user=${credentialCache.userId || '(none)'} fp=${tokenFingerprint(credentialCache)}`)
    const { token, path: tokenPath, created } = loadOrCreateToken(region)
    if (created) ctx.logger.info(`dsh-pylon-trae: 已生成本插件自己的回环 token（不是 Trae 的 token）→ ${tokenPath}`)
    trace(`token: ${created ? 'created' : 'reused'} at ${tokenPath}`)

    /**
     * The green dot, made true BEFORE it is promised.
     *
     * The Models page lights the dot beside a provider name when the profile
     * entry names a credential reference and `credentials.describe(ref)` says
     * `configured: true` (`dsh-client-ui-settings-models/lib/client.js:2158`),
     * and turns it RED when the reference resolves to nothing (`:2159`) — which
     * is not cosmetic, because pi-ai then refuses every request with
     * `MISSING_CREDENTIAL` (`dsh-llm-pi-ai/lib/index.js:2564-2569`). So this
     * runs FIRST and its answer is the only thing that decides whether
     * `apiKeyEnv` is written at all: the value stored is this process's own shim
     * token, byte-identical to the `headers.Authorization` bearer, so naming the
     * credential cannot change which bytes reach the shim — it only makes the
     * fact visible. A failure here costs the dot and nothing else: the entry
     * keeps authenticating through its header, exactly as it did before.
     */
    const credentialResult = await ensureCredentialRef({ store: credentialsFace(), ref: TRAE_API_KEY_REF, value: token })
    verifiedApiKeyEnv = verifiedCredentialRef(credentialResult, TRAE_API_KEY_REF)
    trace(`credential-store: ${credentialResult.status} — ${credentialResult.detail}${credentialResult.backupPath === undefined ? '' : `（备份 ${credentialResult.backupPath}）`}`)
    if (verifiedApiKeyEnv === undefined) {
      ctx.logger.warn(`dsh-pylon-trae: 没能确认凭据库里有 ${TRAE_API_KEY_REF}（${credentialResult.status}：${credentialResult.detail}）—— 本次不写 apiKeyEnv，条目继续只用 Authorization 头认证（宁可不绿，也不能变红打死路由）`)
    } else if (credentialResult.wrote) {
      ctx.logger.info(`dsh-pylon-trae: 已把回环 token 写进凭据库的 ${TRAE_API_KEY_REF}（供 pi-ai 解析；模型页那条 provider 会显示绿点）`)
    }

    /** One place where a provider profile is built, so `apiKeyEnv` cannot be forgotten. */
    const profileFor = (baseUrl: string, list: readonly TraeModel[]): ProviderProfile =>
      buildProviderProfile({
        displayName: config.displayName,
        baseUrl,
        token,
        models: list,
        ...(verifiedApiKeyEnv === undefined ? {} : { apiKeyEnv: verifiedApiKeyEnv })
      })

    let models: readonly TraeModel[] = FALLBACK_MODELS[region]
    try {
      const identityValue = readTraeIdentity(credentialCache.storagePath, credentialCache.edition)
      identityCache = identityValue
      const directory = await fetchDirectoryModels(region, credentialCache, identityValue)
      if (directory.models.length > 0) {
        models = directory.models
        trace(`directory: ${directory.models.length} models (${directory.attempts.map((a) => `${a.fn}:${a.status ?? 'err'}`).join(' ')})`)
        ctx.logger.info(`dsh-pylon-trae: 目录 ${directory.models.length} 个模型（${directory.attempts.map((a) => `${a.fn}:${a.status ?? 'err'}`).join(' ')}）`)
      } else {
        trace(`directory: EMPTY, ${models.length} fallback models (${directory.attempts.map((a) => `${a.fn}:${a.error ?? a.status}`).join(' ')})`)
        ctx.logger.warn(`dsh-pylon-trae: 目录拉取失败，使用 ${models.length} 个兜底模型（${directory.attempts.map((a) => `${a.fn}:${a.error ?? a.status}`).join(' ')}）`)
      }
    } catch (error) {
      trace(`directory: threw — ${error instanceof Error ? error.message : String(error)}`)
      ctx.logger.warn(`dsh-pylon-trae: 身份或目录不可用，使用 ${models.length} 个兜底模型`, error)
    }

    /**
     * "Rebuild the list" — re-read the live directory and add ONLY models this
     * plugin has never offered before. A model the user deleted was offered once,
     * so it stays deleted; that is the whole point of remembering the offer.
     */
    async function refreshDirectory(): Promise<{ outcome: SeedOutcome; modelCount: number }> {
      const settingsFace = settings
      if (settingsFace === undefined) {
        return { outcome: { kind: 'no-namespace', detail: 'settings 服务不可用，无法写入供应商条目' }, modelCount: models.length }
      }
      try {
        const directory = await fetchDirectoryModels(region, await credential(), await identity())
        if (directory.models.length > 0) models = directory.models
        trace(`refresh: directory ${directory.models.length} models (${directory.attempts.map((a) => `${a.fn}:${a.status ?? 'err'}`).join(' ')})`)
      } catch (error) {
        trace(`refresh: directory failed — ${error instanceof Error ? error.message : String(error)}`)
      }
      const baseUrl = shim?.baseUrl() ?? `http://127.0.0.1:${config.port}`
      const profile = profileFor(baseUrl, models)
      const outcome = await seedProvider({
        settings: settingsFace,
        pluginName: name,
        providerName: config.providerId,
        profile,
        mode: 'refresh',
        previouslyOffered: state.lastOffered ?? [],
        skippedInternal: partitionModels(models).internalIds
      })
      if (outcome.kind === 'rebuilt') {
        rememberOffered(outcome.offeredModels)
      }
      // A row appended by this button carries a name we computed, so it enters the
      // name memory here: without the record, the next boot could not tell that
      // name apart from one the user typed and would never improve it.
      if ('nameSync' in outcome) rememberNames(outcome.nameSync?.names)
      trace(`refresh: ${outcome.kind} — ${describeOutcome(outcome)}`)
      return { outcome, modelCount: models.length }
    }

    /**
     * "刷新目录" — re-read the live directory and NOTHING else.
     *
     * READ-ONLY BY CONSTRUCTION, and that is the whole point of it existing beside
     * `refreshDirectory`: no `seedProvider`, no `buildProviderProfile`, no guard and
     * no `settings` write — the in-memory list the shim and `/models` serve is the
     * only thing this touches. A model the user deleted stays deleted; not because
     * this remembers anything, but because it never writes.
     *
     * A failure keeps the list it had and says why. Answering "0 models" for a
     * re-read that never happened would make the card — and the shim — offer a Trae
     * provider with nothing in it.
     */
    async function reloadDirectory(): Promise<ReloadResult> {
      try {
        const directory = await fetchDirectoryModels(region, await credential(), await identity())
        const attempts = directory.attempts
        if (directory.models.length > 0) {
          models = directory.models
          trace(`reload: directory ${models.length} models (${attempts.map((a) => `${a.fn}:${a.status ?? 'err'}`).join(' ')}) — read-only, nothing written`)
          return { ok: true, modelCount: models.length, attempts }
        }
        const why = attempts.map((a) => `${a.fn}:${a.error ?? a.status ?? '没有回答'}`).join('；')
        trace(`reload: EMPTY directory, keeping ${models.length} models (${why})`)
        return { ok: false, detail: `网关没有返回任何模型，保留原来的 ${models.length} 个（${why}）`, modelCount: models.length, attempts }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        trace(`reload: failed — ${detail} (keeping ${models.length} models)`)
        return { ok: false, detail: `重新拉取目录失败，保留原来的 ${models.length} 个：${detail}`, modelCount: models.length, attempts: [] }
      }
    }

    const api = (request: { method: string; path: string; body?: unknown }) =>
      handleApi(request, {
        region,
        port: config.port,
        credential,
        identity,
        models: () => models,
        accounts: listAccounts,
        // Read AFTER `credential()` has run inside the handler, which is where BOTH
        // facts are discovered — a dropped account selection, and a credential that
        // is out of time — hence a getter, not a value.
        accountWarning: accountWarningText,
        selectAccount,
        refresh: refreshDirectory,
        // The read-only half. Same gateway call, no write path — see reloadDirectory.
        reload: reloadDirectory,
        /**
         * Read-only: what the user's OWN entry still carries that the live
         * directory judges internal. Both halves of the comparison come from
         * different places on purpose — `models` is what Trae offers now,
         * `currentProviderModelIds` is what the profile currently says — and the
         * difference is exactly the junk an earlier version wrote.
         */
        internalInEntry: async () => {
          const inEntry = new Set(currentProviderModelIds(settings, config.providerId))
          return partitionModels(models).internalIds.filter((id) => inEntry.has(id))
        },
        /**
         * The DELETE half — the only path in this plugin that removes rows from
         * user configuration. It is NOT scheduled anywhere: `POST
         * /models/prune-internal` is the only caller, and that route is only
         * reachable from the card's own button (see src/api.ts). `models` is read at
         * CALL time rather than captured, so a directory reload between boot and the
         * click is what decides which ids are internal.
         */
        pruneInternal: async () =>
          pruneInternalModels({
            settings,
            pluginName: name,
            providerName: config.providerId,
            internalIds: partitionModels(models).internalIds
          })
      })
    // Publish the SAME handler to the host route above; the shim keeps using it
    // directly. One implementation, two transports.
    apiHandler = api

    shim = createShim({
      region,
      port: config.port,
      token,
      credential,
      identity,
      models: () => models,
      /**
       * `/v1/models` advertises exactly what the provider entry got — the SAME
       * `partitionModels(models).chat` verdict `seedProvider` is handed below, so the
       * shim cannot list an id pi-ai was never told about (nor hide one it was). The
       * classification stays in catalog.ts; the shim only transports this list.
       */
      advertisedModels: () => partitionModels(models).chat,
      api,
      logger: { info: (m, d) => ctx.logger.info(m, d), warn: (m, d) => ctx.logger.warn(m, d), error: (m, d) => ctx.logger.error(m, d) }
    })
    try {
      await shim.ready
    } catch (error) {
      trace(`shim: FAILED — ${error instanceof Error ? error.message : String(error)}`)
      ctx.logger.error(`dsh-pylon-trae: 回环服务起不来 —— ${error instanceof Error ? error.message : String(error)}`)
      shim = undefined
      return
    }
    trace(`shim: listening ${shim.baseUrl()}`)
    ctx.logger.info(`dsh-pylon-trae: 回环服务 ${shim.baseUrl()}（凭据 ${tokenFingerprint(resolved.credential)}，地区 ${region}）`)
    if (stopped) {
      trace('shim: stopped before seeding')
      return
    }

    const settingsFace = settings
    if (!config.seed || settingsFace === undefined) {
      trace(`seed: skipped (seed=${config.seed} settings=${settingsFace === undefined ? 'missing' : 'ok'})`)
      return
    }
    trace(`guard: ${explainPatchLookup(name)}`)
    const catalogue = partitionModels(models)
    /**
     * The boot reconciliation, and NOT `seedProvider`.
     *
     * `seedProvider`'s answer for an entry that exists is `present` — correct for
     * "should I write this from scratch?" and useless for the three things this
     * plugin still owes the user on every start: a token that may have rotated
     * (the entry would keep a stale bearer and 401), a credential reference that
     * may be provable now (the green dot), and model ids Trae has added since the
     * entry was written. See `syncProviderEntry` for the three properties that
     * make touching an existing entry safe — surgical patch, nothing new ⇒
     * nothing written, and the same guard as every other write.
     *
     * `mode: 'refresh'` keeps its old meaning ("always re-read the directory and
     * add what is new") so an existing config that asked for it still gets it.
     */
    const profile = profileFor(shim.baseUrl(), models)
    const outcome = await syncProviderEntry({
      settings: settingsFace,
      pluginName: name,
      providerName: config.providerId,
      profile,
      token,
      refreshOnBoot: config.refreshOnBoot || config.mode === 'refresh',
      previouslyOffered: state.lastOffered ?? [],
      // `!== false`, not `=== true`: the default is ON (see DEFAULT_CONFIG), so a
      // caller that hands `apply` a partial config — a test harness, an older
      // composition — gets the documented behaviour instead of the silent one.
      syncNamesOnBoot: config.syncNamesOnBoot !== false,
      lastNames: state.lastNames ?? {},
      skippedInternal: catalogue.internalIds
    })
    trace(`seed: ${outcome.kind} — ${describeOutcome(outcome)}`)
    // Two lines, because they answer two different questions: "did the token the
    // entry carries get fixed?" and "did a new model arrive?" — the first is
    // ours to maintain, the second is the whole point of `refreshOnBoot`.
    if ('tokenState' in outcome && outcome.tokenState !== undefined) {
      trace(
        outcome.tokenState === 'same'
          ? 'token: 与条目里的一致 —— 一个字节都没写'
          : `token: 轮换已同步（条目里原本是${outcome.tokenState === 'missing' ? '没有 Authorization 头' : '旧 token'}）—— 已在 guard 保护下更新条目并同步凭据库`
      )
    }
    if ('apiKeyEnvState' in outcome && outcome.apiKeyEnvState !== undefined) {
      trace(
        outcome.apiKeyEnvState === 'written'
          ? `apiKeyEnv: 已写入 ${TRAE_API_KEY_REF}（凭据库里已有对应值，绿点才会亮）`
          : outcome.apiKeyEnvState === 'present'
            ? `apiKeyEnv: ${TRAE_API_KEY_REF} 已在条目里，未改动`
            : `apiKeyEnv: 本次不写（凭据库没能确认有 ${TRAE_API_KEY_REF}）—— 条目保持只用 Authorization 头`
      )
    }
    if (config.refreshOnBoot || config.mode === 'refresh') {
      const added = outcome.kind === 'rebuilt' ? outcome.addedModels : []
      trace(
        added.length > 0
          ? `refresh-on-boot: 新增 ${added.length} 个（${added.join('、')}）—— 只增不删，用户删过的不会复活`
          : 'refresh-on-boot: 无新增 —— 一个字节都没写'
      )
    }
    /**
     * 显示名对账：一行说"我们改了什么"，一行说"为什么有些行没动"。
     *
     * The second line is the one that matters when a user wonders why a row kept
     * an odd name: "you changed it, so it is yours" has to be a fact in the log,
     * not an inference. The first line names every id that was rewritten — a
     * silent rewrite of the user's configuration is the accident this plugin
     * exists to avoid.
     */
    const nameSync: SeedNameReport | undefined = 'nameSync' in outcome ? outcome.nameSync : undefined
    if (nameSync !== undefined) {
      const addedModels = outcome.kind === 'rebuilt' ? outcome.addedModels.length : 0
      if (nameSync.state === 'off') {
        trace('名字: 同步已关闭（syncNamesOnBoot=false）—— 条目里的名字一律不动')
      } else if (nameSync.renamed.length > 0) {
        trace(`名字: 已更新 ${nameSync.renamed.length} 行的显示名（${nameSync.renamed.slice(0, 8).map((change) => change.id).join('、')}${nameSync.renamed.length > 8 ? '…' : ''}）—— 只改 name 字段，其余字段与行顺序未动`)
      } else if (outcome.kind === 'created') {
        trace(`名字: 条目是本次新建的，${outcome.modelCount} 行都用了目录算出的显示名（不是各自 id）`)
      } else if (addedModels > 0) {
        trace(`名字: 新增的 ${addedModels} 行自带目录算出的显示名；已有行未改动`)
      } else {
        trace('名字: 与目录算出的显示名一致 —— 未改动')
      }
      if (nameSync.skippedUserNames.length > 0) {
        trace(
          `名字: ${nameSync.skippedUserNames.length} 行是你改过的名字，跳过（${nameSync.skippedUserNames.slice(0, 8).map((row) => row.id).join('、')}${nameSync.skippedUserNames.length > 8 ? '…' : ''}）—— 我们只改自己写过的名字`
        )
      }
    }
    /**
     * 已存在的垃圾条目：只提示，不自动删。
     *
     * An entry written by an earlier version still lists the internal components,
     * and the reconciliation deliberately does not touch them (a user's entry is
     * theirs). So the only thing this plugin owes the user at boot is the fact
     * plus the way out — one line in `boot.log` and a button on the card (`POST
     * /models/prune-internal`). Deleting from user configuration without being
     * asked is the accident this plugin exists to avoid, not a convenience it
     * should take.
     */
    const stillInEntry = 'offeredModels' in outcome ? outcome.offeredModels.filter((id) => catalogue.internalIds.includes(id)) : []
    if (stillInEntry.length > 0) {
      trace(`internal: 检测到 ${stillInEntry.length} 个内部组件仍在你的条目里（${stillInEntry.join('、')}）—— 未自动删除；在设置卡片点「移除内部组件」即可清除（会先备份到 profile 之外）`)
      ctx.logger.warn(`dsh-pylon-trae: 检测到 ${stillInEntry.length} 个 Trae 内部流程组件仍在你的模型条目里（如 ${stillInEntry.slice(0, 3).join('、')}）。没有自动删除 —— 在设置卡片点「移除内部组件」即可清除。`)
    } else if (catalogue.internal.length > 0) {
      trace(`internal: 目录里 ${catalogue.internal.length} 个内部组件已隐藏、未写入条目（${catalogue.internalIds.slice(0, 8).join('、')}${catalogue.internalIds.length > 8 ? '…' : ''}）`)
    }
    // Every outcome that carries a tombstone set feeds it, because that set is
    // the memory which makes "only add" mean what it says: a model the user
    // deletes after this boot must not come back on a later one.
    if ('offeredModels' in outcome) {
      rememberOffered(outcome.offeredModels)
    }
    // And the name memory: ONLY the names a write really landed carries, so a
    // rename that failed is retried next boot instead of being remembered as done.
    if ('nameSync' in outcome) {
      rememberNames(outcome.nameSync?.names)
    }
    if (outcome.kind === 'rolled-back' || outcome.kind === 'failed') ctx.logger.error(`dsh-pylon-trae: ${describeOutcome(outcome)}`)
    else ctx.logger.info(`dsh-pylon-trae: ${describeOutcome(outcome)}`)
  }
}

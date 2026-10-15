/**
 * `src/api.ts` self-test — OFFLINE. No network, no credentials, no quota.
 *
 * Every handler `handleApi` exposes is driven through a FAKE `fetchImpl` and fake
 * deps, so this suite never reads a real Trae token and never talks to a gateway.
 * As a belt-and-braces guard the global `fetch` is replaced with a throwing stub
 * for the whole run: if a code path ever ignores the injected transport, the
 * suite fails loudly instead of quietly going online.
 *
 * What it pins down (the card consumes all of it):
 *   · `/status`   credential summary + accounts, and a failed account scan is NOT fatal
 *                 AND not an empty list: `accounts: null` + `accountsError`, while a scan
 *                 that really found nothing is `[]` with no error field
 *   · `/models`   the shape the card renders, with nulls instead of absences
 *   · `/models/refresh`  the seed outcome passed through untouched
 *   · `/models/reload`   the READ-ONLY re-read: modelCount + the per-function attempts
 *                 + a time stamp; a refusal that carries the dep's own detail and NO
 *                 count (a failed re-read must never read as "0 models"); the existing
 *                 list left exactly as it was; and the evidence that it cannot write —
 *                 the injected `refresh` dep (the only one that seeds) is called ZERO
 *                 times on both the success and the failure path
 *   · `/account`  missing id / accepted / refused
 *   · `/usage`    HTTP failure, business-code failure in BOTH spellings (number and
 *                 numeric string), a code that cannot be read at all refused instead
 *                 of guessed as 0, success, a 200 whose body is not a JSON object
 *                 refused with a bounded excerpt (never `credits: {}`), a complete
 *                 multi-KiB envelope parsed in full (the old 4096 slice cut it in
 *                 half and blamed the gateway), the 1 MiB memory bound reported AS a
 *                 bound, and CN-only
 *   · `/checkin`  GET status, POST claim, a business refusal (read as `ok:false` /
 *                 `claimed:false`, never as "not checked in today"), the claim's own
 *                 code read in both spellings and refused when unreadable or absent,
 *                 a 200 whose body is not a JSON object (proxy page / empty / array)
 *                 refused instead of reported as "not checked in today", a code-less
 *                 but well-formed status answer still a success, a missing or
 *                 non-numeric `credits` left absent instead of fabricated as 0, 405,
 *                 CN-only
 *   · `/models/test`  default probe of the first five, explicit ids answered in the
 *                 order they were requested (unknown ids dropped, a repeat probed
 *                 once), a ceiling of ten REAL probes per request with the truncation
 *                 reported (`requested` / `tested` / `truncated`), the four verdicts
 *                 that matter (available / needs-plan / not-served / rate-limited), and
 *                 a 200 whose stream carries no recognisable event read as
 *                 inconclusive — no generation is ever sent
 *   · unknown route -> 404 with `ok:false`, and a throwing dep never escapes
 *
 * The four fixes of 2026-10-14 (business code on GET /checkin, fabricated
 * `credits: 0`, string business codes, /models/test ordering) each have assertions
 * here; the one that used to document the old asymmetry is now flipped.
 *
 * The three fixes of the follow-up pass (each one measured live before it was
 * reproduced here) also have assertions, and each has at least one line the OLD
 * behaviour fails: the POST claim reads its code through the same reader as the GET
 * (so `{code: "9004"}` is a refusal, not `claimed: true`), a 200 probe whose stream
 * carries no recognisable event is `inconclusive` instead of `available`, and a
 * `/usage` 200 whose body is not a JSON object is refused with a body excerpt
 * instead of `credits: {}`.
 *
 * The last pass adds the two measured leftovers of that same family, again with
 * lines the OLD behaviour fails:
 *   · `post()` parsed AFTER `slice(0, 4096)`, so a complete 6.1 KiB envelope was cut
 *     mid-string and `/usage` answered "not a JSON object" — the plugin's own cap
 *     reported as a malformed gateway body. The whole body is parsed now (up to a
 *     1 MiB memory bound that reports itself AS a bound), and only the error excerpt
 *     is shortened.
 *   · `GET /checkin` never asked `jsonObject`, so a 200 carrying an HTML proxy page
 *     was answered `{ok:true, checkedIn:false, didCheckedIn:false, enabled:true}` —
 *     a proxy page read as a fact about the account. It now refuses the way `/usage`
 *     does, while a code-less well-formed status answer still succeeds.
 *
 * This pass adds the two leftovers of the independent adversarial review (25 cases), again
 * with lines the OLD behaviour fails:
 *   · `GET /status` read the account scan as `deps.accounts().catch(() => [])`, so a scan
 *     that FAILED and a machine with no other account were the same answer — and the card
 *     could then state "没有账号", a claim about this machine the plugin never verified.
 *     A failure is `accounts: null` + `accountsError` now; a scan that really found
 *     nothing is still `[]` and carries no error field.
 *   · `POST /models/test` had no ceiling on explicit `modelIds`: 79 ids meant 79 real
 *     probes, sent serially, each with its own 30 s timeout and its own quota spend. At
 *     most ten are probed now and the answer says so (`requested` / `tested` /
 *     `truncated`); the no-`modelIds` default (the first five) is unchanged.
 *
 * Run:  <dsh-node> tools/test-api.ts        exit 0 = every check passed
 */
import type { TraeCredential } from '../src/auth.ts'
import type { TraeIdentity } from '../src/identity.ts'
import type { DirectoryAttempt, TraeModel } from '../src/catalog.ts'
import type { SeedOutcome } from '../src/seed.ts'
import { readFileSync } from 'node:fs'
import { handleApi, type ApiDeps, type ApiRequest, type TraeAccountInfo } from '../src/api.ts'

let failures = 0
let passed = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failures += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
}

function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

// --------------------------------------------------------------- offline guard
const globalFetch = globalThis.fetch
globalThis.fetch = (() => {
  throw new Error('test-api: a real network call was attempted; pass deps.fetchImpl')
}) as typeof fetch

// ------------------------------------------------------------------ fake deps
const CREDENTIAL = {
  id: 'test',
  edition: 'cn',
  region: 'cn',
  source: 'desktop',
  storagePath: '',
  userId: '100000000000000',
  accountName: 'tester',
  host: 'https://api.trae.cn',
  expiresAtMs: 1792000000000,
  accessToken: 'test-token'
} as TraeCredential
const IDENTITY = { edition: 'cn', machineId: 'machine-1', deviceId: 'device-1', appVersion: '3.3.104' } as TraeIdentity

const MODELS: readonly TraeModel[] = [
  { id: 'm1', name: 'One', contextWindow: 1000, maxTokens: 100, input: ['text'], directoryFunction: 'solo_work_remote' },
  { id: 'm2', name: 'Two', contextWindow: 2000, maxTokens: 200, input: ['text'], directoryFunction: 'solo_work_remote' },
  { id: 'm3', name: 'Three', input: ['text'], directoryFunction: 'solo_agent_remote' },
  { id: 'm4', name: 'Four', contextWindow: 4000, input: ['text'], directoryFunction: 'chat_v3' },
  { id: 'm5', name: 'Five', contextWindow: 5000, input: ['text'], directoryFunction: 'solo_coder' },
  { id: 'm6', name: 'Six', contextWindow: 6000, input: ['text'], directoryFunction: 'solo_work_remote' },
  { id: 'm7', name: 'Seven', contextWindow: 7000, input: ['text'], directoryFunction: 'solo_work_remote' }
]

/**
 * A directory big enough for the `/models/test` ceiling to bite (the fixture above has
 * seven, which is under it). 79 entries is the size the adversarial review actually used
 * when it measured "79 ids = 79 real probes".
 */
const MANY_MODELS: readonly TraeModel[] = Array.from({ length: 79 }, (_, index) => ({
  id: `x${String(index + 1).padStart(2, '0')}`,
  name: `X${String(index + 1).padStart(2, '0')}`,
  contextWindow: 1000,
  input: ['text'],
  directoryFunction: 'solo_work_remote'
}))

const ACCOUNTS: TraeAccountInfo[] = [
  { id: 'desktop/cn', userId: '100000000000000', accountName: 'tester', edition: 'cn', source: 'desktop', expiresAtMs: 1792000000000, active: true }
]

const REFRESH_OUTCOME: SeedOutcome = { kind: 'rebuilt', ns: 'llm-pi-ai', addedModels: ['m7'], keptModels: 6, backupPath: '/tmp/backup.yml', offeredModels: ['m1'] }

/** One entry per directory function, in the wording `fetchDirectoryModels` produces. */
const RELOAD_ATTEMPTS: DirectoryAttempt[] = [
  { fn: 'solo_work_remote', status: 200, count: 7 },
  { fn: 'solo_agent_remote', status: 200, count: 3 },
  { fn: 'chat_v3', status: 500, error: 'upstream says no' }
]

interface Calls {
  url: string
  init: RequestInit
}

/** Route a fake transport by URL and record every call. */
function transport(handler: (url: string, init: RequestInit) => Response): { impl: typeof fetch; calls: Calls[] } {
  const calls: Calls[] = []
  const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const request = init ?? {}
    calls.push({ url: String(url), init: request })
    return handler(String(url), request)
  }) as unknown as typeof fetch
  return { impl, calls }
}

const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status })
const sse = (text: string): Response => new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
const streaming = (events: string): string => events

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    region: 'cn',
    port: 7864,
    credential: async () => CREDENTIAL,
    identity: async () => IDENTITY,
    models: () => MODELS,
    accounts: async () => ACCOUNTS,
    selectAccount: async (accountId: string) => (accountId === 'cli/cn' ? { ok: false, detail: '凭据已过期' } : { ok: true }),
    refresh: async () => ({ outcome: REFRESH_OUTCOME, modelCount: 7 }),
    reload: async () => ({ ok: true, modelCount: MODELS.length, attempts: RELOAD_ATTEMPTS }),
    ...overrides
  }
}

const get = (path: string): ApiRequest => ({ method: 'GET', path })
const post = (path: string, body?: unknown): ApiRequest => ({ method: 'POST', path, body })

// ------------------------------------------------------------------- 1. status
console.log('\n[1] GET /status')
{
  const response = await handleApi(get('/status'), deps())
  check('ok:true with region/port/modelCount', response.body['ok'] === true && response.body['region'] === 'cn' && response.body['port'] === 7864 && response.body['modelCount'] === 7, JSON.stringify(response.body))
  const credential = response.body['credential'] as Record<string, unknown>
  check('credential summary carries no secret', credential['source'] === 'desktop' && credential['userId'] === '100000000000000' && credential['accountName'] === 'tester' && !('accessToken' in credential) && !('refreshToken' in credential), JSON.stringify(credential))
  check('accounts are passed through', same(response.body['accounts'], ACCOUNTS))
}
{
  // 已修（这一轮）：`deps.accounts().catch(() => [])` 把「扫描失败」和「确实没有别的账号」压成
  // 同一个 `[]`，于是卡片可以照实说「没有账号」—— 一条插件从未验证过的、关于这台机器的断言。
  // 现在失败的形状与空列表不同：`accounts` 为 null（未知），并带上失败原因。
  const response = await handleApi(get('/status'), deps({ accounts: async () => { throw new Error('credential scan failed') } }))
  check('a failed account scan is not fatal: ok:true, region/port/modelCount intact', response.body['ok'] === true && response.body['region'] === 'cn' && response.body['port'] === 7864 && response.body['modelCount'] === 7, JSON.stringify(response.body))
  check('...the credential summary survives the partial failure', (response.body['credential'] as Record<string, unknown>)['userId'] === '100000000000000', JSON.stringify(response.body['credential']))
  check('...but accounts is null, NOT an empty list (unknown ≠ none)', response.body['accounts'] === null && !Array.isArray(response.body['accounts']), JSON.stringify(response.body['accounts']))
  check('...and the reason is carried, so the card can say why', response.body['accountsError'] === 'credential scan failed', JSON.stringify(response.body['accountsError']))
}
{
  // 反面：真的扫过、真的没有别的账号 —— 空数组，且**不带**错误字段。这两种回答必须长得不一样，
  // 否则「区分两种情况」只是换了个字段名继续含糊。
  const response = await handleApi(get('/status'), deps({ accounts: async () => [] }))
  check('a scan that really found nothing -> [] with NO accountsError field', same(response.body['accounts'], []) && !('accountsError' in response.body), JSON.stringify(response.body))
}
{
  const response = await handleApi(get('/status'), deps())
  check('a healthy scan carries no accountsError field either', same(response.body['accounts'], ACCOUNTS) && !('accountsError' in response.body), JSON.stringify(response.body['accounts']))
}
{
  // 失败原因可以是任何东西，也可能是空的：错误字段必须永远是一句非空、有界的话。
  const bare = await handleApi(get('/status'), deps({ accounts: async () => { throw '磁盘读不了' } }))
  check('a non-Error rejection still yields a readable reason', bare.body['accounts'] === null && bare.body['accountsError'] === '磁盘读不了', JSON.stringify(bare.body['accountsError']))
  const blank = await handleApi(get('/status'), deps({ accounts: async () => { throw new Error('') } }))
  check('an empty message never leaves an empty reason', blank.body['accounts'] === null && String(blank.body['accountsError'] ?? '').length > 0, JSON.stringify(blank.body['accountsError']))
  const huge = await handleApi(get('/status'), deps({ accounts: async () => { throw new Error('x'.repeat(5000)) } }))
  check('a huge message is bounded, not echoed whole', huge.body['accounts'] === null && String(huge.body['accountsError']).length <= 200, `len=${String(huge.body['accountsError']).length}`)
}
{
  const withSlash = await handleApi(get('/status/'), deps())
  const empty = await handleApi(get(''), deps())
  check('trailing slash and empty path both mean /status', withSlash.body['modelCount'] === 7 && empty.body['modelCount'] === 7)
}
{
  // 清单第 7 条：`account: selected … not present` 原先只进 boot.log，用户看不到。
  // 现在它是 `/status` 的 `accountWarning` —— 「切换器记得的账号」与「实际出账的
  // 账号」不一致时，卡片必须说出来，否则用户只会看到一个安静的错账。
  const warning = '已选账号 deadbeef0000000000000001 在这台机器上不存在（本机可见 1 个），本次改用 desktop/cn'
  const response = await handleApi(get('/status'), deps({ accountWarning: () => warning }))
  check('a dropped account selection reaches the user as accountWarning', response.body['accountWarning'] === warning, JSON.stringify(response.body['accountWarning']))
  check('...on an otherwise healthy answer (ok:true, nothing else disturbed)', response.body['ok'] === true && response.body['modelCount'] === 7 && same(response.body['accounts'], ACCOUNTS))
  const none = await handleApi(get('/status'), deps())
  check('with no warning the field is ABSENT, not an empty string', !('accountWarning' in none.body), JSON.stringify(none.body['accountWarning']))
  const blank = await handleApi(get('/status'), deps({ accountWarning: () => '' }))
  check('an empty warning is no warning', !('accountWarning' in blank.body))
  const huge = await handleApi(get('/status'), deps({ accountWarning: () => 'w'.repeat(5000) }))
  check('a runaway warning is bounded, not echoed whole', typeof huge.body['accountWarning'] === 'string' && String(huge.body['accountWarning']).length <= 700, `len=${String(huge.body['accountWarning']).length}`)
  // 读的时机：`credential()` 是发现「选中的账号没了」的地方，所以这一项必须在两个
  // promise 之后读 —— 否则报出来的是上一轮的结论（第一次调用时是「没有警告」）。
  let inFlight = false
  const ordered = await handleApi(get('/status'), deps({
    credential: async () => { inFlight = true; return CREDENTIAL },
    accountWarning: () => (inFlight ? '凭据解析之后才成立的警告' : undefined)
  }))
  check('read AFTER credential() resolved (not before)', ordered.body['accountWarning'] === '凭据解析之后才成立的警告', JSON.stringify(ordered.body['accountWarning']))
}
{
  const response = await handleApi(get('/status'), deps({ models: () => { throw new Error('目录尚未就绪') } }))
  check('a throwing dep answers ok:false instead of throwing', response.status === 200 && response.body['ok'] === false && String(response.body['detail']).includes('目录尚未就绪'), JSON.stringify(response.body))
}
{
  // 失败分支的诊断形状（清单第 7 条）：凭据解析失败的那句话现在带着「探测过的候选表」，
  // 而它比账号扫描的原因长得多。上限仍然是上限 —— 只是不再短到把「没装」与「没登录」
  // 的区别切掉。
  const scanLine = '已探测 24 个候选（desktop/cn 存在 · desktop/sg 无 · cli/cn 无）；其中 1 个存在但都读不出凭据：…'
  const response = await handleApi(get('/status'), deps({ credential: async () => { throw new Error(scanLine) } }))
  check('a credential failure reaches the card with its candidate table intact', String(response.body['detail']).includes('已探测 24 个候选') && String(response.body['detail']).includes('desktop/cn 存在'), JSON.stringify(String(response.body['detail']).slice(0, 120)))
  const runaway = await handleApi(get('/status'), deps({ credential: async () => { throw new Error('x'.repeat(5000)) } }))
  check('...and a runaway reason is still bounded', response.body['ok'] === false && String(runaway.body['detail']).length <= 700, `len=${String(runaway.body['detail']).length}`)
}

// ------------------------------------------------------------------- 2. models
console.log('\n[2] GET /models')
{
  const response = await handleApi(get('/models'), deps())
  const models = response.body['models'] as Record<string, unknown>[]
  check('every model is listed in order', response.body['ok'] === true && models.length === 7 && models[0]?.['id'] === 'm1' && models[6]?.['id'] === 'm7')
  check('shape: absent capacities become null', same(models[2], { id: 'm3', name: 'Three', contextWindow: null, maxTokens: null, input: ['text'], directoryFunction: 'solo_agent_remote' }), JSON.stringify(models[2]))
  check('shape: present capacities survive', same(models[0], { id: 'm1', name: 'One', contextWindow: 1000, maxTokens: 100, input: ['text'], directoryFunction: 'solo_work_remote' }), JSON.stringify(models[0]))
  check('no reasoning/multimodal field leaks into the card payload', models.every((model) => !('reasoningEfforts' in model) && !('multimodal' in model)))
}

// ---------------------------------------------------------- 3. models/refresh
console.log('\n[3] POST /models/refresh')
{
  const response = await handleApi(post('/models/refresh'), deps())
  check('kind and modelCount are lifted to the top', response.body['kind'] === 'rebuilt' && response.body['modelCount'] === 7, JSON.stringify(response.body))
  check('the whole seed outcome is passed through', same(response.body['outcome'], REFRESH_OUTCOME), JSON.stringify(response.body['outcome']))
}

// ------------------------------------------------- 3b. models/reload (read-only)
console.log('\n[3b] POST /models/reload (read-only re-read)')
{
  // 「刷新目录」 = 重拉网关目录、换掉插件内存里的清单，**绝不写 profile**。证据不是这行
  // 注释，而是注进来的 `refresh`（唯一会 seed 的依赖）一次都没被调用 —— 下面每一条
  // 成功/失败断言都带着这个计数器。
  let refreshCalls = 0
  const response = await handleApi(post('/models/reload'), deps({
    reload: async () => ({ ok: true, modelCount: 79, attempts: RELOAD_ATTEMPTS }),
    refresh: async () => {
      refreshCalls += 1
      return { outcome: REFRESH_OUTCOME, modelCount: 7 }
    }
  }))
  check('ok:true with modelCount and the per-function attempts', response.body['ok'] === true && response.body['modelCount'] === 79 && same(response.body['attempts'], RELOAD_ATTEMPTS), JSON.stringify(response.body))
  check('...stamped with a time the card can print', typeof response.body['at'] === 'number' && (response.body['at'] as number) > 0, JSON.stringify(response.body['at']))
  check('🔴 ...and the WRITE path was never called (refresh = 0 calls)', refreshCalls === 0, `refreshCalls=${refreshCalls}`)
  check('...and no seed outcome is invented (kind/outcome belong to /models/refresh)', !('kind' in response.body) && !('outcome' in response.body), JSON.stringify(Object.keys(response.body)))
}
{
  // 拉取失败（没凭据 / 网关不答）：`{ok:false, detail}`，而且**不清空**现有清单。
  // 回答里没有 modelCount 是刻意的：一次没发生的重拉不许被读成「0 个模型」。
  const modelList: readonly TraeModel[] = MODELS
  let refreshCalls = 0
  const failing = {
    models: () => modelList,
    reload: async () => ({ ok: false, detail: '没有可用凭据 —— storage.json 读不出 token', modelCount: modelList.length, attempts: [] as DirectoryAttempt[] }),
    refresh: async () => {
      refreshCalls += 1
      return { outcome: REFRESH_OUTCOME, modelCount: 7 }
    }
  }
  const failed = await handleApi(post('/models/reload'), deps(failing))
  check('a failed re-read answers ok:false with the dep detail verbatim', failed.status === 200 && failed.body['ok'] === false && failed.body['detail'] === '没有可用凭据 —— storage.json 读不出 token', JSON.stringify(failed.body))
  check('...carrying NO modelCount, so a refusal cannot read as "0 models"', !('modelCount' in failed.body) && !('models' in failed.body), JSON.stringify(Object.keys(failed.body)))
  const listed = await handleApi(get('/models'), deps(failing))
  const stillThere = listed.body['models'] as Record<string, unknown>[]
  check('...and the existing list is still exactly what it was (not cleared)', stillThere.length === 7 && stillThere[0]?.['id'] === 'm1' && stillThere[6]?.['id'] === 'm7', `len=${stillThere.length}`)
  check('...and a FAILED reload never calls the write path either', refreshCalls === 0, `refreshCalls=${refreshCalls}`)
}
{
  // 空目录也是失败，不是「目录空了」：`fetchDirectoryModels` 返回 0 个模型时，索引.ts 的
  // reload 会保留原清单并给出每个 function 的失败原因（这条断言钉住 API 侧怎么转述它）。
  const empty = await handleApi(post('/models/reload'), deps({
    reload: async () => ({ ok: false, detail: '网关没有返回任何模型，保留原来的 7 个（solo_work_remote:500；chat_v3:upstream says no）', modelCount: 7, attempts: RELOAD_ATTEMPTS })
  }))
  check('an empty directory is a refusal that names every function, not a silent 0', empty.body['ok'] === false && String(empty.body['detail']).includes('solo_work_remote:500') && String(empty.body['detail']).includes('保留原来的 7 个'), JSON.stringify(empty.body))
}
{
  // 没有实现（CLI 组合里没注入）要直说，而不是崩；抛异常也不能逃出去。
  const noImpl = await handleApi(post('/models/reload'), deps({ reload: undefined }))
  check('a composition with no reload implementation says so instead of crashing', noImpl.status === 200 && noImpl.body['ok'] === false && String(noImpl.body['detail']).includes('只读端点未注入'), JSON.stringify(noImpl.body))
  const throwing = await handleApi(post('/models/reload'), deps({ reload: async () => { throw new Error('身份读不出来') } }))
  check('a throwing reload dep answers ok:false instead of throwing', throwing.status === 200 && throwing.body['ok'] === false && String(throwing.body['detail']).includes('身份读不出来'), JSON.stringify(throwing.body))
  const wrongMethod = await handleApi(get('/models/reload'), deps())
  check('GET /models/reload is not a route (it POSTs: it re-reads the gateway)', wrongMethod.status === 404 && wrongMethod.body['ok'] === false && String(wrongMethod.body['detail']).includes('no such route'), JSON.stringify(wrongMethod.body))
}

// --------------------------------- 3c. the injected implementation is the read-only one
//
// The route above can only be read-only if the implementation BEHIND it is. That
// implementation is a closure inside src/index.ts `run()`, which needs a real Trae
// credential to reach — so this half is proven by reading the shipped wiring as
// code (comments removed first, so a comment that NAMES the write path is not
// mistaken for a call to it) rather than by driving it.
console.log('\n[3c] src/index.ts wires /models/reload to a read-only implementation')
{
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const bodyOf = (name: string): string | undefined => {
    const head = source.indexOf(`async function ${name}(`)
    if (head < 0) return undefined
    const open = source.indexOf('{', head)
    if (open < 0) return undefined
    let depth = 0
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(open, index + 1)
      }
    }
    return undefined
  }
  const raw = bodyOf('reloadDirectory')
  const body = (raw ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  check('src/index.ts has a reloadDirectory implementation', body !== '')
  check('...that really re-reads the gateway directory', body.includes('fetchDirectoryModels'))
  check('...extracted to its end (the catch branch is in there)', body.includes('catch (error)') && body.length > 200 && body.length < 4000, `len=${body.length}`)
  for (const writePath of ['seedProvider', 'buildProviderProfile', 'writeState', 'settingsFace', 'refreshDirectory']) {
    check(`...and never reaches the write path (${writePath})`, !body.includes(writePath))
  }
  // …and the api deps must still hand the READ-ONLY one to `reload`: `refresh` is the
  // dep that seeds, so wiring them the other way round would silently restore the bug.
  check('...and the api deps inject it as `reload` (never the seeding refresh)', /reload:\s*reloadDirectory/.test(source) && /refresh:\s*refreshDirectory/.test(source))
}

// ------------------------------------------------------------------ 4. account
console.log('\n[4] POST /account')
{
  const missing = await handleApi(post('/account', {}), deps())
  check('missing accountId -> ok:false', missing.status === 200 && missing.body['ok'] === false && String(missing.body['detail']).includes('accountId'), JSON.stringify(missing.body))
  const blank = await handleApi(post('/account', { accountId: '' }), deps())
  check('blank accountId is refused too', blank.body['ok'] === false)
  let seen = ''
  const accepted = await handleApi(post('/account', { accountId: 'desktop/cn' }), deps({ selectAccount: async (accountId) => { seen = accountId; return { ok: true } } }))
  check('accepted switch names the active account', accepted.body['ok'] === true && accepted.body['active'] === 'desktop/cn' && seen === 'desktop/cn', JSON.stringify(accepted.body))
  const refused = await handleApi(post('/account', { accountId: 'cli/cn' }), deps())
  check('refused switch carries the dep detail', refused.body['ok'] === false && refused.body['detail'] === '凭据已过期', JSON.stringify(refused.body))
}

// -------------------------------------------------------------------- 5. usage
console.log('\n[5] GET /usage')
{
  const response = await handleApi(get('/usage'), deps({ credential: async () => ({ ...CREDENTIAL, region: 'ai', edition: 'ai' }) }))
  check('non-CN credential -> ok:false (CN-only)', response.body['ok'] === false && String(response.body['detail']).includes('CN-only'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => new Response('gateway exploded', { status: 502 }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('HTTP != 200 -> ok:false with the body excerpt', response.body['ok'] === false && String(response.body['detail']).includes('HTTP 502') && String(response.body['detail']).includes('gateway exploded'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: 3001, message: 'no entitlement' }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('business code != 0 -> ok:false naming the code', response.body['ok'] === false && String(response.body['detail']).includes('3001') && String(response.body['detail']).includes('no entitlement'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: '3001', message: 'no entitlement' }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('a numeric-string code "3001" is a refusal too, not silently 0', response.body['ok'] === false && String(response.body['detail']).includes('3001') && String(response.body['detail']).includes('no entitlement'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: '0', usage_summary: { credit_amount: 7 } }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('a numeric-string code "0" reads as success', response.body['ok'] === true && same(response.body['credits'], { 'usage_summary.credit_amount': 7 }), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: 'not-a-code', message: 'garbled envelope' }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('a code of an unknown shape -> ok:false, never a guessed success', response.body['ok'] === false && String(response.body['detail']).includes('not-a-code') && String(response.body['detail']).includes('cannot interpret'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: null, message: 'null code' }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('a null code is unreadable, not 0', response.body['ok'] === false && String(response.body['detail']).includes('null'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ usage_summary: { credit_amount: 3 } }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('an absent code field is not a refusal (this gateway omits it)', response.body['ok'] === true && same(response.body['credits'], { 'usage_summary.credit_amount': 3 }), JSON.stringify(response.body))
}
{
  const { impl, calls } = transport(() => json({ code: 0, usage_summary: { credit_amount: 12.5 }, user_entitlement_pack_list: [{ credits_amount: 100, expires_at: 1792000000 }] }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('success -> ok:true with the credited numbers', response.body['ok'] === true && response.body['region'] === 'cn' && same(response.body['credits'], { 'usage_summary.credit_amount': 12.5, 'user_entitlement_pack_list[0].credits_amount': 100 }), JSON.stringify(response.body['credits']))
  check('success carries the payload keys for diagnosis', same(response.body['payloadKeys'], ['code', 'usage_summary', 'user_entitlement_pack_list']))
  check('usage hits the CN pay gateway', calls[0]?.url === 'https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage' && JSON.parse(String(calls[0]?.init.body))['require_usage'] === true, calls[0]?.url)
}
{
  // 已修（后一批）：200 + 非 JSON 体（代理返回的 HTML）曾被读成 `credits: {}` —— 一条
  // 「成功、但一个额度字段都没有」的回答。体里没有信封，就只能报失败并给出体片段。
  const { impl } = transport(() => new Response('<!doctype html><html><body>proxy: no upstream</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('HTTP 200 with an HTML body -> ok:false with an excerpt, never credits:{}', response.body['ok'] === false && !('credits' in response.body) && String(response.body['detail']).includes('not a JSON object') && String(response.body['detail']).includes('proxy: no upstream'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => new Response('', { status: 200 }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('HTTP 200 with an empty body -> ok:false, the excerpt says so', response.body['ok'] === false && String(response.body['detail']).includes('not a JSON object') && String(response.body['detail']).includes('(empty body)'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => new Response('[{"credit_amount":5}]', { status: 200 }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('a JSON array is JSON but not an envelope -> ok:false', response.body['ok'] === false && String(response.body['detail']).includes('not a JSON object') && String(response.body['detail']).includes('credit_amount'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => new Response(`<html>${'x'.repeat(600)}</html>`, { status: 200 }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  const detail = String(response.body['detail'])
  check('the body excerpt is truncated, not the whole body', response.body['ok'] === false && detail.length > 100 && detail.length < 300, `detail.length=${detail.length}`)
}
{
  // 已修（最后一轮）：`post()` 以前先 `slice(0, 4096)` 再 `JSON.parse`，于是一个 6.1 KiB 的
  // 完整信封被从中间切断，`/usage` 回的是 "not a JSON object" —— 拿插件自己的截断去怪网关，
  // 顺带把合法的大信封判死。现在先解析全量，只对「错误摘录」截断。
  //
  // 信封体积由运行时拼出：6.1 KiB 的 message 加一个额度数字，总长 ~6.2 KiB（>4096）。
  const bigMessage = 'y'.repeat(6100)
  const bigBody = JSON.stringify({ code: 0, message: bigMessage, usage_summary: { credit_amount: 42 } })
  const { impl } = transport(() => new Response(bigBody, { status: 200 }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('a complete 6.1 KiB envelope (larger than the old 4096 slice) parses: ok:true', response.body['ok'] === true, JSON.stringify(response.body))
  check('...and its credited number is reported, not just an empty object', same(response.body['credits'], { 'usage_summary.credit_amount': 42 }) && same(response.body['payloadKeys'], ['code', 'message', 'usage_summary']), JSON.stringify(response.body))
  check('...and the 4 KiB panic wording is gone', !String(response.body['detail'] ?? '').includes('not a JSON object'))
}
{
  // 边界说明：4096 恰好是旧切点。4095 老代码也能过，4100 老代码必挂（JSON 在字符串中间断开），
  // 两条一起钉住「切点不再是解析输入」。
  const justUnder = JSON.stringify({ code: 0, message: 'z'.repeat(4020), usage_summary: { credit_amount: 7 } })
  const { impl } = transport(() => new Response(justUnder, { status: 200 }))
  const under = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('a body just under 4096 is read as before', under.body['ok'] === true && same(under.body['credits'], { 'usage_summary.credit_amount': 7 }), `len=${justUnder.length}`)
  const over4096 = JSON.stringify({ code: 0, message: 'z'.repeat(4100), usage_summary: { credit_amount: 8 } })
  const { impl: impl2 } = transport(() => new Response(over4096, { status: 200 }))
  const over = await handleApi(get('/usage'), deps({ fetchImpl: impl2 }))
  check('a body just over 4096 is read too (the four-KiB cut no longer decides)', over4096.length > 4096 && over.body['ok'] === true && same(over.body['credits'], { 'usage_summary.credit_amount': 8 }), `len=${over4096.length}`)
}
{
  // 内存上限仍然存在，但它是 1 MiB 的量级，而且**说自己是上限**，不再伪装成「体不是 JSON」。
  const huge = JSON.stringify({ code: 0, message: 'q'.repeat((1 << 20) + 64), usage_summary: { credit_amount: 1 } })
  const { impl } = transport(() => new Response(huge, { status: 200 }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  const detail = String(response.body['detail'])
  check('a body above the 1 MiB memory bound -> ok:false naming the bound, not a parse error', response.body['ok'] === false && !('credits' in response.body) && detail.includes('more than 1048576 characters') && !detail.includes('not a JSON object'), JSON.stringify(response.body))
  check('...and that refusal quotes only a bounded excerpt of it', detail.length < 400, `detail.length=${detail.length}`)
}
{
  // 上限只针对「非 JSON 体的摘录」：一个体积正常的合法大信封不许被说成解析失败。
  const { impl } = transport(() => new Response(JSON.stringify({ code: 0, usage_summary: { credit_amount: 5.5 }, note: 'n'.repeat(9000) }), { status: 200 }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  check('a 9 KiB valid object is a success, never "not a JSON object"', response.body['ok'] === true && same(response.body['credits'], { 'usage_summary.credit_amount': 5.5 }), JSON.stringify(response.body['credits']))
}
{
  // 非 JSON 的大体（例如 6 KiB 的代理页）仍要报失败，但摘录要有界 —— 截断只作用于摘录。
  const { impl } = transport(() => new Response(`<!doctype html><html>${'p'.repeat(6000)}</html>`, { status: 200 }))
  const response = await handleApi(get('/usage'), deps({ fetchImpl: impl }))
  const detail = String(response.body['detail'])
  check('a 6 KiB HTML body is still refused, with a bounded excerpt (not the whole body)', response.body['ok'] === false && detail.includes('not a JSON object') && detail.length < 300, `detail.length=${detail.length}`)
}

// ------------------------------------------------------------------ 6. checkin
console.log('\n[6] /checkin')
{
  const { impl, calls } = transport(() => json({ checked_in: true, did_checked_in: false, credits: 100, enable: true }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('GET reports the server\'s own answer', same(response.body, { ok: true, checkedIn: true, didCheckedIn: false, credits: 100, enabled: true }), JSON.stringify(response.body))
  check('GET carries x-device-id', ((calls[0]?.init.headers ?? {}) as Record<string, string>)['x-device-id'] === 'device-1')
}
{
  const { impl } = transport((url) => (url.endsWith('/claim') ? json({ code: 0, message: 'ok' }) : json({ checked_in: false })))
  const response = await handleApi(post('/checkin'), deps({ fetchImpl: impl }))
  check('POST claim success -> claimed:true', response.body['ok'] === true && response.body['claimed'] === true && response.body['code'] === 0, JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: 9004, message: 'already claimed today' }))
  const response = await handleApi(post('/checkin'), deps({ fetchImpl: impl }))
  check('business refusal (9004) reads as claimed:false, not an error', response.body['ok'] === true && response.body['claimed'] === false && response.body['code'] === 9004 && String(response.body['message']).includes('already claimed'), JSON.stringify(response.body))
}
{
  // 已修（后一批）：POST 用的是 `typeof code === 'number' ? code : 0`，于是字符串形式
  // 的业务码全被读成 0 —— 上游说「今天已领过」，卡片读到的是「领取成功」。
  const { impl } = transport(() => json({ code: '9004', message: 'already claimed today' }))
  const response = await handleApi(post('/checkin'), deps({ fetchImpl: impl }))
  check('the same refusal spelled "9004" is claimed:false, not a fresh claim', response.body['ok'] === true && response.body['claimed'] === false && response.body['code'] === 9004 && String(response.body['message']).includes('already claimed'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: '0', message: 'granted' }))
  const response = await handleApi(post('/checkin'), deps({ fetchImpl: impl }))
  check('a success spelled "0" is claimed:true with code 0', response.body['ok'] === true && response.body['claimed'] === true && response.body['code'] === 0, JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: 'garbled', message: 'shape we do not know' }))
  const response = await handleApi(post('/checkin'), deps({ fetchImpl: impl }))
  check('POST claim with an unreadable code -> ok:false, never claimed:true', response.body['ok'] === false && !('claimed' in response.body) && String(response.body['detail']).includes('garbled') && String(response.body['detail']).includes('cannot interpret'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: null, message: 'null code' }))
  const response = await handleApi(post('/checkin'), deps({ fetchImpl: impl }))
  check('POST claim with code:null -> ok:false, not claimed:true', response.body['ok'] === false && !('claimed' in response.body) && String(response.body['detail']).includes('null'), JSON.stringify(response.body))
}
{
  // 这条路由没有第二个字段可以读出结果：没有 code 就没有任何「领取成功」的证据。
  const { impl } = transport(() => json({ message: 'no code at all' }))
  const response = await handleApi(post('/checkin'), deps({ fetchImpl: impl }))
  check('POST claim with no code -> ok:false, the outcome is unknown', response.body['ok'] === false && !('claimed' in response.body) && String(response.body['detail']).includes('no business code'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => new Response('boom', { status: 500 }))
  const response = await handleApi(post('/checkin'), deps({ fetchImpl: impl }))
  check('claim HTTP failure -> ok:false', response.body['ok'] === false && String(response.body['detail']).includes('HTTP 500'), JSON.stringify(response.body))
}
{
  // 已修 2026-10-14：GET 现在与 POST 同一口径检查业务 code —— 非零 code（数字或
  // 数字字符串）是被拒绝，不再被读成"今天没签到"。这条断言原先记录的就是旧行为，
  // 现在翻面。
  const { impl } = transport(() => json({ code: 9004, message: 'not enabled for this account' }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('GET business refusal (9004) -> ok:false naming code and message', response.body['ok'] === false && String(response.body['detail']).includes('9004') && String(response.body['detail']).includes('not enabled for this account'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: '9004', message: 'already claimed today' }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('GET catches a refusal spelled as a numeric string too', response.body['ok'] === false && String(response.body['detail']).includes('9004') && String(response.body['detail']).includes('already claimed today'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ code: 'garbled', message: 'shape we do not know' }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('GET with an unreadable code -> ok:false, not "not checked in today"', response.body['ok'] === false && String(response.body['detail']).includes('garbled'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ checked_in: false, did_checked_in: false, enable: false }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('a missing credits field stays absent (no fabricated 0)', same(response.body, { ok: true, checkedIn: false, didCheckedIn: false, enabled: false }), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => json({ checked_in: true, credits: null }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('credits:null is not turned into 0 either', response.body['ok'] === true && response.body['checkedIn'] === true && !('credits' in response.body), JSON.stringify(response.body))
}
{
  // 已修（最后一轮）：GET /checkin 与 /usage 同一口径 —— HTTP 200 + 非 JSON 对象体
  // （代理的 HTML 页、空体、裸数组）不是签到状态答案。以前 `payload` 会是 `{}`，
  // `checked_in`/`did_checked_in` 都缺席，于是回 `{ok:true, checkedIn:false, ...}`：
  // 一张代理页被读成「这个账号今天没签到」—— 一条关于账号状态的假事实。
  const proxyPage = '<!doctype html><html><body>proxy: no upstream</body></html>'
  const { impl } = transport(() => new Response(proxyPage, { status: 200, headers: { 'Content-Type': 'text/html' } }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('GET with an HTML proxy page -> ok:false, never checkedIn:false', response.body['ok'] === false && !('checkedIn' in response.body) && !('didCheckedIn' in response.body), JSON.stringify(response.body))
  check('...naming the cause and quoting the page', String(response.body['detail']).includes('not a JSON object') && String(response.body['detail']).includes('proxy: no upstream'), JSON.stringify(response.body))
  check('...and never claiming the account is enabled either', !('enabled' in response.body))
}
{
  const { impl } = transport(() => new Response('', { status: 200 }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('GET with an empty body -> ok:false, the excerpt says (empty body)', response.body['ok'] === false && String(response.body['detail']).includes('not a JSON object') && String(response.body['detail']).includes('(empty body)'), JSON.stringify(response.body))
}
{
  const { impl } = transport(() => new Response('[{"checked_in":true}]', { status: 200 }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('GET with a JSON array -> ok:false too (JSON, but not an envelope)', response.body['ok'] === false && String(response.body['detail']).includes('not a JSON object') && String(response.body['detail']).includes('checked_in'), JSON.stringify(response.body))
}
{
  // 反面：这不是「体里没有 code 就判失败」。无 code 的正常状态响应仍然成功 —— 否则就把
  // 同事刚修好的那条（缺 code 不算拒绝）又推翻回去了。
  const { impl } = transport(() => json({ checked_in: true, did_checked_in: false, credits: 30, enable: true }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  check('a code-less but well-formed status answer is still a success', same(response.body, { ok: true, checkedIn: true, didCheckedIn: false, credits: 30, enabled: true }), JSON.stringify(response.body))
  const { impl: impl2 } = transport(() => json({ checked_in: false, did_checked_in: false }))
  const plain = await handleApi(get('/checkin'), deps({ fetchImpl: impl2 }))
  check('a code-less "not yet checked in" is still read as such, not as a failure', plain.body['ok'] === true && plain.body['checkedIn'] === false && plain.body['enabled'] === true, JSON.stringify(plain.body))
}
{
  // 大代理页：非 JSON 仍失败，摘录有界（截断只作用于摘录）。
  const { impl } = transport(() => new Response(`<html>${'x'.repeat(6000)}</html>`, { status: 200 }))
  const response = await handleApi(get('/checkin'), deps({ fetchImpl: impl }))
  const detail = String(response.body['detail'])
  check('GET with a 6 KiB HTML body -> ok:false with a bounded excerpt', response.body['ok'] === false && detail.includes('not a JSON object') && detail.length < 300, `detail.length=${detail.length}`)
}
{
  const response = await handleApi({ method: 'PUT', path: '/checkin' }, deps())
  check('PUT /checkin -> 405 with ok:false', response.status === 405 && response.body['ok'] === false, JSON.stringify(response.body))
}
{
  const response = await handleApi(get('/checkin'), deps({ credential: async () => ({ ...CREDENTIAL, region: 'ai', edition: 'ai' }) }))
  check('non-CN -> ok:false (CN-only)', response.body['ok'] === false && String(response.body['detail']).includes('CN-only'))
}

// --------------------------------------------------------------- 7. models/test
console.log('\n[7] POST /models/test')
{
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const response = await handleApi(post('/models/test', {}), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('no modelIds -> the first five are probed', response.body['tested'] === 5 && results.length === 5 && results.map((r) => r['id']).join(',') === 'm1,m2,m3,m4,m5', results.map((r) => r['id']).join(','))
  check('HTTP 200 with a clean stream -> available', results.every((r) => r['verdict'] === 'available' && r['detail'] === 'answered 200'))
  check('the probe sends a real chat request, not a generation', calls.every((call) => call.url.endsWith('/api/agent/v3/llm_utils_chat') && JSON.parse(String(call.init.body))['stream'] === true))
}
{
  // 已修（后一批）：200 是「HTTP 说成功了」，不是「模型答了」。空体 / 只有心跳的流曾被
  // 判成 available —— 那是调用方唯一会照着行动的结论，却发给了什么都没说的回答。
  const { impl } = transport(() => new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
  const response = await handleApi(post('/models/test', { modelIds: ['m1'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('HTTP 200 with an empty stream -> inconclusive, not available', results[0]?.['verdict'] === 'inconclusive' && String(results[0]?.['detail']).includes('no event this plugin recognises'), JSON.stringify(results[0]))
}
{
  const { impl } = transport(() => sse(streaming('event: progress_notice\ndata: {"notice":"still working"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m2'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('a keep-alive-only stream -> inconclusive too', results[0]?.['verdict'] === 'inconclusive' && String(results[0]?.['detail']).includes('keep-alives'), JSON.stringify(results[0]))
}
{
  const { impl } = transport(() => sse(streaming('event: token_usage\ndata: {"prompt_tokens":3,"completion_tokens":0}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m3'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('usage without any output event -> inconclusive', results[0]?.['verdict'] === 'inconclusive', JSON.stringify(results[0]))
}
{
  const { impl } = transport(() => sse(streaming('data: [DONE]\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m4'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('a bare [DONE] is a recognised end -> available', results[0]?.['verdict'] === 'available' && results[0]?.['detail'] === 'answered 200', JSON.stringify(results[0]))
}
{
  // 同一类假可用：流里的 error 事件若不带 code，`classifyProbeStatus(200, undefined)`
  // 会把它读成一次干净的 200。
  const { impl } = transport(() => sse(streaming('event: error\ndata: {"message":"upstream hiccup"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m5'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('an in-stream error with no code -> inconclusive, not available', results[0]?.['verdict'] === 'inconclusive' && String(results[0]?.['detail']).includes('without a code'), JSON.stringify(results[0]))
}
{
  const { impl } = transport(() => sse(streaming('event: error\ndata: {"code":1005,"message":"need plan"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m1'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('in-stream 1005 -> needs-plan', response.body['tested'] === 1 && results[0]?.['verdict'] === 'needs-plan', JSON.stringify(results[0]))
}
{
  const { impl } = transport(() => sse(streaming('event: output\ndata: {"code":4001,"message":"param is invalid"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m2'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('bare code 4001 -> not-served', results[0]?.['verdict'] === 'not-served', JSON.stringify(results[0]))
}
{
  const { impl } = transport(() => new Response('slow down', { status: 429 }))
  const response = await handleApi(post('/models/test', { modelIds: ['m1', 'm2'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('HTTP 429 -> rate-limited', response.body['tested'] === 2 && results.every((r) => r['verdict'] === 'rate-limited'))
}
{
  const { impl } = transport(() => new Response('nope', { status: 401 }))
  const response = await handleApi(post('/models/test', { modelIds: ['m3'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('HTTP 401 -> auth-rejected', results[0]?.['verdict'] === 'auth-rejected' && results[0]?.['detail'] === 'HTTP 401', JSON.stringify(results[0]))
}
{
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m6', 'nope'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('explicit modelIds selects exactly those that exist', response.body['tested'] === 1 && results[0]?.['id'] === 'm6' && calls.length === 1)
  const none = await handleApi(post('/models/test', { modelIds: ['ghost'] }), deps({ fetchImpl: impl }))
  check('no id matched -> ok:false', none.body['ok'] === false && String(none.body['detail']).includes('no model matched'), JSON.stringify(none.body))
}
{
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m6', 'm1', 'm3'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('explicit modelIds come back in REQUEST order, not directory order', response.body['tested'] === 3 && results.map((r) => r['id']).join(',') === 'm6,m1,m3' && calls.length === 3, results.map((r) => r['id']).join(','))
}
{
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['m2', 'ghost', 'm2', 'm2'] }), deps({ fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('a repeated id is probed once, unknown ids still dropped', response.body['tested'] === 1 && results[0]?.['id'] === 'm2' && calls.length === 1, `${results.map((r) => r['id']).join(',')} calls=${calls.length}`)
}
{
  // 已修（这一轮）：显式 modelIds 没有上限 —— 79 个 id 就是 79 次真实探针（串行、每次 30s
  // 超时、每次都花额度）。现在最多探前 10 个，并且把「被截断」明写在回答里。
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: MANY_MODELS.map((model) => model.id) }), deps({ models: () => MANY_MODELS, fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('79 requested ids -> exactly 10 real probes, not 79', calls.length === 10 && response.body['tested'] === 10 && results.length === 10, `calls=${calls.length} tested=${String(response.body['tested'])}`)
  check('...the answer states how many were asked for', response.body['requested'] === 79, JSON.stringify(response.body['requested']))
  check('...and says out loud that it was truncated', response.body['truncated'] === true, JSON.stringify(response.body['truncated']))
  check('...probing the FIRST ten, in request order', results.map((r) => r['id']).join(',') === MANY_MODELS.slice(0, 10).map((model) => model.id).join(','), results.map((r) => r['id']).join(','))
}
{
  // 边界两侧各钉一条：上限是 10（恰好 10 个不算截断，11 个才算），免得以后被顺手改成 9 或 12。
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const ten = await handleApi(post('/models/test', { modelIds: MANY_MODELS.slice(0, 10).map((model) => model.id) }), deps({ models: () => MANY_MODELS, fetchImpl: impl }))
  check('exactly ten ids -> ten probes, requested 10, NOT truncated', ten.body['requested'] === 10 && ten.body['tested'] === 10 && ten.body['truncated'] === false && calls.length === 10, JSON.stringify({ requested: ten.body['requested'], tested: ten.body['tested'], truncated: ten.body['truncated'] }))
  const { impl: impl2, calls: calls2 } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const eleven = await handleApi(post('/models/test', { modelIds: MANY_MODELS.slice(0, 11).map((model) => model.id) }), deps({ models: () => MANY_MODELS, fetchImpl: impl2 }))
  check('eleven ids -> ten probes, requested 11, truncated', eleven.body['requested'] === 11 && eleven.body['tested'] === 10 && eleven.body['truncated'] === true && calls2.length === 10, JSON.stringify({ requested: eleven.body['requested'], tested: eleven.body['tested'], truncated: eleven.body['truncated'] }))
}
{
  // 默认路径（不传 modelIds）保持原样：前 5 条，而且不该被说成截断 —— 上限不能顺手改掉默认行为。
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const response = await handleApi(post('/models/test', {}), deps({ models: () => MANY_MODELS, fetchImpl: impl }))
  const results = response.body['results'] as Record<string, unknown>[]
  check('no modelIds still probes the first five (default unchanged)', calls.length === 5 && response.body['tested'] === 5 && results.map((r) => r['id']).join(',') === MANY_MODELS.slice(0, 5).map((model) => model.id).join(','), results.map((r) => r['id']).join(','))
  check('...and a five-model default is not called truncated', response.body['requested'] === 5 && response.body['truncated'] === false, JSON.stringify({ requested: response.body['requested'], truncated: response.body['truncated'] }))
}
{
  // `requested` 数的是「匹配到的不同 id」—— 正是上限作用的那份列表，所以未知 id 和重复 id 不会
  // 把它撑大：`requested > tested` 只可能是截断，不可能被垃圾输入伪造出来。
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const response = await handleApi(post('/models/test', { modelIds: ['x01', 'ghost', 'x01', 'x02'] }), deps({ models: () => MANY_MODELS, fetchImpl: impl }))
  check('unknown and repeated ids never inflate requested (so > tested means truncation)', response.body['requested'] === 2 && response.body['tested'] === 2 && response.body['truncated'] === false && calls.length === 2, JSON.stringify(response.body))
}
{
  // 截断不改变既有的失败语义：一个都没匹配上仍然是 ok:false，而不是「requested:0, tested:0」。
  const { impl, calls } = transport(() => sse(streaming('event: output\ndata: {"response":"pong"}\n\n')))
  const ghosts = Array.from({ length: 30 }, (_, index) => `ghost${index}`)
  const none = await handleApi(post('/models/test', { modelIds: ghosts }), deps({ models: () => MANY_MODELS, fetchImpl: impl }))
  check('30 unknown ids -> ok:false with ZERO probes, never a fabricated answer', none.body['ok'] === false && String(none.body['detail']).includes('no model matched') && calls.length === 0 && !('results' in none.body), JSON.stringify(none.body))
}

// ----------------------------------------------------------------- 8. routing
console.log('\n[8] routing and containment')
{
  const unknown = await handleApi(get('/nope'), deps())
  check('unknown route -> 404 with ok:false', unknown.status === 404 && unknown.body['ok'] === false && String(unknown.body['detail']).includes('no such route'), JSON.stringify(unknown.body))
  const wrongMethod = await handleApi(post('/status'), deps())
  check('wrong method falls through to 404', wrongMethod.status === 404 && wrongMethod.body['ok'] === false)
  const badBody = await handleApi({ method: 'POST', path: '/account', body: 'not-an-object' }, deps())
  check('a non-object body does not throw', badBody.body['ok'] === false && String(badBody.body['detail']).includes('accountId'), JSON.stringify(badBody.body))
}

globalThis.fetch = globalFetch

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}  (${passed}/${passed + failures})`)
process.exit(failures === 0 ? 0 : 1)

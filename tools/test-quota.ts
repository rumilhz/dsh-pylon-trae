/**
 * The `traeQuota` Cordis service + the shared quota reading — OFFLINE.
 *
 * Everything here runs against a self-made `fetchImpl`: no gateway, no credential
 * file, no clock, no real network. That is not a convenience — the point of the
 * suite is that the LOGIC (status mapping, rounding, caching) is pinned by
 * assertions, so a later change cannot quietly turn "read failed" into "ok".
 *
 * The contract this suite defends (委托方给定，字段名一字不能改):
 *
 *   QuotaSnapshot = { status, message?, fetchedAt?, source?, windows? }
 *   status: 'ok' 有数据 · 'off' 通道没启用/没配置 · 'error' 读失败
 *   window.percent 是【已用】百分比 0–100；limit<=0 时不给 percent，绝不除零
 *
 * and the service discipline:
 *   · getQuota() is SYNCHRONOUS, cached, NEVER touches the network, never throws;
 *   · refresh() is the only read path, forces a pull, never throws;
 *   · an expired cache is still served (with its honest fetchedAt) — expiry never
 *     triggers a request by itself.
 *
 * Run:  <dsh-node> tools/test-quota.ts        exit 0 = every check passed
 */
import type { TraeCredential } from '../src/auth.ts'
import type { TraeIdentity } from '../src/identity.ts'
import {
  createQuotaService,
  fetchQuotaSnapshot,
  QUOTA_CACHE_TTL_MS,
  QUOTA_TOTAL_LABEL,
  QUOTA_USAGE_PATH,
  readQuota,
  type QuotaDeps,
  type QuotaSnapshot
} from '../src/quota.ts'

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

// ------------------------------------------------------------------- fixtures
const CREDENTIAL = {
  id: 'test-cn',
  edition: 'cn',
  region: 'cn',
  source: 'own',
  storagePath: '',
  userId: '0',
  host: '',
  expiresAtMs: 0,
  accessToken: 'test-token'
} as TraeCredential

const IDENTITY = { edition: 'cn', machineId: 'test-machine', deviceId: 'test-device', appVersion: '0.0.0' } as TraeIdentity

/** The real CN payload shape measured on a device (values verbatim). */
const REAL_PAYLOAD = {
  code: 0,
  usage_summary: { consumed_amount: 0.01, total_amount: 4600 },
  user_entitlement_pack_list: [{ credits_amount: 4600, expire_time: 1792000000 }]
}

interface Call {
  url: string
  init: RequestInit
}

/** A fake transport that records every call. */
function transport(answer: () => Response): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    return await answer()
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** A transport that fails the suite if anyone calls it (for "must not fetch" checks). */
function forbiddenTransport(): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    throw new Error('test-quota: a real network call was attempted on a read-only path')
  }) as unknown as typeof fetch
  return { impl, calls }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

function deps(overrides: Partial<QuotaDeps> = {}): QuotaDeps {
  return {
    credential: async () => CREDENTIAL,
    identity: async () => IDENTITY,
    fetchImpl: transport(() => json(REAL_PAYLOAD)).impl,
    ...overrides
  }
}

/** Top-level / nested key sets — the contract's "同形状" check needs the raw keys. */
const TOP_LEVEL_KEYS = ['status', 'message', 'fetchedAt', 'source', 'windows']
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly', 'total']
function onlyKnownKeys(snapshot: QuotaSnapshot): boolean {
  const top = Object.keys(snapshot).every((key) => TOP_LEVEL_KEYS.includes(key))
  const windows = snapshot.windows === undefined ? true : Object.keys(snapshot.windows).every((key) => WINDOW_KEYS.includes(key))
  const windowFields = snapshot.windows === undefined
    ? true
    : Object.values(snapshot.windows).every(
        (window) => window === undefined || Object.keys(window).every((key) => ['percent', 'used', 'limit', 'resetsAt', 'label'].includes(key))
      )
  return top && windows && windowFields
}

// ------------------------------------------------- 1. ok: the mapping rules
console.log('\n[1] ok — the real CN payload maps to windows.total')
{
  const { impl, calls } = transport(() => json(REAL_PAYLOAD))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("status is 'ok'", snapshot.status === 'ok', snapshot.status)
  check('source is trae', snapshot.source === 'trae', String(snapshot.source))
  check('fetchedAt is a number', typeof snapshot.fetchedAt === 'number' && Number.isFinite(snapshot.fetchedAt))
  check('windows has ONLY the total window (credit channel)', same(Object.keys(snapshot.windows ?? {}), ['total']), JSON.stringify(snapshot.windows))
  const total = snapshot.windows?.['total']
  check('used = usage_summary.consumed_amount (0.01)', total?.used === 0.01, String(total?.used))
  check('limit = usage_summary.total_amount (4600)', total?.limit === 4600, String(total?.limit))
  check('label is 积分（总额）', total?.label === QUOTA_TOTAL_LABEL && total?.label === '积分（总额）', String(total?.label))
  // 0.01 / 4600 * 100 = 0.000217… -> two decimals -> 0. The point is FINITE and rounded,
  // not a fraction with 12 digits.
  check('percent is the USED percentage, rounded to 2 decimals (0 here)', total?.percent === 0 && Number.isFinite(total?.percent), String(total?.percent))
  check('resetsAt came from the pack expire_time (seconds -> ms)', total?.resetsAt === 1792000000000, String(total?.resetsAt))
  check('the call went to the CN pay gateway', calls[0]?.url === `https://api.trae.cn${QUOTA_USAGE_PATH}`, calls[0]?.url)
  check('...with require_usage: true', JSON.parse(String(calls[0]?.init.body))['require_usage'] === true, String(calls[0]?.init.body))
  check('every key belongs to the contract shape', onlyKnownKeys(snapshot), JSON.stringify(snapshot))
}
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 1, total_amount: 3 } }))
  const total = (await fetchQuotaSnapshot(deps({ fetchImpl: impl }))).windows?.['total']
  check('1/3 -> 33.33 (two decimals, not 33.3333333333)', total?.percent === 33.33, String(total?.percent))
}
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 2, total_amount: 3 } }))
  const total = (await fetchQuotaSnapshot(deps({ fetchImpl: impl }))).windows?.['total']
  check('2/3 -> 66.67 (rounds up)', total?.percent === 66.67, String(total?.percent))
}

// --------------------------------------------- 2. limit <= 0: never divide
console.log('\n[2] limit = 0 / missing -> used+limit only, NEVER a division')
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 12, total_amount: 0 } }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  const total = snapshot.windows?.['total']
  check("status stays 'ok' (there ARE numbers)", snapshot.status === 'ok', snapshot.status)
  check('limit = 0 is reported as the fact it is', total?.limit === 0, String(total?.limit))
  check('used is reported', total?.used === 12, String(total?.used))
  check('percent is ABSENT (no divide by zero)', total !== undefined && !('percent' in total), JSON.stringify(total))
  check('...and nothing became NaN/Infinity', JSON.stringify(snapshot).includes('NaN') === false && JSON.stringify(snapshot).includes('Infinity') === false)
}
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 5 } }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("used without limit -> 'ok' with used only", snapshot.status === 'ok' && snapshot.windows?.['total']?.used === 5, JSON.stringify(snapshot.windows))
  check('...and no percent', snapshot.windows?.['total'] !== undefined && !('percent' in snapshot.windows['total']))
}
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { total_amount: 100 } }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("limit without used -> 'ok' with limit only", snapshot.status === 'ok' && snapshot.windows?.['total']?.limit === 100, JSON.stringify(snapshot.windows))
  check('...and no percent', snapshot.windows?.['total'] !== undefined && !('percent' in snapshot.windows['total']))
}

// -------------------------------------- 3. resetsAt: only when really there
console.log('\n[3] resetsAt — written only when the payload really carries it')
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 1, total_amount: 10 } }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check('no pack -> no resetsAt at all', snapshot.windows?.['total'] !== undefined && !('resetsAt' in snapshot.windows['total']), JSON.stringify(snapshot.windows))
}
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 1, total_amount: 10 }, user_entitlement_pack_list: [{ expire_time: 0 }] }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check('expire_time 0 -> no resetsAt (epoch 0 is not an expiry)', snapshot.windows?.['total'] !== undefined && !('resetsAt' in snapshot.windows['total']))
}
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 1, total_amount: 10 }, user_entitlement_pack_list: [{ expire_time: 1792000000000 }] }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check('a value already in ms is kept as-is', snapshot.windows?.['total']?.resetsAt === 1792000000000, String(snapshot.windows?.['total']?.resetsAt))
}
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 1, total_amount: 10 }, user_entitlement_pack_list: [{ expire_time: 2000000000 }, { expire_time: 1792000000 }] }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check('several packs -> the EARLIEST expiry (the next change)', snapshot.windows?.['total']?.resetsAt === 1792000000000, String(snapshot.windows?.['total']?.resetsAt))
}

// -------------------------------------------------------------- 4. off cases
console.log('\n[4] off — the precondition is missing')
{
  const forbidden = forbiddenTransport()
  const snapshot = await fetchQuotaSnapshot(deps({ credential: async () => { throw new Error('Trae 未安装或未登录') }, fetchImpl: forbidden.impl }))
  check("no credential -> 'off'", snapshot.status === 'off', snapshot.status)
  check('...message names the reason', typeof snapshot.message === 'string' && snapshot.message.includes('Trae 未安装或未登录'), String(snapshot.message))
  check('...no windows on a non-ok answer', snapshot.windows === undefined)
  check('...and the network was NOT touched', forbidden.calls.length === 0, `calls=${forbidden.calls.length}`)
}
{
  const forbidden = forbiddenTransport()
  const snapshot = await fetchQuotaSnapshot(
    deps({ credential: async () => ({ ...CREDENTIAL, region: 'ai', edition: 'ai' } as TraeCredential), fetchImpl: forbidden.impl })
  )
  check("non-CN region -> 'off'", snapshot.status === 'off', snapshot.status)
  check('...message says CN-only', typeof snapshot.message === 'string' && snapshot.message.includes('CN-only'), String(snapshot.message))
  check('...and no request was sent to the international gateway', forbidden.calls.length === 0)
}
{
  const snapshot = await fetchQuotaSnapshot(deps({ identity: async () => { throw new Error('身份文件读不出来') } }))
  check("identity failure with a credential -> 'error' (not 'off')", snapshot.status === 'error', snapshot.status)
  check('...with a message', typeof snapshot.message === 'string' && snapshot.message !== '')
}

// ------------------------------------------------------------ 5. error cases
console.log('\n[5] error — a credential exists and the read really failed')
{
  const { impl } = transport(() => new Response('gateway exploded', { status: 500 }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("HTTP 500 -> 'error'", snapshot.status === 'error', snapshot.status)
  check('...message names the HTTP status', typeof snapshot.message === 'string' && snapshot.message.includes('500'), String(snapshot.message))
  check('...message does NOT paste the raw body', typeof snapshot.message === 'string' && !snapshot.message.includes('gateway exploded'), String(snapshot.message))
  check('...and still carries fetchedAt + source', typeof snapshot.fetchedAt === 'number' && snapshot.source === 'trae')
}
{
  const { impl } = transport(() => json({ code: 3001, message: 'no entitlement' }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("business code != 0 -> 'error'", snapshot.status === 'error', snapshot.status)
  check('...message names the code', typeof snapshot.message === 'string' && snapshot.message.includes('3001'), String(snapshot.message))
}
{
  const { impl } = transport(() => json({ code: '3001', message: 'no entitlement' }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("numeric-string code '3001' is a refusal too", snapshot.status === 'error' && String(snapshot.message).includes('3001'), String(snapshot.message))
}
{
  const { impl } = transport(() => new Response('<!doctype html><html>proxy</html>', { status: 200 }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("HTTP 200 + non-JSON -> 'error', never ok", snapshot.status === 'error', snapshot.status)
  check('...message says it is not JSON', typeof snapshot.message === 'string' && snapshot.message.includes('JSON'), String(snapshot.message))
}
{
  const { impl } = transport(() => json({ code: 0, note: 'nothing numeric here' }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("readable envelope but NO amount -> 'error' (ok would be a lie)", snapshot.status === 'error', snapshot.status)
  check('...message says no number was readable', typeof snapshot.message === 'string' && snapshot.message.includes('数字'), String(snapshot.message))
}
{
  const throwing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: throwing }))
  check("fetch throws -> 'error'", snapshot.status === 'error', snapshot.status)
  check('...message carries the reason', typeof snapshot.message === 'string' && snapshot.message.includes('network down'), String(snapshot.message))
}
{
  // 一个 payload 里只有字符串数字（不是数字）—— extractNumbers 不认，必须 error。
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: '0.01', total_amount: '4600' } }))
  const snapshot = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  check("string amounts are NOT silently parsed -> 'error'", snapshot.status === 'error', snapshot.status)
}

// ------------------------------------- 6. /usage shares the same reading
console.log('\n[6] readQuota — the reading /usage reuses (one implementation)')
{
  const { impl } = transport(() => json({ code: '0', usage_summary: { credit_amount: 7 } }))
  const reading = await readQuota(deps({ fetchImpl: impl }))
  check('readable envelope -> read.ok true', reading.ok === true)
  check('...the legacy credits map uses the gateway field names', same(reading.credits, { 'usage_summary.credit_amount': 7 }), JSON.stringify(reading.credits))
  check('...payloadKeys is present for the diagnostic line', same(reading.payloadKeys, ['code', 'usage_summary']), JSON.stringify(reading.payloadKeys))
  check('...but the snapshot is error: no amount -> no ok', reading.snapshot.status === 'error', reading.snapshot.status)
}
{
  const { impl } = transport(() => new Response('gateway exploded', { status: 502 }))
  const reading = await readQuota(deps({ fetchImpl: impl }))
  check('HTTP failure -> read.ok false', reading.ok === false)
  check('...legacy detail keeps the HTTP status and excerpt', typeof reading.detail === 'string' && reading.detail.includes('HTTP 502') && reading.detail.includes('gateway exploded'), String(reading.detail))
}
{
  const { impl } = transport(() => new Response('', { status: 200 }))
  const reading = await readQuota(deps({ fetchImpl: impl }))
  check('empty body -> read.ok false with the legacy wording', reading.ok === false && String(reading.detail).includes('not a JSON object') && String(reading.detail).includes('(empty body)'), String(reading.detail))
}
{
  const { impl } = transport(() => json({ code: 0, usage_summary: { consumed_amount: 1, total_amount: 4 } }))
  const reading = await readQuota(deps({ fetchImpl: impl }))
  check('a real read is ok for BOTH consumers', reading.ok === true && reading.snapshot.status === 'ok', `${reading.ok}/${reading.snapshot.status}`)
}

// ------------------------------------------------------------- 7. the service
console.log('\n[7] getQuota() — sync, cached, never network, never throws')
{
  const forbidden = forbiddenTransport()
  const service = createQuotaService(deps({ fetchImpl: forbidden.impl }))
  const before = service.getQuota()
  check('before any fill: an object, status != ok', typeof before === 'object' && before.status !== 'ok', JSON.stringify(before))
  check('...and it did not fetch', forbidden.calls.length === 0, `calls=${forbidden.calls.length}`)
  // A fetch that throws on its FIRST call: getQuota must still be an object.
  const service2 = createQuotaService(deps({ fetchImpl: (async () => { throw new Error('boom') }) as unknown as typeof fetch }))
  void service2.refresh?.()
  const after = service2.getQuota()
  check('a throwing transport cannot make getQuota throw', typeof after === 'object' && after.status !== 'ok', JSON.stringify(after))
}
{
  let clock = 1_000
  const { impl, calls } = transport(() => json(REAL_PAYLOAD))
  const service = createQuotaService(deps({ fetchImpl: impl }), { now: () => clock })
  await service.refresh?.()
  check('refresh() really hit the gateway once', calls.length === 1, `calls=${calls.length}`)
  check('refresh() returned the fresh snapshot', service.getQuota().status === 'ok' && service.getQuota().fetchedAt === 1_000, JSON.stringify(service.getQuota()))
  clock = 1_500
  for (let index = 0; index < 10; index += 1) service.getQuota()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('10 getQuota() calls -> still exactly ONE network call', calls.length === 1, `calls=${calls.length}`)
  check('...and getQuota kept the snapshot\'s own fetchedAt (age is the caller\'s job)', service.getQuota().fetchedAt === 1_000, String(service.getQuota().fetchedAt))
  clock = 2_000
  const refreshed = await service.refresh?.()
  check('a second refresh() pulls again and updates fetchedAt', calls.length === 2 && refreshed?.fetchedAt === 2_000, `calls=${calls.length} at=${String(refreshed?.fetchedAt)}`)
}
{
  let clock = 10_000
  const { impl, calls } = transport(() => json(REAL_PAYLOAD))
  const service = createQuotaService(deps({ fetchImpl: impl }), { now: () => clock })
  await service.refresh?.()
  clock += QUOTA_CACHE_TTL_MS + 1
  const stale = service.getQuota()
  check('expired cache is STILL served by getQuota()', stale.status === 'ok' && stale.fetchedAt === 10_000, JSON.stringify(stale))
  check('...and expiry alone did NOT send a request', calls.length === 1, `calls=${calls.length}`)
  check('...cacheState reports it stale (TTL constant is real)', service.cacheState().stale === true && service.cacheState().ttlMs === QUOTA_CACHE_TTL_MS, JSON.stringify(service.cacheState()))
  await service.refresh?.()
  check('...only refresh() pulls, and it then replaces the cache', calls.length === 2 && service.cacheState().stale === false, `calls=${calls.length}`)
}
{
  const down = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  const service = createQuotaService(deps({ fetchImpl: down }))
  const snapshot = await service.refresh?.()
  check('refresh() never rejects — it answers an error snapshot', snapshot?.status === 'error' && typeof snapshot?.message === 'string', JSON.stringify(snapshot))
  check('...and that error snapshot is what getQuota serves', service.getQuota().status === 'error')
}
{
  const forbidden = forbiddenTransport()
  const service = createQuotaService(deps({ fetchImpl: forbidden.impl }), { enabled: false })
  check("enabled:false -> 'off' without any read", service.getQuota().status === 'off' && String(service.getQuota().message).includes('enabled=false'), JSON.stringify(service.getQuota()))
  const refreshed = await service.refresh?.()
  check('...refresh() stays off and does NOT fetch', refreshed?.status === 'off' && forbidden.calls.length === 0, `status=${String(refreshed?.status)} calls=${forbidden.calls.length}`)
}
{
  const { impl, calls } = transport(() => json(REAL_PAYLOAD))
  const service = createQuotaService(deps({ fetchImpl: impl }))
  const [first, second] = await Promise.all([service.refresh?.(), service.refresh?.()])
  check('two concurrent refresh() calls share ONE read (no double spend)', calls.length === 1 && first?.status === 'ok' && second?.status === 'ok', `calls=${calls.length}`)
}

// --------------------------------------------------------- 8. shape contract
console.log('\n[8] the snapshot shape (same as workbuddyQuota)')
{
  const { impl } = transport(() => json(REAL_PAYLOAD))
  const ok = await fetchQuotaSnapshot(deps({ fetchImpl: impl }))
  const { impl: impl500 } = transport(() => new Response('x', { status: 500 }))
  const error = await fetchQuotaSnapshot(deps({ fetchImpl: impl500 }))
  const off = await fetchQuotaSnapshot(deps({ credential: async () => { throw new Error('none') } }))
  for (const [label, snapshot] of [['ok', ok], ['error', error], ['off', off]] as const) {
    check(`${label}: only the 5 contract keys`, onlyKnownKeys(snapshot), JSON.stringify(Object.keys(snapshot)))
    check(`${label}: windows keys stay within rolling/weekly/monthly/total`, snapshot.windows === undefined || Object.keys(snapshot.windows).every((key) => WINDOW_KEYS.includes(key)))
  }
  check('non-ok snapshots ALWAYS carry a message', typeof error.message === 'string' && error.message !== '' && typeof off.message === 'string' && off.message !== '')
  check('non-ok snapshots carry no windows', error.windows === undefined && off.windows === undefined)
  check("percent, when present, is a finite number", typeof ok.windows?.['total']?.percent === 'number' && Number.isFinite(ok.windows?.['total']?.percent))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}  (${passed}/${passed + failures})`)
process.exit(failures === 0 ? 0 : 1)

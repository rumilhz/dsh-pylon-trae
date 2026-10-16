/**
 * Verify the BROWSER half of dsh-pylon-trae without a browser.
 *
 * This is an OFFLINE gate. It proves, in order:
 *   1. lib/client.js parses as a CLASSIC script (that is how the page loads it) and
 *      contains no ES-module statement and no TypeScript-only syntax.
 *   2. `window.__ModuleLoader__.load()` is called exactly once with
 *      `id === package.json name`, and the factory resolves with PLATFORM SEED
 *      WORDS only — nothing outside `dsh.client.inject` is required.
 *   3. The plugin face is what the client loader reads: `apply` + `inject`
 *      including "slots".
 *   4. BOTH settings seats are registered, with the keys and priority the host
 *      binds on: `plugins.bundle.config` and `plugins.row.config`, priority 30,
 *      key `<bundle>` / `<bundle>#<rowId>`. The specification's own spelling and the
 *      installed package name are now the SAME string (`dsh-pylon-trae`, unscoped
 *      since the rename), so the two seats carry `dsh-pylon-trae` and
 *      `dsh-pylon-trae#dsh-pylon-trae`; the second bundle seat is the inert
 *      duplicate kept on purpose — see the note above BUNDLE_KEYS in
 *      lib/client.js for why a keyed slot allows that and the renderer still draws
 *      exactly one card.
 *   5. NO CREDENTIAL is embedded anywhere: no bearer, no shim token file, no
 *      cookie/localStorage use, no token-shaped literal.
 *   6. Every request path is one of the two host route prefixes this plugin
 *      registers (`/api/plugins/dsh-pylon-trae` first, `/plugins/dsh-pylon-trae` second) —
 *      and the endpoint list matches src/api.ts.
 *   7. The card RENDERS all four states (loading / failure / empty / ready) with
 *      the server's own words on screen, and never a bare `undefined`/`NaN`.
 *   8. The pure formatters tolerate degenerate input (the "server answered
 *      something unexpected" paths) without throwing or printing a ghost.
 *
 * Run:  <dsh-node> tools/client-bundle-check.mjs
 * Exit: 0 = PASS, 1 = FAIL
 */
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const MANIFEST = join(ROOT, 'package.json')

let checks = 0
let failures = 0
const ok = (label, detail = '') => { checks += 1; console.log(`  ok   ${label}${detail ? `  ${detail}` : ''}`) }
const bad = (label, detail = '') => { checks += 1; failures += 1; console.log(`  FAIL ${label}${detail ? `  ${detail}` : ''}`) }
const eq = (label, actual, expected) => {
  if (actual === expected) ok(label, `= ${JSON.stringify(actual)}`)
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const truthy = (label, value) => { if (value) ok(label); else bad(label, `got ${JSON.stringify(value)}`) }
const has = (label, haystack, needle) => {
  if (typeof haystack === 'string' && haystack.includes(needle)) ok(label, `contains ${JSON.stringify(needle)}`)
  else bad(label, `missing ${JSON.stringify(needle)}`)
}
const absent = (label, haystack, needle) => {
  if (typeof haystack === 'string' && !haystack.includes(needle)) ok(label, `no ${JSON.stringify(needle)}`)
  else bad(label, `unexpected ${JSON.stringify(needle)}`)
}

/* ────────────────── 1. parse as a classic script ────────────────── */
console.log('\n[1] lib/client.js parses as a classic script')
const source = readFileSync(BUNDLE, 'utf8')
const bytes = statSync(BUNDLE).size
try {
  new vm.Script(source, { filename: BUNDLE })
  ok('new vm.Script(source) — classic-script parse', `${source.split('\n').length} lines / ${bytes} bytes`)
} catch (error) {
  bad('new vm.Script(source)', String(error.message))
  console.log('\nFATAL: the bundle does not parse; stopping.')
  process.exit(1)
}
absent('no ES import statement', source, '\nimport ')
absent('no ES export statement', source, '\nexport ')
absent('no TypeScript type annotation', source, ': string')
absent('no TypeScript interface', source, 'interface ')
// The card must not reach into another plugin's code.
for (const upstream of ['@deepseek-ai/', 'dsh-connect-trae']) absent(`does not import ${upstream}`, source, upstream)

/* ────────────────── 2. module-loader registration ────────────────── */
console.log('\n[2] window.__ModuleLoader__.load() registration')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const styleTags = []
const documentStub = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, textContent: '', setAttribute(name, value) { this[name] = value }, getAttribute(name) { return this[name] ?? null } }),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {}
}
const registrations = []
const sandbox = {
  window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) }, addEventListener: () => {}, removeEventListener: () => {} },
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.reject(new Error('the offline check never performs a request'))
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
try {
  new vm.Script(source, { filename: BUNDLE }).runInContext(sandbox)
  ok('bundle executed against a stubbed window')
} catch (error) {
  bad('bundle execution', String(error.message))
  process.exit(1)
}
eq('load() called exactly once', registrations.length, 1)
const registration = registrations[0]
eq('registration.id === package.json name', registration.id, manifest.name)
eq('dsh.client.platform', manifest.dsh.client.platform, 'web')
eq("exports['./client'].default", manifest.exports['./client'].default, './lib/client.js')
eq("exports['./client'] resolves to this file", join(ROOT, manifest.exports['./client'].default), BUNDLE)

/* ────────────────── 3. factory + declared externals ────────────────── */
console.log('\n[3] factory surface and declared host modules')
const SEED_WORDS = new Set(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'])
const declared = new Set(manifest.dsh.client.inject ?? [])
const requested = []
const hooks = { state: [], refs: [], effects: [], index: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? null : children.length === 1 ? children[0] : children }
  }),
  useState: (init) => {
    const slot = hooks.index++
    if (!(slot in hooks.state)) hooks.state[slot] = typeof init === 'function' ? init() : init
    return [hooks.state[slot], (next) => { hooks.state[slot] = typeof next === 'function' ? next(hooks.state[slot]) : next }]
  },
  useRef: (init) => {
    const slot = hooks.index++
    if (!(slot in hooks.refs)) hooks.refs[slot] = { current: init === undefined ? null : init }
    return hooks.refs[slot]
  },
  useEffect: (fn) => { const slot = hooks.index++; if (typeof fn === 'function') hooks.effects[slot] = fn },
  useLayoutEffect: (fn) => { const slot = hooks.index++; if (typeof fn === 'function') hooks.effects[slot] = fn },
  useCallback: (fn) => { hooks.index++; return fn },
  useMemo: (fn) => { hooks.index++; return fn() },
  Fragment: Symbol('Fragment')
}
const requireStub = (specifier) => {
  requested.push(specifier)
  if (specifier === 'react') return reactStub
  if (specifier === 'react-dom') return { createPortal: (element) => element }
  throw new Error(`bundle required an undeclared module: ${specifier}`)
}
let exported
try {
  exported = registration.factory(requireStub)
  ok('factory(require) returned a module object')
} catch (error) {
  bad('factory(require)', String(error.message))
  console.log('\nFATAL: cannot inspect the bundle; stopping.')
  process.exit(1)
}
const uniqueRequested = [...new Set(requested)]
for (const specifier of uniqueRequested) {
  if (SEED_WORDS.has(specifier)) ok(`requires "${specifier}" (platform seed word)`)
  else if (declared.has(specifier)) ok(`requires "${specifier}" (declared in dsh.client.inject)`)
  else bad(`requires "${specifier}"`, 'not a seed word and not declared in dsh.client.inject')
}
eq('no undeclared host client module is pulled in', uniqueRequested.filter((s) => !SEED_WORDS.has(s) && !declared.has(s)).length, 0)
eq('typeof exports.apply', typeof exported.apply, 'function')
truthy('Array.isArray(exports.inject)', Array.isArray(exported.inject))
eq('exports.inject is exactly ["slots"]', JSON.stringify(exported.inject), JSON.stringify(['slots']))
const I = exported.__internals
truthy('exports.__internals exists (the check reads the shipped helpers, not copies)', I !== undefined)

/* ────────────────── 4. both settings seats ────────────────── */
console.log('\n[4] settings card seats')
const registrationsBySlot = []
let currentSlot = null
const ctxStub = {
  slots: {
    inject: (name, callback) => { currentSlot = name; return callback() },
    register: (options, component) => { registrationsBySlot.push({ slot: currentSlot, options, component }); return () => {} }
  },
  get: () => undefined
}
try {
  exported.apply(ctxStub)
  ok('apply(ctx) ran against a slots stub')
} catch (error) {
  bad('apply(ctx)', String(error.message))
}
const seatOf = (slot) => registrationsBySlot.filter((entry) => entry.slot === slot)
const bundleSeats = seatOf('plugins.bundle.config')
const rowSeats = seatOf('plugins.row.config')
eq('plugins.bundle.config seats', bundleSeats.length, I.BUNDLE_KEYS.length)
eq('plugins.row.config seats', rowSeats.length, I.ROW_KEYS.length)
for (const entry of registrationsBySlot) {
  eq(`seat ${entry.slot} name matches its slot`, entry.options.name, entry.slot)
  eq(`seat ${entry.slot} priority`, entry.options.priority, 30)
  eq(`seat ${entry.slot} component is a function`, typeof entry.component, 'function')
  truthy(`seat ${entry.slot} key is a non-empty string`, typeof entry.options.key === 'string' && entry.options.key.length > 0)
}
const bundleKeys = bundleSeats.map((entry) => entry.options.key).sort()
const rowKeys = rowSeats.map((entry) => entry.options.key).sort()
eq('bundle keys = [installed package name, spec spelling]', JSON.stringify(bundleKeys), JSON.stringify([I.PKG, I.ROW_ID].sort()))
eq('row keys = [`<pkg>#<rowId>`, `dsh-pylon-trae#dsh-pylon-trae`]', JSON.stringify(rowKeys), JSON.stringify([`${I.PKG}#${I.ROW_ID}`, `${I.ROW_ID}#${I.ROW_ID}`].sort()))
truthy('the specification\'s row key `dsh-pylon-trae#dsh-pylon-trae` is registered', rowKeys.includes('dsh-pylon-trae#dsh-pylon-trae'))
truthy('the installed package\'s row key is registered', rowKeys.includes(`${I.PKG}#${I.ROW_ID}`))

/* ────────────────── 5. no credential anywhere ────────────────── */
console.log('\n[5] no credential is embedded')
const lower = source.toLowerCase()
for (const banned of ['bearer ', 'authorization', 'shim-token', 'shim_token', 'accesstoken', 'access_token', '.trae-cn', 'storage.json']) {
  absent(`no ${JSON.stringify(banned)}`, lower, banned)
}
for (const banned of ['localstorage.', 'sessionstorage.', 'window.localstorage', 'window.sessionstorage', 'document.cookie']) {
  absent(`no ${JSON.stringify(banned)} use`, lower, banned)
}
const tokenish = source.match(/[A-Za-z0-9_-]{40,}/g) ?? []
// Long identifiers/comments are fine; what matters is that none of them looks like the
// base64url shim token (which is 43 chars of random base64url and lives on disk).
eq('no token-shaped literal (40+ char base64url run)', tokenish.filter((run) => !/^[a-z-]+$/.test(run) && !/^\d+$/.test(run)).length, 0)

/* ────────────────── 6. request paths ────────────────── */console.log('\n[6] request paths match the two host route prefixes')
eq('ROUTE_BASE', JSON.stringify(I.ROUTE_BASE), JSON.stringify(['/api/plugins/dsh-pylon-trae', '/plugins/dsh-pylon-trae']))
const KNOWN_ENDPOINTS = new Set(['/status', '/models', '/models/reload', '/models/refresh', '/account', '/usage', '/checkin', '/models/test', '/models/prune-internal'])
for (const [name, path] of Object.entries(I.EP)) {
  truthy(`EP.${name} = ${JSON.stringify(path)} is a known src/api.ts endpoint`, KNOWN_ENDPOINTS.has(path))
  truthy(`EP.${name} starts with "/"`, path.startsWith('/'))
}
eq('every endpoint src/api.ts serves is reachable from the card', new Set(Object.values(I.EP)).size, KNOWN_ENDPOINTS.size)
eq('EP.reload is the READ-ONLY re-read of the gateway directory', I.EP.reload, '/models/reload')
eq('EP.refresh is the write path (re-read + seed)', I.EP.refresh, '/models/refresh')
has('requests are built as base + endpoint', source, 'fetch(base + endpoint')
absent('no absolute URL is requested (same-origin only)', source, 'http://')
// No plugin route may hide behind a third spelling.
for (const match of source.matchAll(/["'](\/[A-Za-z0-9/_-]*)["']/g)) {
  const literal = match[1]
  if (literal === '/' || literal.startsWith('/api/plugins/dsh-pylon-trae') || literal.startsWith('/plugins/dsh-pylon-trae')) continue
  if (KNOWN_ENDPOINTS.has(literal)) continue
  bad(`unexpected path literal ${JSON.stringify(literal)}`, 'only the two route prefixes and the endpoints may appear')
}
ok('every path literal is a route prefix or a known endpoint')

/* ────────────────── 6b. the two directory buttons are two different requests ────────────────── */
//
// The defect this pins: 「刷新目录」 used to issue `GET /models` — it re-read the
// plugin's OWN list while sounding like it went to Trae. It is `POST /models/reload`
// now (the gateway re-read, read-only), while 「重建清单」 stays `POST /models/refresh`
// (the same re-read PLUS the only profile write this card can trigger).
//
// This is a BEHAVIOURAL check, not a grep: it runs the shipped hook against a stub
// `fetch`, clicks each control by calling the handler the view is handed, and reads
// the request that actually left the card. A card that reached `/models/refresh`
// from the 刷新目录 button would fail here even if every comment said otherwise.
console.log('\n[6b] 刷新目录 → POST /models/reload; 重建清单 → POST /models/refresh')
{
  const requests = []
  const answers = {
    '/models/reload': { ok: true, modelCount: 79, at: 1792506420000, attempts: [{ fn: 'solo_work_remote', status: 200, count: 79 }] },
    '/models/refresh': { ok: true, kind: 'rebuilt', modelCount: 79, outcome: { kind: 'rebuilt', ns: 'llm-pi-ai', addedModels: [], keptModels: 79, backupPath: '(no write)' } },
    '/status': { ok: true, region: 'cn', port: 7864, modelCount: 79, accounts: [], credential: { source: 'desktop', edition: 'cn', userId: 'u', expiresAtMs: 1792506420000 } }
  }
  sandbox.fetch = (url, init) => {
    const target = String(url)
    requests.push({ url: target, method: (init && init.method) || 'GET' })
    const endpoint = Object.keys(answers).find((candidate) => target.endsWith(candidate))
    return Promise.resolve({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify(endpoint === undefined ? { ok: false, detail: `no stub answer for ${target}` } : answers[endpoint]))
    })
  }
  hooks.index = 0
  hooks.state = []
  hooks.refs = []
  hooks.effects = []
  const vm = I.useTraeCard()
  truthy('the hook hands the view a 刷新目录 handler', typeof vm.onRefreshDirectory === 'function')
  truthy('the hook hands the view a 重建清单 handler', typeof vm.onRebuild === 'function')

  requests.length = 0
  await vm.onRefreshDirectory()
  eq('刷新目录 issues exactly one request', requests.length, 1)
  eq('...and it is POST /api/plugins/dsh-pylon-trae/models/reload', `${requests[0]?.method} ${requests[0]?.url}`, 'POST /api/plugins/dsh-pylon-trae/models/reload')
  eq('...never the write route (so the profile cannot be touched)', requests.filter((entry) => entry.url.endsWith('/models/refresh')).length, 0)
  eq('...and not the old in-memory-only GET /models either', requests.filter((entry) => entry.url.endsWith('/models')).length, 0)

  requests.length = 0
  await vm.onRebuild()
  eq('重建清单 POSTs /api/plugins/dsh-pylon-trae/models/refresh first', `${requests[0]?.method} ${requests[0]?.url}`, 'POST /api/plugins/dsh-pylon-trae/models/refresh')
  eq('...never a reload', requests.filter((entry) => entry.url.endsWith('/models/reload')).length, 0)
  truthy('...then re-reads /status so the header follows the new list', requests.slice(1).some((entry) => entry.url.endsWith('/status')))

  sandbox.fetch = () => Promise.reject(new Error('the offline check never performs a request'))
}

/* ────────────────── 7. the four rendered states ────────────────── */
console.log('\n[7] the card renders loading / failure / empty / ready')
function textOf(element) {
  const texts = []
  const visit = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) { for (const item of node) visit(item); return }
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    if (typeof node.type === 'function') { visit(node.type(node.props)); return }
    if (typeof node.type === 'string') visit(node.props?.children)
  }
  visit(element)
  return texts.join(' | ')
}
/**
 * Build one scenario. The status payload's own facts (region / port / model count /
 * which account is active) are derived by the SHIPPED `statusFacts`, not by this
 * file — so a scenario cannot describe a card the live hook would never draw.
 */
const view = (overrides) => {
  const base = { ...I.emptyState(), ...overrides }
  const payload = overrides.status?.payload
  return I.TraeCardView(payload === undefined ? base : { ...base, ...I.statusFacts(payload) })
}
const noGhosts = (label, text) => {
  for (const ghost of ['undefined', 'NaN', '[object Object]']) absent(`${label} prints no ${ghost}`, text, ghost)
}

// (a) loading — what the card shows for the first render, before any answer.
{
  const text = textOf(view({}))
  has('(loading) every block says it is reading', text, '读取中…')
  has('(loading) the card announces itself', text, 'Trae（自建供应商）')
  has('(loading) the account block is present', text, '① 账号')
  has('(loading) the directory block is present', text, '② 目录')
  has('(loading) the rebuild block is present', text, '③ 重建清单')
  has('(loading) the credits block is present', text, '④ 用量（额度）')
  has('(loading) the check-in block is present', text, '⑤ 签到 / 测试')
  noGhosts('(loading)', text)
}

// (b) failure — the server's own detail, verbatim, in the blocks that failed.
{
  const detail = '没有找到任何 Trae 安装数据（storage.json / CLI token 都不存在）'
  const text = textOf(view({
    status: { phase: 'error', detail, summary: { lines: [], accounts: [] } },
    usage: { phase: 'error', detail: 'pay gateway answered HTTP 500: boom', rows: [], expanded: false },
    checkin: { phase: 'error', detail: 'check-in status answered HTTP 403', text: '', checkedIn: false },
    rebuild: { phase: 'error', detail: '找不到本 profile 的 cordis.patch.yml（plugin=dsh-pylon-trae），已放弃写入 —— 没有退路就不改用户配置' },
    test: { phase: 'error', detail: '没有可测试的模型（目录为空或读取失败）', lines: [] }
  }))
  has('(failure) the status detail is printed unchanged', text, detail)
  has('(failure) the usage detail is printed unchanged', text, 'pay gateway answered HTTP 500: boom')
  has('(failure) the no-guard text is printed unchanged', text, '没有退路就不改用户配置')
  has('(failure) the test failure is printed', text, '没有可测试的模型')
  noGhosts('(failure)', text)
}

// (c) empty — an answer arrived and carried nothing. Never a blank row.
{
  const text = textOf(view({
    status: { phase: 'ready', detail: '', summary: { lines: ['账号 用户1007740821', '来源 desktop · cn', '到期 2026-10-21 11:47（剩 6 天 3 小时）'], accounts: [] }, payload: { region: 'cn', port: 7864, modelCount: 0, accounts: [], credential: {} } },
    usage: { phase: 'ready', detail: '', rows: [], expanded: false },
    checkin: { phase: 'ready', detail: '', text: '服务端状态：今日未领取 · 今日奖励 100', checkedIn: false },
    test: { phase: 'ready', detail: '', lines: [] }
  }))
  has('(empty) no switchable account is stated, not hidden', text, '本机只看到一个 Trae 安装（没有可切换的账号）')
  has('(empty) zero credits is stated as a fact', text, '服务端没有返回任何额度字段')
  has('(empty) zero verdicts is stated as a fact', text, '服务端没有返回任何 verdict')
  has('(empty) the directory count still renders', text, '模型 0 个')
  noGhosts('(empty)', text)
}

// (d) ready — real payload shapes from src/api.ts and the live CLI readings.
{
  const accounts = [
    { id: 'a1', userId: '357806796716699', accountName: '用户1007740821', edition: 'cn', source: 'desktop', expiresAtMs: 1792506420000, active: true },
    { id: 'a2', userId: '357806796716699', edition: 'cn', source: 'cli', expiresAtMs: 1792184100000, active: false }
  ]
  const text = textOf(view({
    status: {
      phase: 'ready',
      detail: '',
      summary: I.statusSummary({ region: 'cn', port: 7864, modelCount: 79, accounts, credential: { source: 'desktop', edition: 'cn', userId: '357806796716699', accountName: '用户1007740821', host: 'https://api.trae.cn', expiresAtMs: 1792506420000 } }),
      payload: { region: 'cn', port: 7864, modelCount: 79, accounts, credential: { source: 'desktop', edition: 'cn', userId: '357806796716699', accountName: '用户1007740821', host: 'https://api.trae.cn', expiresAtMs: 1792506420000 } }
    },
    activeAccountId: 'a1',
    usage: { phase: 'ready', detail: '', rows: I.creditRows({ credits: { total_amount: 4600, consumed_amount: 0.01, 'user_entitlement_pack_list[0].credits_amount': 100 } }), expanded: false },
    checkin: { phase: 'ready', detail: '', text: I.checkinStatus({ checkedIn: false, didCheckedIn: false, credits: 100, enabled: true }).text, checkedIn: false },
    rebuild: { phase: 'ready', detail: '', summary: I.refreshSummary({ ok: true, kind: 'rebuilt', modelCount: 79, outcome: { kind: 'rebuilt', ns: 'llm-pi-ai', addedModels: ['new-model-x'], keptModels: 79, backupPath: 'C:/tmp/backup', offeredModels: [] } }) },
    test: { phase: 'ready', detail: '', lines: I.testLines({ results: [{ id: 'mimo-v2.6-flash', verdict: 'available', detail: 'answered 200' }, { id: 'glm-5.2', verdict: 'needs-plan', detail: 'Trae requires a paid plan for this model' }] }) }
  }))
  has('(ready) the account name is shown', text, '用户1007740821')
  has('(ready) the credential source is shown', text, 'desktop · cn')
  has('(ready) the gateway is shown', text, 'https://api.trae.cn')
  has('(ready) the expiry is shown', text, '到期')
  has('(ready) both accounts are offered in the switcher', text, '←当前')
  {
    // A controlled <select> must always be handed a value one of its own options
    // carries, or React logs a warning into the console the acceptance list says
    // must stay clean.
    const findSelect = (element) => {
      const found = []
      const visit = (node) => {
        if (node === null || node === undefined || typeof node !== 'object') return
        if (Array.isArray(node)) { for (const item of node) visit(item); return }
        if (node.type === 'select') found.push(node)
        visit(node.props?.children)
      }
      visit(element)
      return found[0]
    }
    const optionValues = (select) => (Array.isArray(select.props.children) ? select.props.children : [select.props.children]).map((option) => option.props.value)
    const activePayload = { region: 'cn', port: 7864, accounts, credential: { source: 'desktop', edition: 'cn', userId: 'u', accountName: '用户1007740821', expiresAtMs: 1792506420000 } }
    const select = findSelect(view({ status: { phase: 'ready', detail: '', summary: I.statusSummary(activePayload), payload: activePayload } }))
    truthy('a <select> is rendered when accounts exist', select !== undefined)
    truthy('the account switcher value matches one of its own options', optionValues(select).includes(select.props.value))
    const idleAccounts = accounts.map((account) => ({ ...account, active: false }))
    const idlePayload = { region: 'cn', port: 7864, accounts: idleAccounts, credential: { source: 'desktop', edition: 'cn', userId: 'u', expiresAtMs: 1792506420000 } }
    const noActive = findSelect(view({ status: { phase: 'ready', detail: '', summary: I.statusSummary(idlePayload), payload: idlePayload } }))
    eq('...and it still matches when no account is marked active', noActive.props.value, accounts[0].id)
  }
  has('(ready) the model count is shown', text, '模型 79 个')
  has('(ready) the rebuild result is shown', text, '保留 79 个')
  has('(ready) the added models are listed', text, 'new-model-x')
  has('(ready) gateway field names are used verbatim', text, 'total_amount')
  has('(ready) credit values are printed', text, '4600')
  has('(ready) the check-in state comes from the server', text, '服务端状态：今日未领取')
  has('(ready) the model verdict is translated', text, '可用（available）')
  has('(ready) a refused model keeps its own detail', text, 'Trae requires a paid plan for this model')
  noGhosts('(ready)', text)
}

// (d2) the directory row prints its number ONCE.
//
// The shipped defect: the row drew `模型 N 个` from `vm.modelCount` AND appended a
// summary sentence that spelled the same count again — `模型 79 个 · 模型 79 个 ·
// 本面板上次读取 …`. The count now has exactly one source (the row), and this pins
// both halves: the sentence carries no count, and the rendered row contains
// `模型 79 个` exactly once — after BOTH kinds of read the card can do.
{
  const at = new Date(2026, 9, 14, 23, 5).getTime()
  const stamp = `本面板上次读取 ${I.formatClock(at)}`
  eq('the /models sentence is the timestamp alone (no second count)', I.modelsSummary({ models: [{ id: 'a' }] }, at).text, stamp)
  eq('the /models/reload sentence is the same shape', I.reloadSummary({ ok: true, modelCount: 79, at }).text, stamp)
  const payload = { region: 'cn', port: 7864, modelCount: 79, accounts: [], credential: { source: 'desktop', edition: 'cn', userId: 'u', expiresAtMs: 1792506420000 } }
  const ready = { status: { phase: 'ready', detail: '', summary: I.statusSummary(payload), payload } }
  const afterModels = textOf(view({ ...ready, directoryText: I.modelsSummary({ models: Array.from({ length: 79 }, (_, index) => ({ id: `m${index}` })) }, at).text }))
  eq('after GET /models the row prints 模型 79 个 exactly once', afterModels.split('模型 79 个').length - 1, 1)
  has('...beside the read stamp', afterModels, stamp)
  const afterReload = textOf(view({ ...ready, directoryText: I.reloadSummary({ ok: true, modelCount: 79, at }).text }))
  eq('after POST /models/reload the row prints 模型 79 个 exactly once', afterReload.split('模型 79 个').length - 1, 1)
  has('...beside the read stamp', afterReload, stamp)
  noGhosts('(directory row)', afterReload)
}

// (d3) the account warning is ON SCREEN, in the account row.
//
// The shipped defect: `account: selected … not present` was written to boot.log and
// nowhere else, so a card could bill a different account than the switcher remembered
// with no visible sign. The field is the server's own sentence, printed verbatim.
{
  const warning = '已选账号 deadbeef0000000000000001 在这台机器上不存在（本机可见 1 个），本次改用 desktop/cn'
  const accounts = [
    { id: 'a1', userId: '357806796716699', accountName: '用户1007740821', edition: 'cn', source: 'desktop', expiresAtMs: 1792506420000, active: true }
  ]
  const payload = { region: 'cn', port: 7864, modelCount: 79, accounts, accountWarning: warning, credential: { source: 'desktop', edition: 'cn', userId: '357806796716699', accountName: '用户1007740821', expiresAtMs: 1792506420000 } }
  const text = textOf(view({ status: { phase: 'ready', detail: '', summary: I.statusSummary(payload), payload } }))
  has('(warning) the account warning is rendered verbatim', text, warning)
  has('...inside the account block (its own heading is still above it)', text, '① 账号')
  // Position, not just presence: warnings about one block belong in that block.
  truthy('...and it sits between the account block and the directory block', text.indexOf(warning) > text.indexOf('① 账号') && text.indexOf(warning) < text.indexOf('② 目录'))
  noGhosts('(warning)', text)
  eq('statusFacts carries it through', I.statusFacts(payload).accountWarning, warning)

  const quiet = { ...payload, accountWarning: undefined }
  const quietText = textOf(view({ status: { phase: 'ready', detail: '', summary: I.statusSummary(quiet), payload: quiet } }))
  eq('no warning -> no warning line (never the word undefined)', I.statusFacts(quiet).accountWarning, '')
  absent('(quiet) the card prints nothing extra', quietText, 'accountWarning')
  noGhosts('(quiet)', quietText)
}

// (e) the hook path itself mounts and draws the loading card (React stub, no effects run).
{
  hooks.index = 0
  hooks.state = []
  hooks.refs = []
  hooks.effects = []
  try {
    const mounted = textOf(reactStub.createElement(I.TraeCard, {}))
    has('(mount) the component renders through React', mounted, 'Trae（自建供应商）')
    truthy('(mount) the mount is the loading state', mounted.includes('读取中…'))
    noGhosts('(mount)', mounted)
  } catch (error) {
    bad('(mount) TraeCard()', String(error.message))
  }
}

/* ────────────────── 8. degenerate input ────────────────── */
console.log('\n[8] pure helpers survive answers that are not what we expected')
const DEGENERATE = [undefined, null, 0, '', 'x', [], {}, { ok: true }, { ok: false }, { credits: null }, { results: null }, { accounts: null }]
{
  const helpers = {
    statusSummary: I.statusSummary,
    refreshSummary: I.refreshSummary,
    creditRows: I.creditRows,
    checkinStatus: I.checkinStatus,
    claimSummary: I.claimSummary,
    testLines: I.testLines,
    detailOf: I.detailOf,
    accountLabel: I.accountLabel,
    verdictText: I.verdictText,
    // The two summaries behind the directory row: a payload the server never sent
    // must not throw and must not print a ghost.
    modelsSummary: (payload) => I.modelsSummary(payload, 1792506420000),
    reloadSummary: I.reloadSummary
  }
  let thrown = null
  let ghosts = null
  for (const [name, fn] of Object.entries(helpers)) {
    for (const input of DEGENERATE) {
      let out
      try {
        out = fn(input)
      } catch (error) {
        thrown = `${name}(${JSON.stringify(input)}) threw ${String(error.message)}`
        continue
      }
      const rendered = typeof out === 'string' ? out : textOf(reactStub.createElement('div', {}, JSON.parse(JSON.stringify(out ?? null))))
      if (/undefined|NaN|\[object Object\]/.test(rendered)) ghosts = `${name}(${JSON.stringify(input)}) → ${rendered.slice(0, 160)}`
    }
  }
  if (thrown === null) ok(`no helper throws on ${DEGENERATE.length} degenerate inputs × ${Object.keys(helpers).length} helpers`)
  else bad('a helper threw', thrown)
  if (ghosts === null) ok('no helper ever renders undefined / NaN / [object Object]')
  else bad('a helper rendered a ghost', ghosts)
  eq('modelsSummary without a payload', I.modelsSummary(undefined, Date.now()).phase, 'empty')
  eq('reloadSummary without a payload', I.reloadSummary(undefined).phase, 'empty')
  eq('reloadSummary of an answer with no count claims no number (never 0)', I.reloadSummary({ ok: true }).count, undefined)
  eq('reloadSummary of an answer with no usable stamp says 未知, not a guessed time', I.reloadSummary({ ok: true, modelCount: 3 }).text, '本面板上次读取 未知')
  eq('reloadSummary keeps ids empty (the answer carries no list)', JSON.stringify(I.reloadSummary({ ok: true, modelCount: 3, at: 1792506420000 }).ids), '[]')
  eq('formatNumber(undefined)', I.formatNumber(undefined), '未知')
  eq('formatNumber(0.010000000000000002)', I.formatNumber(0.010000000000000002), '0.01')
  eq('formatClock(0)', I.formatClock(0), '未知')
  eq('formatLeft(0, 1)', I.formatLeft(0, 1), '未知')
  eq('verdictText(unknown verdict)', I.verdictText('who-knows'), '未知 verdict：who-knows')
  eq('refreshSummary of a nested rolled-back outcome', JSON.stringify(I.refreshSummary({ ok: true, kind: 'rolled-back', outcome: { kind: 'rolled-back', ns: 'llm-pi-ai', reasons: ['条目数变少：34 → 3'], backupPath: 'C:/tmp/b' } }).lines), JSON.stringify(['条目数变少：34 → 3', '已回滚，备份 C:/tmp/b']))
  eq('refreshSummary of no-guard prints the server sentence unchanged', I.refreshSummary({ ok: true, kind: 'no-guard', outcome: { kind: 'no-guard', detail: '找不到本 profile 的 cordis.patch.yml' } }).lines[0], '找不到本 profile 的 cordis.patch.yml')
  eq('claimSummary of a business refusal (HTTP 200 + code 9004)', I.claimSummary({ ok: true, claimed: false, code: 9004, message: 'already checked in' }).tone, 'warn')
  eq('checkinStatus says 已领取 only when the server says so', I.checkinStatus({ checkedIn: true, credits: 100 }).checkedIn, true)
  eq('checkinStatus defaults to 未领取', I.checkinStatus({ credits: 100 }).checkedIn, false)
}

/* ────────────────── summary ────────────────── */
console.log('\n' + '-'.repeat(72))
console.log(`${checks - failures}/${checks} checks passed — ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)

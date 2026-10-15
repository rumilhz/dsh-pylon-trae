/**
 * Verify the HOST ROUTE half of the settings card without a DSH process.
 *
 * What this proves, in order:
 *   1. `apply()` mounts BOTH prefixes on a `webServer` stub — `/plugins/dsh-pylon-trae`
 *      and `/api/plugins/dsh-pylon-trae` — as `kind: 'prefix'` routes, and registers a
 *      `ctx.effect` disposer for them.
 *   2. The disposer really removes them (a second mount on the same server does not
 *      hit `webserver: duplicate prefix route`, which is what makes the inject
 *      callback safe to re-run).
 *   3. Missing the connection fence means NO route at all: the plugin refuses to
 *      publish the operator's account to an unauthenticated path.
 *   4. A REAL HTTP request through a real node server reaches the SHIPPED handler
 *      and the prefix is stripped correctly on both spellings — the endpoint it hands
 *      to `handleApi` is `/status` / `/account` / …, never `/api/plugins/...`.
 *   5. A query string does not break the strip, and a lookalike path
 *      (`/plugins/dsh-pylon-traeX/status`) is not silently treated as ours.
 *   6. The host's fence is applied first: 401/403 answers are plain text and the API
 *      is never consulted.
 *   7. 🔴 The ONE documented exception (2026-10-14, the shipped 403 bug): a fence 403
 *      whose Host and Origin are BOTH loopback is the desktop app's port hop, and is
 *      tolerated — the request reaches the API and answers 200 JSON. A 401 is never
 *      tolerated, and a non-loopback Host or Origin still gets its 403. Without this
 *      the card answers `HTTP 403: /plugins/dsh-pylon-trae 没有返回 JSON` on every request.
 *   8. A body that is not JSON, an API that throws, and an API that is not ready yet
 *      each produce a JSON `{ok:false, detail}` answer — never a 500, never a blank.
 *
 * Run:  <dsh-node> tools/client-route-check.mjs
 * Exit: 0 = PASS, 1 = FAIL
 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * `apply()` writes its boot trace to `$DSH_HOME/.dsh-pylon-trae/boot.log` (src/index.ts
 * `trace()`). Point DSH_HOME at a throwaway directory BEFORE importing the plugin,
 * so running this check can never append to the operator's live home — which it did
 * once, and that is exactly the kind of side effect a check must not have.
 */
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-pylon-trae-route-home-'))
process.env['DSH_HOME'] = scratchHome

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
  else bad(label, `missing ${JSON.stringify(needle)} in ${String(haystack).slice(0, 200)}`)
}

const mod = await import('../src/index.ts')
const { apply, DEFAULT_CONFIG, createHostRouteHandler, ROUTE_PREFIX, API_ROUTE_PREFIX } = mod

/* ────────────────── a fake host: webServer + connection ────────────────── */
/** Mirrors dsh-host-webserver/lib/index.js: register() throws on a duplicate path, returns a disposer. */
function fakeWebServer() {
  const table = new Map()
  return {
    routes: table,
    register(route) {
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => { table.delete(route.path) }
    }
  }
}
/** Mirrors cordis: `inject(names, cb)` runs cb only once EVERY service is present. */
function fakeContext(services) {
  const effects = []
  const makeCtx = (available) => ({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => available[name],
    inject: (names, callback) => {
      if (names.every((name) => available[name] !== undefined)) callback(makeCtx(available))
    },
    effect: (callback) => { effects.push(callback()) }
  })
  return { ctx: makeCtx(services), effects }
}
const quietConfig = { ...DEFAULT_CONFIG, enabled: true, seed: false, port: 7864 }

/* ────────────────── 1. both prefixes are mounted ────────────────── */
console.log('\n[1] apply() mounts both host prefixes')
const webServer = fakeWebServer()
const connection = { requestRejection: () => undefined }
const { ctx, effects } = fakeContext({ connection, webServer })
apply(ctx, quietConfig)
eq('two routes are registered', webServer.routes.size, 2)
truthy(`bare prefix ${ROUTE_PREFIX} is mounted`, webServer.routes.has(ROUTE_PREFIX))
truthy(`api prefix ${API_ROUTE_PREFIX}${ROUTE_PREFIX} is mounted`, webServer.routes.has(`${API_ROUTE_PREFIX}${ROUTE_PREFIX}`))
for (const [path, route] of webServer.routes) {
  eq(`route ${path} kind`, route.kind, 'prefix')
  eq(`route ${path} handler is a function`, typeof route.handler, 'function')
}
// Two effects: the shim's teardown (registered first, always) and the route
// disposer. Both are disposed below, in reverse, the way cordis does it.
truthy('a ctx.effect disposer was registered for the routes', effects.length >= 2)
eq('...and it is a function', typeof effects[effects.length - 1], 'function')
eq('the routes live under the plugin prefix (not the connection\'s own /api)', [...webServer.routes.keys()].filter((p) => p === API_ROUTE_PREFIX).length, 0)

/* ────────────────── 2. the disposer really disposes ────────────────── */
console.log('\n[2] the inject callback can re-run without a duplicate-route throw')
for (const dispose of [...effects].reverse()) dispose()
eq('after dispose, no route remains', webServer.routes.size, 0)
let remountError = null
try {
  const again = fakeContext({ connection, webServer })
  apply(again.ctx, quietConfig)
} catch (error) {
  remountError = error
}
eq('a second apply() on the same server throws nothing', remountError, null)
eq('...and both routes are back', webServer.routes.size, 2)
// Leave one clean mount for the HTTP section below.
webServer.routes.clear()
{
  const fresh = fakeContext({ connection, webServer })
  apply(fresh.ctx, quietConfig)
}

/* ────────────────── 3. no fence, no route ────────────────── */
console.log('\n[3] without the connection fence nothing is registered')
{
  const wall = fakeWebServer()
  const noFence = fakeContext({ webServer: wall })
  apply(noFence.ctx, quietConfig)
  eq('connection service missing ⇒ 0 routes (never an unauthenticated route)', wall.routes.size, 0)
  const noRegister = fakeContext({ connection: { requestRejection: () => undefined } })
  apply(noRegister.ctx, quietConfig)
  ok('webServer missing ⇒ apply() still returns quietly')
}

/* ────────────────── 4–7. real HTTP through the shipped handler ────────────────── */
console.log('\n[4] a real HTTP request reaches the shipped handler')
const seen = []
let apiMode = 'echo'
const handler = createHostRouteHandler({
  requestRejection: (req) => (req.headers['x-fence'] === 'deny' ? 403 : undefined),
  resolveApi: () => (req) => {
    if (apiMode === 'throw') throw new Error('api exploded')
    return Promise.resolve({ status: 200, body: { ok: true, mode: apiMode } })
  }
})
// The handler is what apply() built too; drive the real one from the server for the
// end-to-end cases, and this instance for the fence/body cases.
const server = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url })
  const route = webServer.routes.get(ROUTE_PREFIX)
  const apiRoute = webServer.routes.get(`${API_ROUTE_PREFIX}${ROUTE_PREFIX}`)
  const url = new URL(req.url, 'http://127.0.0.1')
  const match = url.pathname.startsWith(`${API_ROUTE_PREFIX}${ROUTE_PREFIX}`) ? apiRoute : route
  void (match === undefined ? Promise.resolve() : match.handler(req, res)).catch(() => {})
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`

// The mounted handler answers with the "not ready yet" shape, because this fake ctx
// never ran run() (no real Trae credential is touched by this check).
{
  const response = await fetch(`${base}${ROUTE_PREFIX}/status`)
  const text = await response.text()
  eq('GET /plugins/dsh-pylon-trae/status answers 200 (never a 500)', response.status, 200)
  has('...with an honest not-ready detail', text, '插件还在启动')
  has('...and the JSON ok flag is false', text, '"ok":false')
  const viaApi = await fetch(`${base}${API_ROUTE_PREFIX}${ROUTE_PREFIX}/status`)
  eq('the same answer on the /api spelling', viaApi.status, 200)
  has('...identical shape', await viaApi.text(), '插件还在启动')
}

/* ────────────────── 5. prefix stripping, exactly ────────────────── */
console.log('\n[5] prefix stripping hands handleApi a plugin-relative path')
{
  const cases = [
    ['/status', `${ROUTE_PREFIX}/status`, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/status`],
    ['/models', `${ROUTE_PREFIX}/models`, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/models`],
    ['/models/refresh', `${ROUTE_PREFIX}/models/refresh`, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/models/refresh`],
    ['/account', `${ROUTE_PREFIX}/account`, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/account`],
    ['/usage', `${ROUTE_PREFIX}/usage`, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/usage`],
    ['/checkin', `${ROUTE_PREFIX}/checkin`, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/checkin`],
    ['/models/test', `${ROUTE_PREFIX}/models/test`, `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/models/test`]
  ]
  for (const [relative, bare, api] of cases) {
    for (const [label, url] of [['bare', bare], ['api', api]]) {
      const captured = []
      const probe = createHostRouteHandler({
        requestRejection: () => undefined,
        resolveApi: () => (request) => {
          captured.push(request)
          return Promise.resolve({ status: 200, body: { ok: true } })
        }
      })
      await probe({ method: 'GET', url, headers: {}, [Symbol.asyncIterator]: async function* () {} }, { writeHead: () => {}, end: () => {} })
      eq(`(${label}) ${url} → path handed to handleApi`, captured[0]?.path, relative)
    }
  }
  // A query string must not survive into the path, and the trailing slash is api.ts's business.
  const captured = []
  const probe = createHostRouteHandler({
    requestRejection: () => undefined,
    resolveApi: () => (request) => { captured.push(request); return Promise.resolve({ status: 200, body: { ok: true } }) }
  })
  await probe({ method: 'GET', url: `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/models?limit=30&x=1`, headers: {}, [Symbol.asyncIterator]: async function* () {} }, { writeHead: () => {}, end: () => {} })
  eq('a query string is not part of the path', captured[0]?.path, '/models')
  // A lookalike path must NOT lose its own prefix: `/api` is only stripped for OUR spelling.
  const lookalike = []
  const probe2 = createHostRouteHandler({
    requestRejection: () => undefined,
    resolveApi: () => (request) => { lookalike.push(request); return Promise.resolve({ status: 200, body: { ok: true } }) }
  })
  await probe2({ method: 'GET', url: '/api/plugins/dsh-pylon-traeX/status', headers: {}, [Symbol.asyncIterator]: async function* () {} }, { writeHead: () => {}, end: () => {} })
  eq('a lookalike path keeps the /api it had', lookalike[0]?.path, '/api/plugins/dsh-pylon-traeX/status')
}

/* ────────────────── 6. the fence comes first ────────────────── */
console.log('\n[6] the host fence is applied before anything else')
{
  const answers = []
  const fenced = createHostRouteHandler({
    requestRejection: () => 401,
    resolveApi: () => () => { throw new Error('the API must never be reached behind a failing fence') }
  })
  await fenced(
    { method: 'GET', url: `${ROUTE_PREFIX}/status`, headers: {}, [Symbol.asyncIterator]: async function* () {} },
    { writeHead: (code, headers) => answers.push({ code, headers }), end: (body) => answers.push({ body }) }
  )
  eq('401 from the fence', answers[0].code, 401)
  eq('...answered as plain text', answers[0].headers['Content-Type'], 'text/plain; charset=utf-8')
  eq('...with the host\'s own word', answers[1].body, 'unauthorized')
  const forbidden = []
  const deny = createHostRouteHandler({ requestRejection: () => 403, resolveApi: () => undefined })
  await deny(
    { method: 'GET', url: `${ROUTE_PREFIX}/status`, headers: {}, [Symbol.asyncIterator]: async function* () {} },
    { writeHead: (code) => forbidden.push({ code }), end: (body) => forbidden.push({ body }) }
  )
  eq('403 from the fence', forbidden[0].code, 403)
  eq('...with "forbidden"', forbidden[1].body, 'forbidden')
  const throwing = []
  const boom = createHostRouteHandler({ requestRejection: () => { throw new Error('fence exploded') }, resolveApi: () => undefined })
  await boom(
    { method: 'GET', url: `${ROUTE_PREFIX}/status`, headers: {}, [Symbol.asyncIterator]: async function* () {} },
    { writeHead: (code) => throwing.push({ code }), end: (body) => throwing.push({ body }) }
  )
  eq('a fence that throws fails CLOSED (403)', throwing[0].code, 403)
}

/* ────────────────── 7. the loopback port-hop exception (the shipped 403 bug) ────────────────── */
console.log('\n[7] a fence 403 that is only a loopback port hop is tolerated')
{
  const capture = async (handlerFn, req) => {
    const out = []
    await handlerFn(req, { writeHead: (code, headers) => out.push({ code, headers }), end: (body) => out.push({ body }) })
    return { code: out[0].code, headers: out[0].headers, body: out[1].body }
  }
  const loopbackHeaders = (host, origin) => {
    const headers = host === undefined ? {} : { host }
    if (origin !== undefined) headers.origin = origin
    return headers
  }
  /** A handler whose fence answers `rejection` for every request, recording what the API saw. */
  const fenced = (rejection) => {
    const reached = []
    return {
      reached,
      handler: createHostRouteHandler({
        requestRejection: () => rejection,
        resolveApi: () => (request) => {
          reached.push(request)
          return Promise.resolve({ status: 200, body: { ok: true, portHop: true } })
        }
      })
    }
  }

  // The exact shape measured on the live app: :19387 is the app's port, the host port
  // differs, and the framework fence compares `new URL(origin).host === host` — so its
  // answer on this channel is 403 even for a well-behaved local browser.
  for (const [label, headers] of [
    ['host+origin both loopback', loopbackHeaders('127.0.0.1:19387', 'http://127.0.0.1:19387')],
    ['no Origin at all', loopbackHeaders('127.0.0.1:19387')],
    ['Host localhost', loopbackHeaders('localhost:19387', 'http://localhost:19387')],
    ['Origin on a different loopback port', loopbackHeaders('127.0.0.1:9728', 'http://127.0.0.1:19387')]
  ]) {
    const probe = fenced(403)
    const answer = await capture(probe.handler, { method: 'GET', url: `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/status`, headers, [Symbol.asyncIterator]: async function* () {} })
    eq(`(${label}) /api spelling answers 200, not 403`, answer.code, 200)
    has(`(${label}) ...with a JSON body`, answer.body, '"ok":true')
    eq(`(${label}) ...and the API really ran, on the plugin-relative path`, probe.reached[0]?.path, '/status')
    // The same request on the bare spelling (the second registered prefix).
    const bare = fenced(403)
    const bareAnswer = await capture(bare.handler, { method: 'GET', url: `${ROUTE_PREFIX}/status`, headers, [Symbol.asyncIterator]: async function* () {} })
    eq(`(${label}) bare spelling answers 200 too`, bareAnswer.code, 200)
  }

  // Everything that is NOT a loopback port hop keeps the fence's own answer.
  for (const [label, headers] of [
    ['non-loopback Host', loopbackHeaders('evil.example.com')],
    ['non-loopback Origin', loopbackHeaders('127.0.0.1:19387', 'https://evil.example.com')],
    ['0.0.0.0 Host', loopbackHeaders('0.0.0.0:19387')],
    ['unparsable Host', loopbackHeaders('127.0.0.1:not-a-port')],
    ['unparsable Origin', loopbackHeaders('127.0.0.1:19387', 'file://')],
    ['no Host at all', {}]
  ]) {
    const probe = fenced(403)
    const answer = await capture(probe.handler, { method: 'GET', url: `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/status`, headers, [Symbol.asyncIterator]: async function* () {} })
    eq(`(${label}) still 403`, answer.code, 403)
    eq(`(${label}) ...answered as plain text`, answer.headers['Content-Type'], 'text/plain; charset=utf-8')
    eq(`(${label}) ...and the API is never consulted`, probe.reached.length, 0)
  }

  // 401 is "you are not the operator" — a missing/expired browser session, never a
  // port hop. Tolerating it would publish the account to an unauthenticated caller.
  {
    const probe = fenced(401)
    const answer = await capture(probe.handler, { method: 'GET', url: `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/status`, headers: loopbackHeaders('127.0.0.1:19387'), [Symbol.asyncIterator]: async function* () {} })
    eq('a 401 is NOT tolerated, even from loopback', answer.code, 401)
    eq('...with the host\'s own word', answer.body, 'unauthorized')
    eq('...and the API is never consulted', probe.reached.length, 0)
  }

  // A fence that THROWS is still 403; it only becomes tolerable when the request is a
  // loopback port hop (the desktop proxy path), never for anyone else.
  {
    const throwing = (headers) => createHostRouteHandler({ requestRejection: () => { throw new Error('fence exploded') }, resolveApi: () => undefined })
    const remote = await capture(throwing(), { method: 'GET', url: `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/status`, headers: loopbackHeaders('evil.example.com'), [Symbol.asyncIterator]: async function* () {} })
    eq('a throwing fence still fails CLOSED (403) for a remote host', remote.code, 403)
    const local = await capture(throwing(), { method: 'GET', url: `${API_ROUTE_PREFIX}${ROUTE_PREFIX}/status`, headers: loopbackHeaders('127.0.0.1:19387'), [Symbol.asyncIterator]: async function* () {} })
    eq('...and reaches the "not ready yet" answer for a loopback host', local.code, 200)
    has('...which is JSON, so the card sees the plugin and not the proxy', local.body, '插件还在启动')
  }
}

/* ────────────────── 8. bad bodies and a throwing API ────────────────── */
console.log('\n[8] a broken request or a throwing API still answers JSON')
{
  const capture = async (handlerFn, req) => {
    const out = []
    await handlerFn(req, { writeHead: (code, headers) => out.push({ code, headers }), end: (body) => out.push({ body }) })
    return { code: out[0].code, headers: out[0].headers, body: out[1].body }
  }
  const bodyOf = (text) => async function* () { yield Buffer.from(text, 'utf8') }
  const route = createHostRouteHandler({ requestRejection: () => undefined, resolveApi: () => undefined })
  const broken = await capture(route, { method: 'POST', url: `${ROUTE_PREFIX}/account`, headers: {}, [Symbol.asyncIterator]: bodyOf('{not json') })
  eq('a non-JSON body answers 200', broken.code, 200)
  has('...with a JSON detail', broken.body, '"ok":false')
  has('...naming the problem', broken.body, '不是合法 JSON')
  eq('...and the content type is JSON', broken.headers['Content-Type'], 'application/json; charset=utf-8')
  const throwing = await capture(
    createHostRouteHandler({ requestRejection: () => undefined, resolveApi: () => () => { throw new Error('api exploded') } }),
    { method: 'GET', url: `${ROUTE_PREFIX}/status`, headers: {}, [Symbol.asyncIterator]: async function* () {} }
  )
  eq('a throwing API answers 200 (never a 500)', throwing.code, 200)
  has('...carrying the reason', throwing.body, 'api exploded')
  const posted = []
  const okRoute = createHostRouteHandler({
    requestRejection: () => undefined,
    resolveApi: () => (request) => { posted.push(request); return Promise.resolve({ status: 200, body: { ok: true } }) }
  })
  await capture(okRoute, { method: 'POST', url: `${ROUTE_PREFIX}/account`, headers: {}, [Symbol.asyncIterator]: bodyOf('{"accountId":"a2"}') })
  eq('a JSON body reaches the API as an object', JSON.stringify(posted[0]?.body), JSON.stringify({ accountId: 'a2' }))
  eq('...with the method preserved', posted[0]?.method, 'POST')
  const empty = []
  const okRoute2 = createHostRouteHandler({
    requestRejection: () => undefined,
    resolveApi: () => (request) => { empty.push(request); return Promise.resolve({ status: 200, body: { ok: true } }) }
  })
  await capture(okRoute2, { method: 'POST', url: `${ROUTE_PREFIX}/checkin`, headers: {}, [Symbol.asyncIterator]: bodyOf('') })
  eq('an empty POST body becomes {}', JSON.stringify(empty[0]?.body), '{}')
}

server.close()
await once(server, 'close')

/* ────────────────── 9. isolation ────────────────── */
console.log('\n[9] the check leaves no trace outside its own scratch home')
{
  const { readFileSync, existsSync } = await import('node:fs')
  const tracePath = join(scratchHome, '.dsh-pylon-trae', 'boot.log')
  truthy('apply() traced into the throwaway DSH_HOME', existsSync(tracePath))
  const traceText = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : ''
  has('...and the trace names the routes as mounted', traceText, `${ROUTE_PREFIX} and ${API_ROUTE_PREFIX}${ROUTE_PREFIX}`)
  has('...and it names the deferred case too', traceText, 'host route: deferred')
  eq('the live DSH_HOME is not this one', scratchHome.startsWith(tmpdir()) && !scratchHome.toLowerCase().includes('.dsh\\profiles'), true)
  rmSync(scratchHome, { recursive: true, force: true })
  ok('the throwaway home was removed')
}

console.log('\n' + '-'.repeat(72))
console.log(`${checks - failures}/${checks} checks passed — ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)

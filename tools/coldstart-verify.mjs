#!/usr/bin/env node
/**
 * Cold-start acceptance for dsh-pylon-trae — one command, no human clicks.
 *
 * What one run proves, in order:
 *   1. a REAL DSH process, booted against a THROWAWAY DSH_HOME, mounts this
 *      plugin, starts the loopback shim, reads the live directory and writes the
 *      editable provider entry  →  boot #1 must report `seed: created`
 *      (with `--keep-profile`: `created` or `present`);
 *   2. the entry is really the shape the Models page needs:
 *      `<ns>` → `providers.trae` with a NON-ZERO model list, a baseURL pointing at
 *      our fixed loopback port, and OUR shim token in `headers.Authorization`
 *      (compared by sha256 fingerprint only — the value is never printed);
 *   3. the shim answers `GET /admin/status` ⇒ `{ ok: true, … }` with the bearer
 *      read from `$DSH_HOME/.dsh-pylon-trae/cn-shim-token.json`, and 401 without it;
 *   4. a SECOND boot against the same home is a no-op: `seed: present` and the
 *      patch sha256 is unchanged (a user's pruning survives a restart).
 *
 * Isolation is ENFORCED, not merely intended:
 *   · DSH_HOME is `<workspace>/_trae-coldstart/home`, re-checked before every
 *     write; the operator's real `~/.dsh` is never referenced by this script —
 *     and boot.log's own `guard: home=…` line is asserted to agree;
 *   · the scratch profile gets a junction for THIS plugin only, never to a real
 *     profile's node_modules (a pnpm run there would write into the live one);
 *   · the junction is unlinked BEFORE the profile directory is removed, and the
 *     plugin directory is re-checked afterwards;
 *   · every process this script starts is recorded and killed with
 *     `taskkill /PID <pid> /F /T`; the loopback port is re-checked free, and a
 *     port that stays busy is reported, never silently ignored.
 *
 * Repeatable by design: unless `--keep-profile` is given, the scratch profile is
 * rebuilt (patch back to `[]`) and boot.log is cleared first, so run #2 measures
 * exactly what run #1 measured.
 *
 * Usage:
 *   <dsh-node> tools/coldstart-verify.mjs [--keep-profile] [--capture]
 *                                        [--timeout 90] [--port 7864]
 *                                        [--dsh-profile desktop|zz-trae|unset]
 *                                        [--skip-restart] [--force-port]
 *
 *   --keep-profile   reuse the existing scratch profile instead of rebuilding it
 *   --capture        write the DSH child's stdout/stderr to _trae-coldstart\*.log
 *                    (default is stdio:'ignore' — the plugin's own boot.log is
 *                    the diagnostic channel, the host logger is not readable)
 *   --timeout <sec>  per-boot wait budget (default 90)
 *   --port <n>       loopback shim port to police (default 7864)
 *   --dsh-profile <v> what to put in DSH_PROFILE for the child. Default `desktop`
 *                    reproduces the trap this workspace hit (a stale hint that
 *                    LIES about which profile is mounted); `unset` removes it.
 *   --skip-restart   only verify boot #1 (smoke run)
 *   --force-port     if the port is busy, taskkill the owner even if this script
 *                    did not start it (default: refuse and print the PID)
 *
 * Writes: `_trae-coldstart\home\**` (the throwaway home) plus, at the scratch
 * root, `coldstart-pids.json` (our own process ledger) and optional capture logs.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

// ---------- arguments ----------
const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const KEEP_PROFILE = has('keep-profile')
const CAPTURE = has('capture')
const SKIP_RESTART = has('skip-restart')
const FORCE_PORT = has('force-port')
const TIMEOUT_MS = Math.max(10, Number(opt('timeout', '90'))) * 1000
const PORT = Number(opt('port', '7864'))
const DSH_PROFILE_MODE = opt('dsh-profile', 'desktop')

// ---------- paths (all of them inside the scratch tree) ----------
const PLUGIN_DIR = resolve(import.meta.dirname, '..')
const SCRATCH = resolve(PLUGIN_DIR, '..', '..', '_trae-coldstart')
const HOME = join(SCRATCH, 'home')
const PROFILE_NAME = 'zz-trae'
const PROFILE = join(HOME, 'profiles', PROFILE_NAME)
const PATCH = join(PROFILE, 'cordis.patch.yml')
const OWN_DIR = join(HOME, '.dsh-pylon-trae')
const TRACE = join(OWN_DIR, 'boot.log')
const TOKEN_FILE = join(OWN_DIR, 'cn-shim-token.json')
const STATE_FILE = join(OWN_DIR, 'state.json')
const LEDGER = join(SCRATCH, 'coldstart-pids.json')
const DSH_CMD = '<dsh-cli>'
const COMSPEC = process.env['ComSpec'] ?? 'cmd.exe'

// ---------- reporting ----------
const checks = []
let failures = 0
function check(name, passed, evidence = '') {
  checks.push({ name, passed, evidence })
  if (!passed) failures += 1
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${evidence === '' ? '' : `  — ${evidence}`}`)
  return passed
}
function info(message) {
  console.log(`      ${message}`)
}
const line = (char = '-', width = 78) => char.repeat(width)
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Never let a token reach the terminal, even if a host log line ever carries one. */
function redact(text) {
  return String(text)
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted-jwt>')
}
const fingerprint = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * taskkill/netstat speak the console OEM code page (936 here), not UTF-8 — read
 * their bytes with the right decoder so a failure message is legible instead of
 * mojibake. Falls back to UTF-8 if this Node has no full ICU.
 */
const OEM_DECODER = (() => {
  try {
    return new TextDecoder('gbk')
  } catch {
    return undefined
  }
})()
function decodeOem(output) {
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return ''
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output)
  return OEM_DECODER === undefined ? bytes.toString('utf8') : OEM_DECODER.decode(bytes)
}

// ---------- isolation guard ----------
const REAL_HOME = resolve(homedir(), '.dsh')
if (resolve(HOME) === REAL_HOME || REAL_HOME.startsWith(resolve(HOME) + sep)) {
  console.error(`拒绝运行：DSH_HOME(${HOME}) 与真实 home(${REAL_HOME}) 重叠。`)
  process.exit(2)
}
if (basename(HOME) !== 'home' || basename(SCRATCH) !== '_trae-coldstart') {
  console.error(`拒绝运行：临时 home 的形状不对（${HOME}）—— 期望 <工作区>\\_trae-coldstart\\home。`)
  process.exit(2)
}
if (!resolve(PROFILE).startsWith(resolve(HOME) + sep)) {
  console.error(`拒绝运行：profile 不在临时 home 之内（${PROFILE}）。`)
  process.exit(2)
}

console.log(line('='))
console.log(`dsh-pylon-trae 冷启动验收（自动化）  ${new Date().toISOString()}`)
console.log(line('='))
info(`node            ${process.version}  (${process.execPath})`)
info(`插件目录        ${PLUGIN_DIR}`)
info(`临时 DSH_HOME   ${HOME}`)
info(`临时 profile    ${PROFILE_NAME}`)
info(`活体 profile    ${REAL_HOME}\\profiles\\desktop —— 本脚本全程不引用（见下方 guard 断言）`)
info(`dsh 启动器      ${DSH_CMD}${existsSync(DSH_CMD) ? '' : '  ← 不存在！'}`)
console.log(line())

// ---------- process ledger + port hygiene ----------
function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry) => Number.isInteger(entry?.pid)) : []
  } catch {
    return []
  }
}
function writeLedger(entries) {
  try {
    writeFileSync(LEDGER, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  } catch {
    // the ledger is a convenience; never a reason to fail a run
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function killTree(pid) {
  const run = spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true })
  // Concatenate the BUFFERS, not `${stdout}`: template interpolation would decode
  // the OEM bytes as UTF-8 before the decoder ever sees them (measured: that is
  // exactly how the message came out as mojibake).
  const bytes = Buffer.concat([run.stdout ?? Buffer.alloc(0), run.stderr ?? Buffer.alloc(0)])
  const text = decodeOem(bytes).trim().replace(/\s+/g, ' ')
  return { status: run.status, text }
}
function portOwners(port) {
  const run = spawnSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true })
  const stdout = decodeOem(run.stdout)
  if (run.status !== 0 || stdout === '') return []
  const pids = new Set()
  for (const row of stdout.split(/\r?\n/)) {
    if (!row.includes('LISTENING')) continue
    const columns = row.trim().split(/\s+/)
    if (columns.length < 5) continue
    if (!(columns[1] ?? '').endsWith(`:${port}`)) continue
    const pid = Number(columns[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}
function portFree(port) {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.once('listening', () => probe.close(() => done(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/** Kill anything a previous run of THIS script left behind (never a foreign process). */
function reapLedger() {
  const entries = readLedger()
  const alive = entries.filter((entry) => isAlive(entry.pid))
  if (alive.length > 0) {
    info(`清理上次运行残留的进程：${alive.map((entry) => `${entry.pid}(${entry.label ?? '?'})`).join(' ')}`)
    for (const entry of alive) {
      const result = killTree(entry.pid)
      info(`  taskkill /PID ${entry.pid} /F /T → exit=${result.status}${result.text === '' ? '' : `  ${redact(result.text).slice(0, 200)}`}`)
    }
  }
  writeLedger([])
  return alive.length
}

const liveChildren = new Set()
function trackChild(child, label) {
  liveChildren.add(child.pid)
  writeLedger([...readLedger().filter((entry) => isAlive(entry.pid)), { pid: child.pid, label, at: new Date().toISOString() }])
}
function untrackChild(pid) {
  liveChildren.delete(pid)
  writeLedger(readLedger().filter((entry) => entry.pid !== pid))
}
function killAllOurChildren(reason) {
  for (const pid of [...liveChildren]) {
    if (!isAlive(pid)) {
      liveChildren.delete(pid)
      continue
    }
    const result = killTree(pid)
    console.log(`      收尾(${reason})：taskkill /PID ${pid} /F /T → exit=${result.status}${result.text === '' ? '' : `  ${redact(result.text).slice(0, 200)}`}`)
    untrackChild(pid)
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，收尾…`)
    killAllOurChildren(signal)
    process.exit(130)
  })
}

async function stopChild(child, label) {
  if (child === undefined) return true
  const pid = child.pid
  const result = killTree(pid)
  const note = result.status === 0 ? '（进程树已终止）' : `  ${redact(result.text).slice(0, 200)}`
  console.log(`      停 ${label}：taskkill /PID ${pid} /F /T → exit=${result.status}${note}`)
  untrackChild(pid)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await portFree(PORT)) return true
    await sleep(250)
  }
  const owners = portOwners(PORT)
  console.log(`🔴 ${label} 停掉后端口 ${PORT} 仍被占用：PID ${owners.join(', ') || '(netstat 没报出持有者)'}`)
  for (const owner of owners) {
    if (owner === pid || FORCE_PORT) {
      const extra = killTree(owner)
      console.log(`   ← 补刀 taskkill /PID ${owner} /F /T → exit=${extra.status}`)
    }
  }
  await sleep(500)
  return await portFree(PORT)
}

// ---------- boot.log reading ----------
function traceLines() {
  if (!existsSync(TRACE)) return []
  return readFileSync(TRACE, 'utf8').split(/\r?\n/).filter((row) => row.trim() !== '')
}
const SEED_RE = /seed:\s*([a-z-]+)/
function parseSeed(row) {
  const kind = SEED_RE.exec(row)?.[1] ?? 'unknown'
  const ns = /(llm-[a-z0-9-]+)/.exec(row)?.[1]
  const models = /(\d+)\s*个模型/.exec(row)?.[1]
  return { kind, ns, models: models === undefined ? undefined : Number(models), raw: row }
}

/**
 * Wait until boot.log (from `seen` lines on) contains a `seed:` line.
 * A child that exits first fails immediately — a dead process never seeds.
 */
async function awaitSeed(child, seen, label) {
  const started = Date.now()
  const fresh = []
  let cursor = seen
  for (;;) {
    const all = traceLines()
    if (all.length > cursor) {
      fresh.push(...all.slice(cursor))
      cursor = all.length
    }
    const seedRow = [...fresh].reverse().find((row) => SEED_RE.test(row))
    if (seedRow !== undefined) return { seed: parseSeed(seedRow), fresh, seen: cursor, elapsed: Date.now() - started }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${label} 在写出 seed 之前就退出了（exitCode=${child.exitCode} signal=${child.signalCode}）——` +
          `boot.log 新增 ${fresh.length} 行${CAPTURE ? '，见 _trae-coldstart 下的捕获日志' : '（加 --capture 可看到子进程输出）'}：\n` +
          fresh.map((row) => `        ${redact(row)}`).join('\n')
      )
    }
    if (Date.now() - started > TIMEOUT_MS) {
      throw new Error(
        `${label} 等待 seed 超时（${seconds(TIMEOUT_MS)}）。boot.log 新增 ${fresh.length} 行：\n` +
          (fresh.length === 0 ? '        (没有任何新增行 —— 插件可能根本没激活)' : fresh.map((row) => `        ${redact(row)}`).join('\n'))
      )
    }
    await sleep(250)
  }
}

async function startDsh(label) {
  const env = { ...process.env, DSH_HOME: HOME, DSH_NODE: process.execPath }
  if (DSH_PROFILE_MODE === 'unset') delete env['DSH_PROFILE']
  else env['DSH_PROFILE'] = DSH_PROFILE_MODE
  let stdio = 'ignore'
  let fd
  if (CAPTURE) {
    fd = openSync(join(SCRATCH, `coldstart-${label}.log`), 'a')
    stdio = ['ignore', fd, fd]
  }
  // A .cmd cannot be spawned directly on Windows any more; go through cmd.exe.
  // `cmd /d /s /c ""<launcher>" --profile <name>"` is the form Node's own
  // `shell: true` uses — and it needs `windowsVerbatimArguments`, otherwise libuv
  // escapes the inner quotes as `\"`, which cmd.exe reads as a literal backslash
  // and answers with "The filename, directory name, or volume label syntax is
  // incorrect." (measured, not guessed).
  const inner = `"${DSH_CMD}" --profile ${PROFILE_NAME}`
  const child = spawn(COMSPEC, ['/d', '/s', '/c', `"${inner}"`], {
    cwd: SCRATCH,
    env,
    stdio,
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  if (fd !== undefined) closeSync(fd)
  trackChild(child, label)
  return child
}

// ---------- patch inspection (a structural read, never a print of the file) ----------
const indentOf = (row) => row.length - row.trimStart().length
const isBlank = (row) => row.trim() === '' || row.trimStart().startsWith('#')

/** [start, end) of the block introduced by `key:` at `keyIndex`, honouring indentation. */
function blockEnd(rows, keyIndex, keyIndent) {
  for (let i = keyIndex + 1; i < rows.length; i += 1) {
    if (isBlank(rows[i])) continue
    if (indentOf(rows[i]) <= keyIndent) return i
  }
  return rows.length
}

/**
 * Find `providers.<id>` and count its models.
 * Deliberately a tiny structural reader instead of a YAML dependency: the shape
 * is written by this plugin, and "how many model ids are in there" is the fact
 * that matters.
 */
function readProviderBlock(text, providerId) {
  const rows = text.split(/\r?\n/)
  const result = {
    namespace: undefined,
    topLevelEntries: rows.filter((row) => /^- /.test(row)).length,
    providerId,
    found: false,
    models: 0,
    baseUrl: undefined,
    authorization: undefined
  }
  const nsRow = rows.find((row) => /^-\s+id:\s*\S+/.test(row))
  if (nsRow !== undefined) result.namespace = /^-\s+id:\s*(\S+)/.exec(nsRow)?.[1]
  let providersIndex = -1
  let providersIndent = 0
  for (let i = 0; i < rows.length; i += 1) {
    const match = /^(\s*)providers:\s*$/.exec(rows[i])
    if (match !== null) {
      providersIndex = i
      providersIndent = match[1].length
      break
    }
  }
  if (providersIndex === -1) return result
  const providersEnd = blockEnd(rows, providersIndex, providersIndent)
  for (let i = providersIndex + 1; i < providersEnd; i += 1) {
    const match = /^(\s*)([^\s#][^:]*):\s*$/.exec(rows[i])
    if (match === null || match[1].length <= providersIndent || match[2].trim() !== providerId) continue
    result.found = true
    const providerIndent = match[1].length
    const providerEnd = blockEnd(rows, i, providerIndent)
    for (let j = i + 1; j < providerEnd; j += 1) {
      const base = /^(\s*)baseURL:\s*(\S+)\s*$/.exec(rows[j])
      if (base !== null && base[1].length > providerIndent) result.baseUrl = base[2]
      const auth = /^(\s*)Authorization:\s*(.+?)\s*$/.exec(rows[j])
      if (auth !== null && auth[1].length > providerIndent) result.authorization = auth[2]
      const modelsKey = /^(\s*)models:\s*$/.exec(rows[j])
      if (modelsKey === null || modelsKey[1].length <= providerIndent) continue
      const modelsIndent = modelsKey[1].length
      const modelsEnd = blockEnd(rows, j, modelsIndent)
      for (let k = j + 1; k < modelsEnd; k += 1) {
        if (indentOf(rows[k]) >= modelsIndent && /^\s*-\s+id:\s*\S+/.test(rows[k])) result.models += 1
      }
    }
    break
  }
  return result
}

async function stableHash(path, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs
  let previous = sha256File(path)
  while (Date.now() < deadline) {
    await sleep(250)
    const next = sha256File(path)
    if (next === previous) return next
    previous = next
  }
  return previous
}

async function adminStatus(token) {
  const url = `http://127.0.0.1:${PORT}`
  const bearer = await fetch(`${url}/admin/status`, { headers: { Authorization: `Bearer ${token}` } })
  const bearerBody = await bearer.json().catch(() => ({}))
  const bare = await fetch(`${url}/admin/status`)
  const health = await fetch(`${url}/healthz`, { headers: { Authorization: `Bearer ${token}` } })
  const healthBody = await health.json().catch(() => ({}))
  return { bearer, bearerBody, bare, health, healthBody }
}

// ---------- pre-flight ----------
console.log('准备：')
const reaped = reapLedger()
info(reaped === 0 ? '没有上次运行残留的进程' : `已清理 ${reaped} 个上次运行的进程`)

if (!(await portFree(PORT))) {
  const owners = portOwners(PORT)
  console.log(`🔴 端口 ${PORT} 已被占用：PID ${owners.join(', ') || '(netstat 没报出持有者)'}`)
  info('这不是本脚本启动的进程。先自己确认它是谁，再决定；或加 --force-port 让本脚本 taskkill 它。')
  if (!FORCE_PORT) {
    console.log('结论：未开始即中止（端口不干净会伪装成插件失败）。')
    process.exit(2)
  }
  for (const owner of owners) {
    const result = killTree(owner)
    info(`--force-port：taskkill /PID ${owner} /F /T → exit=${result.status}`)
  }
  await sleep(750)
  if (!(await portFree(PORT))) {
    console.log(`🔴 --force-port 之后端口 ${PORT} 仍然被占用，中止。`)
    process.exit(2)
  }
}
info(`端口 ${PORT} 空闲`)

mkdirSync(OWN_DIR, { recursive: true })
const junction = join(PROFILE, 'node_modules', 'dsh-pylon-trae')

if (!KEEP_PROFILE) {
  // Unlink the junction FIRST: a recursive delete of a directory that contains a
  // junction is exactly the kind of thing that eats a source tree.
  if (existsSync(junction)) rmSync(junction, { force: true, recursive: false })
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
  if (!existsSync(join(PLUGIN_DIR, 'package.json'))) {
    console.log('🔴 插件目录在重建临时 profile 后不见了 —— 立刻中止。')
    process.exit(2)
  }
  // Same minimal recipe as tools/make-temp-profile.mjs (an empty entry list, one
  // bundle list, one user patch, one junction — no third-party suspects).
  writeFileSync(join(PROFILE, 'cordis.yml'), '# scratch profile for the dsh-pylon-trae cold start — an empty entry list.\n[]\n', 'utf8')
  writeFileSync(
    join(PROFILE, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE_NAME}`,
        private: true,
        dependencies: { 'dsh-pylon-trae': `link:${PLUGIN_DIR.replaceAll('\\', '/')}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-pylon-trae'] } }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  writeFileSync(PATCH, '# scratch profile patch (user layer) — our plugin writes its provider entry here\n[]\n', 'utf8')
  symlinkSync(PLUGIN_DIR, junction, 'junction')
  rmSync(STATE_FILE, { force: true })
  info('临时 profile 已重建：cordis.yml=[] · package.json(bundles=base+dsh-pylon-trae) · cordis.patch.yml=[] · 只 junction 本插件')
} else {
  info('--keep-profile：沿用现有临时 profile（不重置 patch）')
  if (!existsSync(junction)) symlinkSync(PLUGIN_DIR, junction, 'junction')
}

writeFileSync(TRACE, '', 'utf8')
const patchBytesBefore1 = existsSync(PATCH) ? readFileSync(PATCH).length : 0
const patchHashBefore1 = sha256File(PATCH)
info(`boot.log 已清空（本次运行从零开始）`)
info(`写前 patch：${patchBytesBefore1} B · sha256 ${patchHashBefore1.slice(0, 16)} · 顶层条目 ${readProviderBlock(readFileSync(PATCH, 'utf8'), 'trae').topLevelEntries}`)
console.log(line())

// ---------- boot #1 ----------
const runStarted = Date.now()
let child1
let token
let statusResult
let seed1
let patch1
let patchRow1
{
  console.log(`[1/2] 冷启动 #1：${DSH_CMD} --profile ${PROFILE_NAME}  (DSH_HOME=${HOME}, DSH_PROFILE=${DSH_PROFILE_MODE}, stdio=${CAPTURE ? 'capture' : 'ignore'})`)
  const bootStarted = Date.now()
  child1 = await startDsh('boot1')
  info(`已启动 cmd.exe PID ${child1.pid}（子进程树用 taskkill /T 收）`)
  let failure
  try {
    const waited = await awaitSeed(child1, 0, '冷启动 #1')
    seed1 = waited.seed
    info(`boot.log 新增 ${waited.fresh.length} 行（${seconds(waited.elapsed)} 后出现 seed 行）：`)
    for (const row of waited.fresh) info(`  ${redact(row)}`)
  } catch (error) {
    failure = error
    check('冷启动 #1 写出了 seed 行（插件真的跑到了写配置那一步）', false, error instanceof Error ? error.message : String(error))
  }
  if (failure === undefined) {
    check(
      `seed 行是 created${KEEP_PROFILE ? '（或 present，keep 模式）' : ''}`,
      seed1.kind === 'created' || (KEEP_PROFILE && seed1.kind === 'present'),
      `kind=${seed1.kind}${seed1.models === undefined ? '' : ` · ${seed1.models} 个模型`}`
    )
    // The guard line is the isolation proof: it names the home the plugin wrote in.
    const guardRow = traceLines().find((row) => /guard: home=/.test(row))
    const guardHome = guardRow === undefined ? undefined : /guard: home=([^·]+?)\s*·/.exec(guardRow)?.[1]?.trim()
    check(
      'guard 认定的 home 就是本次临时 home（隔离证据）',
      guardHome !== undefined && resolve(guardHome).toLowerCase() === resolve(HOME).toLowerCase(),
      guardHome === undefined ? 'boot.log 里没有 guard 行' : `home=${guardHome}`
    )
  }

  if (failure === undefined) {
    // --- the entry itself ---
    const patchText = readFileSync(PATCH, 'utf8')
    const bytesAfter = readFileSync(PATCH).length
    const block = readProviderBlock(patchText, 'trae')
    patchRow1 = block
    info(`写后 patch：${patchBytesBefore1} B → ${bytesAfter} B · 顶层条目 ${block.topLevelEntries} · 命名空间 ${block.namespace ?? '?'}`)
    check('patch 里出现 providers.trae', block.found && block.providerId === 'trae', `providers.${block.providerId} ${block.found ? '存在' : '缺失'}`)
    const models = block.models
    check('providers.trae 的模型数 > 0', models > 0, `${models} 个模型${seed1.models === undefined ? '' : `（seed 行自报 ${seed1.models}）`}`)
    if (seed1.models !== undefined && models > 0) {
      check('seed 行自报的模型数与 patch 实际条目一致', seed1.models === models, `trace=${seed1.models} · patch=${models}`)
    }
    check('baseURL 指向本插件的固定回环端口', block.baseUrl === `http://127.0.0.1:${PORT}/v1`, `${block.baseUrl ?? '(缺失)'}`)

    // --- the token: compare fingerprints, print neither value ---
    const tokenLine = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/)[0].trim() : ''
    token = tokenLine
    check('回环 token 已落盘', tokenLine !== '', `${TOKEN_FILE}（长度 ${tokenLine.length}，值不打印）`)
    const authValue = block.authorization === undefined ? '' : (/(?:Bearer\s+)?(.*)$/.exec(block.authorization)?.[1] ?? '')
    check(
      'patch 里的 Authorization 就是我们自己的 shim token',
      authValue !== '' && tokenLine !== '' && fingerprint(authValue) === fingerprint(tokenLine),
      `patch fp=${authValue === '' ? '(缺失)' : fingerprint(authValue)} · 磁盘 fp=${tokenLine === '' ? '(缺失)' : fingerprint(tokenLine)}`
    )
    check('patch 顶层仍是 YAML 列表（未被写坏）', block.topLevelEntries >= 1, `${block.topLevelEntries} 个顶层条目`)

    // --- the live shim ---
    if (token !== '') {
      try {
        statusResult = await adminStatus(token)
        const body = statusResult.bearerBody
        check(
          `GET /admin/status（带 Bearer）⇒ ok:true`,
          statusResult.bearer.status === 200 && body['ok'] === true,
          `HTTP ${statusResult.bearer.status} · modelCount=${body['modelCount'] ?? '?'} · region=${body['region'] ?? '?'}`
        )
        check('模型数为正且与 patch 一致', Number(body['modelCount']) > 0 && Number(body['modelCount']) === models, `status=${body['modelCount'] ?? '?'} · patch=${models}`)
        const credential = body['credential']
        if (typeof credential === 'object' && credential !== null) {
          const face = credential
          info(`凭据：${face['source']}/${face['edition']} user=${face['userId']} 到期=${new Date(Number(face['expiresAtMs'])).toISOString()}`)
        }
        info(`账号数：${Array.isArray(body['accounts']) ? body['accounts'].length : 0}（同机可见的 Trae 凭据）`)
        check('不带 Bearer ⇒ 401（鉴权真的生效）', statusResult.bare.status === 401, `HTTP ${statusResult.bare.status}`)
        check('GET /healthz ⇒ 200 且模型数为正', statusResult.health.status === 200 && Number(statusResult.healthBody['models']) > 0, `HTTP ${statusResult.health.status} · models=${statusResult.healthBody['models'] ?? '?'}`)
      } catch (error) {
        check('GET /admin/status（带 Bearer）⇒ ok:true', false, `打不通：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    patch1 = await stableHash(PATCH)
    check(
      KEEP_PROFILE ? 'patch 可读且非空' : 'boot#1 真的写了文件（不是"created 却空转"）',
      KEEP_PROFILE ? readFileSync(PATCH).length > 0 : patchHashBefore1 !== patch1,
      `写前 sha256 ${patchHashBefore1.slice(0, 16)} → 写后 ${patch1.slice(0, 16)} · ${readFileSync(PATCH).length} B`
    )
  }
  console.log(`      冷启动 #1 用时 ${seconds(Date.now() - bootStarted)}`)
}

// ---------- stop #1 ----------
let portReleased1 = false
if (child1 !== undefined) {
  portReleased1 = await stopChild(child1, '冷启动 #1')
  check(`停掉 #1 后端口 ${PORT} 已释放`, portReleased1, portReleased1 ? '空闲' : `仍被 PID ${portOwners(PORT).join(', ') || '?'} 占用`)
}

// ---------- boot #2 ----------
if (failures === 0 && !SKIP_RESTART && patch1 !== undefined) {
  console.log(line())
  console.log(`[2/2] 冷启动 #2（同一 profile、同一 home，只验证"二次启动是 no-op"）`)
  const bootStarted = Date.now()
  const bytesBefore2 = readFileSync(PATCH).length
  const mtimeBefore2 = statSync(PATCH).mtimeMs
  const seen = traceLines().length
  const child2 = await startDsh('boot2')
  info(`已启动 cmd.exe PID ${child2.pid}`)
  let failure
  try {
    const waited = await awaitSeed(child2, seen, '冷启动 #2')
    info(`boot.log 新增 ${waited.fresh.length} 行（${seconds(waited.elapsed)} 后出现 seed 行）：`)
    for (const row of waited.fresh) info(`  ${redact(row)}`)
    check('二次启动是 seed: present（一个字都没写）', waited.seed.kind === 'present', `kind=${waited.seed.kind}`)
  } catch (error) {
    failure = error
    check('二次启动是 seed: present（一个字都没写）', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  }
  const hashAfter2 = await stableHash(PATCH)
  const bytesAfter2 = readFileSync(PATCH).length
  check(
    'patch sha256 未变（用户的删减活过重启）',
    hashAfter2 === patch1,
    `#1 后 ${patch1.slice(0, 16)} → #2 后 ${hashAfter2.slice(0, 16)} · ${bytesBefore2} B → ${bytesAfter2} B · mtime ${mtimeBefore2 === statSync(PATCH).mtimeMs ? '未变' : '变了'}`
  )
  if (failure === undefined && token !== undefined && token !== '') {
    try {
      const second = await fetch(`http://127.0.0.1:${PORT}/healthz`, { headers: { Authorization: `Bearer ${token}` } })
      const secondBody = await second.json().catch(() => ({}))
      check('二次启动后 shim 仍在服务', second.status === 200 && secondBody['ok'] === true, `HTTP ${second.status} · models=${secondBody['models'] ?? '?'}`)
    } catch (error) {
      check('二次启动后 shim 仍在服务', false, `healthz 打不通：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`      冷启动 #2 用时 ${seconds(Date.now() - bootStarted)}`)
  const portReleased2 = await stopChild(child2, '冷启动 #2')
  check(`停掉 #2 后端口 ${PORT} 已释放`, portReleased2, portReleased2 ? '空闲' : `仍被 PID ${portOwners(PORT).join(', ') || '?'} 占用`)
} else if (SKIP_RESTART) {
  console.log(line())
  info('--skip-restart：跳过二次启动')
} else {
  console.log(line())
  info('boot #1 有失败项 ⇒ 不再做二次启动（先把第一次弄对）')
}

// ---------- leftover check ----------
const stragglers = [...liveChildren].filter(isAlive)
if (stragglers.length > 0) {
  console.log(`🔴 仍有本脚本启动的进程活着：${stragglers.join(', ')} —— 正在补杀`)
  killAllOurChildren('收尾')
}
const finalOwners = portOwners(PORT)
if (finalOwners.length > 0) {
  console.log(`🔴 结束前端口 ${PORT} 仍被占用：PID ${finalOwners.join(', ')}（这会让下一次运行失败，请手动处理）`)
}
const backups = existsSync(HOME) ? readFileSync(TRACE, 'utf8').split(/\r?\n/).filter((row) => /seed:\s*created/.test(row)).length : 0

// ---------- verdict ----------
console.log(line('='))
console.log(`结论`)
console.log(line('='))
const passed = checks.filter((entry) => entry.passed).length
for (const entry of checks) if (!entry.passed) console.log(`  FAIL  ${entry.name}  — ${entry.evidence}`)
const ok = failures === 0
if (ok) {
  console.log(`✅ 冷启动验收通过：${passed}/${checks.length} 项断言全部 PASS`)
  console.log(`   boot #1  seed=${seed1?.kind} · patch ${patchBytesBefore1} B → ${existsSync(PATCH) ? readFileSync(PATCH).length : 0} B · providers.trae=${patchRow1?.models} 个模型`)
  console.log(`   /admin/status  ok=${statusResult?.bearerBody?.['ok'] ?? '?'} · modelCount=${statusResult?.bearerBody?.['modelCount'] ?? '?'} · 无 Bearer HTTP ${statusResult?.bare?.status ?? '?'}`)
  if (!SKIP_RESTART) console.log(`   boot #2  seed=present · patch sha256 ${patch1?.slice(0, 16)}（与 #1 后一致）`)
  console.log(`   端口 ${PORT} 结束时${finalOwners.length === 0 ? '空闲' : `仍被 ${finalOwners.join(', ')} 占用`} · boot.log 里 ${backups} 次 create 记录`)
} else {
  console.log(`🔴 冷启动验收未通过：${failures} 项失败 / 共 ${checks.length} 项`)
}
console.log(`   本次运行 ${seconds(Date.now() - runStarted)} · 活体 profile 未被本脚本引用（guard 断言见上）`)
console.log(line('='))
process.exit(ok ? 0 : 1)

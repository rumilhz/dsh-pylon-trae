/**
 * dsh-pylon-trae — two-boot cold start on an ISOLATED DSH_HOME.
 *
 * WHY THIS EXISTS INSTEAD OF tools/coldstart-verify.mjs
 *   That harness polices the plugin's DEFAULT port 7864, and 7864 is currently
 *   held by PID 24088 — the user's LIVE DeepSeek Harness Desktop Host, i.e. the
 *   very process serving the session that asked for this rename. Its port guard
 *   cannot be satisfied without taskkill-ing that process (--force-port) or
 *   editing the harness (out of scope), so this runs the SAME two boots against a
 *   scratch home whose patch pins the shim to a free port instead.
 *
 * The boot recipe is the one that reproduces reliably on this box (rebuilt
 * profile → poll boot.log → seed line); stdio is piped so the child's own output
 * is available when something goes wrong.
 *
 * Asserts exactly what the rename could have broken:
 *   boot #1: the bundle loads under its NEW bare name `dsh-pylon-trae` and the
 *            plugin seeds a provider entry       -> patch gains providers.trae
 *   boot #2: same home, same profile            -> seed: present, patch sha256 unchanged
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PLUGIN_DIR = resolve(import.meta.dirname, '..')
const SCRATCH = resolve(PLUGIN_DIR, '..', '..', '_rename-scratch', 'coldstart')
const HOME = join(SCRATCH, 'home')
const PROFILE_NAME = 'zz-pylon'
const PROFILE = join(HOME, 'profiles', PROFILE_NAME)
const PATCH = join(PROFILE, 'cordis.patch.yml')
const OWN_DIR = join(HOME, '.dsh-pylon-trae')
const TRACE = join(OWN_DIR, 'boot.log')
const PORT = 17864
const NAME = 'dsh-pylon-trae'
/**
 * The DSH CLI to boot. Explicit override first, else the copy shipped beside the
 * Node that DSH itself runs on, else `dsh` from PATH — so no machine is named.
 */
function dshCli() {
  const explicit = process.env['DSH_CLI'] ?? process.env['DSH_CMD']
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const name = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  // process.execPath is <install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
  const resources = resolve(dirname(process.execPath), '..', '..', '..', '..', '..')
  const derived = join(resources, 'runtime', 'cli', 'bin', name)
  return existsSync(derived) ? derived : name
}
const DSH_CMD = dshCli()
const COMSPEC = process.env['ComSpec'] ?? 'cmd.exe'

const sha256 = (t) => createHash('sha256').update(t).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const traceLines = () => (existsSync(TRACE) ? readFileSync(TRACE, 'utf8').split(/\r?\n/).filter((r) => r.trim() !== '') : [])
const SEED_RE = /seed:\s*(created|present|refreshed|rolled-back|failed|no-namespace)/

let failures = 0
const check = (label, cond, evidence = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${evidence === '' ? '' : `  ${evidence}`}`)
  if (!cond) failures += 1
}

/* ─────────────────── rebuild the scratch profile (new bare name) ─────────────────── */
const junction = join(PROFILE, 'node_modules', NAME)
if (existsSync(junction)) rmSync(junction, { force: true, recursive: false })
rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
mkdirSync(OWN_DIR, { recursive: true })
symlinkSync(PLUGIN_DIR, junction, 'junction')
writeFileSync(join(PROFILE, 'cordis.yml'), '# scratch profile for the dsh-pylon-trae cold start — an empty entry list.\n[]\n', 'utf8')
writeFileSync(
  join(PROFILE, 'package.json'),
  `${JSON.stringify(
    {
      name: `dsh-profile-${PROFILE_NAME}`,
      private: true,
      dependencies: { [NAME]: `link:${PLUGIN_DIR.replaceAll('\\', '/')}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', NAME] } }
    },
    null,
    2
  )}\n`,
  'utf8'
)
// The ONLY deviation from the harness recipe: pin our own port in the user layer so
// this instance never competes with the live app for 7864. The plugin reads it back
// as its `port` config and the seeded baseURL follows it.
writeFileSync(PATCH, `# scratch profile patch (user layer) — our plugin writes its provider entry here\n- id: ${NAME}\n  config:\n    port: ${PORT}\n`, 'utf8')
rmSync(TRACE, { force: true })

console.log(`isolated DSH_HOME = ${HOME}`)
console.log(`profile           = ${PROFILE_NAME}   bundles = ["@deepseek-ai/dsh-base", "${NAME}"]`)
console.log(`junction          = ${junction}  (resolves: ${existsSync(join(junction, 'package.json'))})`)
console.log(`shim port         = ${PORT}   (the live app keeps 7864)\n`)

/* ─────────────────────────────── boot + wait ─────────────────────────────── */
async function bootAndWait(label, seen, timeoutMs = 90000) {
  const env = { ...process.env, DSH_HOME: HOME, DSH_NODE: process.execPath, DSH_PROFILE: PROFILE_NAME }
  const inner = `"${DSH_CMD}" --profile ${PROFILE_NAME}`
  const child = spawn(COMSPEC, ['/d', '/s', '/c', `"${inner}"`], {
    cwd: SCRATCH,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d.toString()))
  child.stderr.on('data', (d) => (out += d.toString()))
  const kill = () => {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const fresh = traceLines().slice(seen)
    const hit = fresh.find((r) => SEED_RE.test(r))
    if (hit !== undefined) {
      kill()
      await sleep(900)
      return { kind: SEED_RE.exec(hit)?.[1] ?? 'unknown', fresh, out }
    }
    // The DSH CLI is free to exit once its boot work is done, so a non-null
    // exitCode is only a failure if no seed line ever appeared.
    if (child.exitCode !== null) {
      await sleep(600)
      const late = traceLines().slice(seen)
      const lateHit = late.find((r) => SEED_RE.test(r))
      if (lateHit !== undefined) return { kind: SEED_RE.exec(lateHit)?.[1] ?? 'unknown', fresh: late, out }
      throw new Error(
        `${label}：子进程已退出（exit=${child.exitCode}）且 boot.log 里没有 seed 行。child output:\n` +
          out.split(/\r?\n/).slice(0, 25).map((l) => '    ' + l).join('\n')
      )
    }
    await sleep(300)
  }
  kill()
  throw new Error(`${label}：等待 seed 超时。boot.log 新增 ${traceLines().slice(seen).length} 行`)
}

const report = (result) => {
  console.log('       trace:')
  for (const row of result.fresh) console.log(`         ${row.replace(/^[0-9T:.Z-]+\s+/, '').slice(0, 150)}`)
}

try {
  /* ────────────────────────────── boot #1 ────────────────────────────── */
  console.log('[1/2] cold start #1 — fresh home, patch carries only the port pin')
  const patchBefore = readFileSync(PATCH, 'utf8')
  check('boot #1 starts with no providers.trae yet', !patchBefore.includes('providers:'))
  const r1 = await bootAndWait('冷启动 #1', 0)
  report(r1)
  check('boot #1 reports seed: created', r1.kind === 'created', `kind=${r1.kind}`)
  const patch1 = readFileSync(PATCH, 'utf8')
  const hash1 = sha256(patch1)
  check('patch gained a providers.trae entry', /providers:\s*\n\s+trae:/.test(patch1))
  check(`seeded baseURL points at the pinned port ${PORT}`, patch1.includes(`http://127.0.0.1:${PORT}/v1`), `found=${/baseURL:\s*(\S+)/.exec(patch1)?.[1] ?? '(none)'}`)
  check('the pinned port survived the write', /port:\s*17864/.test(patch1))
  const models = (patch1.match(/^\s+- id:\s*\S+/gm) ?? []).length
  check('models were seeded (> 0)', models > 0, `${models} model ids`)

  /* ────────────────────────────── boot #2 ────────────────────────────── */
  console.log('\n[2/2] cold start #2 — same home, same profile (must be a no-op)')
  const seen2 = traceLines().length
  const r2 = await bootAndWait('冷启动 #2', seen2)
  report(r2)
  check('boot #2 reports seed: present', r2.kind === 'present', `kind=${r2.kind}`)
  const hash2 = sha256(readFileSync(PATCH, 'utf8'))
  check('patch sha256 unchanged across the restart', hash2 === hash1, `${hash1.slice(0, 16)} -> ${hash2.slice(0, 16)}`)

  console.log(`\n${failures === 0 ? 'COLD START OK (2 boots, isolated home)' : `${failures} FAILURE(S)`}`)
} catch (error) {
  console.error(`\n🔴 ${error instanceof Error ? error.message : String(error)}`)
  console.error('   boot.log (tail):')
  for (const row of traceLines().slice(-12)) console.error(`     ${row.slice(0, 160)}`)
  failures += 1
}
process.exit(failures === 0 ? 0 : 1)

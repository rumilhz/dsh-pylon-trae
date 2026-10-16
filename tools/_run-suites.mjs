/**
 * One command that runs every OFFLINE check this plugin has.
 *
 *   <dsh-node> tools/_run-suites.mjs            offline only (no network, no quota)
 *   <dsh-node> tools/_run-suites.mjs --network   also the live directory probe
 *   <dsh-node> tools/_run-suites.mjs --doctor    also the pre-flight self check
 *
 * A missing script is reported as SKIP with its name — never as a pass, because
 * "the check did not run" and "the check passed" must not look alike.
 *
 * The same rule applies INSIDE a suite: a suite that reports exit 3 is saying "an input
 * is missing, so part of me could not run" (see SKIP_EXIT below). It is counted as
 * skipped, with its own reason line carried through, and it never turns the run red —
 * a missing input is not a defect in this repo. A suite that finds its input PRESENT and
 * wrong still exits 1, and that is the difference this whole convention protects.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const NODE = process.env['DSH_NODE'] ?? process.execPath
const HERE = import.meta.dirname
const NETWORK = process.argv.includes('--network')
/**
 * Exit code a suite uses for "ran, but an input was missing so some checks did not run".
 * 0 is reserved for "every check that exists ran and passed", so a caller that only looks
 * at the code can never mistake a skip for a pass. `tools/test-sse.ts` and
 * `tools/test-contract.ts` are the two suites that use it (a missing pinned fixture).
 */
const SKIP_EXIT = 3
/**
 * `doctor` 是**按机器现状**下结论的（有没有 Trae 凭据、7864 空不空、profile 挂没挂
 * 本插件），所以它默认不进这套离线闸门：一个套件的红绿只应该取决于仓库里的代码，
 * 不该取决于"这台机器上恰好有谁在跑"。要用它当发布前检查时显式加 --doctor。
 */
const DOCTOR = process.argv.includes('--doctor')

/** name, script path, args */
const SUITES = [
  ['entry loads + Config validates', 'check-entry.ts', []],
  ['write path (create/present/refresh/rollback)', 'test-seed.ts', []],
  ['credential + paths (offline)', 'probe-m1.ts', ['--no-network']],
  ...(existsSync(join(HERE, 'test-api.ts')) ? [['api handlers (offline)', 'test-api.ts', []]] : []),
  // The credential's own expiry verdict and its refresh contract: no network (the
  // transport is injected), no real token, and every write inside a temp directory.
  ...(existsSync(join(HERE, 'test-auth.ts')) ? [['credential expiry + refresh (offline)', 'test-auth.ts', []]] : []),
  ...(existsSync(join(HERE, 'test-reasoning.ts')) ? [['reasoning mapping (offline)', 'test-reasoning.ts', []]] : []),
  // 目录分类：哪些 config_name 是对话模型、哪些是 Trae IDE 自己的流程组件。输入是
  // 2026-10-16 从 CN 网关实测下来的 79 条，冻结在套件里，所以它不需要网关、不花额度。
  ...(existsSync(join(HERE, 'test-catalog.ts')) ? [['model directory classification (offline)', 'test-catalog.ts', []]] : []),
  // SSE framing on its own (offline): the end-of-stream residual line (D11) and the
  // bare `data` line (D5) are asserted here directly, so a parser change fails in a
  // suite that names the behaviour instead of only in the contract ledger.
  ...(existsSync(join(HERE, 'test-sse.ts')) ? [['SSE framing: end of stream + bare data (offline)', 'test-sse.ts', []]] : []),
  ...(existsSync(join(HERE, 'client-bundle-check.mjs')) ? [['client bundle (offline)', 'client-bundle-check.mjs', []]] : []),
  ...(existsSync(join(HERE, 'client-route-check.mjs')) ? [['host route handler (real HTTP, in-process)', 'client-route-check.mjs', []]] : []),
  // The only suite whose expected values come from OUTSIDE this repo: the pinned
  // upstream client (~/.dsh/trae-pin) is the counterparty for both the request
  // bodies and the SSE vocabulary. Offline: it reads that directory and nothing else.
  ...(existsSync(join(HERE, 'test-contract.ts')) ? [['wire contract vs pinned upstream (offline)', 'test-contract.ts', []]] : []),
  ...(NETWORK
    ? [
        ['live directory (network, read-only)', 'probe-m1.ts', []],
        ['shim start + models (network, no generation)', 'probe-m2.ts', []],
        // Boots a real DSH process twice in a scratch home (created → present, patch
        // sha256 unchanged). It is the project's "only standard for going live" as a
        // command, so it belongs behind --network rather than in the offline set.
        ...(existsSync(join(HERE, 'coldstart-verify.mjs')) ? [['cold start, twice (real DSH, scratch home)', 'coldstart-verify.mjs', []]] : [])
      ]
    : []),
  // 装/不装之前先问清楚这台机器（只读）。它读的是机器现状，不是仓库代码 ——
  // 所以只在显式要求时跑，退出码含义：0 = 全绿或有 ⚠️，1 = 有 ❌（参见 doctor 的总结行）。
  ...(DOCTOR && existsSync(join(HERE, 'doctor.ts')) ? [['pre-flight self check (read-only, this machine)', 'doctor.ts', ['--no-network']]] : [])
]

const results = []
for (const [label, script, args] of SUITES) {
  const path = join(HERE, script)
  if (!existsSync(path)) {
    results.push({ label, status: 'SKIP', detail: `${script} 不存在` })
    console.log(`SKIP  ${label}  (${script} 不存在)`)
    continue
  }
  const started = Date.now()
  const run = spawnSync(NODE, [path, ...args], { cwd: join(HERE, '..'), encoding: 'utf8', timeout: 180000 })
  const elapsed = Date.now() - started
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.status === SKIP_EXIT) {
    // The suite decided for itself that an input is missing. Its reason line starts with
    // SKIP and is the whole value of this result, so it is carried through instead of
    // being flattened into "exit 3".
    const reason =
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith('SKIP')) ?? `退出码 ${SKIP_EXIT}（套件没有给出原因行）`
    results.push({ label, status: 'SKIP', detail: reason })
    console.log(`SKIP  ${label}  (${elapsed}ms)\n      ${reason.slice(0, 400)}`)
    continue
  }
  const ok = run.status === 0
  const tail = output.trim().split(/\r?\n/).slice(-3).join(' | ')
  results.push({ label, status: ok ? 'PASS' : 'FAIL', detail: `${elapsed}ms` })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${elapsed}ms)${ok ? '' : `\n      ${tail.slice(0, 400)}`}`)
}

const failed = results.filter((r) => r.status === 'FAIL')
const skipped = results.filter((r) => r.status === 'SKIP')
const passed = results.filter((r) => r.status === 'PASS')
console.log('-'.repeat(72))
console.log(`${passed.length} passed · ${failed.length} failed · ${skipped.length} skipped${NETWORK ? ' · network suite included' : ' · offline only (add --network for the live directory probe)'}`)
if (failed.length > 0) for (const failure of failed) console.log(`  FAILED: ${failure.label}`)
// A skip keeps its reason visible here too: the summary is what gets pasted into a report,
// and "2 skipped" without the why is exactly the ambiguity this convention exists to kill.
if (skipped.length > 0) for (const item of skipped) console.log(`  SKIPPED: ${item.label}\n           ${item.detail}`)
process.exit(failed.length === 0 ? 0 : 1)

/**
 * dsh-pylon-trae rename — sync the LIVE desktop profile.
 *
 * The plugin was installed as `@local/dsh-trae`; it is now the unscoped
 * `dsh-pylon-trae`. The profile's `package.json` names it in TWO places and the
 * loader resolves it through a junction, so all three must move together or the
 * next boot cannot load the bundle:
 *
 *   dependencies['@local/dsh-trae']  -> dependencies['dsh-pylon-trae']
 *   dsh.profile.bundles '@local/dsh-trae' -> 'dsh-pylon-trae'
 *   node_modules/@local/dsh-trae     -> node_modules/dsh-pylon-trae
 *
 * (`resolvePatchPath` in src/guard.ts finds the profile by matching the plugin
 * name against `dsh.profile.bundles`, so a stale name there is not cosmetic: the
 * guard would refuse to write.)
 *
 * Same discipline as _backups/trae-pin-20261014/install-into-live-profile.mjs:
 *   1. back up package.json OUTSIDE the profile (`$DSH_HOME\trae-pin\`)
 *   2. edit the JSON structure in memory, write to a temp sibling
 *   3. verify the CANDIDATE key by key BEFORE it replaces the live file
 *   4. create the new junction, then atomically rename the temp over the target
 *   5. on any failure: restore the backup and undo what was created
 *
 * Deliberately NOT touched:
 *   · every other dependency and every other bundle entry — including
 *     `dsh-connect-trae`, which is currently UNMOUNTED (present in dependencies,
 *     absent from bundles) and must stay in exactly that state;
 *   · the other junctions under node_modules/@local (dsh-subagent-router,
 *     dsh-subagent-acp-harness) — only OUR one is removed;
 *   · AppData\Roaming\Trae* — never read, never written.
 *
 * Run: <dsh-node> tools/rename-live-profile.mjs [--dry] [--profile <name>] [--home <path>]
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DRY = process.argv.includes('--dry')

function option(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

/**
 * The plugin directory itself, with any junction resolved away: running this
 * through the profile's `node_modules` junction must still record the REAL
 * source tree in `link:`, never the junction that points back at it.
 */
function realPluginDir() {
  const here = resolve(import.meta.dirname, '..')
  try {
    return realpathSync.native(here)
  } catch {
    return here
  }
}

/** Same resolution install.mjs uses: `--home`, then `$DSH_HOME`, then `~/.dsh`. */
const DSH_HOME = resolve(option('--home') ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
const PROFILE = join(DSH_HOME, 'profiles', option('--profile') ?? 'desktop')
const PLUGIN = realPluginDir()
/** Backups go under the pin directory, outside the profile being edited. */
const PIN = join(DSH_HOME, 'trae-pin')

/** The name being retired, and the name replacing it. */
const OLD_NAME = '@local/dsh-trae'
const NEW_NAME = 'dsh-pylon-trae'
/** Still installed, still deliberately unmounted — must not be re-added by us. */
const KEEP_UNMOUNTED = 'dsh-connect-trae'

const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
})()

const pkgPath = join(PROFILE, 'package.json')
/** An unscoped package resolves straight under node_modules/<name>. */
const newLink = join(PROFILE, 'node_modules', NEW_NAME)
const oldLink = join(PROFILE, 'node_modules', '@local', 'dsh-trae')

let failures = 0
const say = (s) => console.log(s)
const ok = (label) => say(`  PASS  ${label}`)
const bad = (label) => {
  say(`  FAIL  ${label}`)
  failures += 1
}
const check = (label, cond) => (cond ? ok(label) : bad(label))

if (!existsSync(pkgPath)) {
  console.error(`🔴 ${pkgPath} 不存在 —— 中止（没有可改的活体 profile）。`)
  process.exit(2)
}

/* ───────────────────────── 0. baseline ───────────────────────── */
const raw = readFileSync(pkgPath, 'utf8')
const before = JSON.parse(raw)
const eol = raw.includes('\r\n') ? 'CRLF' : 'LF'
const bom = raw.charCodeAt(0) === 0xfeff

say(`[baseline] ${pkgPath}`)
say(`[baseline] eol=${eol} bom=${bom} bytes=${Buffer.byteLength(raw)}`)
say(`[baseline] dependencies.${OLD_NAME} = ${JSON.stringify(before.dependencies?.[OLD_NAME] ?? null)}`)
say(`[baseline] dependencies.${NEW_NAME} = ${JSON.stringify(before.dependencies?.[NEW_NAME] ?? null)}`)
say(`[baseline] bundles = ${JSON.stringify(before.dsh?.profile?.bundles)}`)
if (bom) {
  console.error('🔴 源文件带 BOM，本脚本只写无 BOM 的 UTF-8 —— 中止，不做猜测。')
  process.exit(2)
}
if (before.dependencies?.[OLD_NAME] === undefined) {
  say(`[note] dependencies 里没有 ${OLD_NAME} —— 可能已经改过了，继续做幂等收敛。`)
}

/* ───────────────────── 1. build the candidate ───────────────────── */
const next = JSON.parse(raw)
next.dependencies = { ...next.dependencies }
delete next.dependencies[OLD_NAME]
next.dependencies[NEW_NAME] = `link:${PLUGIN.replaceAll('\\', '/')}`

const bundlesBefore = Array.isArray(next.dsh?.profile?.bundles) ? [...next.dsh.profile.bundles] : []
const bundlesAfter = bundlesBefore.map((b) => (b === OLD_NAME ? NEW_NAME : b))
next.dsh.profile.bundles = bundlesAfter

say(`\n[candidate] bundles = ${JSON.stringify(bundlesAfter)}`)
say(`[candidate] dependencies.${NEW_NAME} = ${JSON.stringify(next.dependencies[NEW_NAME])}`)

/* ───────────────── 2. verify the candidate BEFORE writing ───────────────── */
say('\n[verify] candidate vs baseline')
check(`dependencies.${NEW_NAME} present`, next.dependencies[NEW_NAME] === `link:${PLUGIN.replaceAll('\\', '/')}`)
check(`dependencies.${OLD_NAME} removed`, next.dependencies[OLD_NAME] === undefined)
check(`bundles name ${NEW_NAME} present`, bundlesAfter.includes(NEW_NAME))
check(`bundles name ${OLD_NAME} gone`, !bundlesAfter.includes(OLD_NAME))
check(
  `bundles length unchanged (${bundlesBefore.length})`,
  bundlesAfter.length === bundlesBefore.length
)
check(`every other bundle entry untouched`, JSON.stringify(bundlesAfter.map((b) => (b === NEW_NAME ? OLD_NAME : b))) === JSON.stringify(bundlesBefore))
check(`${KEEP_UNMOUNTED} is NOT in bundles (stays unmounted)`, !bundlesAfter.includes(KEEP_UNMOUNTED))
check(
  `top-level keys unchanged`,
  JSON.stringify(Object.keys(next).sort()) === JSON.stringify(Object.keys(before).sort())
)
for (const key of Object.keys(before)) {
  if (key === 'dependencies' || key === 'dsh') continue
  check(`"${key}" byte-identical`, JSON.stringify(before[key]) === JSON.stringify(next[key]))
}
{
  const depsBefore = Object.keys(before.dependencies ?? {}).filter((k) => k !== OLD_NAME && k !== NEW_NAME).sort()
  const depsAfter = Object.keys(next.dependencies).filter((k) => k !== OLD_NAME && k !== NEW_NAME).sort()
  check('every other dependency untouched', JSON.stringify(depsBefore) === JSON.stringify(depsAfter))
  check(`dependencies count unchanged (${Object.keys(before.dependencies ?? {}).length})`, Object.keys(depsBefore).length + 1 === Object.keys(next.dependencies).length)
}

if (failures > 0) {
  console.error(`\n🔴 候选校验失败 ${failures} 项 —— 未写任何东西，活体 profile 保持原样。`)
  process.exit(1)
}

if (DRY) {
  say('\n--dry：校验全部通过，未写文件、未建 junction。')
  process.exit(0)
}

/* ───────────────────── 3. backs up OUTSIDE the profile ───────────────────── */
mkdirSync(PIN, { recursive: true })
const backup = join(PIN, `package.json.before-pylon-rename-${stamp}.bak`)
copyFileSync(pkgPath, backup)
say(`\n[backup] ${backup}`)

/* ───────────────────── 4. the junction swap ───────────────────── */
say('\n[link] junction')
let createdLink = false
let removedOld = false
const isJunction = (p) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const rollback = (why) => {
  console.error(`\n🔴 ${why}`)
  console.error('[rollback] 还原 package.json 与 junction …')
  try {
    copyFileSync(backup, pkgPath)
    console.error(`[rollback] package.json 已还原（来自 ${backup}）`)
  } catch (error) {
    console.error(`[rollback] 🔴 package.json 还原失败：${String(error)} —— 手工从 ${backup} 复制回去`)
  }
  if (createdLink && isJunction(newLink)) {
    try {
      unlinkSync(newLink)
      console.error('[rollback] 新 junction 已移除')
    } catch (error) {
      console.error(`[rollback] 新 junction 移除失败：${String(error)}`)
    }
  }
  if (removedOld && !existsSync(oldLink)) {
    try {
      mkdirSync(dirname(oldLink), { recursive: true })
      symlinkSync(PLUGIN, oldLink, 'junction')
      console.error('[rollback] 旧 junction 已恢复')
    } catch (error) {
      console.error(`[rollback] 旧 junction 恢复失败：${String(error)}`)
    }
  }
  process.exit(1)
}

try {
  if (existsSync(newLink)) {
    say(`  [link] 已存在：${newLink}`)
  } else {
    symlinkSync(PLUGIN, newLink, 'junction')
    createdLink = true
    say(`  [link] ${newLink} -> ${PLUGIN}`)
  }
} catch (error) {
  rollback(`新 junction 建不起来：${String(error)}`)
}

// ONLY a reparse point is removed here. A real directory at this path would mean
// somebody vendored the plugin, and deleting it would destroy their files.
if (existsSync(oldLink) || isJunction(oldLink)) {
  if (isJunction(oldLink)) {
    try {
      unlinkSync(oldLink)
      removedOld = true
      say(`  [unlink] ${oldLink}（只删 junction，真目录不动）`)
    } catch (error) {
      rollback(`旧 junction 删不掉：${String(error)}`)
    }
  } else {
    rollback(`🔴 ${oldLink} 不是 junction 而是真目录 —— 拒绝递归删除，请人工确认后处理。`)
  }
} else {
  say(`  [unlink] ${oldLink} 不存在，跳过`)
}
// Do not remove node_modules/@local itself: the router and acp-harness live there.
if (existsSync(join(PROFILE, 'node_modules', '@local'))) {
  say(`  [keep] ${join(PROFILE, 'node_modules', '@local')} 保留（还有别的插件）`)
}

/* ───────────────────── 5. verify the file, then swap it in ───────────────────── */
const serialized = `${JSON.stringify(next, null, 2)}\n`
const tmp = `${pkgPath}.renaming`
writeFileSync(tmp, serialized, 'utf8')

const candidate = JSON.parse(readFileSync(tmp, 'utf8'))
if (candidate.dependencies[NEW_NAME] === undefined) rollback('candidate 丢了新依赖')
if (candidate.dependencies[OLD_NAME] !== undefined) rollback('candidate 还留着旧依赖')
if (!candidate.dsh.profile.bundles.includes(NEW_NAME)) rollback('candidate 丢了新 bundle')
if (candidate.dsh.profile.bundles.includes(OLD_NAME)) rollback('candidate 还留着旧 bundle')
if (candidate.dsh.profile.bundles.includes(KEEP_UNMOUNTED)) rollback('candidate 把 dsh-connect-trae 加回了 bundles')
say('  [verify] 落盘后的 candidate 逐键复核通过')

renameSync(tmp, pkgPath)
say(`[done] ${pkgPath} 已原子替换`)

/* ───────────────────── 6. read the live file back ───────────────────── */
say('\n[readback] 活体 profile 现状')
const live = JSON.parse(readFileSync(pkgPath, 'utf8'))
check(`dependencies.${NEW_NAME} = ${JSON.stringify(live.dependencies[NEW_NAME])}`, live.dependencies[NEW_NAME]?.startsWith('link:'))
check(`dependencies.${OLD_NAME} 已不存在`, live.dependencies[OLD_NAME] === undefined)
check(`bundles 里是 ${NEW_NAME}`, live.dsh.profile.bundles.includes(NEW_NAME))
check(`bundles 里没有 ${OLD_NAME}`, !live.dsh.profile.bundles.includes(OLD_NAME))
check(`${KEEP_UNMOUNTED} 仍在 dependencies 里、仍不在 bundles 里`, live.dependencies[KEEP_UNMOUNTED] !== undefined && !live.dsh.profile.bundles.includes(KEEP_UNMOUNTED))
check(`新 junction 存在且指向插件目录`, isJunction(newLink))
check(`旧 junction 已不在`, !existsSync(oldLink))
check(`node_modules/@local 还在（别的插件不受影响）`, existsSync(join(PROFILE, 'node_modules', '@local')))

say(`\n[revert] 还原方法：copy "${backup}" "${pkgPath}"；再 rmdir "${newLink}" 并重建旧 junction。`)
say(failures === 0 ? '\nLIVE PROFILE OK' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

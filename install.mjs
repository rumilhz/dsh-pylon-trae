/**
 * dsh-pylon-trae install — 用户侧一条命令：把本插件装进（或从）一个 DSH profile。
 *
 * 语义是从 `_backups\install-into-live-profile.mjs`（手工装进活体
 * profile 的那份）逐条搬过来的，一条没少：
 *
 *   ① 先备份到 profile **之外**（`$DSH_HOME\.dsh-pylon-trae\install-backups\<stamp>\`）
 *      —— 备份放在 profile 里，就和正本一起毁于同一次事故；
 *   ② 候选 JSON 写进临时文件后**逐键校验**（顶层键不许变、其它依赖不许动、我们的
 *      依赖与 bundles 必须在、上游必须不在），通过了才原子替换正本；
 *   ③ junction 用 `symlinkSync(..., 'junction')`；删的时候用 `rmdir`（**递归删除一个
 *      junction 会删掉它指向的真目录** —— 这条踩过的人很多，所以代码里只走 rmdir，
 *      并且在删之前确认那真的是个链接）；
 *   ④ 写完之后**再读一遍**核对（"写入返回了"和"内容还在"是两件事，本仓为这条付过账）；
 *      对不上就立刻用备份还原，然后以非 0 退出。
 *
 * 三种来源、三种动作：
 *
 *   node install.mjs                       源码目录 link 安装（开发用；default profile=desktop）
 *   node install.mjs --from <tgz>          从发布包安装（用户用）：解到
 *                                          `$DSH_HOME\.dsh-pylon-trae\plugin\<version>\`，
 *                                          再登记依赖 + 挂 bundles + junction 指过去。
 *                                          **不铺进 profile 的 node_modules** —— 那样升级会脏。
 *   node install.mjs --uninstall           干净回滚：移掉我们的依赖行与 bundles 条目、
 *                                          删 junction、按记录把上游 dsh-connect-trae 放回
 *                                          bundles，并明确告诉你"上游要不要恢复"。
 *   node install.mjs --rollback            用最近一次备份还原 profile 的两个文件
 *                                          （升级出问题时最快的出路）。
 *
 * 装之前先跑 `tools/doctor.ts`：有 ❌ 就**拒绝安装**并把 doctor 的"怎么办"打出来。
 * 唯一的例外是 `--uninstall` / `--rollback` —— 回滚永远不该被前置条件拦住。
 *
 * 默认**只装不启**：装完只打印"请重启 DSH"和重启后该看什么，绝不替你启动或重启 DSH。
 *
 * 绝不写 `AppData\Roaming\Trae*`（代码里有断言；Trae 的数据只读）。
 * 绝不打印任何凭据（doctor 也只打 sha256 前 12 位）。
 *
 * 用法：
 *   node install.mjs [--profile <name>] [--home <path>] [--from <tgz>]
 *                    [--dry-run] [--force] [--allow-untested-platform] [--quiet-doctor]
 *   node install.mjs --uninstall [--profile <name>] [--home <path>]
 *   node install.mjs --rollback  [--profile <name>] [--home <path>]
 *
 * 退出码：0 成功（或 dry-run 通过）· 1 被拒绝/校验失败（失败时 profile 已还原）· 2 用法错误
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const HERE = import.meta.dirname
const ROOT = HERE
const TARGET_NAME = 'dsh-pylon-trae'
const LEGACY_NAMES = ['@local/dsh-trae', 'dsh-trae']
const ALL_NAMES = [TARGET_NAME, ...LEGACY_NAMES]
const UPSTREAM_NAME = 'dsh-connect-trae'
const OWN_DIR = '.dsh-pylon-trae'
const MIN_NODE = [22, 6]

/* ────────────────────────────────────────────────────────────────────────────
 * 命令行
 * ──────────────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2)
function option(name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}
const HOME = resolve(option('--home') ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
const PROFILE = option('--profile') ?? 'desktop'
const PROFILE_DIR = join(HOME, 'profiles', PROFILE)
const PACKAGE_PATH = join(PROFILE_DIR, 'package.json')
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')
const OWN_ROOT = join(HOME, OWN_DIR)
const PLUGIN_STORE = join(OWN_ROOT, 'plugin')
const BACKUP_ROOT = join(OWN_ROOT, 'install-backups')
const RECORD_PATH = join(OWN_ROOT, 'install-record.json')

const UNINSTALL = argv.includes('--uninstall')
const ROLLBACK = argv.includes('--rollback')
const DRY_RUN = argv.includes('--dry-run')
const FORCE = argv.includes('--force')
const ALLOW_UNTESTED = argv.includes('--allow-untested-platform')
const QUIET_DOCTOR = argv.includes('--quiet-doctor')
const FROM = option('--from')

if (argv.includes('--help') || argv.includes('-h')) {
  // 顶部的文档注释就是帮助文本：去掉 JSDoc 的装饰符，别让它看起来像没排版好的代码。
  const header = readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]
  const text = header
    .replace(/^\/\*\*?/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*∕?/, '').replace(/^\s\* ?/, '').trimEnd())
    .join('\n')
    .trim()
  console.log(text)
  process.exit(0)
}
if (UNINSTALL && ROLLBACK) {
  console.error('❌ --uninstall 与 --rollback 不能同时用（一个拆、一个还原，语义相反）')
  process.exit(2)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 小工具
 * ──────────────────────────────────────────────────────────────────────────── */
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const fileSha256 = (path) => sha256(readFileSync(path))
const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const info = (text) => console.log(text)
const warn = (text) => console.log(`⚠️  ${text}`)
const step = (text) => console.log(`\n── ${text}`)

function fail(text, hint) {
  console.error(`\n❌ ${text}`)
  if (hint !== undefined) console.error(`   → 怎么办：${hint}`)
  process.exit(1)
}

/**
 * 这些路径永远不许写。
 *
 * 本插件的全部输入都是 Trae 的**只读**数据（storage.json / state.vscdb / machineid），
 * 唯一会写 Trae 的是 Trae 自己。把这条写成断言而不是注释，是因为"顺手修一下用户配置"
 * 这种改动看起来总是无害的。
 */
function assertWritable(path) {
  const normalized = resolve(path).replaceAll('\\', '/')
  if (/\/AppData\/Roaming\/Trae/i.test(normalized) || /\/\.trae(-cn)?\//i.test(normalized)) {
    fail(`拒绝写入 Trae 自己的目录：${path}`, '这不是本插件的文件；Trae 的数据只读。若你确信要改，请手工操作。')
  }
  if (!normalized.startsWith(resolve(HOME).replaceAll('\\', '/'))) {
    // 备份目录、junction 目标都在 home 里；备份到 home 之外不是错，但必须是显式调用
    if (!normalized.startsWith(resolve(ROOT).replaceAll('\\', '/'))) {
      fail(`拒绝写入 home 与插件目录之外的路径：${path}`, 'install.mjs 只碰 $DSH_HOME 下的 profile 与本插件自己的状态目录。')
    }
  }
}

function readJson(path) {
  const raw = readFileSync(path, 'utf8')
  return { raw, value: JSON.parse(raw), eol: raw.includes('\r\n') ? 'CRLF' : 'LF', bom: raw.charCodeAt(0) === 0xfeff }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 0. profile 先决条件（不满足就没法装，也不需要跑 doctor 才知道）
 * ──────────────────────────────────────────────────────────────────────────── */
function requireProfile() {
  if (!existsSync(HOME)) {
    fail(`$DSH_HOME 不存在：${HOME}`, '先启动一次 DSH（它会创建 home 与 profile），或用 --home <path> 指到真的 home。')
  }
  if (!existsSync(PROFILE_DIR)) {
    const names = existsSync(join(HOME, 'profiles'))
      ? readdirSync(join(HOME, 'profiles'), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : []
    fail(
      `profile 目录不存在：${PROFILE_DIR}`,
      names.length > 0 ? `这个 home 下有这些 profile：${names.join(', ')} —— 用 --profile <name> 选一个` : '先启动一次 DSH，让它把 profile 建出来'
    )
  }
  if (!existsSync(PACKAGE_PATH)) fail(`profile 里没有 package.json：${PACKAGE_PATH}`, 'profile 不完整：先启动一次 DSH 让它补齐，或换一个 profile。')
  if (!existsSync(PATCH_PATH)) {
    warn(`profile 里没有 cordis.patch.yml：${PATCH_PATH}`)
    warn('插件会以 no-guard 启动（能起、能读，但写模型清单会被拒绝）。patch 由 DSH 首次启动该 profile 时创建 —— 建议先启动一次再装。')
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. doctor 闸门
 * ──────────────────────────────────────────────────────────────────────────── */
function runDoctor() {
  const args = [join(HERE, 'tools', 'doctor.ts'), '--home', HOME, '--profile', PROFILE, ...(ALLOW_UNTESTED ? ['--allow-untested-platform'] : [])]
  step(`自检（doctor）· ${PROFILE}`)
  const doctor = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: QUIET_DOCTOR ? 'pipe' : 'inherit',
    encoding: 'utf8'
  })
  if (QUIET_DOCTOR) {
    const text = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('结论') || line.startsWith('总结') || /^[✅⚠❌]/.test(line) || /^ {3}→/.test(line)) console.log(line)
    }
  }
  if (doctor.status === 1) {
    fail(
      'doctor 报了 ❌ —— 现在装上去也不会好用，先按上面的"怎么办"把 ❌ 解决掉',
      `重跑自检：node tools\\doctor.ts --profile ${PROFILE}${ALLOW_UNTESTED ? '' : '（非 Windows 且确要试装，加 --allow-untested-platform）'}`
    )
  }
  if (doctor.status !== 0) {
    warn(`doctor 自己没跑成（退出码 ${String(doctor.status)}）—— 继续，但这次安装没有前置检查兜底`)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. tar.gz 读取器（安装方要能解 `pack.mjs` 打出来的包）
 *
 * 只认标准 ustar 的普通文件，逐项校验头 checksum；路径越界（绝对路径、`..`）直接拒绝 ——
 * 装的是别人给的包，这一步不能省。
 * ──────────────────────────────────────────────────────────────────────────── */
function parseTarGz(tgzPath) {
  const tgz = readFileSync(tgzPath)
  const tar = gunzipSync(tgz)
  const entries = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const stored = block.subarray(148, 156).toString('latin1')
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]
    const declared = parseInt(stored.replace(/\0.*$/, '').trim() || '-1', 8)
    if (declared !== sum) throw new Error(`tar 头 checksum 不符（偏移 ${offset}）：包已损坏，拒绝解包`)
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(block.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8)
    const typeflag = block.subarray(156, 157).toString('latin1')
    const full = prefix === '' ? name : `${prefix}/${name}`
    const start = offset + 512
    const bytes = tar.subarray(start, start + size)
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const normalized = full.replaceAll('\\', '/')
      if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
        throw new Error(`包里有个越界路径，拒绝解包：${full}`)
      }
      if (!normalized.startsWith('package/')) throw new Error(`包内路径不在 package/ 前缀下，拒绝解包：${full}`)
      entries.push({ path: normalized.slice('package/'.length), bytes, size })
    }
    offset = start + size + ((512 - (size % 512)) % 512)
  }
  if (entries.length === 0) throw new Error('包里一个文件都没有')
  return { tgz, entries }
}

/** 与 pack.mjs 打印的"装配 sha256"同一套规范（路径\0内容hash\0字节数，按路径排序）。 */
function assemblyDigestOf(entries) {
  const canonical = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((entry) => `${entry.path}\0${entry.sha256}\0${entry.size}`)
    .join('\n')
  return sha256(Buffer.from(canonical, 'utf8'))
}

/** 期望的装配 sha256：读 `<tgz>.manifest.txt`（pack.mjs 的产物之一），没有就返回 undefined。 */
function expectedAssemblyDigest(tgzPath) {
  const manifestPath = `${tgzPath}.manifest.txt`
  if (!existsSync(manifestPath)) return undefined
  const match = /^assembly-sha256:\s*([0-9a-f]{64})$/m.exec(readFileSync(manifestPath, 'utf8'))
  return match?.[1]
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 备份（写到 profile 之外）
 * ──────────────────────────────────────────────────────────────────────────── */
function backupProfile(label) {
  const dir = join(BACKUP_ROOT, `${stamp()}-${label}`)
  assertWritable(dir)
  if (DRY_RUN) {
    info(`[dry-run] 会备份 ${basename(PACKAGE_PATH)} 与 ${basename(PATCH_PATH)} → ${dir}`)
    return { dir, package: join(dir, 'package.json'), patch: join(dir, 'cordis.patch.yml') }
  }
  mkdirSync(dir, { recursive: true })
  const packageBackup = join(dir, 'package.json')
  const patchBackup = join(dir, 'cordis.patch.yml')
  copyFileSync(PACKAGE_PATH, packageBackup)
  if (existsSync(PATCH_PATH)) copyFileSync(PATCH_PATH, patchBackup)
  // 立刻核对备份，别等出事了才发现备份是空的
  if (fileSha256(packageBackup) !== fileSha256(PACKAGE_PATH)) fail(`备份校验失败：${packageBackup} 与正本不一致`, '磁盘可能有问题，先解决这个再装。')
  info(`[备份] ${dir}（package.json sha256 ${fileSha256(PACKAGE_PATH).slice(0, 12)}…）`)

  // 保留最近 10 次备份：这是个只增的目录，而它每次安装都长一份
  const all = readdirSync(BACKUP_ROOT).sort()
  for (const stale of all.slice(0, Math.max(0, all.length - 10))) {
    try {
      rmSync(join(BACKUP_ROOT, stale), { recursive: true, force: true })
    } catch {
      // 清理失败不该让安装失败（安全网的第一职责是保住正本）
    }
  }
  return { dir, package: packageBackup, patch: patchBackup }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. junction（只走 rmdir；递归删一个 junction 会删掉源目录）
 * ──────────────────────────────────────────────────────────────────────────── */
function linkTargetOf(linkPath) {
  try {
    return readlinkSync(linkPath)
  } catch {
    return undefined
  }
}

function removeJunction(linkPath, why) {
  if (!existsSync(linkPath)) return
  const stats = lstatSync(linkPath)
  if (!stats.isSymbolicLink()) {
    fail(
      `拒绝删除 ${linkPath}：它不是 junction，而是一个真目录（${why}）`,
      '手工确认它是什么：真的插件安装目录就先移除依赖，再删这个目录。本脚本只会删 junction。'
    )
  }
  if (DRY_RUN) {
    info(`[dry-run] 会 rmdir ${linkPath}`)
    return
  }
  rmdirSync(linkPath)
  info(`[junction] 已移除 ${linkPath}`)
}

function makeJunction(sourceDir, linkPath) {
  const parent = dirname(linkPath)
  if (DRY_RUN) {
    info(`[dry-run] 会建 junction ${linkPath} -> ${sourceDir}`)
    return
  }
  mkdirSync(parent, { recursive: true })
  const existing = linkTargetOf(linkPath)
  if (existing !== undefined && resolve(existing) === resolve(sourceDir)) {
    info(`[junction] 已指向目标，未改动：${linkPath} -> ${sourceDir}`)
    return
  }
  // 切换目标不是一次原子操作（Windows 上一次 rmdir + 一次 symlink）。做法：先在旁边把
  // 新链接建好并核对，再拆旧的、把它改名到位；任何一步失败都立刻把旧链接指回去。
  const tempLink = `${linkPath}.new-${process.pid}`
  if (existsSync(tempLink)) rmSync(tempLink, { recursive: false, force: true })
  symlinkSync(sourceDir, tempLink, 'junction')
  if (resolve(linkTargetOf(tempLink) ?? '') !== resolve(sourceDir)) {
    rmSync(tempLink, { force: true, recursive: false })
    fail(`新建的 junction 指向不对：${tempLink}`, '文件系统不支持 junction？确认在 Windows/NTFS 上。')
  }
  let previous
  try {
    previous = linkTargetOf(linkPath)
    if (previous !== undefined) rmdirSync(linkPath)
    renameSync(tempLink, linkPath)
  } catch (error) {
    try {
      if (existsSync(tempLink)) rmSync(tempLink, { force: true, recursive: false })
      if (previous !== undefined && !existsSync(linkPath)) symlinkSync(previous, linkPath, 'junction')
    } catch {
      // 还原也失败：下面的报错里带上足够信息，让人能手工修
    }
    fail(
      `junction 切换失败：${error instanceof Error ? error.message : String(error)}`,
      previous === undefined
        ? `手工建：mklink /J "${linkPath}" "${sourceDir}"（cmd，管理员不需要）`
        : `已尝试还原到旧目标 ${previous}。手工核对：dir "${dirname(linkPath)}"`
    )
  }
  info(`[junction] ${linkPath} -> ${sourceDir}`)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. 候选 profile JSON 的逐键校验（照搬手工脚本，一条没少）
 * ──────────────────────────────────────────────────────────────────────────── */
function buildCandidate(before, dependencyValue) {
  const next = JSON.parse(JSON.stringify(before))
  next.dependencies = { ...next.dependencies }
  for (const legacy of LEGACY_NAMES) delete next.dependencies[legacy]
  next.dependencies[TARGET_NAME] = dependencyValue

  const bundles = Array.isArray(next?.dsh?.profile?.bundles) ? [...next.dsh.profile.bundles] : []
  const upstreamWasMounted = bundles.includes(UPSTREAM_NAME)
  const withoutUpstream = bundles.filter((bundle) => bundle !== UPSTREAM_NAME && !LEGACY_NAMES.includes(bundle))
  if (!withoutUpstream.includes(TARGET_NAME)) withoutUpstream.push(TARGET_NAME)
  next.dsh = { ...next.dsh, profile: { ...next.dsh?.profile, bundles: withoutUpstream } }
  return { next, upstreamWasMounted, previousBundles: bundles }
}

function verifyCandidate(before, candidate) {
  const problems = []
  if (candidate.dependencies?.[TARGET_NAME] === undefined) problems.push(`候选丢了 ${TARGET_NAME} 的依赖行`)
  if (!Array.isArray(candidate?.dsh?.profile?.bundles) || !candidate.dsh.profile.bundles.includes(TARGET_NAME)) problems.push(`候选丢了 bundles 里的 ${TARGET_NAME}`)
  if (candidate?.dsh?.profile?.bundles?.includes(UPSTREAM_NAME)) problems.push(`候选仍然挂着上游 ${UPSTREAM_NAME}`)
  const keysBefore = Object.keys(before).sort().join(',')
  const keysAfter = Object.keys(candidate).sort().join(',')
  if (keysBefore !== keysAfter) problems.push(`候选改了顶层键：${keysBefore} → ${keysAfter}`)
  for (const key of Object.keys(before)) {
    if (key === 'dependencies' || key === 'dsh') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(candidate[key])) problems.push(`候选改了 "${key}" 的值`)
  }
  const depsBefore = Object.keys(before.dependencies ?? {}).filter((k) => !ALL_NAMES.includes(k)).sort()
  const depsAfter = Object.keys(candidate.dependencies ?? {}).filter((k) => !ALL_NAMES.includes(k)).sort()
  if (depsBefore.join(',') !== depsAfter.join(',')) problems.push(`候选动了别的依赖：${depsBefore.join(',')} → ${depsAfter.join(',')}`)
  if (JSON.stringify(before?.dsh?.profile ?? {}) !== '{}') {
    for (const key of Object.keys(before.dsh.profile ?? {})) {
      if (key === 'bundles') continue
      if (JSON.stringify(before.dsh.profile[key]) !== JSON.stringify(candidate.dsh.profile[key])) problems.push(`候选改了 dsh.profile.${key}`)
    }
  }
  return problems
}

/**
 * 与"候选长什么样"无关的硬不变量。
 *
 * 前两道检查（候选 vs 写入前、写后 vs 候选）都是**相对**的：候选自己就是坏的，它们
 * 会一致地认为"没问题"。这一道是绝对的 —— 不管谁写的、写了什么，落盘之后的 profile
 * 必须真的有我们、且没有上游。变异验证（把前两道闸门去掉、再塞一个坏候选）就是被
 * 这一道抓住的：文件被还原，进程以非 0 退出。
 */
function invariantProblems(value) {
  const problems = []
  const bundles = Array.isArray(value?.dsh?.profile?.bundles) ? value.dsh.profile.bundles : []
  if (value?.dependencies?.[TARGET_NAME] === undefined) problems.push(`写完后 dependencies 里没有 ${TARGET_NAME}`)
  if (!bundles.includes(TARGET_NAME)) problems.push(`写完后 bundles 里没有 ${TARGET_NAME}`)
  if (bundles.includes(UPSTREAM_NAME)) problems.push(`写完后 bundles 里仍有上游 ${UPSTREAM_NAME}（路由会被抢）`)
  const stale = bundles.filter((bundle) => ALL_NAMES.includes(bundle) && bundle !== TARGET_NAME)
  if (stale.length > 0) problems.push(`写完后 bundles 里还留着旧名：${stale.join(', ')}`)
  return problems
}

/** 原子替换 + 写后核对；对不上立刻用备份还原。 */
function commitPackage(backup, before, candidate) {
  const serialized = `${JSON.stringify(candidate, null, 2)}\n`
  if (before.bom) fail('profile 的 package.json 带 BOM —— 本脚本只写无 BOM 的 UTF-8，拒绝继续', '手工把 BOM 去掉再装（BOM 会让某些 JSON 解析器报错）。')
  if (DRY_RUN) {
    info(`[dry-run] 会把下列内容写进 ${PACKAGE_PATH}：`)
    info(`           dependencies["${TARGET_NAME}"] = ${String(candidate.dependencies[TARGET_NAME])}`)
    info(`           bundles = [${candidate.dsh.profile.bundles.join(', ')}]`)
    return
  }
  const tmp = `${PACKAGE_PATH}.installing-${process.pid}`
  writeFileSync(tmp, serialized, 'utf8')
  const check = readJson(tmp).value
  const problems = verifyCandidate(before.value, check)
  if (problems.length > 0) {
    rmSync(tmp, { force: true })
    fail(`候选 JSON 自校验不过，已放弃写入：\n     · ${problems.join('\n     · ')}`, '这是脚本的 bug，不是你的配置问题；什么都没改，请把这段贴给维护者。')
  }
  renameSync(tmp, PACKAGE_PATH)

  // 写后核对：重新读盘，逐键比一遍，再补一遍绝对不变量
  const after = readJson(PACKAGE_PATH).value
  const afterProblems = [...verifyCandidate(after, candidate), ...invariantProblems(after)]
  if (afterProblems.length > 0) {
    warn(`写入后核对不过：${afterProblems.join(' · ')} —— 立刻用备份还原`)
    copyFileSync(backup.package, PACKAGE_PATH)
    if (existsSync(backup.patch)) copyFileSync(backup.patch, PATCH_PATH)
    fail('写入后核对失败，profile 已还原到安装前', '磁盘或杀软可能在改文件。重试一次；仍然失败就把这段贴给维护者。')
  }
  info(`[写入] ${PACKAGE_PATH}（已重新读盘核对：依赖、bundles、其它键都对得上）`)
}

/** 卸载候选的逐键校验：我们的名字必须消失，别的键一个都不许动。 */
function verifyUninstallCandidate(before, candidate) {
  const problems = []
  for (const name of ALL_NAMES) {
    if (candidate.dependencies?.[name] !== undefined) problems.push(`候选里还留着 ${name} 的依赖行`)
    if (candidate?.dsh?.profile?.bundles?.includes(name)) problems.push(`候选的 bundles 里还留着 ${name}`)
  }
  const keysBefore = Object.keys(before).sort().join(',')
  const keysAfter = Object.keys(candidate).sort().join(',')
  if (keysBefore !== keysAfter) problems.push(`候选改了顶层键：${keysBefore} → ${keysAfter}`)
  for (const key of Object.keys(before)) {
    if (key === 'dependencies' || key === 'dsh') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(candidate[key])) problems.push(`候选改了 "${key}" 的值`)
  }
  const depsBefore = Object.keys(before.dependencies ?? {}).filter((k) => !ALL_NAMES.includes(k)).sort()
  const depsAfter = Object.keys(candidate.dependencies ?? {}).filter((k) => !ALL_NAMES.includes(k)).sort()
  if (depsBefore.join(',') !== depsAfter.join(',')) problems.push(`候选动了别的依赖：${depsBefore.join(',')} → ${depsAfter.join(',')}`)
  for (const key of Object.keys(before.dsh?.profile ?? {})) {
    if (key === 'bundles') continue
    if (JSON.stringify(before.dsh.profile[key]) !== JSON.stringify(candidate.dsh.profile[key])) problems.push(`候选改了 dsh.profile.${key}`)
  }
  return problems
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. 发布包（--from）的处理：解到插件自己的 store，再让 junction 指过去
 * ──────────────────────────────────────────────────────────────────────────── */
function installFromTgz(tgzPath) {
  const absolute = resolve(tgzPath)
  if (!existsSync(absolute)) fail(`找不到发布包：${absolute}`, '先打一个：node tools\\pack.mjs，或用 --from 指到 dist\\ 下的 tgz。')
  info(`[发布包] ${absolute}（${statSync(absolute).size} B，sha256 ${fileSha256(absolute).slice(0, 16)}…）`)
  const sidecar = `${absolute}.sha256`
  if (existsSync(sidecar)) {
    const declared = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]
    const actual = fileSha256(absolute)
    if (declared !== actual) fail(`发布包 sha256 与校验文件不符：声明 ${declared.slice(0, 16)}… 实际 ${actual.slice(0, 16)}…`, '包在传输中坏了或被改过：重新拷一份，别装这个。')
    info(`[校验] sha256 与 ${basename(sidecar)} 一致`)
  } else {
    warn(`没有校验副文件 ${basename(sidecar)} —— 只验证了压缩包结构，没法证明它就是你打的那一份`)
  }

  const parsed = parseTarGz(absolute)
  const entries = parsed.entries.map((entry) => ({ ...entry, sha256: sha256(entry.bytes) }))
  const assembly = assemblyDigestOf(entries)
  const expected = expectedAssemblyDigest(absolute)
  if (expected !== undefined && expected !== assembly) {
    fail(`装配 sha256 不符：清单声明 ${expected.slice(0, 16)}… 实际 ${assembly.slice(0, 16)}…`, '包内容与它的清单不一致：别装，重新打包。')
  }
  const manifestEntry = parsed.entries.find((entry) => entry.path === 'package.json')
  if (manifestEntry === undefined) fail('包里没有 package.json —— 这不是一个插件包', '确认 --from 指的是 tools\\pack.mjs 的产物。')
  const inner = JSON.parse(manifestEntry.bytes.toString('utf8'))
  for (const required of ['src/index.ts', 'lib/client.js', 'cordis.patch.yml']) {
    if (!entries.some((entry) => entry.path === required)) fail(`包里缺 ${required} —— 不完整的发布包`, '重新打包（node tools\\pack.mjs --force）。')
  }
  const version = typeof inner.version === 'string' ? inner.version : '0.0.0'
  info(`[发布包] name=${String(inner.name)} version=${version} · ${entries.length} 个文件 · 装配 sha256 ${assembly.slice(0, 16)}…`)
  if (inner.name !== TARGET_NAME) {
    warn(
      `包内 package.json 的 name 是 ${String(inner.name)}，而 profile 里登记的是 ${TARGET_NAME} —— ` +
        `这是改名（dsh-trae → ${TARGET_NAME}）扫尾完成前的正常状态；扫尾落地后重打一次包，这条警告会自己消失。`
    )
  }

  const finalDir = join(PLUGIN_STORE, version)
  const stagingDir = join(PLUGIN_STORE, `${version}.staging-${process.pid}`)
  if (DRY_RUN) {
    info(`[dry-run] 会解包到 ${finalDir}（先解到 ${stagingDir} 校验，再改名到位）`)
    return { sourceDir: finalDir, version, assembly, inner, entries: entries.length }
  }

  if (existsSync(finalDir)) {
    const installed = existsSync(join(finalDir, 'package.json')) ? fileSha256(join(finalDir, 'package.json')) : ''
    const incoming = sha256(manifestEntry.bytes)
    if (installed === incoming) {
      info(`[store] ${finalDir} 已存在且内容一致 —— 复用（不重解）`)
      return { sourceDir: finalDir, version, assembly, inner, entries: entries.length }
    }
    if (!FORCE) {
      fail(
        `插件 store 里已有同名版本但内容不同：${finalDir}`,
        '同一个版本号两套字节是最难查的事故，所以这里默认拒绝。确认要覆盖：加 --force（旧目录会改名为 *.superseded-<stamp> 保留）。'
      )
    }
    const superseded = `${finalDir}.superseded-${stamp()}`
    renameSync(finalDir, superseded)
    info(`[store] 旧目录改名为 ${superseded}`)
  }

  mkdirSync(stagingDir, { recursive: true })
  for (const entry of entries) {
    const destination = join(stagingDir, entry.path)
    assertWritable(destination)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, entry.bytes)
  }
  // 解包后重新读盘核对：解出来的字节必须与包里的一致
  const onDisk = entries.map((entry) => {
    const buffer = readFileSync(join(stagingDir, entry.path))
    return { path: entry.path, size: buffer.length, sha256: sha256(buffer) }
  })
  if (assemblyDigestOf(onDisk) !== assembly) fail('解包后重算的装配 sha256 与包不一致', '磁盘写入可能被拦截（杀软/只读盘）。什么都没改，重试一次。')
  info(`[解包] ${entries.length} 个文件 → ${stagingDir}（重算装配 sha256 一致）`)

  mkdirSync(PLUGIN_STORE, { recursive: true })
  renameSync(stagingDir, finalDir)
  info(`[store] ${finalDir}`)
  const kept = readdirSync(PLUGIN_STORE).filter((name) => !name.includes('.staging-') && name !== version)
  if (kept.length > 0) info(`[store] 保留的旧版本：${kept.join(', ')}（升级失败要回退时还用得上）`)
  return { sourceDir: finalDir, version, assembly, inner, entries: entries.length }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7. 安装
 * ──────────────────────────────────────────────────────────────────────────── */
function isNewerOrEqual(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1
  }
  return 0
}

function install() {
  requireProfile()
  runDoctor()

  const from = FROM === undefined ? undefined : installFromTgz(FROM)
  const sourceDir = from === undefined ? ROOT : from.sourceDir
  const mode = from === undefined ? '源码 link' : `发布包 ${from.version}`
  if (from === undefined) info(`[来源] 源码目录 link：${ROOT}（开发用；发布给用户的路径是 --from <tgz>）`)

  const before = readJson(PACKAGE_PATH)
  const already = Array.isArray(before.value?.dsh?.profile?.bundles) ? before.value.dsh.profile.bundles : []
  const previousTarget = linkTargetOf(join(PROFILE_DIR, 'node_modules', TARGET_NAME))
  const recordBefore = existsSync(RECORD_PATH) ? JSON.parse(readFileSync(RECORD_PATH, 'utf8')) : undefined

  step(`安装 · profile=${PROFILE} · 来源=${mode}`)
  info(`[基线] package.json eol=${before.eol} bom=${before.bom} · bundles ${already.length} 条 · dependencies ${Object.keys(before.value.dependencies ?? {}).length} 条`)
  if (previousTarget !== undefined) info(`[基线] 现有 junction → ${previousTarget}`)
  if (recordBefore !== undefined && previousTarget !== undefined && resolve(previousTarget) !== resolve(sourceDir)) {
    const previousVersion = recordBefore.version ?? undefined
    if (previousVersion !== undefined && from !== undefined) {
      const order = isNewerOrEqual(from.version, previousVersion)
      info(
        order >= 0
          ? `[升级] ${previousVersion} → ${from.version}（${order === 0 ? '同版本重装' : '向后升级'}）`
          : `[降级] ${previousVersion} → ${from.version}（你要装的比在装的旧；继续，但你多半是想反了）`
      )
    }
  }

  const backup = backupProfile(from === undefined ? 'install' : `install-${from.version}`)
  const { next, upstreamWasMounted, previousBundles } = buildCandidate(before.value, `link:${sourceDir.replaceAll('\\', '/')}`)
  const problems = verifyCandidate(before.value, next)
  if (problems.length > 0) fail(`候选 JSON 自校验不过（没写盘）：\n     · ${problems.join('\n     · ')}`, '这是脚本的 bug，请把这段贴给维护者。')

  // 顺序：先把 junction 立稳，再改 profile JSON。反过来的话，profile 里挂着一个
  // 解析不到的包，宿主会以"bundle 加载失败"启动 —— 那比不装更糟。
  step('junction')
  makeJunction(sourceDir, join(PROFILE_DIR, 'node_modules', TARGET_NAME))

  step('profile 登记')
  commitPackage(backup, before, next)

  if (!DRY_RUN) {
    assertWritable(RECORD_PATH)
    mkdirSync(OWN_ROOT, { recursive: true })
    /**
     * 有些字段记的是"装我们**之前**的世界"，它们只能记一次。
     *
     * 这是实测踩出来的：第二次安装（同版本重装/升级）时，profile 里已经挂着我们、
     * 上游早就摘掉了，于是 `upstreamWasMounted` 会变成 false —— 卸载时就再也不会把
     * 上游放回去，用户从此少了一个插件，而他根本不知道是哪一步弄丢的。
     * 所以这些"原始现场"字段从旧记录里**继承**：只要旧记录里有，就一律沿用，
     * 不看它当时是 install 还是 uninstalled（一次卸载不该抹掉历史）。
     */
    const carried =
      recordBefore !== undefined && (recordBefore.upstreamWasMounted !== undefined || recordBefore.previousBundles !== undefined)
        ? {
            previousBundles: recordBefore.previousBundles ?? previousBundles,
            upstreamWasMounted: recordBefore.upstreamWasMounted === true || upstreamWasMounted,
            originalBackupDir: recordBefore.originalBackupDir ?? recordBefore.backupDir ?? backup.dir,
            firstInstalledAt: recordBefore.firstInstalledAt ?? recordBefore.at ?? new Date().toISOString()
          }
        : { previousBundles, upstreamWasMounted, originalBackupDir: backup.dir, firstInstalledAt: new Date().toISOString() }
    const record = {
      schema: 'dsh-pylon-trae/install-record@1',
      at: new Date().toISOString(),
      home: HOME,
      profile: PROFILE,
      name: TARGET_NAME,
      mode: from === undefined ? 'link' : 'tgz',
      version: from?.version ?? recordBefore?.version ?? 'source',
      assemblySha256: from?.assembly,
      source: sourceDir,
      from: FROM === undefined ? undefined : resolve(FROM),
      previousJunctionTarget: previousTarget,
      previousBundles: carried.previousBundles,
      upstreamWasMounted: carried.upstreamWasMounted,
      originalBackupDir: carried.originalBackupDir,
      firstInstalledAt: carried.firstInstalledAt,
      backupDir: backup.dir,
      backups: { package: backup.package, patch: backup.patch }
    }
    writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    info(`[记录] ${RECORD_PATH}（卸载/回滚要读它）`)
    if (recordBefore !== undefined && recordBefore.upstreamWasMounted !== undefined) {
      info(`[记录] 原始现场沿用上一次记录（上游当初挂载=${String(carried.upstreamWasMounted)}，首次安装于 ${String(carried.firstInstalledAt)}）`)
    }
  }

  const bundlesAfter = next.dsh.profile.bundles
  info(
    `\n[变更] bundles：${previousBundles.length} 条 → ${bundlesAfter.length} 条` +
      (upstreamWasMounted ? `（已摘掉上游 ${UPSTREAM_NAME}；依赖与磁盘保留，放回名字就是还原）` : '（上游本来就没挂）')
  )
  info(`[变更] dependencies["${TARGET_NAME}"] = link:${sourceDir.replaceAll('\\', '/')}`)

  if (DRY_RUN) {
    console.log('\n（--dry-run：以上全部检查都过了，但没有写任何文件。）')
    return
  }

  console.log(`\n✅ 装好了。**没有替你启动 DSH** —— 请自己重启 DSH（完全退出再开，不是刷新页面）。`)
  console.log(`\n重启后按这个顺序看（三处，任一处不对就知道停在哪一步）：`)
  console.log(`  1. 启动日志/诊断轨迹里有两行：`)
  console.log(`       [dsh-trae] module loaded            ← 模块被 import 了（没有 = 没挂上）`)
  console.log(`       apply: enabled=true port=7864 provider=trae mode=auto   ← apply 跑了（有上一行没这一行 = 卡在依赖等待）`)
  console.log(`     文件：$DSH_HOME\\${OWN_DIR}\\boot.log（改名扫尾完成前它还在 $DSH_HOME\\.dsh-trae\\boot.log）`)
  console.log(`  2. 设置 → 模型：出现一条 Trae（可编辑、含全量模型）；设置 → 插件：出现 dsh-pylon-trae 卡片`)
  console.log(`  3. 回环服务活着：curl -H "Authorization: Bearer <token>" http://127.0.0.1:7864/healthz 回 {"ok":true,...}`)
  console.log(`     （token 在同目录的 cn-shim-token.json 里；不要打印它）`)
  console.log(`\n出问题的第一站不是猜：先跑 node tools\\doctor.ts --profile ${PROFILE}`)
  if (upstreamWasMounted) console.log(`\n提醒：上游 ${UPSTREAM_NAME} 已从 bundles 摘掉（怕它抢路由 id）。想还原：node install.mjs --uninstall --profile ${PROFILE}`)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 8. 卸载（干净回滚）
 * ──────────────────────────────────────────────────────────────────────────── */
function uninstall() {
  requireProfile()
  const before = readJson(PACKAGE_PATH)
  const record = existsSync(RECORD_PATH) ? JSON.parse(readFileSync(RECORD_PATH, 'utf8')) : undefined
  const bundles = Array.isArray(before.value?.dsh?.profile?.bundles) ? before.value.dsh.profile.bundles : []
  const ours = bundles.filter((bundle) => ALL_NAMES.includes(bundle))
  const upstreamInstalledOnDisk = existsSync(join(PROFILE_DIR, 'node_modules', UPSTREAM_NAME))

  step(`卸载 · profile=${PROFILE}`)
  info(`[基线] bundles 含我们 ${ours.length} 条：${ours.join(', ') || '(无)'} · 上游挂载 ${bundles.includes(UPSTREAM_NAME) ? '是' : '否'} · 上游在磁盘上 ${upstreamInstalledOnDisk ? '是' : '否'}`)
  if (record === undefined) warn(`没有安装记录（${RECORD_PATH}）—— 按当前 profile 的实际内容回滚，不会去猜历史`)

  // 「要不要把上游放回去」这件事只有一个诚实的判据：它当初是不是我们摘掉的。
  const shouldRestoreUpstream = record?.upstreamWasMounted === true
  const next = JSON.parse(JSON.stringify(before.value))
  next.dependencies = { ...next.dependencies }
  for (const name of ALL_NAMES) delete next.dependencies[name]
  const nextBundles = bundles.filter((bundle) => !ALL_NAMES.includes(bundle))
  if (shouldRestoreUpstream && !nextBundles.includes(UPSTREAM_NAME)) {
    // 放回**原来的位置**，不是简单地追加到末尾：干净的还原应当逐字节等于安装前，
    // 而 bundles 的顺序会被别的工具读（谁也不希望一次装卸就顺手把顺序改了）。
    const pristineBundles = Array.isArray(record?.previousBundles) ? record.previousBundles : []
    const originalIndex = pristineBundles.indexOf(UPSTREAM_NAME)
    const at = originalIndex >= 0 ? Math.min(originalIndex, nextBundles.length) : nextBundles.length
    nextBundles.splice(at, 0, UPSTREAM_NAME)
  }
  next.dsh = { ...next.dsh, profile: { ...next.dsh?.profile, bundles: nextBundles } }

  const backup = backupProfile('uninstall')
  const realProblems = verifyUninstallCandidate(before.value, next)
  if (realProblems.length > 0) fail(`回滚候选自校验不过（没写盘）：\n     · ${realProblems.join('\n     · ')}`, '这是脚本的 bug；profile 没被改动。')

  // 顺序与安装相反：先把 profile 里的登记撤掉，再拆 junction。
  step('profile 撤销登记')
  const serialized = `${JSON.stringify(next, null, 2)}\n`
  if (DRY_RUN) {
    info(`[dry-run] 会写回 ${PACKAGE_PATH}：移除 ${ALL_NAMES.join('/')} 的依赖行与 bundles 条目${shouldRestoreUpstream ? `，并把 ${UPSTREAM_NAME} 放回 bundles` : ''}`)
  } else {
    const tmp = `${PACKAGE_PATH}.uninstalling-${process.pid}`
    writeFileSync(tmp, serialized, 'utf8')
    const check = readJson(tmp).value
    if (ALL_NAMES.some((name) => check.dependencies?.[name] !== undefined)) {
      rmSync(tmp, { force: true })
      fail('候选里还有我们的依赖行（脚本 bug），已放弃写入', 'profile 没被改动。')
    }
    renameSync(tmp, PACKAGE_PATH)
    const after = readJson(PACKAGE_PATH).value
    if (ALL_NAMES.some((name) => after.dependencies?.[name] !== undefined)) {
      copyFileSync(backup.package, PACKAGE_PATH)
      if (existsSync(backup.patch)) copyFileSync(backup.patch, PATCH_PATH)
      fail('写入后核对失败（依赖行没删干净），已用备份还原', '重试一次；仍然失败就把这段贴给维护者。')
    }
    info(`[写入] ${PACKAGE_PATH}（已重新读盘核对）`)
  }

  step('junction')
  removeJunction(join(PROFILE_DIR, 'node_modules', TARGET_NAME), '卸载')
  for (const legacy of LEGACY_NAMES) {
    const linkPath = join(PROFILE_DIR, 'node_modules', legacy)
    if (existsSync(linkPath)) removeJunction(linkPath, '卸载（旧名）')
  }

  if (!DRY_RUN) {
    const nextRecord = {
      schema: 'dsh-pylon-trae/install-record@1',
      at: new Date().toISOString(),
      home: HOME,
      profile: PROFILE,
      name: TARGET_NAME,
      mode: 'uninstalled',
      version: undefined,
      previousJunctionTarget: record?.previousJunctionTarget,
      previousBundles: record?.previousBundles,
      upstreamWasMounted: record?.upstreamWasMounted,
      lastUninstallBackupDir: backup.dir
    }
    writeFileSync(RECORD_PATH, `${JSON.stringify(nextRecord, null, 2)}\n`, 'utf8')
  }

  console.log(`\n✅ 已卸载：profile ${PROFILE} 里没有我们的依赖行与 bundles 条目，junction 已移除。`)
  console.log(`   本次备份：${backup.dir}（要还原这次卸载 → node install.mjs --rollback --profile ${PROFILE}）`)
  console.log(`\n是否需要恢复上游 ${UPSTREAM_NAME}？`)
  if (shouldRestoreUpstream) {
    console.log(`   需要，而且已经做了：安装记录里它当初是挂着的，所以已把 "${UPSTREAM_NAME}" 放回 bundles。`)
    console.log(`   想彻底回到只有上游的状态：重启 DSH 即可（它的依赖还在：${upstreamInstalledOnDisk ? '磁盘上在' : '磁盘上不见了，需要 pnpm install'}）。`)
  } else if (upstreamInstalledOnDisk) {
    console.log(`   不需要（默认没动它）：它在磁盘上是装着的，但当初就不在 bundles 里 —— 我们没摘过它，所以也不替你放回去。`)
    console.log(`   若你确实想改用回上游：把 "${UPSTREAM_NAME}" 加进 ${PACKAGE_PATH} 的 dsh.profile.bundles，再重启 DSH。`)
  } else {
    console.log(`   上游根本不在磁盘上（node_modules\\${UPSTREAM_NAME} 不存在）—— 没什么可恢复的；要用它得先装。`)
  }
  console.log(`\n插件自己的状态目录没有删（${OWN_ROOT}：token、state.json、备份、记录）—— 想彻底清掉就手工删这个目录。`)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 9. 回滚：用最近一次备份还原 profile 的两个文件
 * ──────────────────────────────────────────────────────────────────────────── */
function rollback() {
  requireProfile()
  if (!existsSync(BACKUP_ROOT)) fail(`没有备份目录：${BACKUP_ROOT}`, '没有备份就没法回滚：这个 profile 没被本脚本改过。')
  const dirs = readdirSync(BACKUP_ROOT).sort()
  const latest = dirs[dirs.length - 1]
  if (latest === undefined) fail(`备份目录是空的：${BACKUP_ROOT}`, '没有备份可回滚。')
  const dir = join(BACKUP_ROOT, latest)
  const packageBackup = join(dir, 'package.json')
  const patchBackup = join(dir, 'cordis.patch.yml')
  if (!existsSync(packageBackup)) fail(`最近一次备份里没有 package.json：${dir}`, '换一个备份目录手工还原。')

  step(`回滚 · 用 ${dir}`)
  const record = existsSync(RECORD_PATH) ? JSON.parse(readFileSync(RECORD_PATH, 'utf8')) : undefined
  info(`[备份] package.json sha256 ${fileSha256(packageBackup).slice(0, 12)}…`)

  // 回滚本身也要有退路：先把"现在"存一份，别把回滚变成不可逆操作
  const safety = backupProfile('pre-rollback')
  if (DRY_RUN) {
    info(`[dry-run] 会把 ${packageBackup} 还原到 ${PACKAGE_PATH}${existsSync(patchBackup) ? '，并还原 cordis.patch.yml' : ''}`)
    info(`[dry-run] 回滚前的现场会先存到 ${safety.dir}`)
    return
  }
  copyFileSync(packageBackup, PACKAGE_PATH)
  if (existsSync(patchBackup)) copyFileSync(patchBackup, PATCH_PATH)
  const restored = readJson(PACKAGE_PATH)
  const bundles = Array.isArray(restored.value?.dsh?.profile?.bundles) ? restored.value.dsh.profile.bundles : []
  info(`[还原] ${PACKAGE_PATH} · bundles=[${bundles.join(', ')}]`)

  const previous = record?.previousJunctionTarget
  if (typeof previous === 'string' && existsSync(previous)) {
    makeJunction(previous, join(PROFILE_DIR, 'node_modules', TARGET_NAME))
    info(`[还原] junction 指回 ${previous}`)
  } else if (typeof previous === 'string') {
    warn(`记录里的旧 junction 目标已经不在磁盘上：${previous} —— junction 保持现状`)
  }
  console.log(`\n✅ 已回滚到 ${dir} 里的那份 profile。重启 DSH 生效。`)
  console.log(`   回滚前的现场存在：${safety.dir}（要撤销这次回滚，就再跑一次 --rollback 之前先手工从这里拷回）`)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 入口
 * ──────────────────────────────────────────────────────────────────────────── */
const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0)
const nodeMinor = Number(process.versions.node.split('.')[1] ?? 0)
if (nodeMajor < MIN_NODE[0] || (nodeMajor === MIN_NODE[0] && nodeMinor < MIN_NODE[1])) {
  fail(`Node ${process.versions.node} 太旧（需要 ≥ ${MIN_NODE.join('.')}）`, '用 DSH 自带的 node：<dsh-node>')
}

if (UNINSTALL) uninstall()
else if (ROLLBACK) rollback()
else install()

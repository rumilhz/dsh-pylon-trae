/**
 * dsh-pylon-trae doctor — 装之前先问清楚这台机器行不行（**只读**）。
 *
 * 为什么要有它：这个插件的每一种前提不满足，症状都是"卡片空白"或"模型页没有
 * Trae 这一条"，而这两件事在日志里长得一模一样。装之前把下面七件事各问一遍，
 * 每一条都给出 ✅/⚠️/❌ 加一句"怎么办"，就没有"静默失败"这种东西了。
 *
 *   ① 平台是不是 Windows（别的平台代码结构在，但没实测）
 *   ② 能不能找到 Trae 凭据（桌面端 / CLI 分开说；候选表整张打出来）
 *   ③ 7864（CN）/ 7865（AI）这两个回环端口是不是空闲（被占要报持有者 PID/进程名）
 *   ④ $DSH_HOME 与目标 profile 的 cordis.patch.yml 在不在（no-guard 的三种成因
 *      用 guard.ts 的 explainPatchLookup 原话打出来 —— 那段诊断就是为这一刻写的）
 *   ⑤ 该 profile 的 package.json：bundles 里有没有我们；是不是还挂着上游
 *      dsh-connect-trae（它注册同名路由 `trae`/`trae-global`，会和我们抢）
 *   ⑥ Trae 网关可达吗（只读探测；不可达不致命，会退回内置兜底清单）
 *   ⑦ 运行时是不是够用（Node ≥ 22.6 才原生跑 .ts）
 *
 * 退出码：有 ❌ → 1，其余（全绿或只有 ⚠️）→ 0。⚠️ 仍然打印，只是不拦。
 *
 * 命名：本插件的目标名是 `dsh-pylon-trae`（非作用域，`dsh-pylon-` 是今后同类插件的
 * 统一前缀）。改名扫尾完成之前，profile 里可能还是旧名 `@local/dsh-trae` —— 两种都
 * 认，旧名报 ⚠️ 并说明"重启前需要完成改名"，因为那正是迁移期真实存在的样子。
 *
 * 这个脚本**不写任何文件**，也不打印任何凭据（token 只出现 sha256 前 12 位）。
 *
 * 用法：
 *   <dsh-node> tools/doctor.ts [--profile <name>] [--home <path>] [--no-network] [--quiet]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  isExpired,
  renderCandidateReport,
  renderCandidateTable,
  scanCredentials,
  tokenFingerprint,
  type TraeCredential
} from '../src/auth.ts'
import { REGION_GATEWAYS } from '../src/catalog.ts'
import { explainPatchLookup, resolvePatchPath } from '../src/guard.ts'
import { traeStorageCandidates, type TraeRegion } from '../src/paths.ts'

/* ────────────────────────────────────────────────────────────────────────────
 * 名字：目标名 + 迁移期旧名
 *
 * `dsh-trae`（裸名）也要认：guard.ts 现在拿到的 pluginName 还是 `dsh-trae`
 * （src/index.ts 的 `export const name`），改名扫尾会把它换成新名。三种拼法都
 * 出现在 bundles 匹配里，才不至于在迁移期把"装着"误判成"没装"。
 * ──────────────────────────────────────────────────────────────────────────── */
const TARGET_NAME = 'dsh-pylon-trae'
const LEGACY_NAMES = ['@local/dsh-trae', 'dsh-trae'] as const

/** 本插件在 profile 的 bundles 里的三种可能拼法，按"新旧"排序判定。 */
function classifyBundle(name: string): 'target' | 'legacy' | 'no' {
  if (name === TARGET_NAME) return 'target'
  return (LEGACY_NAMES as readonly string[]).includes(name) ? 'legacy' : 'no'
}

/** 上游插件名：它注册的同名路由会和我们抢。 */
const UPSTREAM_NAME = 'dsh-connect-trae'

/** 数据目录：新名优先，旧名只用于"这里是旧目录"的提示。 */
const OWN_DIR_NEW = '.dsh-pylon-trae'
const OWN_DIR_LEGACY = '.dsh-trae'

/* ────────────────────────────────────────────────────────────────────────────
 * 命令行
 * ──────────────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2)
function option(name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}
const NO_NETWORK = argv.includes('--no-network')
const QUIET = argv.includes('--quiet')
const ALLOW_UNTESTED_PLATFORM = argv.includes('--allow-untested-platform')
const DSH_HOME = option('--home') ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

/* ────────────────────────────────────────────────────────────────────────────
 * 结论的收集器：每条一个 level + 标题 + 怎么办
 * ──────────────────────────────────────────────────────────────────────────── */
type Level = 'ok' | 'warn' | 'bad'
interface Verdict {
  id: string
  level: Level
  title: string
  fix?: string
  /** 细节行（缩进打印，不参与总结计数）。 */
  detail?: string[]
}
const verdicts: Verdict[] = []
const add = (verdict: Verdict): void => void verdicts.push(verdict)
const MARK: Record<Level, string> = { ok: '✅', warn: '⚠️ ', bad: '❌' }

/** 名字里带 Trae 的数据目录一律只读 —— 这个断言是给未来改代码的人看的。 */
const FORBIDDEN_WRITE_PREFIXES = ['AppData\\Roaming\\Trae', 'AppData/Roaming/Trae']
function assertReadOnlyPath(path: string): void {
  for (const prefix of FORBIDDEN_WRITE_PREFIXES) {
    if (path.includes(prefix)) throw new Error(`doctor 是只读的，拒绝把 ${path} 当写目标`)
  }
}

const line = (char = '─', width = 78): string => char.repeat(width)

/* ────────────────────────────────────────────────────────────────────────────
 * ① 平台
 * ──────────────────────────────────────────────────────────────────────────── */
add(
  process.platform === 'win32'
    ? { id: 'platform', level: 'ok', title: `平台 Windows (win32) —— 这是唯一实测过的平台` }
    : {
        id: 'platform',
        level: ALLOW_UNTESTED_PLATFORM ? 'warn' : 'bad',
        title:
          `平台 ${process.platform} —— 本项目只在 Windows + Trae CN 上实测过，路径表虽按三平台写好但**未实测**` +
          (ALLOW_UNTESTED_PLATFORM ? '（你已用 --allow-untested-platform 明确表示要试，这一条降级为 ⚠️）' : ''),
        fix: `非 Windows 一律当"未实测"处理：install.mjs 默认会拒绝。确要试装请显式加 --allow-untested-platform，并预期需要在 进展.md 里补一次实测记录。`
      }
)

/* ────────────────────────────────────────────────────────────────────────────
 * ⑦ 运行时（放在前面，因为它解释"为什么这条命令能跑"）
 * ──────────────────────────────────────────────────────────────────────────── */
const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0)
const nodeMinor = Number(process.versions.node.split('.')[1] ?? 0)
add(
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)
    ? { id: 'node', level: 'ok', title: `Node ${process.versions.node} —— ≥22.6，可以直接跑 .ts（类型擦除，无构建步骤）` }
    : {
        id: 'node',
        level: 'bad',
        title: `Node ${process.versions.node} —— 低于 22.6，跑不了 .ts`,
        fix: `用 DSH 自带的那个 node：DSH 安装目录下 resources\\runtime\\…\\node.exe（比系统 node 新），或把系统 node 升到 ≥22.6`
      }
)

/* ────────────────────────────────────────────────────────────────────────────
 * ② 凭据：桌面端 / CLI 分开说，候选表整张打出来
 *
 * 这张表是 auth.ts 的既有能力（candidateReports / renderCandidateTable）：只有它
 * 能区分"这台机器没装 Trae"和"装了但没人登录"—— 这两件事对用户的要求完全不同。
 * ──────────────────────────────────────────────────────────────────────────── */
const candidates = traeStorageCandidates()
const scan = scanCredentials(candidates)
const where = (credential: TraeCredential): string =>
  `${credential.source}/${credential.edition} user=${credential.userId || '(无)'} fp=${tokenFingerprint(credential)}`

const desktopCreds = scan.credentials.filter((c) => c.source === 'desktop')
const cliCreds = scan.credentials.filter((c) => c.source === 'cli')
const now = Date.now()
const live = (list: TraeCredential[]): TraeCredential[] => list.filter((c) => !isExpired(c, 60_000, now))

const candidateTable = renderCandidateTable(candidates)
const candidateDetail = renderCandidateReport(candidates).split('\n')

if (desktopCreds.length > 0) {
  const liveDesktop = live(desktopCreds)
  add({
    id: 'cred-desktop',
    level: liveDesktop.length > 0 ? 'ok' : 'warn',
    title: `桌面端凭据 ${desktopCreds.length} 份${liveDesktop.length > 0 ? '' : '（都已过期，重启后会先用 refreshToken 续期）'}`,
    detail: desktopCreds.map((c) => `    ${where(c)}`)
  })
} else {
  add({
    id: 'cred-desktop',
    level: 'warn',
    title: `桌面端没有可用凭据（Trae 桌面端没装，或装了但没人登录）`,
    detail: [`    已探测：${candidateTable}`, ...candidateDetail.slice(0, 6).map((l) => `    ${l}`), '    …（完整候选表见 --quiet 之外的原始输出）'],
    fix: `打开 Trae 桌面端登录一次（登录后它的 storage.json 里会出现 auth 文档），再跑一次本命令`
  })
}

if (cliCreds.length > 0) {
  const liveCli = live(cliCreds)
  add({
    id: 'cred-cli',
    level: liveCli.length > 0 ? 'ok' : 'warn',
    title: `CLI 凭据 ${cliCreds.length} 份${liveCli.length > 0 ? '' : '（都已过期）'}`,
    detail: cliCreds.map((c) => `    ${where(c)}`)
  })
} else {
  add({
    id: 'cred-cli',
    level: 'warn',
    title: `没有 CLI 凭据（~/.trae-cn/trae-jwt-token 不存在）—— 只用桌面端也能跑，这不是问题`,
    fix: undefined
  })
}

if (scan.credentials.length === 0) {
  add({
    id: 'cred-any',
    level: 'bad',
    title: `一个可用凭据都没有`,
    detail: [`    ${scan.found.length === 0 ? '没有任何候选存在' : `${scan.found.length} 个候选存在但都读不出凭据`}`],
    fix: `先在本机登录 Trae（桌面端最省事），登录后重跑 doctor。诊断原文：${
      scan.found.length === 0
        ? `已探测 ${candidates.length} 个候选，没有一个存在 —— Trae 桌面板与 CLI 都没装（或装在其他用户目录下）`
        : scan.failures.join(' | ')
    }`
  })
} else if (scan.failures.length > 0) {
  add({
    id: 'cred-failures',
    level: 'warn',
    title: `${scan.failures.length} 个候选存在但读不出凭据（其余候选可用，通常不影响）`,
    detail: scan.failures.map((f) => `    ${f}`)
  })
}

/* ────────────────────────────────────────────────────────────────────────────
 * ③ 端口：先试着 bind 一次（最可靠的占用判定），被占再去问"是谁"
 * ──────────────────────────────────────────────────────────────────────────── */
interface PortOwner {
  pid?: number
  processName?: string
  ours?: boolean
  ourNote?: string
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** Windows: netstat 找 PID → tasklist 找进程名。别的平台: lsof（没有就只报端口被占）。 */
function ownerOf(port: number): PortOwner {
  try {
    if (process.platform === 'win32') {
      const netstat = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 5000 })
      const row = netstat
        .split(/\r?\n/)
        .find((l) => l.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(l))
      const pidText = row?.trim().split(/\s+/).pop()
      const pid = pidText !== undefined && /^\d+$/.test(pidText) ? Number(pidText) : undefined
      if (pid === undefined) return {}
      let processName: string | undefined
      try {
        const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000 })
        processName = csv.trim().split('","')[0]?.replace(/^"/, '') || undefined
      } catch {
        processName = undefined
      }
      return { pid, processName }
    }
    const lsof = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 })
    const row = lsof.split(/\r?\n/)[1]
    const pid = row === undefined ? undefined : Number(row.trim().split(/\s+/)[1])
    const processName = row === undefined ? undefined : row.trim().split(/\s+/)[0]
    return { pid: Number.isFinite(pid) ? pid : undefined, processName }
  } catch {
    return {}
  }
}

/**
 * 是不是我们自己的 shim 占着？
 *
 * `/healthz` 在 Bearer 之后（401 之前的 403/401 都长得一样，认不出是谁），所以
 * 先匿名试一次，认不出来再拿**我们自己**的回环 token 试一次 —— 那个 token 不是
 * Trae 的凭据（它只挡住别的本机进程蹭额度），文件就在本插件自己的状态目录里：
 * `$DSH_HOME/{.dsh-pylon-trae,.dsh-trae}/<region>-shim-token.json`，内容是裸 token
 * 一行。**只读，且永不打印**（doctor 对任何 token 都只认形状不认内容）。
 *
 * 这一步决定 7864 被占是 ⚠️ 还是 ❌：占着的人是"正在运行的自己"（重启即可）还是
 * "别的什么进程"（必须先解决）—— 同一句"端口被占"对用户的要求完全不同。
 */
async function looksLikeOurShim(port: number, bearer?: string): Promise<string | undefined> {
  for (const token of [undefined, bearer]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1500),
        ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } })
      })
      if (!response.ok) continue
      const record = (await response.json()) as { ok?: unknown; region?: unknown; models?: unknown }
      if (record.ok === true && (record.region === 'cn' || record.region === 'ai') && typeof record.models === 'number') {
        return `本插件的回环服务（region=${String(record.region)} models=${String(record.models)}）`
      }
    } catch {
      // 不是我们、或者对面根本不是 HTTP：都只是"认不出"，继续下一种试法
    }
  }
  return undefined
}

/**
 * 读我们自己那个回环 token（新名目录优先，迁移期回落到旧名目录）。
 *
 * 要找的**不止目标 home**：7864 上那个 shim 属于"正在运行的那个 DSH"，而它用的是
 * 它自己的 home。只想检查一个临时 home 的时候，如果只在这个 home 里找 token，
 * 就会把"正在运行的我们自己"误判成"别的进程占着端口" —— 而这正是安装前最不该
 * 出现的一句假警报。所以：目标 home → 环境里的 DSH_HOME → 默认 ~/.dsh，依次找。
 */
function ownShimToken(): string | undefined {
  const homes = [DSH_HOME, process.env['DSH_HOME'], join(homedir(), '.dsh')].filter(
    (value): value is string => typeof value === 'string' && value !== ''
  )
  for (const home of new Set(homes.map((value) => resolve(value)))) {
    for (const dir of [OWN_DIR_NEW, OWN_DIR_LEGACY]) {
      for (const region of ['cn', 'ai']) {
        const path = join(home, dir, `${region}-shim-token.json`)
        assertReadOnlyPath(path)
        try {
          if (!existsSync(path)) continue
          const token = readFileSync(path, 'utf8').trim()
          if (token !== '') return token
        } catch {
          continue
        }
      }
    }
  }
  return undefined
}

const PORTS: { port: number; label: string }[] = [
  { port: 7864, label: 'CN' },
  { port: 7865, label: 'AI' }
]
const shimToken = ownShimToken()
for (const { port, label } of PORTS) {
  const free = await probePort(port)
  if (free) {
    add({ id: `port-${port}`, level: 'ok', title: `${port}（${label}）空闲` })
    continue
  }
  const ours = await looksLikeOurShim(port, shimToken)
  const owner = ownerOf(port)
  const ownerText = owner.pid === undefined ? '（拿不到持有者 PID）' : `pid=${owner.pid} ${owner.processName ?? '(进程名未知)'}`
  if (ours !== undefined) {
    add({
      id: `port-${port}`,
      level: 'warn',
      title: `${port}（${label}）被占用：${ours} —— 也就是本插件正在某个 DSH 里跑着`,
      detail: [`    持有者：${ownerText}`],
      fix: `安装/升级前先退出 DSH（否则宿主退出时可能覆盖 profile 的 package.json）。只是检查的话，这一条不影响结论。`
    })
  } else {
    add({
      id: `port-${port}`,
      level: 'bad',
      title: `${port}（${label}）被别的进程占着：${ownerText}`,
      fix: `关掉它，或在 DSH 里把 dsh-pylon-trae 的 config.port 改成别的端口（默认 ${port}）。改端口会让"用 7864 的旧配置"失效，优先关进程。`
    })
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * ④ $DSH_HOME 与目标 profile 的 patch
 *
 * "no-guard" 有三种成因（home 不对 / profile 没挂我们 / profile 根本不存在），
 * 而 explainPatchLookup 的整段输出就是为把这三者分开写的 —— 这里**原话照打**。
 * ──────────────────────────────────────────────────────────────────────────── */
const explicitHome = process.env['DSH_HOME']
const profilesRoot = join(DSH_HOME, 'profiles')
const profileArg = option('--profile')
const mountingPatch = resolvePatchPath('dsh-trae', DSH_HOME) ?? resolvePatchPath(TARGET_NAME, DSH_HOME)
const autoProfile =
  profileArg ??
  (mountingPatch === undefined ? undefined : mountingPatch.replaceAll('\\', '/').split('/profiles/')[1]?.split('/')[0]) ??
  'desktop'

const homeExists = existsSync(DSH_HOME)
add(
  homeExists
    ? {
        id: 'home',
        level: 'ok',
        title: `$DSH_HOME = ${DSH_HOME}${explicitHome === undefined ? '（环境变量未设置，按默认 ~/.dsh 处理 —— 这是正常情况）' : ''}`
      }
    : {
        id: 'home',
        level: 'bad',
        title: `$DSH_HOME = ${DSH_HOME} 不存在${explicitHome === undefined ? '（环境变量未设置，按默认 ~/.dsh 推出来的）' : ''}`,
        fix: `先启动一次 DSH（它会创建 home 与 profile），或者用 --home <path> 指向真的 home`
      }
)

const profileDir = join(profilesRoot, autoProfile)
const profilePackage = join(profileDir, 'package.json')
const profilePatch = join(profileDir, 'cordis.patch.yml')
const profileExists = existsSync(profileDir)
const packageExists = existsSync(profilePackage)
const patchExists = existsSync(profilePatch)

if (!profileExists || !packageExists) {
  add({
    id: 'profile',
    level: 'bad',
    title: `profile ${autoProfile} 不完整：目录 ${profileExists ? '在' : '不在'} · package.json ${packageExists ? '在' : '不在'}`,
    fix: `先启动一次 DSH（profile 由它创建），或把 --profile 指到已有的 profile 名（当前 home 下有：${
      existsSync(profilesRoot) ? readdirSync(profilesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).join(', ') || '(无)' : '(没有 profiles/ 目录)'
    }）`
  })
}

// 无论上面结论如何，这三行都要打：它就是"为什么 guard 找不到 patch"的答案本身。
add({
  id: 'patch',
  level: patchExists ? 'ok' : 'bad',
  title: patchExists
    ? `目标 patch 存在：${profilePatch}`
    : `目标 patch **不存在**：${profilePatch} —— 插件会以 no-guard 启动（只读能用，写模型清单会被拒绝）`,
  detail: [
    `    guard 原话（pluginName=dsh-trae）：${explainPatchLookup('dsh-trae', DSH_HOME)}`,
    `    guard 原话（pluginName=${TARGET_NAME}）：${explainPatchLookup(TARGET_NAME, DSH_HOME)}`
  ],
  ...(patchExists ? {} : { fix: `patch 由 DSH 在 profile 首次启动时创建；确认 profile 名对不对（--profile），别对着一个不存在的 profile 装。` })
})

/* ────────────────────────────────────────────────────────────────────────────
 * ⑤ profile 的 bundles：有没有我们 / 是不是旧名 / 是不是还挂着上游
 * ──────────────────────────────────────────────────────────────────────────── */
interface ProfileManifest {
  dependencies?: Record<string, unknown>
  dsh?: { profile?: { bundles?: unknown } }
}
let manifest: ProfileManifest | undefined
if (packageExists) {
  try {
    manifest = JSON.parse(readFileSync(profilePackage, 'utf8')) as ProfileManifest
  } catch (error) {
    add({
      id: 'manifest',
      level: 'bad',
      title: `profile 的 package.json 解析失败：${error instanceof Error ? error.message : String(error)}`,
      fix: `先修好这个 JSON（它是 profile 的挂载表），再谈装插件`
    })
  }
}

if (manifest !== undefined) {
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles.map(String) : []
  const target = bundles.filter((b) => classifyBundle(b) === 'target')
  const legacy = bundles.filter((b) => classifyBundle(b) === 'legacy')
  const upstream = bundles.includes(UPSTREAM_NAME)

  if (target.length > 0) {
    add({ id: 'bundles-us', level: 'ok', title: `bundles 含 ${TARGET_NAME} —— 挂载正常`, detail: [`    bundles = [${bundles.join(', ')}]`] })
  } else if (legacy.length > 0) {
    add({
      id: 'bundles-us',
      level: 'warn',
      title: `bundles 里是我们的**旧名** ${legacy.join(', ')} —— 这是改名（dsh-trae → ${TARGET_NAME}）扫尾完成前的正常状态`,
      detail: [`    bundles = [${bundles.join(', ')}]`],
      fix: `重启前需要完成改名：把 bundles 与 dependencies 里的旧名换成 ${TARGET_NAME}（install.mjs 会做这件事）。旧名继续挂着也能跑，但两套名字同时在 profile 里出现时最容易"以为装了其实没装"。`
    })
  } else {
    add({
      id: 'bundles-us',
      level: 'warn',
      title: `bundles 里没有我们 —— 插件**还没挂进这个 profile**（这正是"卡片空白/模型页没有 Trae"的第一原因）`,
      detail: [`    bundles = [${bundles.join(', ')}]`],
      fix: `运行 node install.mjs --profile ${autoProfile}（从源码）或 node install.mjs --profile ${autoProfile} --from dist\\${TARGET_NAME}-<version>.tgz（从发布包）`
    })
  }

  add(
    upstream
      ? {
          id: 'bundles-upstream',
          level: 'warn',
          title: `bundles **仍挂着上游 ${UPSTREAM_NAME}** —— 它会注册同名路由（trae / trae-global），与我们的供应商抢同一个 id`,
          detail: [`    症状：模型页里两条 Trae，或选择器里的条目被上游接管`],
          fix: `install.mjs 会把它从 bundles 里摘掉（依赖与磁盘保留，放回名字就是还原）。要手工做就删掉 bundles 里的 "${UPSTREAM_NAME}" 一行，然后重启 DSH。`
        }
      : { id: 'bundles-upstream', level: 'ok', title: `bundles 未挂载上游 ${UPSTREAM_NAME}（依赖仍在磁盘上留着，这是对的）` }
  )

  const dependency = manifest.dependencies?.[TARGET_NAME]
  const legacyDependency = LEGACY_NAMES.map((n) => manifest.dependencies?.[n]).find((v) => v !== undefined)
  add({
    id: 'deps',
    level: typeof dependency === 'string' ? 'ok' : 'warn',
    title:
      typeof dependency === 'string'
        ? `dependencies["${TARGET_NAME}"] = ${dependency}`
        : legacyDependency === undefined
          ? `dependencies 里没有 ${TARGET_NAME}（bundles 挂了但没有依赖登记 ⇒ 宿主可能解析不到它）`
          : `dependencies 里是旧名：${String(legacyDependency)}`,
    fix: typeof dependency === 'string' ? undefined : `install.mjs 会补上依赖登记；手工做法是加一行 "${TARGET_NAME}": "link:<插件目录>"（源码）或 "file:<tgz>"（发布包）`
  })
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑥ 网关可达（只读、无凭据、HEAD 一次）
 *
 * 不可达不致命：catalog.ts 里带一份内置兜底清单，插件照常能起来，只是模型目录
 * 不是实时的。所以这一条永远是 ⚠️，不是 ❌。
 * ──────────────────────────────────────────────────────────────────────────── */
if (NO_NETWORK) {
  add({ id: 'gateway', level: 'warn', title: `网关探测已跳过（--no-network）`, fix: `去掉 --no-network 可以确认 Trae 网关是否可达` })
} else {
  const regions: TraeRegion[] = ['cn', 'ai']
  const results: string[] = []
  let anyOk = false
  let anyReachable = false
  for (const region of regions) {
    const host = REGION_GATEWAYS[region].pay
    try {
      const response = await fetch(host, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(4000) })
      anyReachable = true
      anyOk = true
      results.push(`${region}: ${host} → HTTP ${response.status}（可达）`)
    } catch (error) {
      results.push(`${region}: ${host} → 不可达（${error instanceof Error ? error.name : String(error)}）`)
    }
  }
  add({
    id: 'gateway',
    level: anyOk ? 'ok' : 'warn',
    title: anyReachable ? `Trae 网关可达（只看 TCP/TLS，不发凭据）` : `Trae 网关都不可达 —— 重启后模型目录会退回内置兜底清单（插件本身仍能启动）`,
    detail: results.map((r) => `    ${r}`),
    fix: anyOk ? undefined : `确认这台机器能上外网（公司代理/防火墙）。只是目录不实时，不影响"装得上"。`
  })
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⑦ 本插件自己的数据目录（新名 / 旧名各看一眼，只读）
 * ──────────────────────────────────────────────────────────────────────────── */
const ownNew = join(DSH_HOME, OWN_DIR_NEW)
const ownLegacy = join(DSH_HOME, OWN_DIR_LEGACY)
assertReadOnlyPath(ownNew) // 防御性断言：这几个目录永远只读
const ownDetail: string[] = []
if (existsSync(join(ownNew, 'boot.log'))) ownDetail.push(`    ${join(ownNew, 'boot.log')}（上一次启动的诊断轨迹）`)
if (existsSync(ownLegacy) && !existsSync(ownNew)) {
  ownDetail.push(`    发现旧目录 ${ownLegacy}（改名前的状态目录；重启后插件会在 ${ownNew} 重建状态）`)
}
add({
  id: 'state',
  level: 'ok',
  title: ownDetail.length > 0 ? `本插件状态目录就绪` : `本插件状态目录还不存在（首次启动时创建：${ownNew}）`,
  detail: ownDetail
})

/* ────────────────────────────────────────────────────────────────────────────
 * 打印 + 总结
 * ──────────────────────────────────────────────────────────────────────────── */
console.log(line('='))
console.log(`dsh-pylon-trae doctor · ${process.platform} · node ${process.versions.node}`)
console.log(`home=${DSH_HOME}（${explicitHome === undefined ? 'DSH_HOME 未设置，用默认' : 'DSH_HOME 已设置'}） · profile=${autoProfile}`)
console.log(line('='))
if (!QUIET) {
  for (const verdict of verdicts) {
    console.log(`${MARK[verdict.level]} ${verdict.title}`)
    for (const detail of verdict.detail ?? []) console.log(detail)
    if (verdict.fix !== undefined) console.log(`   → 怎么办：${verdict.fix}`)
  }
  console.log(line())
}

const bad = verdicts.filter((v) => v.level === 'bad')
const warn = verdicts.filter((v) => v.level === 'warn')
const ok = verdicts.filter((v) => v.level === 'ok')

console.log(`结论：${ok.length} 项 ✅ · ${warn.length} 项 ⚠️ · ${bad.length} 项 ❌`)
if (bad.length === 0 && warn.length === 0) {
  console.log(`总结：**可以直接装**。下一步 → node install.mjs --profile ${autoProfile}`)
} else if (bad.length === 0) {
  console.log(`总结：**可以直接装**，但有 ${warn.length} 项要你自己判断（⚠️ 不拦安装）：`)
  for (const v of warn) console.log(`   ⚠️  ${v.title}`)
} else {
  console.log(`总结：**先别装** —— ${bad.length} 项必须先解决：`)
  for (const v of bad) {
    console.log(`   ❌ ${v.title}`)
    if (v.fix !== undefined) console.log(`      → ${v.fix}`)
  }
}
console.log(bad.length === 0 ? '退出码 0（全绿或有 ⚠️）' : '退出码 1（有 ❌）')
process.exit(bad.length === 0 ? 0 : 1)

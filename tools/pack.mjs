/**
 * dsh-pylon-trae pack — 打出**可分发成品** `dist\dsh-pylon-trae-<version>.tgz`。
 *
 * 为什么不用 `npm pack`：随 DSH 一起发的那个 node 目录里**没有 npm**
 * （`…\dependencies\node\` 只有 node.exe），而"新电脑上要能装"这件事不能先要求
 * 用户装一个 npm。所以这里自己写 ustar + gzip：格式是标准的（`package/` 前缀、
 * 512 字节头、checksum 校验），任何 tar 实现都能解，但**不依赖任何外部命令**。
 * 顺带得到一个好处：写入是确定性的（mtime 固定、顺序固定、uid/gid 固定），
 * 同样的输入永远得到同样的 sha256，发布物可以被别人复算。
 *
 * 白名单（这是发布物的边界，不是"顺手多带点"）：
 *   · 权威来源**只有** `package.json` 的 `files` 字段。本脚本不再往里追加任何东西：
 *     发布必须能自我安装（`install.mjs`）、必须带装机说明（`部署-新电脑.md`）、必须
 *     自检能跑全（`tools/fixtures/*.json`）—— 这三件事都是**白名单里的条目**，不是
 *     打包脚本的例外。脚本只做一件事：核对它们仍在 `files` 里，掉一个就拒绝产出。
 *   · `package.json` 自己永远进包（tar 的惯例，也是安装方唯一的元数据）。
 *
 * 硬排除（无论白名单怎么写都不进包）：
 *   `node_modules/`、`dist/`、`*.bak`、`*.log`、任何 `_*` 临时目录、任何名字里带
 *   `mutation` 的目录。这些是本仓的施工痕迹，不是产品。
 *
 * `tools/fixtures/*.json`（**默认进包**；`--no-fixtures` 可裁掉）：它们是"钉住的上游
 * 产物"，仓库里有生成脚本（`tools/emit-turn-bodies.mjs`），而生成脚本要读
 * `~/.dsh/trae-pin` 里那份上游快照 —— 新电脑上没有它，所以**在解出来的包里它们无法
 * 重建**。合计 20 KB，而代价是：解包后自检里有两组会 **SKIP（套件退出码 3）**，而不是 FAIL
 * —— 缺文件与文件过期是两回事，后者仍判失败。这点代价不划算，所以默认带着：
 * 解包后自检是 13 passed · 0 failed（在有钉死快照的机器上）。带着还有个额外好处：
 * fixture 与 `src/` 的一致性闸门（`test-contract.ts` 的过期检查）跟着发布物一起走，
 * 打一份 src 变了却没重生成 fixture 的包会被它当场判红。
 * 形状说清楚：**缺** fixture 是 SKIP（套件退出码 3），**有但过期**是 FAIL —— 两件事
 * 不许长得一样。
 *
 * 用法：
 *   <dsh-node> tools/pack.mjs [--force] [--no-fixtures] [--with-docs] [--files-strict] [--out <dir>] [--dry-run]
 *
 * 退出码：0 成功；1 拒绝（产物已存在且没给 --force、白名单落空、发布必需项不在 `files`
 * 里、开关冲突、自校验不过）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..')
const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')
/** 兼容旧写法：fixtures 现在默认就在 `files` 里，这个开关已无副作用（只在输出里提示一次）。 */
const WITH_FIXTURES = argv.includes('--with-fixtures')
/** 裁剪开关：仍照 `files` 打，但把 `tools/fixtures/*.json` 去掉。代价见文件头。 */
const NO_FIXTURES = argv.includes('--no-fixtures')
const WITH_DOCS = argv.includes('--with-docs')
/** 严格照 `files` 打：不接受任何追加/裁剪开关（与 `--no-fixtures` / `--with-docs` 互斥）。 */
const FILES_STRICT = argv.includes('--files-strict')
const DRY_RUN = argv.includes('--dry-run')
function option(name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}
const OUT_DIR = resolve(option('--out') ?? join(ROOT, 'dist'))

const TARGET_NAME = 'dsh-pylon-trae'
/** tar 里的时间戳：固定值，让"同样的输入 → 同样的 sha256"成立。 */
const FIXED_MTIME = 0
/** 要打进包的两份文档（`files` 没列时只有 `--with-docs` 才带）。 */
const DOCS = ['进展.md', '接口契约.md']
/**
 * 发布物**必须**有的成员 —— 但它们必须在 `package.json` 的 `files` 里，而不是在这里。
 *
 * 上一版这里是 `RELEASE_EXTRA`：不管 `files` 怎么写都强行追加 `install.mjs` 与装机说明。
 * 那是"打包脚本自己另有一套规则"——同一件事有两个出处，早晚会分叉（改 `files` 的人
 * 看不到这段，看这段的人以为 `files` 已经够了）。现在规则只有一个出处：`files`。
 * 本脚本退回到它该做的事 —— **核对**：这些成员任何一个没被白名单覆盖就拒绝产出，
 * 并把"去改 package.json"这句话打出来。
 *
 * 为什么是这四项而不是别的：少了 `install.mjs` 装不了；少了装机说明新电脑不知道
 * 先干什么；少了两个 fixture，解包后自检会少两组检查（SKIP，不是 FAIL —— 见文件头）。
 */
const RELEASE_REQUIRED = ['install.mjs', '部署-新电脑.md', 'tools/fixtures/trae-stream.json', 'tools/fixtures/turn-bodies.json']
/** `files` 没落地时用的内置白名单 —— 与最初交付说明里的那份一致（发布必需项仍走上面的核对）。 */
const DEFAULT_WHITELIST = ['src', 'lib', 'tools', 'install.mjs', '部署-新电脑.md', 'package.json', 'cordis.patch.yml', 'README.md', ...DOCS]

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 白名单
 * ──────────────────────────────────────────────────────────────────────────── */
/**
 * 开关冲突先判：`--files-strict` 的意思就是"只按 `files` 打"，再叠一个"加点什么"
 * 或"裁点什么"就变成两套规则了 —— 那种"以为加了其实没加"的静默分歧正是本脚本要
 * 消灭的东西，所以这里直接拒绝，而不是猜用户想要哪个。
 */
const conflicting = [
  ...(NO_FIXTURES ? ['--no-fixtures'] : []),
  ...(WITH_DOCS ? ['--with-docs'] : [])
]
if (FILES_STRICT && conflicting.length > 0) {
  console.error(`❌ --files-strict 与 ${conflicting.join(' / ')} 同时给出：严格模式不允许任何追加或裁剪。`)
  console.error(`   只有 --files-strict（或只给裁剪开关）两者取其一。`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
const pkgName = typeof manifest.name === 'string' ? manifest.name : '(package.json 没有 name)'
const filesField = Array.isArray(manifest.files) ? manifest.files.map(String) : undefined
const whitelist = filesField !== undefined && filesField.length > 0 ? [...filesField] : [...DEFAULT_WHITELIST]
const whitelistSource =
  filesField !== undefined && filesField.length > 0
    ? `package.json 的 files（${filesField.length} 条）${FILES_STRICT ? ' · --files-strict：不接受任何追加/裁剪' : ''}`
    : `内置默认（package.json 没有 files；待 files 落地后需复核一次）`

const notes = []
if (pkgName !== TARGET_NAME) {
  notes.push(
    `package.json 的 name 仍是 ${pkgName}，而发布名的目标是 ${TARGET_NAME} —— 改名扫尾还没落地。` +
      `本 tgz 按目标名命名，但包内的 package.json 仍写着旧名：**扫尾完成前不要用它装新电脑**（安装方按包内 name 解析）。`
  )
}
if (filesField !== undefined) {
  // 只核对"发布物里还有没有说明文档"，不再点名某两份 —— 哪几份是随包文档由 `files`
  // 说了算（它可能就是被另一个维护者换掉的），这个脚本只负责发现"一份都没有"。
  const docEntries = filesField.filter((entry) => entry.endsWith('.md'))
  if (docEntries.length === 0) notes.push(`files 里一份 .md 都没有 ⇒ 发布物将不带任何说明文档；要带就加进 files，或用 --with-docs 临时补上 ${DOCS.join(' / ')}。`)
}
if (filesField === undefined) notes.push(`package.json 没有 files：本次用内置默认白名单，files 落地后需复核一次。`)
if (WITH_FIXTURES) notes.push(`--with-fixtures 已无副作用：tools/fixtures 现在是 package.json files 里的条目，默认就进包。`)
if (NO_FIXTURES) {
  notes.push(
    `--no-fixtures：本次**不带** tools/fixtures/*.json ⇒ 解包后自检会少两组检查（SKIP，不是 FAIL）。` +
      `除非有明确理由，否则不要这样发。`
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 展开白名单 → 文件列表（硬排除在这里生效）
 * ──────────────────────────────────────────────────────────────────────────── */
/** 一个待打包文件：包内路径 + 字节 + 内容 sha256。 */
function entryOf(relativePath, bytes) {
  return { path: relativePath, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * `isDirectory` 是必须的：`_*` 的排除规则只针对**目录**（施工留下的 `_trae-coldstart`
 * 这类），而 `tools/_run-suites.mjs` 是一个正经的入口文件，不能被它误伤。
 */
function excluded(relativePath, isDirectory) {
  const segments = relativePath.split('/')
  const directories = isDirectory ? segments : segments.slice(0, -1)
  if (directories.includes('node_modules')) return 'node_modules/'
  if (directories.includes('dist')) return 'dist/'
  if (directories.some((segment) => segment.startsWith('_'))) return '_* 临时目录'
  const base = segments[segments.length - 1] ?? ''
  /**
   * `mutation` 这条比 `_*` 严：**目录名和文件名都算**。
   *
   * 实测过（`--dry-run` 真清单）：一个叫 `leftover_mutation_notes.json` 的**文件**能从
   * 旧规则（只看目录段）的缝里进包。名字里带 mutation 的施工残留没有一个是产品，
   * 而 `_*` 只能按目录判 —— `tools/_run-suites.mjs` 是正经入口文件，按文件名判会误伤它。
   */
  if (segments.some((segment) => segment.toLowerCase().includes('mutation'))) return '*mutation* 施工残留（目录或文件名）'
  if (base.endsWith('.bak')) return '*.bak'
  if (base.endsWith('.log')) return '*.log'
  if (NO_FIXTURES && relativePath.startsWith('tools/fixtures/')) return 'tools/fixtures/*.json（--no-fixtures 裁掉；默认应带上）'
  return undefined
}

const collected = []
const skipped = []

function addFile(absolutePath, relativePath) {
  const reason = excluded(relativePath, false)
  if (reason !== undefined) {
    skipped.push(`${relativePath}（${reason}）`)
    return
  }
  const bytes = readFileSync(absolutePath)
  collected.push(entryOf(relativePath, bytes))
}

function walk(absolutePath, relativePath) {
  const info = statSync(absolutePath)
  if (info.isDirectory()) {
    const reason = excluded(relativePath, true)
    if (reason !== undefined) {
      skipped.push(`${relativePath}/（${reason}）`)
      return
    }
    for (const child of readdirSync(absolutePath, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      walk(join(absolutePath, child.name), `${relativePath}/${child.name}`)
    }
    return
  }
  if (info.isFile()) addFile(absolutePath, relativePath)
}

const unresolved = []
for (const entry of whitelist) {
  const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  const absolute = join(ROOT, normalized)
  if (!existsSync(absolute)) {
    unresolved.push(normalized)
    continue
  }
  walk(absolute, normalized)
}

/** `package.json` 永远进包（安装方唯一的元数据来源）。 */
if (!collected.some((entry) => entry.path === 'package.json')) {
  addFile(join(ROOT, 'package.json'), 'package.json')
}

/** 追加式白名单：文档与 fixture 的显式开关。 */
if (WITH_DOCS) {
  for (const doc of DOCS) {
    if (collected.some((entry) => entry.path === doc)) continue
    if (existsSync(join(ROOT, doc))) addFile(join(ROOT, doc), doc)
    else unresolved.push(doc)
  }
}

/**
 * 白名单里可以有重叠条目（`tools` 已经覆盖 `tools/fixtures`，后者仍被显式列出来，
 * 因为"fixtures 是故意带的"这件事应该写在白名单上、而不是只活在打包脚本里）。
 * 重叠不报错，但必须去重：同一个路径进两次 tar，清单和装配 sha256 就成了谎话。
 */
const seen = new Map()
const deduped = []
for (const entry of collected) {
  const first = seen.get(entry.path)
  if (first === undefined) {
    seen.set(entry.path, entry)
    deduped.push(entry)
    continue
  }
  if (first.sha256 !== entry.sha256) {
    console.error(`❌ 同一个包内路径被白名单用不同内容登记了两次：${entry.path}（这是脚本的 bug，拒绝产出）`)
    process.exit(1)
  }
}
const duplicates = collected.length - deduped.length
collected.length = 0
collected.push(...deduped)

/**
 * 发布必需项的**核对**（不是追加）。
 *
 * 规则只有一个出处 —— `package.json` 的 `files`。这里做的是"它还成立吗"：
 * 任何一项没被白名单覆盖，就拒绝产出并指名去改 package.json。上一版在这里静默追加，
 * 于是"发布物该有什么"有两个出处；现在只有一个，且这个脚本会在它被改坏时立刻喊。
 */
const uncovered = []
{
  const present = new Set(collected.map((entry) => entry.path))
  const coveredBy = (required) => present.has(required) || [...present].some((path) => required.startsWith(`${path}/`))
  // `--no-fixtures` 是明确的裁剪决定，不是白名单被改坏：核对里就去掉这两项。
  const required = NO_FIXTURES ? RELEASE_REQUIRED.filter((item) => !item.startsWith('tools/fixtures/')) : RELEASE_REQUIRED
  for (const item of required) {
    if (!existsSync(join(ROOT, item))) unresolved.push(item)
    else if (!coveredBy(item)) uncovered.push(item)
  }
}

collected.sort((a, b) => (a.path < b.path ? -1 : 1))

if (collected.length === 0) {
  console.error('❌ 白名单展开后一个文件都没有 —— 拒绝产出空包。检查 package.json 的 files 与当前目录。')
  process.exit(1)
}

if (uncovered.length > 0) {
  console.error(`\n❌ 发布必需项不在 package.json 的 files 里，拒绝产出：`)
  for (const item of uncovered) console.error(`   · ${item}`)
  console.error(`   发布物少了它们就不再"拷过去就能装 / 就能自检"：install.mjs 是装机入口，`)
  console.error(`   部署-新电脑.md 是装机说明，两个 fixture 决定解包后自检是 SKIP 还是真跑。`)
  console.error(`   把它们加进 package.json 的 files —— 不要在这里追加，否则规则就有两个出处了。`)
  process.exit(1)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. ustar 写入器（确定性）
 * ──────────────────────────────────────────────────────────────────────────── */
function octal(value, width) {
  // width 含结尾的 NUL；tar 的八进制字段就是"定宽 + NUL"。
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function header(name, size) {
  const buffer = Buffer.alloc(512)
  let entryName = name
  let prefix = ''
  if (Buffer.byteLength(entryName) > 100) {
    // ustar 的 155+100 拆分：只在最后一个还装得下的 '/' 处切。
    const parts = name.split('/')
    let index = parts.length - 1
    while (index > 0 && Buffer.byteLength(parts.slice(index).join('/')) <= 100) index -= 1
    prefix = parts.slice(0, index + 1).join('/')
    entryName = parts.slice(index + 1).join('/')
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(entryName) > 100) {
      throw new Error(`tar 路径太长且无法用 ustar 的 prefix 拆分：${name}`)
    }
  }
  buffer.write(entryName, 0, 100, 'utf8')
  buffer.write(octal(0o644, 8), 100, 8, 'latin1') // mode
  buffer.write(octal(0, 8), 108, 8, 'latin1') // uid
  buffer.write(octal(0, 8), 116, 8, 'latin1') // gid
  buffer.write(octal(size, 12), 124, 12, 'latin1')
  buffer.write(octal(FIXED_MTIME, 12), 136, 12, 'latin1')
  buffer.write('        ', 148, 8, 'latin1') // chksum：先填空格
  buffer.write('0', 156, 1, 'latin1') // typeflag：普通文件
  buffer.write('ustar\0', 257, 6, 'latin1')
  buffer.write('00', 263, 2, 'latin1')
  buffer.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of buffer) sum += byte
  buffer.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return buffer
}

const chunks = []
for (const entry of collected) {
  chunks.push(header(`package/${entry.path}`, entry.bytes.length))
  chunks.push(entry.bytes)
  const padding = (512 - (entry.bytes.length % 512)) % 512
  if (padding > 0) chunks.push(Buffer.alloc(padding))
}
chunks.push(Buffer.alloc(1024)) // 两个空块收尾
const tarball = Buffer.concat(chunks)
const tgz = gzipSync(tarball, { level: 9 })
const tgzSha256 = createHash('sha256').update(tgz).digest('hex')

/** 装配 sha256：清单本身（路径 + 内容 hash + 大小，固定顺序）的摘要。 */
const canonicalListing = collected.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.bytes.length}`).join('\n')
const assemblySha256 = createHash('sha256').update(canonicalListing).digest('hex')

/* ────────────────────────────────────────────────────────────────────────────
 * 4. 自校验：把刚写的包读回来，逐个文件比 sha256
 *
 * "写出去返回了"和"包里真的是那些字节"是两件事（这个项目为这条教训付过账）。
 * ──────────────────────────────────────────────────────────────────────────── */
function readTarGz(buffer) {
  const tar = gunzipSync(buffer)
  const out = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(block.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8)
    const full = prefix === '' ? name : `${prefix}/${name}`
    const start = offset + 512
    out.set(full, tar.subarray(start, start + size))
    offset = start + size + ((512 - (size % 512)) % 512)
  }
  return out
}

const reread = readTarGz(tgz)
const mismatches = []
for (const entry of collected) {
  const inPack = reread.get(`package/${entry.path}`)
  if (inPack === undefined) mismatches.push(`${entry.path}: 包里没有`)
  else if (createHash('sha256').update(inPack).digest('hex') !== entry.sha256) mismatches.push(`${entry.path}: 字节不一致`)
}
const extra = [...reread.keys()].filter((key) => !collected.some((entry) => `package/${entry.path}` === key))

/* ────────────────────────────────────────────────────────────────────────────
 * 5. 打印 + 落盘
 * ──────────────────────────────────────────────────────────────────────────── */
const tgzName = `${TARGET_NAME}-${version}.tgz`
const tgzPath = join(OUT_DIR, tgzName)

console.log('='.repeat(78))
console.log(`dsh-pylon-trae pack · ${collected.length} 个文件 · 装配 sha256 ${assemblySha256.slice(0, 16)}…`)
console.log('='.repeat(78))
console.log(`白名单来源：${whitelistSource}`)
console.log(`发布必需项核对：${RELEASE_REQUIRED.length - (NO_FIXTURES ? 2 : 0)} 项全部由 files 覆盖（本脚本不追加任何文件）`)
console.log(`version=${version}（来自 package.json）· 输出名=${tgzName} · 前缀=package/ · mtime=固定(${FIXED_MTIME}) → 可复算`)
console.log('')
console.log('文件清单（包内路径 · 字节 · sha256）')
for (const entry of collected) {
  console.log(`  ${entry.path.padEnd(42)} ${String(entry.bytes.length).padStart(8)}  ${entry.sha256}`)
}
console.log('')
console.log(`装配 sha256（清单摘要，可复算）：${assemblySha256}`)
console.log(`tgz 自身 sha256：${tgzSha256}`)
console.log(`tgz 体积：${tgz.length} B（${(tgz.length / 1024).toFixed(1)} KiB）· 解包后 ${tarball.length} B`)
if (skipped.length > 0) {
  console.log('')
  console.log(`按硬排除规则跳过 ${skipped.length} 项：`)
  for (const item of skipped.slice(0, 12)) console.log(`  · ${item}`)
  if (skipped.length > 12) console.log(`  …其余 ${skipped.length - 12} 项同类`)
}
if (duplicates > 0) console.log(`\n（白名单里有重叠条目，按路径去重 ${duplicates} 条：tools 与 tools/fixtures 互相覆盖，属预期）`)
const fixtureBytes = collected.filter((entry) => entry.path.startsWith('tools/fixtures/')).reduce((sum, entry) => sum + entry.bytes.length, 0)
if (fixtureBytes > 0) {
  console.log('')
  console.log(`自检说明：本包含 tools/fixtures/*.json（合计 ${fixtureBytes} B）`)
  console.log(`      ⇒ 解包后 \`node tools/_run-suites.mjs\` 每组都能真跑：有 ~/.dsh/trae-pin 那份钉住快照的机器上是 13 passed · 0 failed。`)
  console.log(`         没有那份快照时，test-contract 会以"缺少真相源"退 1（它故意的闸：没核对过 ≠ 核对过且正确），test-sse 仍绿。`)
  console.log(`         （fixture 本身要是与包内 src/ 不一致，test-contract 当场判 FAIL —— 这正是带着它走的好处。）`)
} else {
  const fixtureCount = skipped.filter((item) => item.startsWith('tools/fixtures/')).length
  if (fixtureCount > 0) {
    console.log('')
    console.log(`自检说明：本包**不含** tools/fixtures/*.json ⇒ 解包后 \`node tools/_run-suites.mjs\` 少两组检查：`)
    console.log(`      11 passed · 0 failed · 2 skipped（SKIP 带原因行；缺输入不是 FAIL，但也从来不算 PASS）。`)
  }
}
if (unresolved.length > 0) console.log(`\n⚠️  白名单里有 ${unresolved.length} 条在当前目录找不到（已跳过）：${unresolved.join(', ')}`)
for (const note of notes) console.log(`\n⚠️  ${note}`)

if (mismatches.length > 0 || extra.length > 0) {
  console.error(`\n❌ 自校验失败，拒绝产出：`)
  for (const item of mismatches) console.error(`   · ${item}`)
  for (const item of extra) console.error(`   · 包里多出未登记成员 ${item}`)
  process.exit(1)
}
console.log(`\n✅ 自校验：重新解包后 ${collected.length}/${collected.length} 个文件的 sha256 与打包前一致，无多余成员`)

if (DRY_RUN) {
  console.log(`\n（--dry-run：以上都算过了，但没有写盘。去掉 --dry-run 会写 ${tgzPath}）`)
  process.exit(0)
}

if (existsSync(tgzPath) && !FORCE) {
  console.error(`\n❌ 产物已存在：${tgzPath}`)
  console.error(`   发布物一律不覆盖（同一个名字两套字节是最难查的那种事故）。确认要重打：加 --force。`)
  process.exit(1)
}
if (existsSync(tgzPath) && FORCE) rmSync(tgzPath, { force: true })

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(tgzPath, tgz)
const sidecar = `${tgzPath}.sha256`
writeFileSync(sidecar, `${tgzSha256}  ${tgzName}\n`, 'utf8')

/**
 * 清单文件：文件列表 + 装配 sha256。
 *
 * 它是 `install.mjs --from` 的对照物：安装方解包后自己重算一遍装配 sha256，和这里
 * 声明的一致才算"装进去的就是发布出来的"。放在 tgz 外面而不是里面，因为一个文件的
 * 摘要不可能包含它自己 —— 而"包里自带清单"正是最容易被忽略的那种自欺。
 */
const manifestPath = `${tgzPath}.manifest.txt`
const manifestLines = [
  `package: ${TARGET_NAME}`,
  `version: ${version}`,
  `tgz: ${tgzName}`,
  `tgz-sha256: ${tgzSha256}`,
  `tgz-bytes: ${tgz.length}`,
  `assembly-sha256: ${assemblySha256}`,
  `files: ${collected.length}`,
  '',
  ...collected.map((entry) => `${entry.sha256}  ${String(entry.bytes.length).padStart(8)}  ${entry.path}`)
]
writeFileSync(manifestPath, `${manifestLines.join('\n')}\n`, 'utf8')

console.log(`\n✅ 已写出：${tgzPath}`)
console.log(`✅ 校验副文件：${sidecar}（一行：<sha256>  <文件名>，可 certutil / sha256sum 复核）`)
console.log(`✅ 清单：${manifestPath}（install.mjs --from 会拿它核对装配 sha256）`)
console.log(`   装机命令：node install.mjs --profile desktop --from ${relative(process.cwd(), tgzPath).replaceAll('\\', '/')}`)

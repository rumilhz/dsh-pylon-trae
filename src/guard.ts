/**
 * Write guard: the safety net every write to user configuration goes through.
 *
 * Why it exists (this project has paid for it): on 2026-10-08 a write path
 * reported success while `cordis.patch.yml` shrank from 34 entries to 3. The
 * service threw nothing. So "the write returned" is NOT evidence — the file has
 * to be re-read and compared, and the backup has to live OUTSIDE the profile so
 * a broken profile can always be repaired from it.
 *
 * Three rules, in this order:
 *   ① the snapshot is taken BEFORE the write, into a directory of this plugin's
 *      OWN, outside every profile;
 *   ② the file is re-read afterwards and compared — "the write returned" and
 *      "the content is still there" are two different facts;
 *   ③ anything lost is covered by the whole snapshot (`rollbackPatch`), because
 *      the accident shape is a REWRITTEN file, not one wrong value.
 *
 * Refusal is a valid outcome: with no readable patch file there is no way to
 * verify a write, and a plugin that cannot verify does not write.
 *
 * ## Backups: one dedicated directory, a bounded number of them
 *
 * Backups used to land in the DSH home ROOT, next to the user's own files, with
 * nothing ever removing them — a directory that only grows. They now live in
 * {@link DEFAULT_BACKUP_DIR_NAME} under the home and the newest
 * {@link DEFAULT_KEEP_BACKUPS} are kept. Two deliberate consequences:
 *
 *   · **only our own names are pruned.** The prefix compared against is built
 *     from the patch's own file name (`cordis.patch.yml.before-dsh-trae-…`), so
 *     the legacy `.bak` files a previous version left in the home root — and
 *     anything else a user keeps there — are never touched. This directory
 *     cleans up after itself and nothing else.
 *   · **a failed cleanup is swallowed.** The first duty of a safety net is to
 *     keep the original intact; tidying a backup directory is not a reason for a
 *     write that would otherwise succeed to fail.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export interface PatchSnapshot {
  patchPath: string
  backupPath: string
  entryCount: number
  bytes: number
}

export interface VerifyResult {
  ok: boolean
  reasons: string[]
  entryCount?: number
}

/** How many `- id:` lines a line may carry and still be a composition entry. */
export const MAX_ENTRY_INDENT = 4

/** Backups live in this subdirectory of the DSH home — never in the home root. */
export const DEFAULT_BACKUP_DIR_NAME = '.dsh-pylon-trae/backups'

/** How many backups of ONE patch are kept; the oldest beyond this are removed. */
export const DEFAULT_KEEP_BACKUPS = 20

/** The infix that later tells a backup of OURS apart from every other `.bak`. */
export const BACKUP_INFIX = '.before-dsh-trae-'

/**
 * Top-level patch entries: a `- id:` line indented at most {@link MAX_ENTRY_INDENT}.
 *
 * Matches the two shapes a composition entry really takes — a top-level entry at
 * column 0, and an entry inside an `- insert:` list at indent 4 — and rejects the
 * configuration nested underneath them (a provider name at indent 6, a model id
 * at indent 10).
 *
 * ## Why `- id:` and not every list item
 *
 * The patch is not a flat list of `- ` items: the entry we seed lives inside a
 * `config:` block, so "count the list items" would count a line that is itself
 * nested configuration. Counting `- id:` at a bounded indent is the shape that
 * both real forms share and no configuration line has.
 *
 * ## Why a text line count and not a YAML parse
 *
 * The accident shape is "the file was rewritten whole", and at that moment the
 * file need not still be valid YAML. A parser would throw on exactly the input
 * this function exists to measure; counting lines tells you the bad file is bad.
 */
export function countPatchEntries(text: string): number {
  const pattern = new RegExp(`^ {0,${MAX_ENTRY_INDENT}}-\\s*id:\\s*\\S`)
  let count = 0
  for (const line of text.split(/\r?\n/)) if (pattern.test(line)) count += 1
  return count
}

/** The DSH home directory (all profiles live under it). */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Where this plugin keeps the snapshots it takes before writing.
 *
 * Derived from the HOME, never from the patch directory, and that is the whole
 * of rule ①: a backup stored inside the profile would be destroyed by the same
 * accident as the file it was meant to rescue. `snapshotPatch` asserts the
 * consequence (the directory is not inside the profile) instead of trusting
 * every caller to have thought about it.
 */
export function backupDir(home = dshHome()): string {
  return join(home, DEFAULT_BACKUP_DIR_NAME)
}

/**
 * The patch file of the profile this process runs in.
 *
 * The profile is identified by WHICH ONE MOUNTS THIS PLUGIN — a fact read out of
 * each profile's package.json bundles — not by the `DSH_PROFILE` environment
 * variable. That variable describes the profile the operator launched from the
 * desktop app (it stayed `desktop` during a scratch-home cold start of a
 * different profile), so trusting it first sent this plugin looking for a
 * profile that did not exist in the home it was actually running in, and the
 * guard correctly refused to write. A hint that is validated, not obeyed:
 * `DSH_PROFILE` only breaks a tie between several mounting profiles.
 */
export function resolvePatchPath(pluginName: string, home = dshHome()): string | undefined {
  const profilesRoot = join(home, 'profiles')
  if (!existsSync(profilesRoot)) return undefined
  const mounting: { name: string; patch: string }[] = []
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const patch = join(profilesRoot, entry.name, 'cordis.patch.yml')
    const manifest = join(profilesRoot, entry.name, 'package.json')
    if (!existsSync(patch) || !existsSync(manifest)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      const bundles = (parsed as { dsh?: { profile?: { bundles?: unknown } } })?.dsh?.profile?.bundles
      // A bundle is named either bare (`dsh-pylon-trae`) or scoped (`@scope/name`);
      // compare on both so a profile that mounts the scoped spelling is still found.
      const mounts = Array.isArray(bundles) && bundles.some((bundle) => typeof bundle === 'string' && (bundle === pluginName || bundle.endsWith(`/${pluginName}`)))
      if (mounts) mounting.push({ name: entry.name, patch })
    } catch {
      continue
    }
  }
  if (mounting.length === 0) return undefined
  const explicit = process.env['DSH_PROFILE']
  if (typeof explicit === 'string' && explicit !== '') {
    const hit = mounting.find((candidate) => candidate.name === explicit)
    if (hit !== undefined) return hit.patch
  }
  return mounting.length === 1 ? mounting[0]?.patch : undefined
}

/**
 * Is `candidate` the same path as `root`, or inside it?
 *
 * `resolve` first, so `home/profiles/p/../p` and a trailing separator are
 * compared as the paths they really are rather than as the strings they were
 * spelled with. A path that cannot be resolved (a malformed one) is treated as
 * outside, and `resolve` does not touch the disk — nothing here creates anything.
 */
function isInside(root: string, candidate: string): boolean {
  let rootResolved: string
  let candidateResolved: string
  try {
    rootResolved = resolve(root)
    candidateResolved = resolve(candidate)
  } catch {
    return false
  }
  if (candidateResolved === rootResolved) return true
  const prefix = rootResolved.endsWith('/') || rootResolved.endsWith('\\') ? rootResolved : `${rootResolved}${process.platform === 'win32' ? '\\' : '/'}`
  return candidateResolved.startsWith(prefix)
}

/**
 * `20261014-214704`: a fixed-width stamp for the name of a backup.
 *
 * Every component is zero-padded to a constant width, which is the property the
 * retention policy leans on: with the stamp in the file NAME, sorting the names
 * as strings gives the same order as sorting them by time, so "delete the oldest
 * beyond N" needs no stat call and no date parsing. Local time on purpose — the
 * files it sits beside are read by a human.
 */
function compactStamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
}

/** `cordis.patch.yml.before-dsh-trae-<stamp>-<n>entries.bak` */
function backupName(patchPath: string, at: Date, entryCount: number): string {
  return `${basename(patchPath)}${BACKUP_INFIX}${compactStamp(at)}-${entryCount}entries.bak`
}

/**
 * Say out loud what {@link resolvePatchPath} saw.
 *
 * Without it, "no guard" is a dead end: an unset DSH_HOME, a profile whose
 * bundles spell the plugin differently, and a genuinely missing profile all look
 * identical from the outside. Cheap to call, and it is only ever called on the
 * failure path (or on demand from the boot trace).
 */
export function explainPatchLookup(pluginName: string, home = dshHome()): string {
  const profilesRoot = join(home, 'profiles')
  const parts = [`home=${home}`, `DSH_HOME=${process.env['DSH_HOME'] ?? '(unset)'}`, `DSH_PROFILE=${process.env['DSH_PROFILE'] ?? '(unset)'}`]
  if (!existsSync(profilesRoot)) {
    parts.push(`profiles/ 不存在`)
    return parts.join(' ')
  }
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const patch = join(profilesRoot, entry.name, 'cordis.patch.yml')
    const manifest = join(profilesRoot, entry.name, 'package.json')
    if (!existsSync(manifest)) {
      parts.push(`${entry.name}: 没有 package.json`)
      continue
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      const bundles = (parsed as { dsh?: { profile?: { bundles?: unknown } } })?.dsh?.profile?.bundles
      const list = Array.isArray(bundles) ? bundles.map(String) : []
      const hit = list.some((bundle) => bundle === pluginName || bundle.endsWith(`/${pluginName}`))
      parts.push(`${entry.name}: patch=${existsSync(patch) ? 'yes' : 'NO'} bundles=[${list.join(',')}] match=${hit ? 'YES' : 'no'}`)
    } catch (error) {
      parts.push(`${entry.name}: package.json 解析失败 ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return parts.join(' · ')
}

/** Every backup of THIS patch currently in {@link backupDir}, oldest name first. */
export function listBackups(patchPath: string, home = dshHome()): string[] {
  const dir = backupDir(home)
  if (!existsSync(dir)) return []
  const prefix = `${basename(patchPath)}${BACKUP_INFIX}`
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => join(dir, name))
}

/**
 * Keep only the newest `keep` backups of this patch.
 *
 * The names carry the fixed-width stamp, so their string order IS their time
 * order and the oldest are exactly the head of the sorted list — no `stat`, no
 * date parsing. Returns how many were removed, which is what makes the policy
 * assertable without inspecting the directory afterwards.
 *
 * A cleanup failure is swallowed, deliberately: the safety net's first duty is
 * to keep the original file intact, and tidying the backup directory is not a
 * reason for a write that would otherwise succeed to fail. `keep <= 0` means
 * "keep nothing" and returns 0 — callers that want to disable pruning pass
 * `keep: undefined` instead.
 */
export function pruneBackups(patchPath: string, keep = DEFAULT_KEEP_BACKUPS, home = dshHome()): number {
  if (!Number.isFinite(keep) || keep <= 0) return 0
  try {
    const names = listBackups(patchPath, home)
    let removed = 0
    for (const path of names.slice(0, Math.max(0, names.length - keep))) {
      try {
        rmSync(path, { force: true })
        removed += 1
      } catch {
        // One undeletable file must not stop the rest, nor the write.
      }
    }
    return removed
  } catch {
    return 0
  }
}

/**
 * Copy the patch out of the profile before touching it.
 *
 * Throws anyway when the backup cannot be written, and that is the intended
 * direction: refusing to write costs "this write does not happen", while writing
 * without a backup risks another silent truncation with no way back.
 *
 * @param home The DSH home the backup directory is derived from. Injectable so a
 *   caller can point it at a scratch home — and, in the tests, at a directory
 *   that IS the profile, which must be refused.
 */
export function snapshotPatch(patchPath: string, home = dshHome()): PatchSnapshot {
  const text = readFileSync(patchPath, 'utf8')
  const entryCount = countPatchEntries(text)
  const dir = backupDir(home)
  // Rule ① asserted rather than assumed. The backup directory is derived from the
  // home, and the profile lives under the home, so a caller that passes a profile
  // as the home would silently store every backup inside the very directory it
  // must survive. Cheap to check, and the failure mode it prevents is the exact
  // accident this module exists for.
  if (isInside(join(patchPath, '..'), dir)) {
    throw new Error(`拒绝把备份写进 profile 目录：${dir} 在 ${join(patchPath, '..')} 之内 —— 备份必须活在正本之外，才可能在正本损坏时救它`)
  }
  mkdirSync(dir, { recursive: true })
  const backupPath = join(dir, backupName(patchPath, new Date(), entryCount))
  copyFileSync(patchPath, backupPath)
  pruneBackups(patchPath, DEFAULT_KEEP_BACKUPS, home)
  return { patchPath, backupPath, entryCount, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * What to expect of the file after the write. Every field is optional: a caller
 * that knows only the before-text still gets rule ① applied.
 */
export interface PatchExpectation {
  /** The name we just wrote into the root `providers` dict. */
  provider?: string
  /** How many models that provider must declare. Checked only when given. */
  expectedModelCount?: number
}

/**
 * Judge a write by comparing the file before and after it. **Pure** — no file
 * system, no clock — so the rules that are easiest to lose silently can be
 * asserted directly in a unit test.
 *
 * Four rules, and the reasons are phrased as observations plus consequences:
 *   ① the entry count must not shrink (the 34 → 3 accident);
 *   ② the file must not be empty (a rewrite that lost everything);
 *   ③ the provider we just wrote must really be in the root `providers` dict —
 *      "the write returned success" and "the content is still there" are two
 *      different facts, and this is the one that catches the second;
 *   ④ that provider must declare exactly the number of models we wrote.
 * More entries than before is NOT a failure: another plugin writing its own
 * section is a legitimate concurrent writer, not damage.
 *
 * `afterText === undefined` means the file could not be read back. That is a
 * FAILURE, never a pass: "cannot confirm" and "confirmed intact" must never
 * collapse into the same answer, or the net fails at the one moment it is for.
 *
 * Both text-derived facts are FUNCTIONS of the after-text, which is why this
 * signature is the pure one — provider/model checks included. A version that
 * took an already-computed provider count could not distinguish "absent" from
 * "zero models", and that is the difference between the two rules.
 */
export function judgePatchWrite(
  beforeText: string,
  afterText: string | undefined,
  expected: PatchExpectation = {}
): VerifyResult {
  const before = countPatchEntries(beforeText)
  if (afterText === undefined) {
    return { ok: false, reasons: [`写入后读不到 profile patch，无法确认内容（写入前 ${before} 条目）`] }
  }
  const reasons: string[] = []
  const entryCount = countPatchEntries(afterText)
  if (entryCount < before) reasons.push(`条目数变少：写入前 ${before} → 写入后 ${entryCount}`)
  if (afterText.trim() === '') reasons.push('写入后文件为空')

  const provider = expected.provider
  if (provider !== undefined) {
    const count = modelCountOf(afterText, provider)
    if (count === undefined) reasons.push(`provider ${provider} 不在 providers 字典里（这次写入没有落地）`)
    else if (expected.expectedModelCount !== undefined && count !== expected.expectedModelCount) {
      reasons.push(`provider ${provider} 的模型数不符：期望 ${expected.expectedModelCount} → 实际 ${count}`)
    }
  }
  return reasons.length === 0 ? { ok: true, entryCount } : { ok: false, reasons, entryCount }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * How many models the entry for `provider` declares, or `undefined` when there is
 * no such entry in the patch text — the two cases rank ③ and ④ apart.
 *
 * Read out of the text, not out of `settings.describe()`: the accident shape is
 * the file on disk being rewritten, and `describe()` reports the Loader's
 * in-memory composition, which can still look healthy at that moment. The scope
 * ends at the next line indented two spaces or less, so the model count of one
 * provider can never be a neighbour's.
 */
export function modelCountOf(text: string, provider: string): number | undefined {
  const lines = text.split(/\r?\n/)
  const head = new RegExp(`^\\s*(?:'${escapeRegExp(provider)}'|"${escapeRegExp(provider)}"|${escapeRegExp(provider)})\\s*:\\s*(?:#.*)?$`)
  for (const [index, line] of lines.entries()) {
    if (!head.test(line)) continue
    let count = 0
    for (const inner of lines.slice(index + 1)) {
      if (inner.trim() === '') continue
      if (!/^\s/.test(inner)) break
      if (/^ {0,2}\S/.test(inner)) break
      if (/^\s*-\s*id:\s*\S/.test(inner)) count += 1
    }
    return count
  }
  return undefined
}

/**
 * Re-read the patch and demand that nothing was lost.
 *
 * Reads the file and hands both texts to {@link judgePatchWrite}; all the rules
 * live there. Loss is the only failure this guard judges: an added entry, a
 * changed section, or a rewritten body all pass, because those are what a
 * legitimate write looks like. A missing file, an unreadable file, or fewer
 * entries than before fails.
 */
export function verifyPatch(snapshot: PatchSnapshot, expected: PatchExpectation = {}): VerifyResult {
  if (!existsSync(snapshot.patchPath)) {
    return { ok: false, reasons: [`profile patch 消失了（写入前 ${snapshot.entryCount} 条目 / ${snapshot.bytes} B）`] }
  }
  let after: string
  try {
    after = readFileSync(snapshot.patchPath, 'utf8')
  } catch (error) {
    return { ok: false, reasons: [`写入后读不到 profile patch：${error instanceof Error ? error.message : String(error)}`] }
  }
  return judgePatchWrite(readFileSync(snapshot.backupPath, 'utf8'), after, expected)
}

/** Put the snapshot back verbatim. */
export function rollbackPatch(snapshot: PatchSnapshot): void {
  writeFileSync(snapshot.patchPath, readFileSync(snapshot.backupPath))
}

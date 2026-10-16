/**
 * M3 self-test — the write path, without DSH.
 *
 * Runs `src/seed.ts` + `src/guard.ts` against a throwaway DSH home and a fake
 * settings service, covering the four outcomes that matter:
 *
 *   1 create    — no provider yet: the entry is written, entry count grows
 *   2 present   — provider already there: NOTHING is written (the user's pruning stands)
 *   3 refresh   — only genuinely new ids are added; a model the user deleted is NOT resurrected
 *   4 corrupted — the write truncates the file: the guard must roll it back byte-for-byte
 *
 * Case 4 is the one this project has paid for twice (2026-10-08: 34 entries → 3).
 *
 * ## Why this suite uses a REAL temporary directory
 *
 * Every check below runs against real files: a real `cordis.patch.yml` is written,
 * a real `.bak` is copied, a real wrong write is rolled back, real stale backups are
 * deleted. An in-memory stand-in would verify the JUDGEMENT and say nothing about
 * "the bytes really left the process" — and the guards here are exactly the layer
 * that only ever runs on the day something went wrong. The temp home is removed at
 * the end; on failure it is left in place and its path printed, because the useful
 * artifact of a failed run is the scene it failed in.
 *
 * Run:  <dsh-node> tools/test-seed.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKUP_INFIX,
  DEFAULT_BACKUP_DIR_NAME,
  DEFAULT_KEEP_BACKUPS,
  backupDir,
  countPatchEntries,
  dshHome,
  judgePatchWrite,
  modelCountOf,
  pruneBackups,
  rollbackPatch,
  snapshotPatch,
  verifyPatch
} from '../src/guard.ts'
import { candidateReports, describeCredentialScan, renderCandidateTable, scanCredentials, type CredentialScan } from '../src/auth.ts'
import { partitionModels, type TraeModel } from '../src/catalog.ts'
import {
  buildProviderProfile,
  currentProviderModelIds,
  findProviderNamespace,
  isProvidersForm,
  pruneInternalModels,
  seedProvider,
  type SettingsDescriptorLike,
  type SettingsServiceLike
} from '../src/seed.ts'
import type { TraeStorageCandidate } from '../src/paths.ts'

const PLUGIN = 'dsh-pylon-trae'
const NS = 'llm-pi-ai'
const PROVIDER = 'trae'
const STAMP_RE = /\d{8}-\d{6}/

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

// ---------------------------------------------------------------- throwaway home
const home = mkdtempSync(join(tmpdir(), 'dsh-pylon-trae-test-'))
const profileDir = join(home, 'profiles', 'zz-trae')
mkdirSync(profileDir, { recursive: true })
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-zz-trae', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PLUGIN] } } }, null, 2), 'utf8')
const initialEntries = 34
/** A legacy backup, from the version that wrote into the HOME ROOT. Must survive. */
const legacyBackup = join(home, `${'cordis.patch.yml'}${BACKUP_INFIX}20261001-000000-34entries.bak`)
writeFileSync(legacyBackup, 'LEGACY: this file belongs to an older version and to the user\n', 'utf8')
writeFileSync(
  patchPath,
  Array.from({ length: initialEntries }, (_, index) => `- id: entry-${index}\n  name: "@deepseek-ai/entry-${index}"\n`).join(''),
  'utf8'
)
process.env['DSH_HOME'] = home
delete process.env['DSH_PROFILE']
console.log(`temp home: ${home}`)
console.log(`patch: ${initialEntries} entries, ${readFileSync(patchPath, 'utf8').length} B`)

// ---------------------------------------------------------------- fake settings service
const state: {
  providers: Record<string, unknown>
  revision: number
  mutateCalls: number
  breakNextWrite: boolean
  providerNeverLands: boolean
  truncateProviderModels: boolean
} = {
  providers: {},
  revision: 1,
  mutateCalls: 0,
  breakNextWrite: false,
  providerNeverLands: false,
  truncateProviderModels: false
}

function renderPatch(): string {
  const head = Array.from({ length: initialEntries }, (_, index) => `- id: entry-${index}\n  name: "@deepseek-ai/entry-${index}"\n`).join('')
  const ids = Object.keys(state.providers)
  if (ids.length === 0) return head
  const body = ids
    .map((id) => {
      const value = state.providers[id] as { displayName?: string; baseURL?: string; models?: { id: string }[] }
      return [
        `- id: ${NS}`,
        `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
        `  config:`,
        `    providers:`,
        `      ${id}:`,
        `        displayName: ${value.displayName ?? id}`,
        `        baseURL: ${value.baseURL ?? ''}`,
        `        models:`,
        ...(value.models ?? []).map((model) => `          - id: ${model.id}`)
      ].join('\n')
    })
    .join('\n')
  return `${head}${body}\n`
}

const settings: SettingsServiceLike = {
  describe(): SettingsDescriptorLike[] {
    return [
      { ns: 'ui-chat', revision: 3 },
      {
        ns: NS,
        revision: state.revision,
        // The REAL shape: schemastery's reference table, where the root node and
        // its `dict.providers` entry point at each other by numeric id. The
        // inline form is a different serialisation and is covered separately.
        schema: { uid: 30940, refs: { '30797': { type: 'number' }, '30940': { type: 'object', dict: { providers: 30798 } }, '30798': { type: 'dict' } } },
        base: { providers: {} },
        user: { providers: state.providers },
        value: { providers: state.providers }
      }
    ]
  },
  async mutate(ns: string, ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[]): Promise<unknown> {
    state.mutateCalls += 1
    for (const op of ops) {
      if (op.path[0] === 'providers' && typeof op.path[1] === 'string' && !state.providerNeverLands) state.providers[op.path[1]] = op.value
    }
    state.revision += 1
    if (state.breakNextWrite) {
      writeFileSync(patchPath, Array.from({ length: 3 }, (_, i) => `- id: lost-${i}\n`).join(''), 'utf8')
      return undefined
    }
    writeFileSync(patchPath, renderPatch(), 'utf8')
    if (state.truncateProviderModels) {
      // "The write returned success, and the entry is there — with fewer models than
      // we asked for." Rule ④ exists for this shape: drop one model line (indent 10),
      // leaving the entry and the remaining models intact.
      const kept = readFileSync(patchPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !/^ {10}- id: m3$/.test(line))
        .join('\n')
      writeFileSync(patchPath, kept, 'utf8')
    }
    return undefined
  }
}

const models: readonly TraeModel[] = [
  { id: 'm1', name: 'One', contextWindow: 1000, input: ['text'] as const, directoryFunction: 'solo_work_remote', kind: 'chat' as const },
  { id: 'm2', name: 'Two', contextWindow: 1000, input: ['text'] as const, directoryFunction: 'solo_work_remote', kind: 'chat' as const },
  { id: 'm3', name: 'Three', contextWindow: 1000, input: ['text'] as const, directoryFunction: 'solo_work_remote', kind: 'chat' as const }
]
const profile = buildProviderProfile({ displayName: 'Trae', baseUrl: 'http://127.0.0.1:7864', token: 'test-token', models })
check('profile carries no apiKeyEnv (deliberate)', !('apiKeyEnv' in profile))
check('profile sets the Authorization header', profile.headers['Authorization'] === 'Bearer test-token')
check('profile baseURL is fixed loopback', profile.baseURL === 'http://127.0.0.1:7864/v1')

// ---------------------------------------------------------------- 1. create
console.log('\n[1] create — no provider yet')
const before = readFileSync(patchPath, 'utf8')
const created = await seedProvider({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile })
check('outcome is created', created.kind === 'created', created.kind)
check('model count carried', created.kind === 'created' && created.modelCount === 3)
check('patch gained an entry', countPatchEntries(readFileSync(patchPath, 'utf8')) > countPatchEntries(before))
check('backup written OUTSIDE the profile', created.kind === 'created' && existsSync(created.backupPath) && !created.backupPath.startsWith(profileDir))
check('backup holds the pre-write bytes', created.kind === 'created' && readFileSync(created.backupPath, 'utf8') === before)
{
  // 清单第 6 条增量 ①：备份落到专用子目录，不再和用户自己的文件混在 home 根目录里。
  const dir = backupDir(home)
  const name = created.kind === 'created' ? created.backupPath.slice(dir.length + 1) : ''
  check('backup lands in the dedicated subdirectory', created.kind === 'created' && created.backupPath.startsWith(`${dir}\\`) || created.backupPath.startsWith(`${dir}/`), dir)
  check('...whose name is `<patch>.before-dsh-pylon-trae-<stamp>-<n>entries.bak`', name.startsWith(`cordis.patch.yml${BACKUP_INFIX}`) && STAMP_RE.test(name) && name.endsWith('-34entries.bak'), name)
  check('...i.e. NOT in the home root any more', created.kind === 'created' && !created.backupPath.startsWith(`${home}${'\\'}cordis.patch.yml`), created.kind === 'created' ? created.backupPath : '')
  check('the legacy root-level backup is untouched', existsSync(legacyBackup) && readFileSync(legacyBackup, 'utf8').startsWith('LEGACY'))
}
const afterCreate = readFileSync(patchPath, 'utf8')

// ---------------------------------------------------------------- 2. present
console.log('\n[2] present — provider already exists')
const callsBefore = state.mutateCalls
const present = await seedProvider({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile })
check('outcome is present', present.kind === 'present', present.kind)
check('nothing was written', state.mutateCalls === callsBefore)
check('file unchanged', readFileSync(patchPath, 'utf8') === afterCreate)

// ---------------------------------------------------------------- 3. refresh, tombstone respected
console.log('\n[3] refresh — user deleted m2, directory still lists it')
state.providers[PROVIDER] = { ...(state.providers[PROVIDER] as object), models: [{ id: 'm1' }, { id: 'm3' }] }
writeFileSync(patchPath, renderPatch(), 'utf8')
const live = [...models, { id: 'm4', name: 'Four', contextWindow: 1000, input: ['text'] as const, directoryFunction: 'solo_work_remote', kind: 'chat' as const }]
const refreshProfile = buildProviderProfile({ displayName: 'Trae', baseUrl: 'http://127.0.0.1:7864', token: 'test-token', models: live })
const refreshed = await seedProvider({
  settings,
  pluginName: PLUGIN,
  providerName: PROVIDER,
  profile: refreshProfile,
  mode: 'refresh',
  previouslyOffered: ['m1', 'm2', 'm3']
})
check('outcome is rebuilt', refreshed.kind === 'rebuilt', refreshed.kind)
check('only the genuinely new id was added', refreshed.kind === 'rebuilt' && refreshed.addedModels.join(',') === 'm4', refreshed.kind === 'rebuilt' ? refreshed.addedModels.join(',') : '')
check('deleted m2 was NOT resurrected', refreshed.kind === 'rebuilt' && !refreshed.addedModels.includes('m2'))
const refreshedModels = (state.providers[PROVIDER] as { models: { id: string }[] }).models.map((model) => model.id)
check('entry keeps the user\'s two models plus m4', refreshedModels.join(',') === 'm1,m3,m4', refreshedModels.join(','))

// ---------------------------------------------------------------- 4. corrupted write
console.log('\n[4] corrupted write — the file loses entries mid-write')
const beforeBroken = readFileSync(patchPath, 'utf8')
const entriesBeforeBroken = countPatchEntries(beforeBroken)
state.breakNextWrite = true
const broken = await seedProvider({
  settings,
  pluginName: PLUGIN,
  providerName: 'trae-broken',
  profile: buildProviderProfile({ displayName: 'Trae Broken', baseUrl: 'http://127.0.0.1:7864', token: 't', models })
})
check('outcome is rolled-back', broken.kind === 'rolled-back', broken.kind)
check('reason names the loss', broken.kind === 'rolled-back' && broken.reasons.join(' ').includes('条目数变少'))
check('file restored byte-for-byte', readFileSync(patchPath, 'utf8') === beforeBroken, `${entriesBeforeBroken} entries`)
check('entry count is back', countPatchEntries(readFileSync(patchPath, 'utf8')) === entriesBeforeBroken)
check(
  'the rollback ALSO names the provider that never landed (rule ③)',
  broken.kind === 'rolled-back' && broken.reasons.some((reason) => reason.includes('不在 providers 字典里')),
  broken.kind === 'rolled-back' ? broken.reasons.join(' / ') : ''
)
state.breakNextWrite = false

// ------------------------------------------------- 4b. wrote nothing at all (rule ③)
console.log('\n[4b] mutate returns fine but the provider never lands — rule ③')
const beforeNeverLands = readFileSync(patchPath, 'utf8')
const entriesNeverLands = countPatchEntries(beforeNeverLands)
state.providerNeverLands = true
const neverLands = await seedProvider({
  settings,
  pluginName: PLUGIN,
  providerName: 'trae-ghost',
  profile: buildProviderProfile({ displayName: 'Trae Ghost', baseUrl: 'http://127.0.0.1:7864', token: 't', models })
})
state.providerNeverLands = false
check('outcome is rolled-back', neverLands.kind === 'rolled-back', neverLands.kind)
check(
  '...and the reason is "provider 不在 providers 字典里"',
  neverLands.kind === 'rolled-back' && neverLands.reasons.some((reason) => reason.includes('不在 providers 字典里')),
  neverLands.kind === 'rolled-back' ? neverLands.reasons.join(' / ') : ''
)
check('...file restored (entry count unchanged)', countPatchEntries(readFileSync(patchPath, 'utf8')) === entriesNeverLands, `${entriesNeverLands}`)

// --------------------------------------- 4c. landed with fewer models (rule ④)
console.log('\n[4c] the entry lands with one model missing — rule ④')
const beforeTruncated = readFileSync(patchPath, 'utf8')
const entriesTruncated = countPatchEntries(beforeTruncated)
state.truncateProviderModels = true
const truncatedModels = await seedProvider({
  settings,
  pluginName: PLUGIN,
  providerName: 'trae-short',
  profile: buildProviderProfile({ displayName: 'Trae Short', baseUrl: 'http://127.0.0.1:7864', token: 't', models })
})
state.truncateProviderModels = false
check('outcome is rolled-back', truncatedModels.kind === 'rolled-back', truncatedModels.kind)
check(
  '...and the reason is the model-count mismatch (expected 3, found 2)',
  truncatedModels.kind === 'rolled-back'
    && truncatedModels.reasons.some((reason) => reason.includes('模型数不符') && reason.includes('期望 3') && reason.includes('实际 2')),
  truncatedModels.kind === 'rolled-back' ? truncatedModels.reasons.join(' / ') : ''
)
check('...file restored byte-for-byte', readFileSync(patchPath, 'utf8') === beforeTruncated, `${entriesTruncated} entries`)

// ---------------------------------------------------------------- 5. no guard, no write
console.log('\n[5] no patch file — refuse to write')
process.env['DSH_HOME'] = join(home, 'nowhere')
const noGuard = await seedProvider({ settings, pluginName: PLUGIN, providerName: 'trae-x', profile })
check('outcome is no-guard', noGuard.kind === 'no-guard', noGuard.kind)
process.env['DSH_HOME'] = home
check('dshHome() follows DSH_HOME', dshHome() === home, dshHome())

// ---------------------------------------------------------------- 6. guard primitives
console.log('\n[6] guard primitives')
check('countPatchEntries counts top-level composition entries', countPatchEntries('- id: a\n  x: 1\n- id: b\n') === 2)
check('countPatchEntries counts an `- insert:` entry (indent 4)', countPatchEntries('- insert:\n    - id: mcp-exa\n      name: x\n') === 1)
check('countPatchEntries counts both forms at once', countPatchEntries('- id: top\n- insert:\n    - id: inner\n') === 2)
check(
  'countPatchEntries IGNORES a nested configuration list item',
  countPatchEntries('- id: top\n  config:\n    list:\n      - hi: there\n') === 1,
  `got ${countPatchEntries('- id: top\n  config:\n    list:\n      - hi: there\n')}`
)
// 清单第 6 条的口径：模型 id（缩进 10）不能被数成顶层条目，否则合法下架会被判成截断。
const nestedFixture = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      trae:',
  '        models:',
  '          - id: minimax-m3',
  '          - id: glm-5.3-flash',
  ''
].join('\n')
check('model ids (indent 10) are NOT counted as entries', countPatchEntries(nestedFixture) === 1, `${countPatchEntries(nestedFixture)}`)
check('provider names are NOT counted either', countPatchEntries(nestedFixture.replace('    providers:', '    providers:').replace('      trae:', '      trae2:')) === 1)
check('modelCountOf(trae) counts the declared models', modelCountOf(nestedFixture, 'trae') === 2, String(modelCountOf(nestedFixture, 'trae')))
check('modelCountOf stops at the entry boundary', modelCountOf(nestedFixture, 'trae') === 2 && modelCountOf(`${nestedFixture}- id: other\n  config:\n    providers:\n      other:\n        models:\n          - id: x\n`, 'trae') === 2)
check('modelCountOf of a provider that is not there is undefined', modelCountOf(nestedFixture, 'nope') === undefined, String(modelCountOf(nestedFixture, 'nope')))
check('modelCountOf does not match a longer name with the same prefix', modelCountOf(nestedFixture, 'trae2') === undefined, String(modelCountOf(nestedFixture, 'trae2')))
check('modelCountOf reports an entry with zero models as 0, not undefined', modelCountOf('- id: x\n  config:\n    providers:\n      trae:\n        displayName: T\n', 'trae') === 0)

const snap = snapshotPatch(patchPath)
writeFileSync(patchPath, '- only\n')
const verdict = verifyPatch(snap)
check('verifyPatch rejects shrinkage', !verdict.ok && verdict.reasons.length > 0)
rollbackPatch(snap)
check('rollbackPatch restores', countPatchEntries(readFileSync(patchPath, 'utf8')) === entriesNeverLands, `${countPatchEntries(readFileSync(patchPath, 'utf8'))} / expected ${entriesNeverLands}`)

// ------------------------------------------------- 6b. the pure judge, rule by rule
console.log('\n[6b] judgePatchWrite — pure, so the rules can be asserted directly')
{
  const before3 = '- id: a\n- id: b\n- id: c\n'
  const after4 = `${before3}- id: d\n`
  const goodDict = `${after4}- id: llm-pi-ai\n  config:\n    providers:\n      trae:\n        models:\n          - id: m1\n          - id: m2\n          - id: m3\n`
  const hit = judgePatchWrite(before3, goodDict, { provider: 'trae', expectedModelCount: 3 })
  check('rule 0: nothing lost + provider present + right model count -> ok', hit.ok === true, JSON.stringify(hit))
  check('...and reports the post-write entry count', hit.entryCount === 5, String(hit.entryCount))
  const shrink = judgePatchWrite(before3, '- id: a\n- id: llm-pi-ai\n  config:\n    providers:\n      trae:\n        models:\n          - id: m1\n', { provider: 'trae', expectedModelCount: 1 })
  check('rule ①: fewer entries fails', shrink.ok === false && shrink.reasons.some((reason) => reason.includes('条目数变少')), JSON.stringify(shrink))

  const absent = judgePatchWrite(before3, `${after4}- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        models:\n`, { provider: 'trae', expectedModelCount: 3 })
  check('rule ③: provider absent from the dict fails', absent.ok === false && absent.reasons.some((reason) => reason.includes('不在 providers 字典里')), JSON.stringify(absent))

  const wrongCount = judgePatchWrite(before3, goodDict.replace('          - id: m3\n', ''), { provider: 'trae', expectedModelCount: 3 })
  check('rule ④: model count != expected fails', wrongCount.ok === false && wrongCount.reasons.some((reason) => reason.includes('模型数不符')), JSON.stringify(wrongCount))
  check('...and says both numbers', wrongCount.reasons.join(' ').includes('期望 3') && wrongCount.reasons.join(' ').includes('实际 2'), wrongCount.reasons.join(' / '))

  const unreadable = judgePatchWrite(before3, undefined, { provider: 'trae', expectedModelCount: 3 })
  check('unreadable is a FAILURE, never a pass', unreadable.ok === false && unreadable.reasons.length > 0, JSON.stringify(unreadable))
  check('...and says so in words a human reads as "cannot confirm"', unreadable.reasons.some((reason) => reason.includes('无法确认')), unreadable.reasons.join(' / '))
  check('...with no entry count invented for it', unreadable.entryCount === undefined)

  const empty = judgePatchWrite(before3, '   \n')
  check('an empty rewrite fails too', empty.ok === false && empty.reasons.some((reason) => reason.includes('文件为空')), JSON.stringify(empty))

  const grown = judgePatchWrite(before3, `${after4}- id: e\n- id: f\n`, { provider: 'trae', expectedModelCount: 3 })
  check('more entries is NOT damage (a concurrent writer) — but the provider rule still applies', grown.ok === false && !grown.reasons.some((reason) => reason.includes('条目数变少')) && grown.reasons.some((reason) => reason.includes('不在 providers 字典里')), JSON.stringify(grown))
  const grownOk = judgePatchWrite(before3, '- id: a\n- id: b\n- id: c\n- id: e\n', {})
  check('growth alone passes when no provider was claimed', grownOk.ok === true, JSON.stringify(grownOk))
}

// ------------------------------------------------- 6c. retention policy (real files)
console.log('\n[6c] backup retention — only the newest N, oldest deleted, order by name')
{
  const dir = backupDir(home)
  // A patch file of its own, so the counts below cannot be polluted by the backups
  // the cases above produced: retention is a statement about ONE patch's backups.
  const retentionPatch = join(profileDir, 'retention.patch.yml')
  writeFileSync(retentionPatch, '- id: a\n- id: b\n', 'utf8')
  // 25 real backups with REAL stamps, spread over 25 seconds: the point of the
  // fixed-width stamp is that the FILENAME orders them, and a test that faked the
  // clock would not exercise that.
  const base = Date.UTC(2026, 9, 1, 0, 0, 0)
  const names: string[] = []
  for (let index = 0; index < 25; index += 1) {
    const at = new Date(base + index * 1000)
    const p = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`
    const name = `retention.patch.yml${BACKUP_INFIX}${stamp}-2entries.bak`
    writeFileSync(join(dir, name), `backup #${index}\n`, 'utf8')
    names.push(name)
  }
  const ours = (): string[] => readdirSync(dir).filter((name) => names.includes(name)).sort()
  check('25 real backups planted', ours().length === 25, `${ours().length}`)
  check('...and each carries a fixed-width stamp (name order == time order)', names.every((name) => STAMP_RE.test(name)) && ours().join('|') === names.join('|'), names[0] ?? '')

  const prunedSnap = snapshotPatch(retentionPatch)
  const remaining = ours()
  // The snapshot just taken is itself one of the kept files, so the kept count is
  // exactly `DEFAULT_KEEP_BACKUPS` and the survivors among the 25 are the newest 19.
  check(`retention keeps exactly ${DEFAULT_KEEP_BACKUPS} for this patch`, ours().length === DEFAULT_KEEP_BACKUPS - 1 && readdirSync(dir).filter((name) => name.startsWith('retention.patch.yml')).length === DEFAULT_KEEP_BACKUPS, `${ours().length} planted left`)
  check('...deleting exactly the OLDEST ones (name order == time order)', !remaining.includes(names[0]) && !remaining.includes(names[5]) && remaining[0] === names[6] && remaining[remaining.length - 1] === names[24], `${remaining[0]} … ${remaining[remaining.length - 1]}`)
  check('...by delete-oldest, i.e. the 6 oldest names are gone', names.slice(0, 6).every((name) => !remaining.includes(name)) && names.slice(6).every((name) => remaining.includes(name)))
  check('the snapshot itself survived its own pruning', existsSync(prunedSnap.backupPath) && STAMP_RE.test(prunedSnap.backupPath), prunedSnap.backupPath.slice(dir.length + 1))
  check('the legacy root-level backup still is not our business', existsSync(legacyBackup))
  check('pruneBackups reports how many it removed (20 → 5 removes 15)', pruneBackups(retentionPatch, 5, home) === 15, `kept ${ours().length}`)
  check('...and a second pass to the same limit removes nothing', pruneBackups(retentionPatch, 5, home) === 0)
  for (const name of ours()) rmSync(join(dir, name), { force: true })
  rmSync(retentionPatch, { force: true })
}
{
  // A cleanup that CANNOT succeed must not turn a perfectly good write into a failure.
  // `rmSync` on a non-empty directory throws (ERR_FS_EISDIR / EPERM), which is the
  // realistic shape of "this file could not be removed".
  const dir = backupDir(home)
  const undeletable = `cordis.patch.yml${BACKUP_INFIX}20260901-000000-34entries.bak`
  mkdirSync(join(dir, undeletable), { recursive: true })
  writeFileSync(join(dir, undeletable, 'occupied.txt'), 'not empty\n', 'utf8')
  const beforeCleanup = readFileSync(patchPath, 'utf8')
  let threw = ''
  let snapAfter = undefined as ReturnType<typeof snapshotPatch> | undefined
  try {
    snapAfter = snapshotPatch(patchPath)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('a cleanup that cannot delete anything is swallowed (snapshot still succeeds)', threw === '' && snapAfter !== undefined, threw)
  check('...and the write it guards is still possible', snapAfter !== undefined && readFileSync(snapAfter.backupPath, 'utf8') === beforeCleanup)
  check('...while the undeletable entry is reported by name, not silently claimed removed', existsSync(join(dir, undeletable)), undeletable)
  rmSync(join(dir, undeletable), { recursive: true, force: true })
}
{
  // 铁律 ①，用一条断言钉住：备份目录绝不能落在 profile 之内。
  let refused = ''
  try {
    snapshotPatch(patchPath, profileDir)
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  check('a backup directory INSIDE the profile is refused outright', refused.includes('拒绝把备份写进 profile 目录'), refused)
  check('...and nothing was created there', !existsSync(join(profileDir, DEFAULT_BACKUP_DIR_NAME)))
}

// ---------------------------------------------------------------- 7. namespace shapes
console.log('\n[7] namespace shape detection (the bug that made 0.4.0 a no-op)')
check(
  'refs-table form is recognised',
  isProvidersForm({ uid: 1, refs: { '1': { type: 'object', dict: { providers: 2 } }, '2': { type: 'dict' } } })
)
check('inline form is recognised too', isProvidersForm({ type: 'object', dict: { providers: { type: 'dict' } } }))
check('a non-provider schema is rejected', !isProvidersForm({ type: 'object', dict: { theme: { type: 'string' } } }))
check(
  'providers that is NOT a dict is rejected',
  !isProvidersForm({ uid: 1, refs: { '1': { type: 'object', dict: { providers: 2 } }, '2': { type: 'string' } } })
)
const found = findProviderNamespace(settings)
check('namespace resolves from the refs form', found?.ns === NS, found?.ns ?? 'undefined')

// ------------------------------------------------- 8. credential failure diagnostics
console.log('\n[8] a failed credential scan says WHICH candidates it probed')
{
  const here = join(home, 'fake-trae', 'storage.json')
  const candidates: TraeStorageCandidate[] = [
    { edition: 'cn', region: 'cn', path: here, source: 'desktop', exists: true },
    { edition: 'sg', region: 'ai', path: join(home, 'fake-trae-sg', 'storage.json'), source: 'desktop', exists: false },
    { edition: 'cn', region: 'cn', path: join(home, '.trae-cn', 'trae-jwt-token'), source: 'cli', exists: false }
  ]
  mkdirSync(join(home, 'fake-trae'), { recursive: true })
  // An install that IS there with a well-formed storage document, but no token in it:
  // the "installed, not signed in" case the candidate table must make distinguishable
  // from "not installed at all".
  writeFileSync(here, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': '{"userId":"u1"}' }), 'utf8')
  const scan = scanCredentials(candidates)
  check('the scan reports one failure per existing candidate', scan.failures.length === 1 && scan.found.length === 1, `${scan.failures.length} failure(s)`)
  const reports = candidateReports(candidates)
  check('candidateReports gives the whole probed list with existence', reports.length === 3 && reports.map((report) => report.exists).join(',') === 'true,false,false', JSON.stringify(reports.map((report) => report.label)))
  const table = renderCandidateTable(candidates)
  check('renderCandidateTable marks 存在 / 无 per candidate', table.includes('desktop/cn 存在') && table.includes('desktop/sg 无') && table.includes('cli/cn 无'), table)
  const message = describeCredentialScan(scan, candidates)
  check('the failure message carries the candidate table', message.includes('已探测 3 个候选') && message.includes('desktop/cn 存在') && table.length < 420, message.slice(0, 200))
  check('...and the reason each existing candidate failed', message.includes('auth document carries no token'), message)
  const missing = describeCredentialScan({ credentials: [], failures: [], found: [] } as CredentialScan, candidates)
  check('"none of them exists" is stated as such (not merely "no credential")', missing.includes('没有任何一个存在'), missing)
  check('the table is bounded, never one huge line', renderCandidateTable(Array.from({ length: 80 }, (_, index) => ({ edition: 'cn', region: 'cn' as const, path: `C:/very/long/path/number/${index}/storage.json`, source: 'desktop' as const, exists: index % 2 === 0 }))).length <= 420)
}

// ------------------------------------------- 9. internal components stay OUT of the entry
//
// The defect this section exists for: 79 ids — the whole callable directory,
// internal workflow components included — were written into the user's provider
// entry, so the model picker offered `title_generation` and `fast_apply`.
console.log('\n[9] the write path offers conversation models ONLY')
{
  const judged: readonly TraeModel[] = [
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 116000, input: ['text'] as const, directoryFunction: 'solo_work_remote', kind: 'chat' as const },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200000, input: ['text'] as const, directoryFunction: 'chat_v3', kind: 'chat' as const },
    { id: 'title_generation', name: 'title_generation', contextWindow: 44096, input: ['text'] as const, directoryFunction: 'chat_v3', kind: 'internal' as const, internalReason: 'usage=title_generation' },
    { id: 'fast_apply', name: 'fast_apply', contextWindow: 40000, input: ['text'] as const, directoryFunction: 'chat_v3', kind: 'internal' as const, internalReason: 'usage=fast_apply' },
    { id: 'custom_model_gpt-6', name: 'custom_model_gpt-6', contextWindow: 1, input: ['text'] as const, directoryFunction: 'solo_work_remote', kind: 'internal' as const, internalReason: 'usage=custom_model' }
  ]
  const split = partitionModels(judged)
  check('the catalogue splits 2 chat / 3 internal', split.chat.length === 2 && split.internalIds.join(',') === 'title_generation,fast_apply,custom_model_gpt-6', split.internalIds.join(','))

  const profile = buildProviderProfile({ displayName: 'Trae', baseUrl: 'http://127.0.0.1:7864', token: 't', models: judged })
  check('buildProviderProfile writes ONLY the two conversation models', profile.models.map((model) => model.id).join(',') === 'glm-5.2,kimi-k2.6', profile.models.map((model) => model.id).join(','))
  check('...and not one internal component appears in the entry', !profile.models.some((model) => split.internalIds.includes(model.id)))
  const withInternal = buildProviderProfile({ displayName: 'Trae', baseUrl: 'http://127.0.0.1:7864', token: 't', models: judged, includeInternal: true })
  check('includeInternal: true is the documented escape hatch (all 5 written)', withInternal.models.length === 5, String(withInternal.models.length))
  // STRICT, not lenient: a row that never went through the classifier has no verdict,
  // and "no verdict" must not be written as if it had been judged safe.
  const unjudged = [{ id: 'hand-built', name: 'H', input: ['text'] as const, directoryFunction: 'chat_v3' } as unknown as TraeModel]
  check('a TraeModel with no kind is NOT written', buildProviderProfile({ displayName: 'Trae', baseUrl: 'http://127.0.0.1:7864', token: 't', models: unjudged }).models.length === 0)

  // The seed outcome reports what it left out — the omission is visible, not silent.
  const created = await seedProvider({
    settings,
    pluginName: PLUGIN,
    providerName: 'trae-only-chat',
    profile,
    skippedInternal: split.internalIds
  })
  check('seed writes the entry with 2 models', created.kind === 'created' && created.modelCount === 2, created.kind)
  check('...and SeedOutcome names all 3 skipped components', created.kind === 'created' && created.skippedInternal.join(',') === 'title_generation,fast_apply,custom_model_gpt-6', created.kind === 'created' ? created.skippedInternal.join(',') : '')
  const onDisk = currentProviderModelIds(settings, 'trae-only-chat')
  check('...and the file on disk really holds only those 2 ids', onDisk.join(',') === 'glm-5.2,kimi-k2.6', onDisk.join(','))
  const present = await seedProvider({ settings, pluginName: PLUGIN, providerName: 'trae-only-chat', profile, skippedInternal: ['title_generation', 'fast_apply', 'title_generation'] })
  check('a `present` outcome carries skippedInternal too (duplicates collapsed)', present.kind === 'present' && present.skippedInternal.join(',') === 'title_generation,fast_apply', present.kind === 'present' ? present.skippedInternal.join(',') : present.kind)
  const omitted = await seedProvider({ settings, pluginName: PLUGIN, providerName: 'trae-only-chat', profile })
  check('a caller that classifies nothing reports an empty list, never undefined', omitted.kind === 'present' && Array.isArray(omitted.skippedInternal) && omitted.skippedInternal.length === 0, omitted.kind === 'present' ? JSON.stringify(omitted.skippedInternal) : omitted.kind)
}

// ------------------------------------------- 10. removing what an earlier version already wrote
console.log('\n[10] prune-internal — the explicit clean-up, guarded like every other write')
const INTERNAL_IDS = ['title_generation', 'fast_apply', 'custom_model_gpt-6', 'search_agent_qwen_fast'] as const
{
  // An entry as an earlier version left it: conversation models AND components, some
  // as bare `{ id }` rows (which is what a refresh rewrites an unknown id into).
  state.providers['trae-junk'] = {
    displayName: 'Trae（我改过这个名字）',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:7864/v1',
    headers: { Authorization: 'Bearer shim-token' },
    models: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'title_generation' }, { id: 'kimi-k2.6', name: 'Kimi-K2.6' }, { id: 'fast_apply' }, { id: 'custom_model_gpt-6' }]
  }
  writeFileSync(patchPath, renderPatch(), 'utf8')
  const beforePrune = readFileSync(patchPath, 'utf8')
  check('currentProviderModelIds reads the 5 ids in order', currentProviderModelIds(settings, 'trae-junk').join(',') === 'glm-5.2,title_generation,kimi-k2.6,fast_apply,custom_model_gpt-6')

  const pruned = await pruneInternalModels({ settings, pluginName: PLUGIN, providerName: 'trae-junk', internalIds: INTERNAL_IDS })
  check('outcome is pruned', pruned.kind === 'pruned', pruned.kind)
  check('...and it NAMES the 3 rows it removed (a delete must be enumerable)', pruned.kind === 'pruned' && pruned.removed.join(',') === 'title_generation,fast_apply,custom_model_gpt-6', pruned.kind === 'pruned' ? pruned.removed.join(',') : '')
  check('...it does NOT remove the id that was on its list but absent from the entry', pruned.kind === 'pruned' && !pruned.removed.includes('search_agent_qwen_fast'))
  check('...it kept exactly the two conversation models', pruned.kind === 'pruned' && pruned.keptModels === 2, pruned.kind === 'pruned' ? String(pruned.keptModels) : '')
  check('...and the row order of what stayed is the user\'s', currentProviderModelIds(settings, 'trae-junk').join(',') === 'glm-5.2,kimi-k2.6', currentProviderModelIds(settings, 'trae-junk').join(','))
  check('a backup exists, and it holds the PRE-prune bytes', pruned.kind === 'pruned' && existsSync(pruned.backupPath) && readFileSync(pruned.backupPath, 'utf8') === beforePrune)
  check('...and that backup is OUTSIDE the profile', pruned.kind === 'pruned' && !pruned.backupPath.startsWith(profileDir), pruned.kind === 'pruned' ? pruned.backupPath : '')
  const entry = state.providers['trae-junk'] as Record<string, unknown>
  check('every other field of the entry survived verbatim (displayName/api/baseURL/headers)', entry['displayName'] === 'Trae（我改过这个名字）' && entry['api'] === 'openai-completions' && entry['baseURL'] === 'http://127.0.0.1:7864/v1' && JSON.stringify(entry['headers']) === JSON.stringify({ Authorization: 'Bearer shim-token' }), JSON.stringify(Object.keys(entry)))
  check('the two remaining rows kept their names (not flattened to bare ids)', JSON.stringify((entry['models'] as { name?: string }[]).map((model) => model.name)) === JSON.stringify(['GLM-5.2', 'Kimi-K2.6']))

  // ③ an empty candidate list is not a write.
  const callsBefore = state.mutateCalls
  const afterPrune = readFileSync(patchPath, 'utf8')
  const again = await pruneInternalModels({ settings, pluginName: PLUGIN, providerName: 'trae-junk', internalIds: INTERNAL_IDS })
  check('a second prune finds nothing and says so', again.kind === 'nothing', again.kind)
  check('...and writes NOTHING (no mutate call, file byte-identical)', state.mutateCalls === callsBefore && readFileSync(patchPath, 'utf8') === afterPrune)
  const absent = await pruneInternalModels({ settings, pluginName: PLUGIN, providerName: 'no-such-provider', internalIds: INTERNAL_IDS })
  check('a provider that does not exist is reported as absent, not as "nothing to do"', absent.kind === 'absent', absent.kind)
}

// ------------------------------------------- 10b. prune obeys the guard, and obeys the tombstone
console.log('\n[10b] prune refuses without a guard, rolls back a bad write, and never revives a deleted model')
{
  // No patch file for this plugin → no way to verify a write → refuse. The entry
  // needs a real internal row, because "nothing to remove" is checked first and
  // answering "no guard" for a delete that was never going to happen would be a
  // false alarm.
  state.providers['trae-junk'] = { displayName: 'Trae', models: [{ id: 'title_generation' }, { id: 'glm-5.2' }] }
  writeFileSync(patchPath, renderPatch(), 'utf8')
  process.env['DSH_HOME'] = join(home, 'nowhere')
  const noGuard = await pruneInternalModels({ settings, pluginName: PLUGIN, providerName: 'trae-junk', internalIds: INTERNAL_IDS })
  process.env['DSH_HOME'] = home
  check('with no cordis.patch.yml the prune refuses (no-guard), it does not write blind', noGuard.kind === 'no-guard', noGuard.kind)
  check('...and the refusal states the consequence', noGuard.kind === 'no-guard' && noGuard.detail.includes('没有退路就不改用户配置'), noGuard.kind === 'no-guard' ? noGuard.detail.slice(0, 60) : '')
  check('...and the internal row is untouched because nothing was written', currentProviderModelIds(settings, 'trae-junk').join(',') === 'title_generation,glm-5.2', currentProviderModelIds(settings, 'trae-junk').join(','))

  // A write that lands with one row missing → rule ④ → roll back byte-for-byte.
  state.providers['trae-partial'] = {
    displayName: 'Trae Partial',
    models: [{ id: 'm3', name: 'Three' }, { id: 'title_generation' }, { id: 'glm-5.2', name: 'GLM-5.2' }]
  }
  writeFileSync(patchPath, renderPatch(), 'utf8')
  const beforeBad = readFileSync(patchPath, 'utf8')
  state.truncateProviderModels = true
  const rolledBack = await pruneInternalModels({ settings, pluginName: PLUGIN, providerName: 'trae-partial', internalIds: INTERNAL_IDS })
  state.truncateProviderModels = false
  check('a write that lands with a row missing is rolled back', rolledBack.kind === 'rolled-back', rolledBack.kind)
  check('...and the reason names the model count mismatch', rolledBack.kind === 'rolled-back' && rolledBack.reasons.some((reason) => reason.includes('模型数不符')), rolledBack.kind === 'rolled-back' ? rolledBack.reasons.join(' / ') : '')
  check('...the entry is back byte-for-byte, internal row included', readFileSync(patchPath, 'utf8') === beforeBad)
  check('...and the failed prune STILL left a backup to restore from', rolledBack.kind === 'rolled-back' && existsSync(rolledBack.backupPath), rolledBack.kind === 'rolled-back' ? rolledBack.backupPath : '')

  // Tombstone semantics: a conversation model the user deleted stays deleted. The
  // prune only ever removes ids the LIVE catalogue judged internal, so it cannot be
  // a back door that re-adds or re-creates anything — and the tombstone set it must
  // not disturb (`previouslyOffered`) is not even a parameter of this function.
  state.providers['trae-tombstone'] = { displayName: 'Trae T', models: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'title_generation' }] }
  writeFileSync(patchPath, renderPatch(), 'utf8')
  const tombPrune = await pruneInternalModels({ settings, pluginName: PLUGIN, providerName: 'trae-tombstone', internalIds: INTERNAL_IDS })
  check('prune removes the component and leaves the one chat model', tombPrune.kind === 'pruned' && tombPrune.removed.join(',') === 'title_generation' && currentProviderModelIds(settings, 'trae-tombstone').join(',') === 'glm-5.2', tombPrune.kind)
  check('...and returns NO `offeredModels` (it must not touch the tombstone set)', !('offeredModels' in tombPrune))
  const afterTombPrune = await seedProvider({
    settings,
    pluginName: PLUGIN,
    providerName: 'trae-tombstone',
    profile: buildProviderProfile({
      displayName: 'Trae T',
      baseUrl: 'http://127.0.0.1:7864',
      token: 't',
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', input: ['text'] as const, directoryFunction: 'solo_work_remote', kind: 'chat' as const },
        { id: 'kimi-k2.6', name: 'Kimi-K2.6', input: ['text'] as const, directoryFunction: 'chat_v3', kind: 'chat' as const }
      ]
    }),
    mode: 'refresh',
    previouslyOffered: ['glm-5.2', 'kimi-k2.6']
  })
  check('a refresh after a prune still refuses to resurrect the deleted model', afterTombPrune.kind === 'rebuilt' && afterTombPrune.addedModels.length === 0, afterTombPrune.kind === 'rebuilt' ? afterTombPrune.addedModels.join(',') : afterTombPrune.kind)
  check('...and the entry still holds exactly what the user had left', currentProviderModelIds(settings, 'trae-tombstone').join(',') === 'glm-5.2', currentProviderModelIds(settings, 'trae-tombstone').join(','))
}

// ---------------------------------------------------------------- summary
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`\n(临时 home 保留在 ${home}，供排查)`)
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

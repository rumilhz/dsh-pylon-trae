/**
 * M4 self-test — the credential store, and the boot reconciliation.
 *
 * Three features that only exist together, because each one is unsafe alone:
 *
 *   A. **the green dot, made true before it is promised.** The Models page lights
 *      it when the entry names `apiKeyEnv` and `credentials.describe(ref)` says
 *      `configured: true` (`dsh-client-ui-settings-models/lib/client.js:2158`),
 *      and turns it RED when the name resolves to nothing (`:2159`) — after which
 *      pi-ai refuses every request with `MISSING_CREDENTIAL`
 *      (`dsh-llm-pi-ai/lib/index.js:2564-2569`). So the ONE ordering rule this
 *      suite exists to pin is: the value goes into the store FIRST, and the entry
 *      names it only from the verified answer.
 *   B. **token rotation.** `loadOrCreateToken` mints a new shim token when its
 *      file is gone; before this, the entry kept the old bearer and every request
 *      401'd until someone re-seeded by hand.
 *   C. **boot, only add.** A model Trae adds must arrive without the user
 *      clicking anything — and a boot with nothing new must write NOTHING.
 *
 * ## What is real here, and what is a stand-in
 *
 * Real: the temporary DSH home, the `cordis.patch.yml` on disk, the backups, the
 * read-back verification and the rollbacks (all through the shipping
 * `src/guard.ts` and `src/auth.ts`). A stand-in: the credentials service, because
 * a suite cannot mount one. Two properties of the stand-in are NOT invented —
 * they were measured against the real `dsh-credentials-local` + `yaml` on
 * 2026-10-16 and are what the verifier is allowed to assume:
 *
 *   · a write touches ONLY the named key: rendering the real document with one
 *     `refs` entry added and then removing that key reproduced the original
 *     bytes EXACTLY (records, comments, ordering and trailing newline included);
 *   · a plain base64url value is written unquoted, and a value that would re-read
 *     as a number/boolean is written quoted (which is why the reader accepts
 *     both spellings).
 *
 * The fake service deliberately CAN misbehave (`corruptOtherKey`), because the
 * interesting assertion is not "it worked" but "when it does not, the entry never
 * ends up naming a credential that is not there".
 *
 * Run:  <dsh-node> tools/test-credentials.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CREDENTIALS_FILENAME,
  credentialsRefValue,
  ensureCredentialRef,
  judgeCredentialsWrite,
  listCredentialBackups,
  parseCredentialScalar,
  readCredentialsDocument,
  snapshotCredentials,
  verifiedCredentialRef,
  type CredentialStoreFace
} from '../src/auth.ts'
import { DEFAULT_BACKUP_DIR_NAME } from '../src/guard.ts'
import {
  buildProviderProfile,
  decideRowName,
  mergeNames,
  mergeOffered,
  planNameSync,
  syncProviderEntry,
  TRAE_API_KEY_REF,
  type ProviderProfile,
  type SettingsDescriptorLike,
  type SettingsServiceLike
} from '../src/seed.ts'
import { partitionModels, type TraeModel } from '../src/catalog.ts'

const PLUGIN = 'dsh-pylon-trae'
const NS = 'llm-pi-ai'
const PROVIDER = 'trae'
const TOKEN_A = 'AAAAtoken-token-token-token-token-token-1'
const TOKEN_B = 'BBBBtokentokentokentokentokentoken22'

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

// ---------------------------------------------------------------- throwaway home
const home = mkdtempSync(join(tmpdir(), 'dsh-pylon-trae-cred-'))
const profileDir = join(home, 'profiles', 'zz-cred')
mkdirSync(profileDir, { recursive: true })
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-zz-cred', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PLUGIN] } } }, null, 2), 'utf8')
process.env['DSH_HOME'] = home
delete process.env['DSH_PROFILE']
delete process.env[TRAE_API_KEY_REF]
const credentialsPath = join(home, CREDENTIALS_FILENAME)
console.log(`temp home: ${home}`)

/**
 * A credentials document shaped exactly like the real one (measured 2026-10-16):
 * a `records` section of grants, then a `refs` section, no trailing blank line.
 * The values are obviously fake; nothing here needs a real secret.
 */
const REAL_SHAPE = [
  'version: 1',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      secret: fake-browser-session-secret-value',
  '  deepseek-account-platform/default:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      token: fake-account-token-value',
  '      issuer: https://platform.deepseek.com',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-fake-deepseek-value',
  '  XIAOMI_API_KEY: sk-fake-xiaomi-value',
  ''
].join('\n')

/** The stand-in store: it edits the `refs` body the way the real one does. */
interface FakeStore extends CredentialStoreFace {
  writes: number
  corruptOtherKey: boolean
  refuse: string | undefined
  existing: Map<string, string>
}
function makeStore(options: { refuse?: string; corruptOtherKey?: boolean; path?: string } = {}): FakeStore {
  const target = options.path ?? credentialsPath
  const store: FakeStore = {
    writes: 0,
    corruptOtherKey: options.corruptOtherKey === true,
    refuse: options.refuse,
    existing: new Map(),
    async set(ref: string, value: string): Promise<void> {
      if (store.refuse !== undefined) throw new Error(store.refuse)
      store.writes += 1
      if (store.corruptOtherKey) {
        // The failure this verifier exists for: the write lands, and it also
        // rewrote a key that belongs to somebody else.
        writeFileSync(target, readFileSync(target, 'utf8').replace(/XIAOMI_API_KEY: .*/, 'XIAOMI_API_KEY: sk-clobbered-by-someone-else'), 'utf8')
      }
      const text = existsSync(target) ? readFileSync(target, 'utf8') : 'version: 1\nrefs:\n'
      const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      const header = lines.findIndex((line) => /^refs:\s*$/.test(line))
      const existing = lines.findIndex((line) => new RegExp(`^[ \t]+${ref}:`).test(line))
      const rendered = `  ${ref}: ${value}`
      if (existing !== -1) lines[existing] = rendered
      else if (header !== -1) lines.push(rendered)
      else lines.push('refs:', rendered)
      writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
      store.existing.set(ref, value)
    }
  }
  return store
}

function writeCredentialsDocument(text = REAL_SHAPE): void {
  writeFileSync(credentialsPath, text, 'utf8')
}

/** Green / red / none, exactly as `client.js:2158-2159` computes it. */
function dotState(entry: Record<string, unknown> | undefined, configuredRefs: ReadonlySet<string>): 'green' | 'red' | 'none' {
  const ref = entry?.['apiKeyEnv']
  if (typeof ref !== 'string') return 'none'
  return configuredRefs.has(ref) ? 'green' : 'red'
}

/** What `credentials.describe(ref).configured` says, read out of the file. */
function configuredRefs(): Set<string> {
  try {
    const parsed = readCredentialsDocument(readFileSync(credentialsPath, 'utf8'), credentialsPath)
    return 'refs' in parsed ? new Set(parsed.refs.keys()) : new Set()
  } catch {
    return new Set()
  }
}

// ---------------------------------------------------------------- fake settings service
interface FakeSettingsState {
  providers: Record<string, unknown>
  revision: number
  mutateCalls: number
  breakNextWrite: boolean
}
const state: FakeSettingsState = { providers: {}, revision: 1, mutateCalls: 0, breakNextWrite: false }

function renderPatch(): string {
  const ids = Object.keys(state.providers)
  if (ids.length === 0) return '# no providers\n'
  return ids
    .map((id) => {
      const value = state.providers[id] as { displayName?: string; baseURL?: string; headers?: Record<string, string>; apiKeyEnv?: string; models?: { id: string; name?: string }[] }
      return [
        `- id: ${NS}`,
        `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
        `  config:`,
        `    providers:`,
        `      ${id}:`,
        `        displayName: ${value.displayName ?? id}`,
        `        baseURL: ${value.baseURL ?? ''}`,
        ...(value.apiKeyEnv === undefined ? [] : [`        apiKeyEnv: ${value.apiKeyEnv}`]),
        `        headers:`,
        `          Authorization: ${value.headers?.['Authorization'] ?? ''}`,
        `        models:`,
        // The `name:` line is rendered too: the name reconciliation must be visible
        // in the FILE a user opens, not only in the in-memory dict this stand-in
        // holds. `modelCountOf` counts `- id:` lines, so the extra line is inert.
        ...(value.models ?? []).flatMap((model) => [`          - id: ${model.id}`, ...(model.name === undefined ? [] : [`            name: ${model.name}`])])
      ].join('\n')
    })
    .join('\n')
    .concat('\n')
}

const settings: SettingsServiceLike = {
  describe(): SettingsDescriptorLike[] {
    return [
      {
        ns: NS,
        revision: state.revision,
        schema: { uid: 30940, refs: { '30797': { type: 'number' }, '30940': { type: 'object', dict: { providers: 30798 } }, '30798': { type: 'dict' } } },
        base: { providers: {} },
        user: { providers: state.providers },
        value: { providers: state.providers }
      }
    ]
  },
  async mutate(_ns: string, ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[]): Promise<unknown> {
    state.mutateCalls += 1
    for (const op of ops) if (op.path[0] === 'providers' && typeof op.path[1] === 'string') state.providers[op.path[1]] = op.value
    state.revision += 1
    if (state.breakNextWrite) {
      writeFileSync(patchPath, '# lost\n', 'utf8')
      return undefined
    }
    writeFileSync(patchPath, renderPatch(), 'utf8')
  }
}

function chat(id: string, name = id): TraeModel {
  return { id, name, contextWindow: 128000, input: ['text'] as const, directoryFunction: 'chat_v3', kind: 'chat' as const }
}
function internal(id: string): TraeModel {
  return { id, name: id, contextWindow: 8000, input: ['text'] as const, directoryFunction: 'chat_v3', kind: 'internal' as const, internalReason: 'usage=title_generation' }
}
function profileOf(token: string, models: TraeModel[], apiKeyEnv?: string): ProviderProfile {
  return buildProviderProfile({ displayName: 'Trae', baseUrl: 'http://127.0.0.1:7864', token, models, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) })
}
function resetEntry(entry?: Record<string, unknown>): void {
  state.providers = entry === undefined ? {} : { [PROVIDER]: entry }
  writeFileSync(patchPath, renderPatch(), 'utf8')
}

try {
  // ══════════════════════════════════════════ 1. reading the real document shape
  console.log('\n[1] the credentials document: read strictly, refuse to guess')
  writeCredentialsDocument()
  {
    const parsed = readCredentialsDocument(REAL_SHAPE, credentialsPath)
    check('the real shape parses: version + records + refs', !('detail' in parsed) && parsed.version === 1, 'detail' in parsed ? parsed.detail : `v${String(parsed.version)}`)
    check('...the two refs are read back verbatim', !('detail' in parsed) && parsed.refs.get('DEEPSEEK_API_KEY') === 'sk-fake-deepseek-value' && parsed.refs.get('XIAOMI_API_KEY') === 'sk-fake-xiaomi-value')
    check('...the records/version part is captured for byte-comparison', !('detail' in parsed) && parsed.outsideRefs.includes('client-connection/browser-session') && !parsed.outsideRefs.includes('DEEPSEEK_API_KEY'))
    const quoted = readCredentialsDocument('version: 1\nrefs:\n  A_KEY: "123"\n  B_KEY: \'x\'\'y\'\n', credentialsPath)
    check('quoted scalars are read (the yaml writer quotes a numeric-looking value)', !('detail' in quoted) && quoted.refs.get('A_KEY') === '123' && quoted.refs.get('B_KEY') === "x'y")
    const unknownVersion = readCredentialsDocument('version: 2\nrefs:\n', credentialsPath)
    check('an unknown document version is REFUSED, never written', 'detail' in unknownVersion && unknownVersion.detail.includes('version 2'))
    const nested = readCredentialsDocument('version: 1\nrefs:\n  A_KEY:\n    nested: 1\n', credentialsPath)
    check('a nested block under refs is refused (not read as a value)', 'detail' in nested)
    check('parseCredentialScalar refuses block scalars/anchors', parseCredentialScalar('|') === undefined && parseCredentialScalar('&anchor x') === undefined && parseCredentialScalar('plain-value') === 'plain-value')
    const absent = readCredentialsDocument('', credentialsPath)
    check('an absent document is an EMPTY store, not a failure', !('detail' in absent) && absent.refs.size === 0 && absent.exists === false)
    const freshVerdict = judgeCredentialsWrite(absent, 'version: 1\nrefs:\n  TRAE_API_KEY: tok\n', TRAE_API_KEY_REF, 'tok')
    check('creating a document from nothing passes (rules ③-⑤ have no prior state)', freshVerdict.ok, freshVerdict.reasons.join('；'))
    const freshMissing = judgeCredentialsWrite(absent, 'version: 1\nrefs:\n', TRAE_API_KEY_REF, 'tok')
    check('...but a created document WITHOUT our key still fails rule ②', !freshMissing.ok, freshMissing.reasons.join('；'))
  }

  // ══════════════════════════════════════════ 2. ensuring our key (state machine)
  console.log('\n[2] ensureCredentialRef — the value goes in FIRST, and only then is it promised')
  {
    writeCredentialsDocument()
    const store = makeStore()
    const written = await ensureCredentialRef({ store, ref: TRAE_API_KEY_REF, value: TOKEN_A, home })
    check('a missing key is written', written.status === 'written' && written.wrote === true, `${written.status} ${written.detail}`)
    check('...the file really holds it afterwards (read back from DISK)', credentialsRefValue(home, TRAE_API_KEY_REF) === TOKEN_A)
    check('...and the OTHER keys are byte-identical (sk-fake-deepseek / sk-fake-xiaomi survived)', credentialsRefValue(home, 'DEEPSEEK_API_KEY') === 'sk-fake-deepseek-value' && credentialsRefValue(home, 'XIAOMI_API_KEY') === 'sk-fake-xiaomi-value')
    check('...the records section is byte-identical too', readFileSync(credentialsPath, 'utf8').includes('secret: fake-browser-session-secret-value') && readFileSync(credentialsPath, 'utf8').includes('issuer: https://platform.deepseek.com'))
    check('...a backup exists, OUTSIDE every profile', written.backupPath !== undefined && existsSync(written.backupPath) && !written.backupPath.startsWith(profileDir), written.backupPath ?? '(none)')
    check('...and it holds the PRE-write bytes', written.backupPath !== undefined && readFileSync(written.backupPath, 'utf8') === REAL_SHAPE)
    check('...the backup directory is the plugin-owned one, not the home root', written.backupPath !== undefined && written.backupPath.startsWith(join(home, DEFAULT_BACKUP_DIR_NAME)))

    const backupsBefore = listCredentialBackups(home).length
    const again = await ensureCredentialRef({ store, ref: TRAE_API_KEY_REF, value: TOKEN_A, home })
    check('same value ⇒ status present and NOT one write', again.status === 'present' && store.writes === 1, `${again.status} writes=${store.writes}`)
    const before = readFileSync(credentialsPath, 'utf8')
    await ensureCredentialRef({ store, ref: TRAE_API_KEY_REF, value: TOKEN_A, home })
    check('...and the file is byte-identical after the no-op (no mtime churn for the watcher)', readFileSync(credentialsPath, 'utf8') === before)
    check('...and no backup is taken for a write that never happens (no per-boot growth)', listCredentialBackups(home).length === backupsBefore, `${backupsBefore} → ${listCredentialBackups(home).length}`)

    const rotated = await ensureCredentialRef({ store, ref: TRAE_API_KEY_REF, value: TOKEN_B, home })
    check('a different value (token rotation) IS written', rotated.status === 'written' && credentialsRefValue(home, TRAE_API_KEY_REF) === TOKEN_B)

    const refused = await ensureCredentialRef({ store: makeStore({ refuse: 'credentials-local: nope' }), ref: TRAE_API_KEY_REF, value: TOKEN_A, home })
    check('a store that refuses ⇒ failed, wrote:false', refused.status === 'failed' && refused.wrote === false, refused.status)
    check('...and the old value is still the one on disk', credentialsRefValue(home, TRAE_API_KEY_REF) === TOKEN_B)

    const noService = await ensureCredentialRef({ store: undefined, ref: TRAE_API_KEY_REF, value: TOKEN_A, home })
    check('no credentials service in the composition ⇒ no-service (never a blind write)', noService.status === 'no-service' && noService.wrote === false, noService.status)
    const fromEnv = await ensureCredentialRef({ store: makeStore(), ref: TRAE_API_KEY_REF, value: TOKEN_A, home, env: { [TRAE_API_KEY_REF]: 'supplied-by-the-shell' } })
    check('a reference the launch environment supplies ⇒ env (writing it would be shadowed)', fromEnv.status === 'env' && fromEnv.wrote === false, fromEnv.status)
    const badRef = await ensureCredentialRef({ store: makeStore(), ref: 'not a ref', value: TOKEN_A, home })
    check('a reference name outside the grammar ⇒ failed, before anything is touched', badRef.status === 'failed')
    const emptyValue = await ensureCredentialRef({ store: makeStore(), ref: TRAE_API_KEY_REF, value: '', home })
    check('an empty value ⇒ failed (the store rejects empty values)', emptyValue.status === 'failed')
    check('...and none of those refusals reached the store', badRef.wrote === false && emptyValue.wrote === false)
  }

  // ══════════════════════════════════════════ 2b. a machine with NO document yet
  console.log('\n[2b] a machine that has never stored a credential: the document is CREATED, not rejected')
  {
    // The "new machine turns green immediately" case — and the one rule-⑤ trap:
    // comparing a brand-new document against an absent one must not read as loss.
    const freshHome = mkdtempSync(join(tmpdir(), 'dsh-pylon-trae-cred-'))
    const freshPath = join(freshHome, CREDENTIALS_FILENAME)
    check('the fixture really has no document', !existsSync(freshPath))
    const store = makeStore({ path: freshPath })
    const created = await ensureCredentialRef({ store, ref: TRAE_API_KEY_REF, value: TOKEN_A, home: freshHome })
    check('...a missing document is created, not refused', created.status === 'written' && created.wrote === true, `${created.status} ${created.detail}`)
    check('...the new document holds our key (read back from disk)', credentialsRefValue(freshHome, TRAE_API_KEY_REF) === TOKEN_A)
    check('...and it is a version-1 document this plugin can read', !('detail' in readCredentialsDocument(readFileSync(freshPath, 'utf8'), freshPath)))
    check('...no backup was needed for a file that did not exist', created.backupPath === undefined)
    check('...and the second boot is the zero-write case', (await ensureCredentialRef({ store, ref: TRAE_API_KEY_REF, value: TOKEN_A, home: freshHome })).status === 'present')
    // A concurrent writer creating its own key must not fail our write.
    const shared = mkdtempSync(join(tmpdir(), 'dsh-pylon-trae-cred-'))
    writeFileSync(join(shared, CREDENTIALS_FILENAME), 'version: 1\nrefs:\n  SOMEONE_ELSE_KEY: theirs\n', 'utf8')
    const sharedStore: CredentialStoreFace = {
      async set(ref: string, value: string): Promise<void> {
        writeFileSync(join(shared, CREDENTIALS_FILENAME), `version: 1\nrefs:\n  SOMEONE_ELSE_KEY: theirs\n  ${ref}: ${value}\n`, 'utf8')
      }
    }
    const sharedResult = await ensureCredentialRef({ store: sharedStore, ref: TRAE_API_KEY_REF, value: TOKEN_A, home: shared })
    check('a sibling key written by somebody else is never touched', sharedResult.status === 'written' && credentialsRefValue(shared, 'SOMEONE_ELSE_KEY') === 'theirs')
    rmSync(freshHome, { recursive: true, force: true })
    rmSync(shared, { recursive: true, force: true })
  }

  // ══════════════════════════════════════════ 3. the verifier + rollback
  console.log('\n[3] the write is judged from disk — a store that clobbers another key is undone')
  {
    writeCredentialsDocument()
    const before = readCredentialsDocument(REAL_SHAPE, credentialsPath)
    if ('detail' in before) throw new Error('fixture did not parse')
    const good = judgeCredentialsWrite(before, REAL_SHAPE.replace('refs:\n', `refs:\n  ${TRAE_API_KEY_REF}: ${TOKEN_A}\n`), TRAE_API_KEY_REF, TOKEN_A)
    check('a clean append passes all five rules', good.ok, good.reasons.join('；'))
    const clobbered = judgeCredentialsWrite(before, REAL_SHAPE.replace('sk-fake-xiaomi-value', 'sk-clobbered'), TRAE_API_KEY_REF, TOKEN_A)
    check('...a changed sibling key fails', !clobbered.ok && clobbered.reasons.some((reason) => reason.includes('XIAOMI_API_KEY')), clobbered.reasons.join('；'))
    const dropped = judgeCredentialsWrite(before, REAL_SHAPE.replace('  XIAOMI_API_KEY: sk-fake-xiaomi-value\n', ''), TRAE_API_KEY_REF, TOKEN_A)
    check('...a DROPPED sibling key fails (that would un-authenticate another provider)', !dropped.ok && dropped.reasons.some((reason) => reason.includes('丢掉了')))
    const notLanded = judgeCredentialsWrite(before, REAL_SHAPE, TRAE_API_KEY_REF, TOKEN_A)
    check('...a value that never landed fails', !notLanded.ok && notLanded.reasons.some((reason) => reason.includes('不在写入后的 refs 里')))
    const wrongValue = judgeCredentialsWrite(before, REAL_SHAPE.replace('refs:\n', `refs:\n  ${TRAE_API_KEY_REF}: something-else\n`), TRAE_API_KEY_REF, TOKEN_A)
    check('...a value that is not OURS fails', !wrongValue.ok && wrongValue.reasons.some((reason) => reason.includes('不是我们写入的那个')))
    const recordsTouched = judgeCredentialsWrite(before, REAL_SHAPE.replace('secret: fake-browser-session-secret-value', 'secret: replaced').replace('refs:\n', `refs:\n  ${TRAE_API_KEY_REF}: ${TOKEN_A}\n`), TRAE_API_KEY_REF, TOKEN_A)
    check('...a touched records section fails (outside-refs must be byte-identical)', !recordsTouched.ok && recordsTouched.reasons.some((reason) => reason.includes('refs 段之外')))

    writeCredentialsDocument()
    const clobberStore = makeStore({ corruptOtherKey: true })
    const clobberedWrite = await ensureCredentialRef({ store: clobberStore, ref: TRAE_API_KEY_REF, value: TOKEN_A, home })
    check('a clobbering write is reported rolled-back', clobberedWrite.status === 'rolled-back' && clobberedWrite.wrote === false, `${clobberedWrite.status} ${clobberedWrite.detail}`)
    check('...and the document is restored BYTE-FOR-BYTE from the backup', readFileSync(credentialsPath, 'utf8') === REAL_SHAPE)
    check('...so the sibling key is back', credentialsRefValue(home, 'XIAOMI_API_KEY') === 'sk-fake-xiaomi-value')
    check('...and our key is NOT half-written', credentialsRefValue(home, TRAE_API_KEY_REF) === undefined)

    const snapshot = snapshotCredentials(home)
    check('snapshotCredentials leaves a backup of the current bytes', snapshot.backupPath !== undefined && readFileSync(snapshot.backupPath, 'utf8') === REAL_SHAPE)
    check('...and the backup list keeps only files of one document', listCredentialBackups(home).every((path) => path.includes(CREDENTIALS_FILENAME)))
  }

  // ══════════════════════════════════════════ 4. the green dot's three states
  console.log('\n[4] the dot: green only with a value in the store, and NEVER red because of us')
  {
    // ① an entry that predates apiKeyEnv, with the credential verified first.
    writeCredentialsDocument()
    resetEntry({ displayName: 'Trae', api: 'openai-completions', baseURL: 'http://127.0.0.1:7864/v1', headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] })
    const store = makeStore()
    const ensured = await ensureCredentialRef({ store, ref: TRAE_API_KEY_REF, value: TOKEN_B, home })
    const synced = await syncProviderEntry({
      settings,
      pluginName: PLUGIN,
      providerName: PROVIDER,
      profile: profileOf(TOKEN_B, [chat('glm-5.2')], ensured.status === 'written' || ensured.status === 'present' ? TRAE_API_KEY_REF : undefined),
      token: TOKEN_B,
      refreshOnBoot: true,
      previouslyOffered: ['glm-5.2']
    })
    const entry = state.providers[PROVIDER] as Record<string, unknown>
    check('① credential in the store ⇒ the entry names apiKeyEnv', entry['apiKeyEnv'] === TRAE_API_KEY_REF, String(entry['apiKeyEnv']))
    check('...the outcome says so', synced.kind === 'rotated' && synced.apiKeyEnvState === 'written', synced.kind)
    check('...the dot is GREEN', dotState(entry, configuredRefs()) === 'green')
    check('...and the model rows were NOT rebuilt (the user\'s row is untouched)', JSON.stringify(entry['models']) === JSON.stringify([{ id: 'glm-5.2', name: 'GLM-5.2' }]))

    // ② the credential write FAILS ⇒ apiKeyEnv must not be named at all.
    writeCredentialsDocument()
    resetEntry({ displayName: 'Trae', headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2' }] })
    const failed = await ensureCredentialRef({ store: makeStore({ refuse: 'credentials-local: refused' }), ref: TRAE_API_KEY_REF, value: TOKEN_B, home })
    // The boot's own decision, taken from the shipped function rather than restated
    // here: a failure must yield NO reference, and that is what keeps the dot at
    // "none" instead of the red "named but missing".
    const failedRef = verifiedCredentialRef(failed, TRAE_API_KEY_REF)
    check('② a failed credential write yields NO reference to name', failedRef === undefined, String(failedRef))
    const afterFailure = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, [chat('glm-5.2')], failedRef), token: TOKEN_B, refreshOnBoot: true, previouslyOffered: ['glm-5.2'], skippedInternal: ['title_generation'] })
    const failedEntry = state.providers[PROVIDER] as Record<string, unknown>
    check('② a failed credential write ⇒ NO apiKeyEnv is written', !('apiKeyEnv' in failedEntry), JSON.stringify(failedEntry['apiKeyEnv']))
    check('...the dot is NONE (the old behaviour), never RED', dotState(failedEntry, configuredRefs()) === 'none')
    check('...and the outcome records the refusal', afterFailure.kind === 'present' && afterFailure.apiKeyEnvState === 'skipped', `${afterFailure.kind}/${String(afterFailure.apiKeyEnvState)}`)
    // The same mapping for every other answer the store can give: the reference is
    // named ONLY for the three states that mean "describe() says configured".
    const refFor = (status: 'written' | 'present' | 'env' | 'no-service' | 'unreadable' | 'failed' | 'rolled-back'): string | undefined =>
      verifiedCredentialRef({ status, ref: TRAE_API_KEY_REF, detail: '', wrote: status === 'written' }, TRAE_API_KEY_REF)
    check('② the decision names the reference only for written/present/env', refFor('written') === TRAE_API_KEY_REF && refFor('present') === TRAE_API_KEY_REF && refFor('env') === TRAE_API_KEY_REF)
    check('② ...and never for the four failure states (this is the red-dot rule)', refFor('no-service') === undefined && refFor('unreadable') === undefined && refFor('failed') === undefined && refFor('rolled-back') === undefined)

    // ③ the value is already there and identical ⇒ not one byte written.
    writeCredentialsDocument(REAL_SHAPE.replace('refs:\n', `refs:\n  ${TRAE_API_KEY_REF}: ${TOKEN_B}\n`))
    resetEntry({ displayName: 'Trae', api: 'openai-completions', baseURL: 'http://127.0.0.1:7864/v1', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] })
    const beforeText = readFileSync(patchPath, 'utf8')
    const beforeDoc = readFileSync(credentialsPath, 'utf8')
    const calls = state.mutateCalls
    const quietStore = makeStore()
    const quiet = await ensureCredentialRef({ store: quietStore, ref: TRAE_API_KEY_REF, value: TOKEN_B, home })
    const present = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, [chat('glm-5.2')], TRAE_API_KEY_REF), token: TOKEN_B, refreshOnBoot: true, previouslyOffered: ['glm-5.2'] })
    check('③ same value + same token + no new model ⇒ present, zero writes', present.kind === 'present' && state.mutateCalls === calls && readFileSync(patchPath, 'utf8') === beforeText)
    check('...the credential store was not written either', quiet.status === 'present' && quietStore.writes === 0 && readFileSync(credentialsPath, 'utf8') === beforeDoc)
    check('...and the dot stays GREEN throughout', dotState(state.providers[PROVIDER] as Record<string, unknown>, configuredRefs()) === 'green')
  }

  // ══════════════════════════════════════════ 5. token rotation
  console.log('\n[5] rotation: a new shim token reaches the entry and the store, or nothing is written')
  {
    writeCredentialsDocument(REAL_SHAPE.replace('refs:\n', `refs:\n  ${TRAE_API_KEY_REF}: ${TOKEN_A}\n`))
    resetEntry({ displayName: 'Trae（我改过）', api: 'openai-completions', baseURL: 'http://127.0.0.1:9999/v1', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_A}`, 'X-Mine': 'keep-me' }, models: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'title_generation' }] })
    const calls = state.mutateCalls
    const rotated = await ensureCredentialRef({ store: makeStore(), ref: TRAE_API_KEY_REF, value: TOKEN_B, home })
    check('a rotated token is synced INTO the credential store', rotated.status === 'written' && credentialsRefValue(home, TRAE_API_KEY_REF) === TOKEN_B)
    const outcome = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, [chat('glm-5.2')], TRAE_API_KEY_REF), token: TOKEN_B, refreshOnBoot: true, previouslyOffered: ['glm-5.2', 'title_generation'] })
    const entry = state.providers[PROVIDER] as Record<string, unknown>
    check('...and the entry is updated (rotated), under the guard', outcome.kind === 'rotated' && outcome.tokenState === 'rotated' && state.mutateCalls > calls, `${outcome.kind}/${outcome.kind === 'rotated' ? outcome.tokenState : '?'}`)
    check('...the header carries the CURRENT token', (entry['headers'] as Record<string, string>)['Authorization'] === `Bearer ${TOKEN_B}`)
    check('...every other header survived verbatim', (entry['headers'] as Record<string, string>)['X-Mine'] === 'keep-me')
    check('...displayName/api/baseURL and the internal row are untouched', entry['displayName'] === 'Trae（我改过）' && entry['api'] === 'openai-completions' && entry['baseURL'] === 'http://127.0.0.1:9999/v1' && (entry['models'] as { id: string }[]).map((model) => model.id).join(',') === 'glm-5.2,title_generation')
    check('...a backup of the pre-rotation patch exists', outcome.kind === 'rotated' && existsSync(outcome.backupPath) && !outcome.backupPath.startsWith(profileDir))

    const calls2 = state.mutateCalls
    const beforeText = readFileSync(patchPath, 'utf8')
    const same = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, [chat('glm-5.2')], TRAE_API_KEY_REF), token: TOKEN_B, refreshOnBoot: true, previouslyOffered: ['glm-5.2', 'title_generation'] })
    check('a token that already matches ⇒ present, zero writes', same.kind === 'present' && same.tokenState === 'same' && state.mutateCalls === calls2 && readFileSync(patchPath, 'utf8') === beforeText)

    // No Authorization header at all: the entry cannot authenticate, so it is fixed.
    resetEntry({ displayName: 'Trae', models: [{ id: 'glm-5.2' }] })
    const missing = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, [chat('glm-5.2')]), token: TOKEN_B, refreshOnBoot: false, previouslyOffered: ['glm-5.2'] })
    check('an entry with no Authorization header is fixed and reported as missing', missing.kind === 'rotated' && missing.tokenState === 'missing', `${missing.kind}/${missing.kind === 'rotated' ? missing.tokenState : '?'}`)
    check('...and it now carries the token', ((state.providers[PROVIDER] as Record<string, unknown>)['headers'] as Record<string, string>)['Authorization'] === `Bearer ${TOKEN_B}`)
  }

  // ══════════════════════════════════════════ 6. boot: only add
  console.log('\n[6] boot refresh — only add, never revive, and nothing to add means nothing written')
  {
    writeCredentialsDocument(REAL_SHAPE.replace('refs:\n', `refs:\n  ${TRAE_API_KEY_REF}: ${TOKEN_B}\n`))
    resetEntry({ displayName: 'Trae', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] })
    const directory = [chat('glm-5.2'), chat('kimi-k2.6'), internal('title_generation'), internal('fast_apply')]
    const catalogue = partitionModels(directory)
    const outcome = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, directory, TRAE_API_KEY_REF), token: TOKEN_B, refreshOnBoot: true, previouslyOffered: ['glm-5.2'], skippedInternal: catalogue.internalIds })
    const ids = ((state.providers[PROVIDER] as Record<string, unknown>)['models'] as { id: string }[]).map((model) => model.id)
    check('a new chat model is added and named in the outcome', outcome.kind === 'rebuilt' && outcome.addedModels.join(',') === 'kimi-k2.6', outcome.kind === 'rebuilt' ? outcome.addedModels.join(',') : outcome.kind)
    check('...the internal components did NOT come with it (chat only)', !ids.includes('title_generation') && !ids.includes('fast_apply') && ids.join(',') === 'glm-5.2,kimi-k2.6', ids.join(','))
    check('...the outcome carries the skipped internal ids so the omission is explainable', outcome.kind === 'rebuilt' && outcome.skippedInternal.join(',') === 'title_generation,fast_apply')
    check('...the existing row is carried through VERBATIM (rows are appended, never rebuilt)', JSON.stringify(((state.providers[PROVIDER] as Record<string, unknown>)['models'] as unknown[])[0]) === JSON.stringify({ id: 'glm-5.2', name: 'GLM-5.2' }), JSON.stringify(((state.providers[PROVIDER] as Record<string, unknown>)['models'] as unknown[])[0]))
    check('...and the appended row is the live directory\'s, with its name', (((state.providers[PROVIDER] as Record<string, unknown>)['models'] as { id: string; name?: string }[])[1]?.name) === 'kimi-k2.6')
    check('...and the tombstone set is exactly what the entry now holds', outcome.kind === 'rebuilt' && outcome.offeredModels.join(',') === 'glm-5.2,kimi-k2.6')

    const calls = state.mutateCalls
    const beforeText = readFileSync(patchPath, 'utf8')
    const quiet = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, directory, TRAE_API_KEY_REF), token: TOKEN_B, refreshOnBoot: true, previouslyOffered: ['glm-5.2', 'kimi-k2.6'] })
    check('a second boot with nothing new writes NOTHING (no mutate, file byte-identical)', quiet.kind === 'present' && state.mutateCalls === calls && readFileSync(patchPath, 'utf8') === beforeText)

    // The user deleted kimi-k2.6: it must not come back, even though the directory offers it.
    state.providers[PROVIDER] = { ...(state.providers[PROVIDER] as Record<string, unknown>), models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] }
    writeFileSync(patchPath, renderPatch(), 'utf8')
    const calls2 = state.mutateCalls
    const tombstoned = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, directory, TRAE_API_KEY_REF), token: TOKEN_B, refreshOnBoot: true, previouslyOffered: ['glm-5.2', 'kimi-k2.6'] })
    check('a model the user deleted is NOT revived by the boot refresh', tombstoned.kind === 'present' && state.mutateCalls === calls2)
    check('...and the entry still holds only what the user kept', (((state.providers[PROVIDER] as Record<string, unknown>)['models'] as { id: string }[]).map((model) => model.id).join(',') === 'glm-5.2'))

    // The tombstone must be APPEND-ONLY, or a deletion undoes itself one boot later:
    // boot N remembers {A,B}; the user deletes B; boot N+1 correctly refuses to
    // re-add it but (if the memory were replaced by "what the entry holds") forgets
    // B; boot N+2 then sees B as brand new and adds it back. Three boots, no user.
    let memory: string[] = []
    const boot = async (): Promise<string[]> => {
      const result = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, [chat('glm-5.2'), chat('kimi-k2.6')], TRAE_API_KEY_REF), token: TOKEN_B, refreshOnBoot: true, previouslyOffered: memory })
      memory = mergeOffered(memory, 'offeredModels' in result ? result.offeredModels : [])
      return currentIds()
    }
    const currentIds = (): string[] => ((state.providers[PROVIDER] as Record<string, unknown>)['models'] as { id: string }[]).map((model) => model.id)
    resetEntry({ displayName: 'Trae', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2' }, { id: 'kimi-k2.6' }] })
    await boot()
    check('boot 1: the memory holds both ids', memory.join(',') === 'glm-5.2,kimi-k2.6', memory.join(','))
    // The user deletes kimi-k2.6 through the Models page (a write the plugin never sees).
    state.providers[PROVIDER] = { ...(state.providers[PROVIDER] as Record<string, unknown>), models: [{ id: 'glm-5.2' }] }
    writeFileSync(patchPath, renderPatch(), 'utf8')
    const boot2 = await boot()
    check('boot 2: the deleted model is NOT re-added', !boot2.includes('kimi-k2.6'), boot2.join(','))
    check('...and the memory still remembers it (this is what makes it permanent)', memory.includes('kimi-k2.6'), memory.join(','))
    const boot3 = await boot()
    check('boot 3: it is STILL not re-added (a shrinking memory would have revived it here)', !boot3.includes('kimi-k2.6'), boot3.join(','))
    check('three boots, and the entry is exactly what the user kept', currentIds().join(',') === 'glm-5.2', currentIds().join(','))
    check('mergeOffered is a union, never a replacement', mergeOffered(['a'], ['b']).join(',') === 'a,b' && mergeOffered(['a', 'b'], ['a']).join(',') === 'a,b' && mergeOffered(undefined, ['x']).join(',') === 'x')

    // refreshOnBoot: false ⇒ the old conservative behaviour, so the button keeps its meaning.
    const calls3 = state.mutateCalls
    const off = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, directory, TRAE_API_KEY_REF), token: TOKEN_B, refreshOnBoot: false, previouslyOffered: ['glm-5.2'] })
    check('refreshOnBoot=false ⇒ no model is added, nothing is written', off.kind === 'present' && state.mutateCalls === calls3)
    check('...so "rebuild the list" still has something to offer it later', off.kind === 'present' && !(off.offeredModels ?? []).includes('kimi-k2.6'))
  }

  // ══════════════════════════════════════════ 7. the guard still rules the sync
  console.log('\n[7] the sync obeys the same guard: no patch file ⇒ refuse; a lossy write ⇒ roll back')
  {
    resetEntry({ displayName: 'Trae', headers: { Authorization: `Bearer ${TOKEN_A}` }, models: [{ id: 'glm-5.2' }] })
    const saved = process.env['DSH_HOME']
    process.env['DSH_HOME'] = join(home, 'nowhere')
    const noGuard = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, [chat('glm-5.2')]), token: TOKEN_B, refreshOnBoot: true })
    process.env['DSH_HOME'] = saved
    check('with no cordis.patch.yml the rotation REFUSES (no-guard) instead of writing blind', noGuard.kind === 'no-guard', noGuard.kind)
    check('...and the stale token is untouched', ((state.providers[PROVIDER] as Record<string, unknown>)['headers'] as Record<string, string>)['Authorization'] === `Bearer ${TOKEN_A}`)

    resetEntry({ displayName: 'Trae', headers: { Authorization: `Bearer ${TOKEN_A}` }, models: [{ id: 'glm-5.2' }] })
    writeFileSync(patchPath, renderPatch(), 'utf8')
    const beforeBad = readFileSync(patchPath, 'utf8')
    state.breakNextWrite = true
    const rolledBack = await syncProviderEntry({ settings, pluginName: PLUGIN, providerName: PROVIDER, profile: profileOf(TOKEN_B, [chat('glm-5.2')]), token: TOKEN_B, refreshOnBoot: false })
    state.breakNextWrite = false
    check('a write that truncates the patch is rolled back', rolledBack.kind === 'rolled-back', rolledBack.kind)
    check('...and the file is back byte-for-byte', readFileSync(patchPath, 'utf8') === beforeBad)
    check('...with a backup that can restore it', rolledBack.kind === 'rolled-back' && existsSync(rolledBack.backupPath))
  }
  // ══════════════════════════════════════════ 8. display names
  console.log('\n[8] name sync — improve what WE wrote, and never touch what the USER wrote')
  {
    const rowsOf = (): Record<string, unknown>[] => ((state.providers[PROVIDER] as Record<string, unknown> | undefined)?.['models'] as Record<string, unknown>[]) ?? []
    const rowName = (index: number): unknown => rowsOf()[index]?.['name']
    const sameNames = (left: Readonly<Record<string, string>> | undefined, right: Readonly<Record<string, string>> | undefined): boolean => {
      const a = left ?? {}
      const b = right ?? {}
      const keys = Object.keys(a)
      return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
    }
    const directory = [chat('glm-5.2', 'GLM-5.2'), chat('kimi-k2.6', 'Kimi-K2.6')]
    const profile = profileOf(TOKEN_B, directory, TRAE_API_KEY_REF)
    /** The entry a version WITHOUT display names left behind: every row named after its own id. */
    const legacyRow = { id: 'glm-5.2', name: 'glm-5.2', contextWindow: 116000, input: ['text'], reasoningEfforts: { off: null, low: 'low' }, compat: { supportsReasoningEffort: true } }
    const base = { settings, pluginName: PLUGIN, providerName: PROVIDER, profile, token: TOKEN_B, refreshOnBoot: true, previouslyOffered: ['glm-5.2', 'kimi-k2.6'] }
    const withNames = { ...base, syncNamesOnBoot: true }

    // ① the first boot of this feature: the id-names become display names.
    resetEntry({
      displayName: 'Trae',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:7864/v1',
      apiKeyEnv: TRAE_API_KEY_REF,
      headers: { Authorization: `Bearer ${TOKEN_B}` },
      models: [legacyRow, { id: 'kimi-k2.6', name: 'kimi-k2.6', contextWindow: 200000, input: ['text'] }, { id: 'title_generation' }]
    })
    const calls1 = state.mutateCalls
    const beforeText = readFileSync(patchPath, 'utf8')
    const boot1 = await syncProviderEntry({ ...withNames, lastNames: {} })
    const names1 = boot1.nameSync?.names ?? {}
    check(
      'boot 1: every row named after its own id is rewritten to the computed name',
      boot1.nameSync?.state === 'written' && JSON.stringify(boot1.nameSync.renamed) === JSON.stringify([{ id: 'glm-5.2', from: 'glm-5.2', to: 'GLM-5.2' }, { id: 'kimi-k2.6', from: 'kimi-k2.6', to: 'Kimi-K2.6' }]),
      JSON.stringify(boot1.nameSync?.renamed)
    )
    check('...the entry really carries them', rowName(0) === 'GLM-5.2' && rowName(1) === 'Kimi-K2.6', `${String(rowName(0))}/${String(rowName(1))}`)
    check('...and so does the FILE on disk (not only the in-memory dict)', readFileSync(patchPath, 'utf8') !== beforeText && /- id: glm-5\.2\n\s+name: GLM-5\.2/.test(readFileSync(patchPath, 'utf8')))
    check('...in ONE write, not one per row', state.mutateCalls - calls1 === 1, String(state.mutateCalls - calls1))
    check('...and no row was added, removed or reordered (a rename is not a rebuild)', rowsOf().map((row) => row['id']).join(',') === 'glm-5.2,kimi-k2.6,title_generation', rowsOf().map((row) => row['id']).join(','))
    check(
      '...ONLY `name` changed: contextWindow/input/reasoningEfforts/compat survive verbatim',
      JSON.stringify({ ...rowsOf()[0], name: 'glm-5.2' }) === JSON.stringify(legacyRow),
      JSON.stringify(rowsOf()[0])
    )
    check('...the internal component did not participate (untouched, unclaimed)', JSON.stringify(rowsOf()[2]) === '{"id":"title_generation"}' && !('title_generation' in names1))
    check('...and the memory owns exactly the names we wrote', sameNames(names1, { 'glm-5.2': 'GLM-5.2', 'kimi-k2.6': 'Kimi-K2.6' }), JSON.stringify(names1))

    // ② the second boot must be a TRUE no-op — this is the assertion that fails when
    // the memory is not written back after a rename (the plugin would then have to
    // re-derive "is this ours?" from nothing, and would record the very names it
    // already knew).
    const calls2 = state.mutateCalls
    const text2 = readFileSync(patchPath, 'utf8')
    const boot2 = await syncProviderEntry({ ...withNames, lastNames: names1 })
    check('boot 2: nothing to do ⇒ present, zero mutate calls, byte-identical file', boot2.kind === 'present' && state.mutateCalls === calls2 && readFileSync(patchPath, 'utf8') === text2, `${boot2.kind}/${String(state.mutateCalls - calls2)}`)
    check('...no row renamed, and NONE mistaken for a user edit', boot2.nameSync?.renamed.length === 0 && boot2.nameSync?.skippedUserNames.length === 0, JSON.stringify(boot2.nameSync))
    check('...and the name memory does not grow on a boot that wrote nothing (no state.json churn)', sameNames(mergeNames(names1, boot2.nameSync?.names), names1), JSON.stringify(boot2.nameSync?.names))

    // ③ the user renames a row we wrote, and separately types a name on a row we
    // never recorded. The first must survive; the second must never be "upgraded".
    state.providers[PROVIDER] = { ...(state.providers[PROVIDER] as Record<string, unknown>), models: [{ id: 'glm-5.2', name: '我的 GLM' }, { id: 'kimi-k2.6', name: 'Kimi-K2.6' }, { id: 'title_generation' }] }
    writeFileSync(patchPath, renderPatch(), 'utf8')
    const calls3 = state.mutateCalls
    const text3 = readFileSync(patchPath, 'utf8')
    const boot3 = await syncProviderEntry({ ...withNames, lastNames: names1 })
    check('a row the USER renamed is not overwritten (and nothing is written)', rowName(0) === '我的 GLM' && state.mutateCalls === calls3 && readFileSync(patchPath, 'utf8') === text3)
    check('...the outcome names the skipped row, so boot.log can say "用户改过的名字，跳过"', JSON.stringify(boot3.nameSync?.skippedUserNames) === JSON.stringify([{ id: 'glm-5.2', name: '我的 GLM' }]), JSON.stringify(boot3.nameSync?.skippedUserNames))
    check("...and the user's name is NOT claimed as ours (that claim is what would overwrite it next boot)", mergeNames(names1, boot3.nameSync?.names)['glm-5.2'] === 'GLM-5.2', JSON.stringify(boot3.nameSync?.names))
    check('...while the row the user left alone keeps the name we gave it', rowName(1) === 'Kimi-K2.6')
    const boot3b = await syncProviderEntry({ ...withNames, lastNames: {} })
    check('a name we have NO record of writing is the user\'s too, even with an empty memory', rowName(0) === '我的 GLM' && JSON.stringify(boot3b.nameSync?.skippedUserNames) === JSON.stringify([{ id: 'glm-5.2', name: '我的 GLM' }]), JSON.stringify(boot3b.nameSync?.skippedUserNames))

    // ④ already correct is not a write — but it IS a claim, and that claim is what
    // lets a LATER, better computation still reach the row.
    resetEntry({ displayName: 'Trae', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] })
    const calls4 = state.mutateCalls
    const boot4 = await syncProviderEntry({ ...withNames, lastNames: {} })
    check('a row that already carries the computed name is not rewritten', boot4.kind === 'present' && state.mutateCalls === calls4 && boot4.nameSync?.renamed.length === 0, boot4.kind)
    check('...but it IS claimed, so a later improvement can still reach it', boot4.nameSync?.names?.['glm-5.2'] === 'GLM-5.2', JSON.stringify(boot4.nameSync?.names))
    const improved = await syncProviderEntry({ ...withNames, lastNames: boot4.nameSync?.names, profile: profileOf(TOKEN_B, [chat('glm-5.2', 'GLM-5.2（同名补了后缀）')], TRAE_API_KEY_REF) })
    check('...and it does: the claimed name is updated when the computation improves', improved.nameSync?.renamed.length === 1 && rowName(0) === 'GLM-5.2（同名补了后缀）', JSON.stringify(improved.nameSync?.renamed))

    // ⑤ a rename and a new model travel in ONE write.
    resetEntry({ displayName: 'Trae', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'glm-5.2' }, { id: 'kimi-k2.6', name: 'Kimi-K2.6' }] })
    const calls5 = state.mutateCalls
    const both = await syncProviderEntry({
      ...withNames,
      profile: profileOf(TOKEN_B, [chat('glm-5.2', 'GLM-5.2'), chat('kimi-k2.6', 'Kimi-K2.6'), chat('doubao-1.8', 'Doubao-1.8')], TRAE_API_KEY_REF),
      lastNames: { 'glm-5.2': 'glm-5.2' }
    })
    check('a rename and a new model land in ONE write', both.kind === 'rebuilt' && state.mutateCalls - calls5 === 1, `${both.kind}/${String(state.mutateCalls - calls5)}`)
    check('...the appended row arrives with its name and stays LAST', JSON.stringify(rowsOf().map((row) => [row['id'], row['name']])) === JSON.stringify([['glm-5.2', 'GLM-5.2'], ['kimi-k2.6', 'Kimi-K2.6'], ['doubao-1.8', 'Doubao-1.8']]), JSON.stringify(rowsOf().map((row) => [row['id'], row['name']])))
    check('...and the outcome reports both halves', both.kind === 'rebuilt' && both.addedModels.join(',') === 'doubao-1.8' && both.nameSync?.renamed.length === 1 && both.nameSync.renamed[0]?.id === 'glm-5.2', both.kind === 'rebuilt' ? `${both.addedModels.join(',')}/${JSON.stringify(both.nameSync?.renamed)}` : both.kind)
    check('...and the memory owns all three names', sameNames(both.nameSync?.names, { 'glm-5.2': 'GLM-5.2', 'kimi-k2.6': 'Kimi-K2.6', 'doubao-1.8': 'Doubao-1.8' }), JSON.stringify(both.nameSync?.names))

    // ⑥ a rename that never landed must leave the memory BEHIND, so the next boot
    // retries instead of believing a name that was rolled back.
    resetEntry({ displayName: 'Trae', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'glm-5.2' }] })
    const beforeFail = readFileSync(patchPath, 'utf8')
    state.breakNextWrite = true
    const failedRename = await syncProviderEntry({ ...withNames, lastNames: {} })
    state.breakNextWrite = false
    check('a rename whose write is lost is rolled back', failedRename.kind === 'rolled-back', failedRename.kind)
    check('...the patch is back byte-for-byte', readFileSync(patchPath, 'utf8') === beforeFail)
    check('...and the outcome carries NO name memory at all', !('nameSync' in failedRename), 'nameSync' in failedRename ? JSON.stringify(failedRename.nameSync) : '(absent)')
    resetEntry({ displayName: 'Trae', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'glm-5.2' }] })
    const retry = await syncProviderEntry({ ...withNames, lastNames: {} })
    check('...so the next boot retries the very same rename (memory was never polluted)', retry.nameSync?.renamed.length === 1 && rowName(0) === 'GLM-5.2', JSON.stringify(retry.nameSync?.renamed))

    // ⑦ the switch: off means today's behaviour, and an omitted switch is off too
    // (the CALLER opts in from config; this module never assumes).
    resetEntry({ displayName: 'Trae', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'glm-5.2' }] })
    const calls6 = state.mutateCalls
    const text6 = readFileSync(patchPath, 'utf8')
    const switchedOff = await syncProviderEntry({ ...withNames, syncNamesOnBoot: false, lastNames: {} })
    check('syncNamesOnBoot:false ⇒ the entry is untouched, as before this feature', switchedOff.kind === 'present' && state.mutateCalls === calls6 && readFileSync(patchPath, 'utf8') === text6 && rowName(0) === 'glm-5.2', switchedOff.kind)
    check('...the outcome says the sync was off and hands back no memory', switchedOff.nameSync?.state === 'off' && switchedOff.nameSync.names === undefined, JSON.stringify(switchedOff.nameSync))
    const omitted = await syncProviderEntry({ ...base, lastNames: {} })
    check('...and an omitted switch is the module default (off), so the caller has to opt in', omitted.nameSync?.state === 'off' && rowName(0) === 'glm-5.2' && state.mutateCalls === calls6, JSON.stringify(omitted.nameSync))

    // ⑧ the memory is a union with value updates, never a replacement
    check('mergeNames updates a value and keeps every other key', JSON.stringify(mergeNames({ a: 'A', b: 'B' }, { a: 'A2' })) === '{"a":"A2","b":"B"}', JSON.stringify(mergeNames({ a: 'A', b: 'B' }, { a: 'A2' })))
    check('...never drops a key the entry no longer holds (append-only)', JSON.stringify(mergeNames({ a: 'A' }, {})) === '{"a":"A"}' && JSON.stringify(mergeNames(undefined, { x: 'X' })) === '{"x":"X"}')
    check('...and never records an empty name as ours', JSON.stringify(mergeNames({ a: 'A' }, { b: '' })) === '{"a":"A"}')
    // The entry holds glm-5.2 only; the memory also remembers kimi-k2.6, which the
    // user deleted. A row that left the entry must not lose its record.
    resetEntry({ displayName: 'Trae', apiKeyEnv: TRAE_API_KEY_REF, headers: { Authorization: `Bearer ${TOKEN_B}` }, models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] })
    const stale = await syncProviderEntry({ ...withNames, lastNames: { 'glm-5.2': 'GLM-5.2', 'kimi-k2.6': 'Kimi-K2.6' } })
    check('...a remembered id that left the entry keeps its record', stale.kind === 'present' && stale.nameSync?.names?.['kimi-k2.6'] === 'Kimi-K2.6', JSON.stringify(stale.nameSync?.names))
    check(
      'decideRowName: the three branches are exhaustive and named',
      JSON.stringify(decideRowName({ id: 'a', current: 'a', wanted: 'A' })) === '{"action":"rename","from":"a","to":"A"}' &&
        JSON.stringify(decideRowName({ id: 'a', current: 'Old', previous: 'Old', wanted: 'New' })) === '{"action":"rename","from":"Old","to":"New"}' &&
        JSON.stringify(decideRowName({ id: 'a', current: 'Mine', wanted: 'New' })) === '{"action":"user","name":"Mine"}' &&
        JSON.stringify(decideRowName({ id: 'a', current: 'New', wanted: 'New' })) === '{"action":"keep","reason":"same"}' &&
        JSON.stringify(decideRowName({ id: 'a', wanted: 'New' })) === '{"action":"user"}' &&
        JSON.stringify(decideRowName({ id: 'internal', current: 'internal' })) === '{"action":"keep","reason":"unknown-id"}'
    )
    const plan = planNameSync({ rows: [{ id: 'a', name: 'a' }, { id: 'internal' }], wanted: new Map([['a', 'A']]), previous: {} })
    check('planNameSync: an id the profile does not describe is neither renamed nor claimed nor reported', plan.renames.size === 1 && plan.skippedUserNames.length === 0 && JSON.stringify(plan.claimed) === '{"a":"A"}', JSON.stringify(plan))
  }
} catch (error) {
  failures += 1
  console.log(`  FAIL  suite threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
}

// ---------------------------------------------------------------- summary
console.log(`\n${failures === 0 ? 'CREDENTIALS OK' : `${failures} FAILURE(S)`}`)
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`(临时 home 保留在 ${home}，供排查)`)
process.exit(failures === 0 ? 0 : 1)

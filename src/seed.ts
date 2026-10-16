/**
 * Seeding the editable provider entry — the capability this whole plugin exists
 * for, and the same shape wb2api 0.4.0 writes for `workbuddy`.
 *
 * The entry lands in the LLM namespace whose root schema is a dict of providers
 * (`llm-pi-ai`), because the Models page renders an editor only for that
 * namespace: its `layoutOf(ns)` knows `llm-pi-ai` and `llm-deepseek` and treats
 * everything else as "unknown" with the save button disabled
 * (dsh-client-ui-settings-models/lib/client.js:1493-1497, :1813-1816, :1828).
 *
 * What we write carries no secret of Trae's: the baseURL is our own loopback
 * shim and the Authorization header holds the shim's own token.
 *
 * Modes:
 *   create   — no such provider yet: write the full entry
 *   present  — the provider exists: do nothing (a user's pruning is theirs)
 *   refresh  — the user asked to re-read the directory: ADD new models only,
 *              never resurrect a model they deleted, and report the diff
 */
import type { TraeModel } from './catalog.ts'
import { resolvePatchPath, rollbackPatch, snapshotPatch, verifyPatch } from './guard.ts'

/** The subset of the settings service this module uses (typed structurally: host types live inside app.asar). */
export interface SettingsDescriptorLike {
  ns: string
  revision?: number
  schema?: unknown
  base?: unknown
  user?: unknown
  value?: unknown
}

export interface SettingsServiceLike {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptorLike[]
  mutate(ns: string, ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[], revision?: number): Promise<unknown>
}

export interface ProviderNamespace {
  ns: string
  revision?: number
  providers: Record<string, unknown>
  candidates: string[]
}

/**
 * Unwrap schemastery's REFERENCE-TABLE serialisation.
 *
 * `settings.describe()` hands out `schema` not as inline JSON but as
 * schemastery's `toJSON()` form, where nodes point at each other by numeric id:
 *
 *   { "uid": 30940,
 *     "refs": { "30797": { "type": "number" },
 *               "30940": { "type": "object", "dict": { "providers": 30798 } } } }
 *
 * So "is root-level `providers` a dict?" can only be answered AFTER dereferencing
 * — and getting this wrong is silent: the plugin simply reports "no namespace"
 * and never writes anything. This exact bug cost this workspace a shipped
 * release whose headline feature had never worked once (see the same-named
 * helper in `_wb2api-src/src/provider-config.ts`, which documents the incident).
 */
function deref(refs: Record<string, unknown>, node: unknown): Record<string, unknown> | undefined {
  let current: unknown = node
  for (let hop = 0; hop < 32; hop += 1) {
    if (typeof current === 'number') {
      current = refs[String(current)]
      continue
    }
    if (typeof current === 'string' && /^\d+$/.test(current)) {
      current = refs[current]
      continue
    }
    break
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : undefined
}

function dictField(node: Record<string, unknown> | undefined, key: string): unknown {
  const dict = node?.['dict']
  if (typeof dict !== 'object' || dict === null) return undefined
  return (dict as Record<string, unknown>)[key]
}

interface ProvidersShape {
  form: 'none' | 'inline' | 'refs'
  rootType?: string
  providersType?: string
  rootKeys: string[]
  dictKeys: string[]
}

/** Normalise one `descriptor.schema` into the shape facts we judge on. */
export function readProvidersShape(schema: unknown): ProvidersShape {
  if (typeof schema !== 'object' || schema === null) return { form: 'none', rootKeys: [], dictKeys: [] }
  const node = schema as Record<string, unknown>
  const refsRaw = node['refs']
  const isRefTable =
    typeof refsRaw === 'object' && refsRaw !== null && (typeof node['uid'] === 'number' || (typeof node['uid'] === 'string' && /^\d+$/.test(node['uid'])))
  const table = isRefTable ? (refsRaw as Record<string, unknown>) : {}
  const root = isRefTable ? deref(table, node['uid']) : node
  const providersNode = deref(table, dictField(root, 'providers'))
  const dict = root?.['dict']
  return {
    form: isRefTable ? 'refs' : 'inline',
    ...(typeof root?.['type'] === 'string' ? { rootType: root['type'] as string } : {}),
    ...(typeof providersNode?.['type'] === 'string' ? { providersType: providersNode['type'] as string } : {}),
    rootKeys: root === undefined ? [] : Object.keys(root),
    dictKeys: typeof dict === 'object' && dict !== null ? Object.keys(dict) : []
  }
}

/** Is this the "root `providers` is a dict" form a provider entry can live in? */
export function isProvidersForm(schema: unknown): boolean {
  const shape = readProvidersShape(schema)
  return shape.form !== 'none' && shape.rootType === 'object' && shape.providersType === 'dict'
}

/** One line per descriptor, for the "no namespace matched" diagnosis. */
function describeNamespaces(descriptors: readonly SettingsDescriptorLike[]): string {
  if (descriptors.length === 0) return 'settings.describe() 返回了 0 个条目'
  return descriptors
    .map((descriptor) => {
      const shape = readProvidersShape(descriptor.schema)
      return `${descriptor.ns}[${shape.form} root=${shape.rootType ?? '?'} dict={${shape.dictKeys.join(',')}} providers=${shape.providersType ?? 'none'}]`
    })
    .join(' · ')
}

function providersDict(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const providers = (value as Record<string, unknown>)['providers']
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return {}
  return providers as Record<string, unknown>
}

/**
 * Find the namespace a provider entry belongs in.
 *
 * Selection prefers `llm-pi-ai` explicitly, then sorts the rest, so a profile
 * with several provider-shaped namespaces still resolves deterministically.
 */
export function findProviderNamespace(settings: SettingsServiceLike | undefined, preferred = 'llm-pi-ai'): ProviderNamespace | undefined {
  if (settings?.describe === undefined) return undefined
  let descriptors: SettingsDescriptorLike[]
  try {
    descriptors = settings.describe({ redactSecrets: true }) ?? []
  } catch {
    return undefined
  }
  const matched = descriptors.filter((descriptor) => isProvidersForm(descriptor.schema))
  if (matched.length === 0) return undefined
  const candidates = matched.map((descriptor) => descriptor.ns).sort()
  const chosen = matched.find((descriptor) => descriptor.ns === preferred) ?? matched.slice().sort((l, r) => l.ns.localeCompare(r.ns))[0]
  if (chosen === undefined) return undefined
  return {
    ns: chosen.ns,
    revision: chosen.revision,
    providers: { ...providersDict(chosen.base), ...providersDict(chosen.user), ...providersDict(chosen.value) },
    candidates
  }
}

/** Every namespace we could see, for the failure message. */
export function probeNamespaces(settings: SettingsServiceLike | undefined): string {
  if (settings?.describe === undefined) return 'settings 服务没有 describe()'
  try {
    return describeNamespaces(settings.describe({ redactSecrets: true }) ?? [])
  } catch (error) {
    return `settings.describe() 抛出：${error instanceof Error ? error.message : String(error)}`
  }
}

export function providerExists(namespace: ProviderNamespace, name: string): boolean {
  return Object.hasOwn(namespace.providers, name) && namespace.providers[name] !== undefined
}

/**
 * One `models` entry, in the shape `dsh-llm-pi-ai`'s own profile schema accepts.
 *
 * `reasoningEfforts` is that schema's declared-effort dict, NOT pi-ai's
 * materialised `thinkingLevelMap`: the host turns the former into the latter,
 * pinning every undeclared level to `null` so a profile author never has to know
 * pi-ai's asymmetric defaulting
 * (dsh-llm-pi-ai/lib/index.js:567-590, schema at :1001-1014, documented in its
 * README.md:101-103). Keys are restricted to pi-ai's thinking levels and values
 * are the wire spellings dispatch sends.
 *
 * `off: null` is load-bearing. It is the one level allowed an empty value, and a
 * declared-but-empty `off` is the only spelling that keeps the level selectable
 * while sending no `reasoning_effort` at all — which is what "not thinking"
 * means on this wire. Omit it and `map.off` becomes `null`, i.e. "unsupported",
 * and a reasoning model can never be switched off.
 *
 * `compat.supportsReasoningEffort` is what makes pi-ai's OpenAI-compatible
 * implementation read the map: without it the `reasoning_effort` branch is
 * skipped entirely
 * (@earendil-works/pi-ai/dist/api/openai-completions.js:712-716). The host gates
 * this field as "offer" for `openai-completions`
 * (dsh-llm-pi-ai/lib/index.js:382, :966), so writing it here is accepted.
 */
export interface ProviderProfileModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: readonly string[]
  reasoningEfforts?: { off: null; low?: string; high?: string; xhigh?: string }
  compat?: { supportsReasoningEffort: true }
}

export interface ProviderProfile {
  displayName?: string
  api: 'openai-completions'
  baseURL: string
  headers: Record<string, string>
  /**
   * The credential reference pi-ai resolves for this route — present ONLY when
   * the caller has already proven the value is in the harness credential store
   * (see {@link TRAE_API_KEY_REF} and `src/auth.ts`'s `ensureCredentialRef`).
   */
  apiKeyEnv?: string
  models: ProviderProfileModel[]
}

/**
 * The credential reference our seeded entry names — the ONE spelling this
 * plugin writes anywhere.
 *
 * It is not a free choice: the Models page derives exactly this name for a route
 * id when the user types a key into the form
 * (``${provider.toUpperCase().replace(/[^A-Z0-9]+/g,'_')}_API_KEY`` →
 * `TRAE_API_KEY`, `dsh-client-ui-settings-models/lib/client.js:938-940`), so
 * writing the same name means the plugin and the page can never disagree about
 * where this route's key lives. A constant, not a literal at each site, because
 * a second spelling would be a second empty slot — green in one place, red in
 * the other.
 *
 * ## Why the entry names it at all, and why only AFTER the store holds it
 *
 * The green dot beside a provider name means "this route's credential is
 * configured" (`client.js:2158`), and the RED dot means "named but missing"
 * (`:2159`) — which is not cosmetic: pi-ai then fails every request with
 * `MISSING_CREDENTIAL` (`dsh-llm-pi-ai/lib/index.js:2564-2569`), so a name
 * written before the value exists turns the route off. The value we store is the
 * SHIM's own token, byte-identical to the `headers.Authorization` bearer below,
 * so the two authentication paths pi-ai can take (its `apiKey` and the profile's
 * header) carry the same bytes and either one authenticates.
 */
export const TRAE_API_KEY_REF = 'TRAE_API_KEY'

/**
 * Build the provider profile.
 *
 * `apiKeyEnv` is passed in by the caller and NOT defaulted here, because naming a
 * credential this process has not verified would be exactly the red-dot accident
 * {@link TRAE_API_KEY_REF} documents. The `headers.Authorization` bearer stays
 * mandatory either way: it is what authenticates the route when the credential
 * store is unavailable, which is why this entry has always worked without one.
 *
 * ## Why internal components are NOT written by default
 *
 * The Trae directory answers with every callable `config_name`, and most of them
 * are not conversation models: `title_generation`, `fast_apply`,
 * `input_optimization`, the `custom_model_*` placeholders, the `*_advisor` /
 * `search_agent_*` routing aliases. The criterion and its measured evidence live
 * in `src/catalog.ts` (see `classifyDirectoryEntry`); this function only obeys its
 * verdict.
 *
 * The rule is stated strictly as `kind === 'chat'` rather than
 * `kind !== 'internal'`: a `TraeModel` that never went through `parseModel` has no
 * verdict at all, and "not judged" must not be written into a user's configuration
 * as if it had been judged safe. The filter is ONE line and it lives HERE — not in
 * the callers — so no composition can accidentally write the junk list.
 *
 * `includeInternal: true` writes them anyway: that is the escape hatch for a user
 * whose Trae account really does route through one of these slots, and it is what
 * makes this a default rather than a prohibition.
 */
export function buildProviderProfile(options: {
  displayName: string
  baseUrl: string
  token: string
  models: readonly TraeModel[]
  /** Write the internal components too. Default FALSE — see the note above. */
  includeInternal?: boolean
  /**
   * The verified credential reference to name, or `undefined` to leave the entry
   * header-authenticated only. Never a default — see {@link TRAE_API_KEY_REF}.
   */
  apiKeyEnv?: string
}): ProviderProfile {
  const seen = new Set<string>()
  const models: ProviderProfileModel[] = []
  for (const model of options.models) {
    if (model.id === '' || seen.has(model.id)) continue
    if (model.kind !== 'chat' && options.includeInternal !== true) continue
    seen.add(model.id)
    // A model the directory described no recoverable effort list for gets no
    // reasoning field at all: the host then keeps whatever the installed catalog
    // says about it, which is strictly better than declaring it non-reasoning.
    const efforts = model.reasoningEfforts
    models.push({
      id: model.id,
      ...(model.name === undefined || model.name === '' ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      // Stays `['text']`: catalog.ts knows which models Trae calls multimodal
      // (`TraeModel.multimodal`) but this row is the promise the user sees, and
      // src/protocol.ts translates no image content part yet. Adding 'image'
      // here before that work lands would let someone attach a picture that
      // silently never reaches the model.
      input: [...model.input],
      ...(efforts === undefined
        ? {}
        : { reasoningEfforts: { off: null as null, ...efforts }, compat: { supportsReasoningEffort: true as const } })
    })
  }
  const apiKeyEnv = options.apiKeyEnv
  return {
    displayName: options.displayName,
    api: 'openai-completions',
    baseURL: `${options.baseUrl.replace(/\/$/, '')}/v1`,
    headers: { Authorization: `Bearer ${options.token}` },
    ...(typeof apiKeyEnv === 'string' && apiKeyEnv !== '' ? { apiKeyEnv } : {}),
    models
  }
}

/**
 * What a seed attempt did — and, on every outcome that could have written,
 * WHICH internal components were deliberately left out.
 *
 * `skippedInternal` is not decoration. Hiding a row from a user's configuration
 * is a decision made on their behalf, and a decision nobody can see is
 * indistinguishable from a bug: this list is what `boot.log`, the settings card
 * and `SeedOutcome` all read, so "47 models, 32 hidden" is always explainable
 * down to the id.
 *
 * ## What the kinds mean once a boot can also RECONCILE (added 2026-10-16)
 *
 *   created  — there was no entry: the full profile was written
 *   present  — there is an entry and this boot changed NOTHING: no rotation, no
 *              new models, no `apiKeyEnv` to add. `tokenState` / `apiKeyEnvState`
 *              say why nothing was needed
 *   rotated  — there is an entry, and the only reason it was rewritten is that
 *              the shim token it carries is no longer the current one (the token
 *              file was deleted, or a new region/account minted a new token), or
 *              that the verified `apiKeyEnv` had to be added. Model rows are
 *              untouched
 *   rebuilt  — the entry gained genuinely new model ids ("only add": never a
 *              resurrection, never a delete). `rotated`/`apiKeyEnv` are carried
 *              along when the same write also had to fix the token or add the
 *              credential reference
 *   the rest — refusals, as before
 */
export type SeedTokenState = 'same' | 'rotated' | 'missing'
export type SeedApiKeyEnvState = 'present' | 'written' | 'skipped'

export type SeedOutcome =
  | { kind: 'created'; ns: string; modelCount: number; backupPath: string; offeredModels: string[]; skippedInternal: string[]; nameSync?: SeedNameReport }
  | {
      kind: 'present'
      ns: string
      modelCount?: number
      offeredModels: string[]
      skippedInternal: string[]
      /** Why nothing had to be written — recorded so "no write" is explainable. */
      tokenState?: SeedTokenState
      apiKeyEnvState?: SeedApiKeyEnvState
      nameSync?: SeedNameReport
    }
  | {
      kind: 'rotated'
      ns: string
      tokenState: SeedTokenState
      apiKeyEnvState: SeedApiKeyEnvState
      keptModels: number
      backupPath: string
      offeredModels: string[]
      skippedInternal: string[]
      nameSync?: SeedNameReport
    }
  | { kind: 'rebuilt'; ns: string; addedModels: string[]; keptModels: number; backupPath: string; offeredModels: string[]; skippedInternal: string[]; tokenState?: SeedTokenState; apiKeyEnvState?: SeedApiKeyEnvState; nameSync?: SeedNameReport }
  | { kind: 'no-namespace'; detail: string }
  | { kind: 'no-guard'; detail: string }
  | { kind: 'rolled-back'; ns: string; reasons: string[]; backupPath: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'no-namespace'; detail: string }
  | { kind: 'no-guard'; detail: string }
  | { kind: 'rolled-back'; ns: string; reasons: string[]; backupPath: string }
  | { kind: 'failed'; detail: string }

export interface SeedOptions {
  settings: SettingsServiceLike | undefined
  pluginName: string
  providerName: string
  profile: ProviderProfile
  /** `refresh` re-reads the directory and adds models the entry lacks. */
  mode?: 'auto' | 'refresh'
  /**
   * Model ids this plugin offered LAST time (kept in our own settings namespace).
   *
   * This is what makes "only add" mean what it says. Without it, a refresh sees
   * the live directory, notices a model the entry lacks, and re-adds the very
   * model the user just deleted. With it: a model that was offered before and is
   * gone now is the user's decision, and only genuinely NEW ids are added.
   */
  previouslyOffered?: readonly string[]
  /**
   * The ids this seed deliberately did NOT write, i.e. the internal components
   * `buildProviderProfile` filtered out. Reported back verbatim so the caller can
   * put them in `boot.log` and on the card instead of leaving the omission
   * unrecorded. Defaults to `[]` so a caller that does not classify still works.
   */
  skippedInternal?: readonly string[]
}

/** Write the provider entry, or report why we did not. Never writes without a guard. */
export async function seedProvider(options: SeedOptions): Promise<SeedOutcome> {
  const { settings } = options
  if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
    return { kind: 'no-namespace', detail: 'settings 服务不可用（describe/mutate 缺失）' }
  }
  const namespace = findProviderNamespace(settings)
  if (namespace === undefined) {
    return { kind: 'no-namespace', detail: `没有任何「根级 providers 是 dict」的命名空间。看到的条目：${probeNamespaces(settings)}` }
  }
  // Deduplicated so a caller that hands over the same id twice (two functions listing
  // one entry, a hand-built list) cannot make the report say "2 hidden" for 1 model.
  const skippedInternal = [...new Set(options.skippedInternal ?? [])]
  const exists = providerExists(namespace, options.providerName)
  const current = namespace.providers[options.providerName] as { models?: { id?: unknown }[] } | undefined
  const currentIds = Array.isArray(current?.models) ? current.models.map((model) => model?.id).filter((id): id is string => typeof id === 'string') : []
  if (exists && options.mode !== 'refresh') {
    return { kind: 'present', ns: namespace.ns, modelCount: currentIds.length, offeredModels: currentIds, skippedInternal }
  }
  const patchPath = resolvePatchPath(options.pluginName)
  if (patchPath === undefined) {
    return { kind: 'no-guard', detail: `找不到本 profile 的 cordis.patch.yml（plugin=${options.pluginName}），已放弃写入 —— 没有退路就不改用户配置` }
  }
  const target = { ...options.profile }
  if (exists && options.mode === 'refresh') {
    const keptIds = new Set(currentIds)
    const offered = new Set(options.previouslyOffered ?? [])
    const added = target.models.filter((model) => !keptIds.has(model.id) && !offered.has(model.id))
    if (added.length === 0) {
      return { kind: 'rebuilt', ns: namespace.ns, addedModels: [], keptModels: currentIds.length, backupPath: '(no write)', offeredModels: [...new Set([...currentIds, ...target.models.map((m) => m.id)])], skippedInternal }
    }
    target.models = [...currentIds.map((id) => target.models.find((model) => model.id === id) ?? { id }), ...added]
    const snapshot = snapshotPatch(patchPath)
    try {
      await settings.mutate(namespace.ns, [{ op: 'set', path: ['providers', options.providerName], value: target }], namespace.revision)
    } catch (error) {
      rollbackPatch(snapshot)
      return { kind: 'failed', detail: `写入抛出：${error instanceof Error ? error.message : String(error)}（已回滚）` }
    }
    // The expectation is handed to the guard, not checked here: rule ③ ("the
    // provider really is in the dict") and rule ④ ("and it has the models we wrote")
    // are the two that catch a write which RETURNED SUCCESS without landing, and
    // they only work if the caller states what it meant to write.
    const verdict = verifyPatch(snapshot, { provider: options.providerName, expectedModelCount: target.models.length })
    if (!verdict.ok) {
      rollbackPatch(snapshot)
      return { kind: 'rolled-back', ns: namespace.ns, reasons: verdict.reasons, backupPath: snapshot.backupPath }
    }
    return {
      kind: 'rebuilt',
      ns: namespace.ns,
      addedModels: added.map((model) => model.id),
      keptModels: currentIds.length,
      backupPath: snapshot.backupPath,
      offeredModels: [...new Set([...currentIds, ...target.models.map((model) => model.id)])],
      skippedInternal,
      // Only the rows THIS write created carry a name of ours. An existing row was
      // not touched, so nothing about its name is claimed here (the boot
      // reconciliation owns that judgement — see `planNameSync`).
      nameSync: { state: 'written', renamed: [], skippedUserNames: [], names: namesOfModels(added) }
    }
  }

  const snapshot = snapshotPatch(patchPath)
  try {
    await settings.mutate(namespace.ns, [{ op: 'set', path: ['providers', options.providerName], value: target }], namespace.revision)
  } catch (error) {
    rollbackPatch(snapshot)
    return { kind: 'failed', detail: `写入抛出：${error instanceof Error ? error.message : String(error)}（已回滚）` }
  }
  const verdict = verifyPatch(snapshot, { provider: options.providerName, expectedModelCount: target.models.length })
  if (!verdict.ok) {
    rollbackPatch(snapshot)
    return { kind: 'rolled-back', ns: namespace.ns, reasons: verdict.reasons, backupPath: snapshot.backupPath }
  }
  return {
    kind: 'created',
    ns: namespace.ns,
    modelCount: target.models.length,
    backupPath: snapshot.backupPath,
    offeredModels: target.models.map((model) => model.id),
    skippedInternal,
    // The whole entry is ours, so every name in it is ours to remember.
    nameSync: { state: 'written', renamed: [], skippedUserNames: [], names: namesOfModels(target.models) }
  }
}

/**
 * Read the model ids the user's provider entry currently declares.
 *
 * Read-only, and the ONLY way the plugin can tell "what is in the entry" apart
 * from "what the live directory says" — the two differ exactly in the case this
 * matters: an entry written by an earlier version still carries the internal
 * components this version refuses to write, and nothing would ever remove them
 * without a read like this one.
 */
export function currentProviderModelIds(settings: SettingsServiceLike | undefined, providerName: string): string[] {
  const namespace = findProviderNamespace(settings)
  if (namespace === undefined) return []
  const entry = namespace.providers[providerName] as { models?: { id?: unknown }[] } | undefined
  if (!Array.isArray(entry?.models)) return []
  return entry.models.map((model) => model?.id).filter((id): id is string => typeof id === 'string')
}

/**
 * The tombstone set, made APPEND-ONLY where it is remembered.
 *
 * `lastOffered` is the plugin's memory of every model id it has ever put in the
 * user's entry, and its whole job is to make "the user deleted it" permanent. A
 * set that is REPLACED by "what the entry holds now" cannot do that: the boot
 * after a deletion still sees the id (it was remembered last time), but by the
 * end of that boot the memory has been overwritten with the entry's remaining
 * ids — so the id comes back on the boot AFTER that. With a boot-time refresh
 * enabled, that means a model the user deleted returns by itself two restarts
 * later, which is exactly what this set exists to prevent.
 *
 * Union, never replacement. Grown only by what was really offered (ids actually
 * written into the entry at some point), so an id the directory mentioned but the
 * classifier filtered out is never tombstoned — that would block a model from
 * ever being added if Trae later re-classified it as a conversation model.
 */
export function mergeOffered(previous: readonly string[] | undefined, offered: readonly string[]): string[] {
  return [...new Set([...(previous ?? []), ...offered])]
}

/** One model row whose display name this plugin owns, and is about to change. */
export interface SeedNameChange {
  id: string
  /** The name the row carried before. Absent only when the row had no `name` field. */
  from?: string
  to: string
}

/**
 * What a boot reconciliation did to the display NAMES of the entry's rows.
 *
 * ## Why names need the same tombstone discipline as model ids
 *
 * The rows this plugin writes carry a computed display name, and that computation
 * improves (`uniquifyDisplayNames` exists because 47 rows offered 47 names that
 * collided). But a name is also the one field a user is most likely to hand-edit,
 * and user configuration is theirs. So the two questions must be answered from
 * MEMORY, not from the row alone:
 *
 *   · a name equal to what we wrote LAST time is ours → we may improve it;
 *   · a name we have no record of, and that is not the row's own id, is the
 *     user's → never touched (this is what `lastNames` exists for);
 *   · a name equal to the row's id is not a name at all — it is what an entry
 *     written before this feature looks like, and it is what we are here to fix.
 */
export interface SeedNameReport {
  /** `off` = the config switch is off; `same` = nothing needed changing; `written` = rows were rewritten. */
  state: 'off' | 'same' | 'written'
  /** Rows this plugin renamed, in entry order. */
  renamed: SeedNameChange[]
  /** Rows that LOOK hand-edited. Reported so `boot.log` can say why nothing happened to them. */
  skippedUserNames: { id: string; name?: string }[]
  /**
   * id → name this plugin is entitled to remember as OURS (`lastNames`, append-only).
   *
   * Present ONLY on an outcome whose write really landed. A refusal, a throw or a
   * rollback must leave the memory exactly as it was: recording a name that never
   * reached the file would make the next boot treat the row as already renamed and
   * the improvement would be lost for good. "Rather retry than lie."
   */
  names?: Record<string, string>
}

/** What {@link decideRowName} decided about one row. */
export type RowNameDecision =
  | { action: 'keep'; reason: 'same' | 'unknown-id' }
  | { action: 'rename'; from?: string; to: string }
  | { action: 'user'; name?: string }

/**
 * Decide whether ONE row's display name may be replaced.
 *
 * Pure, and the only place this judgement is made (the mutation harness in the
 * suite targets exactly these three branches). `previous` is what we remember
 * having written; `wanted` is what the current computation produces; `current` is
 * what the row says right now.
 */
export function decideRowName(options: { id: string; current?: string; previous?: string; wanted?: string }): RowNameDecision {
  const { id, current, previous, wanted } = options
  // An id the profile does not describe (an internal component, or a row whose
  // model the directory no longer lists) gets no name from us. Not our call.
  if (wanted === undefined || wanted === '') return { action: 'keep', reason: 'unknown-id' }
  // Already exactly right ⇒ nothing to write. (The caller still CLAIMS it — see
  // planNameSync — so a later, better computation can still reach this row.)
  if (current === wanted) return { action: 'keep', reason: 'same' }
  // The row still carries the last name we wrote: ours to improve.
  if (previous !== undefined && current === previous) return { action: 'rename', ...(current === undefined ? {} : { from: current }), to: wanted }
  // No record, and the name is the row's own id: that is not a name the user chose,
  // it is what this plugin wrote before it computed display names at all.
  if (previous === undefined && current === id) return { action: 'rename', from: id, to: wanted }
  // Everything else: a name we have no record of writing. It is the user's.
  return { action: 'user', ...(current === undefined ? {} : { name: current }) }
}

export interface SeedNamePlan {
  /** id → the name the row must carry. Only ids we are allowed to touch. */
  renames: Map<string, string>
  changes: SeedNameChange[]
  skippedUserNames: { id: string; name?: string }[]
  /** id → name this plugin may remember as ours (what it wrote, or already owns). */
  claimed: Record<string, string>
}

/**
 * Plan the name reconciliation for every row of an entry.
 *
 * One pass, no writes, no side effects — the caller decides whether the plan is
 * worth a write. `claimed` deliberately includes rows that were ALREADY equal to
 * the computed name: claiming costs nothing (the caller's merge is idempotent) and
 * is the only way a row named by an older version can later receive an improved
 * name. Unclaimed, "already right" is indistinguishable from "the user typed this"
 * on the next boot, and the row would be frozen forever.
 */
export function planNameSync(options: {
  rows: readonly unknown[]
  wanted: ReadonlyMap<string, string>
  previous: Readonly<Record<string, string>> | undefined
}): SeedNamePlan {
  const renames = new Map<string, string>()
  const changes: SeedNameChange[] = []
  const skippedUserNames: { id: string; name?: string }[] = []
  const claimed: Record<string, string> = {}
  const previous = options.previous ?? {}
  for (const row of options.rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const id = record['id']
    if (typeof id !== 'string' || id === '') continue
    const wanted = options.wanted.get(id)
    const current = typeof record['name'] === 'string' ? (record['name'] as string) : undefined
    const remembered = previous[id]
    const decision = decideRowName({
      id,
      ...(current === undefined ? {} : { current }),
      ...(typeof remembered === 'string' ? { previous: remembered } : {}),
      ...(wanted === undefined ? {} : { wanted })
    })
    if (decision.action === 'keep') {
      if (decision.reason === 'same' && wanted !== undefined) claimed[id] = wanted
      continue
    }
    if (decision.action === 'rename') {
      renames.set(id, decision.to)
      claimed[id] = decision.to
      changes.push({ id, ...(decision.from === undefined ? {} : { from: decision.from }), to: decision.to })
      continue
    }
    skippedUserNames.push({ id, ...(decision.name === undefined ? {} : { name: decision.name }) })
  }
  return { renames, changes, skippedUserNames, claimed }
}

/**
 * The name memory, made APPEND-ONLY — `lastNames`, the exact counterpart of
 * {@link mergeOffered}.
 *
 * Keys are never dropped (a row the user deleted must not lose the record of what
 * we wrote there, or re-adding it later would look like a fresh user edit), while
 * VALUES do get updated: a name we rewrote is a name we now own under its new
 * spelling.
 */
export function mergeNames(
  previous: Readonly<Record<string, string>> | undefined,
  written: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const merged: Record<string, string> = { ...(previous ?? {}) }
  for (const [id, name] of Object.entries(written ?? {})) if (id !== '' && name !== '') merged[id] = name
  return merged
}

/** `name` fields of a model list, restricted to rows that actually have one. */
export function namesOfModels(models: readonly { id: string; name?: string }[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const model of models) if (typeof model.name === 'string' && model.name !== '') names[model.id] = model.name
  return names
}

/** A `Bearer <token>` header, or `undefined` when there is not one to compare. */
export function bearerTokenOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const headers = (entry as Record<string, unknown>)['headers']
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return undefined
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() !== 'authorization') continue
    if (typeof value !== 'string') return undefined
    const match = /^Bearer[ \t]+(.+)$/i.exec(value.trim())
    return match === null ? undefined : (match[1] ?? '').trim()
  }
  return undefined
}

/** What a boot reconciliation did to an entry that already exists. */
export type SyncTokenState = SeedTokenState
export type SyncApiKeyEnvState = SeedApiKeyEnvState

export interface SyncOptions {
  settings: SettingsServiceLike | undefined
  pluginName: string
  providerName: string
  /**
   * The profile built from the CURRENT token. Its `apiKeyEnv` is included only
   * when the caller has already verified that the value is in the credential
   * store (`ensureCredentialRef`), so this module never has to guess.
   */
  profile: ProviderProfile
  /** The shim token this process will authenticate with right now. */
  token: string
  /**
   * Whether genuinely new directory ids may be appended. Default FALSE: the
   * caller decides from config, and a caller that says nothing gets the
   * conservative "touch nothing" behaviour.
   */
  refreshOnBoot?: boolean
  /** Every id this plugin has ever offered (the tombstone set). */
  previouslyOffered?: readonly string[]
  /**
   * Whether this boot may replace a display name it owns. Default FALSE: the
   * caller decides from config, and a caller that says nothing gets the
   * conservative "touch nothing" behaviour — the same contract as
   * `refreshOnBoot`.
   */
  syncNamesOnBoot?: boolean
  /**
   * `lastNames` — the names this plugin wrote last time, so "ours" can be told
   * apart from "the user's". See {@link SeedNameReport}.
   */
  lastNames?: Readonly<Record<string, string>>
  skippedInternal?: readonly string[]
}

/**
 * Reconcile the EXISTING entry with the present: the token this process really
 * uses, the credential reference that may now be provable, the models the live
 * directory now offers, and the display names we are allowed to improve.
 *
 * ## Why this exists beside `seedProvider`
 *
 * `seedProvider` answers "should I write this entry from scratch?" and its
 * answer for an entry that exists is `present` — deliberately, because a user's
 * entry is theirs. That leaves four things nothing else in the plugin could fix,
 * each of which turns into a support question:
 *
 *   ① **a rotated token.** `loadOrCreateToken` mints a new shim token when the
 *      file is missing, and the entry keeps the old bearer until someone
 *      re-seeds by hand → every request 401s. The stale token is not the user's
 *      to fix: it is ours, and it is on disk.
 *   ② **the credential reference.** An entry that predates this feature names no
 *      `apiKeyEnv`, so the Models page shows no green dot; adding it is only
 *      safe AFTER the store holds the value, which the caller has verified.
 *   ③ **a new model in Trae's directory.** Without a boot reconciliation the
 *      only way to get it is the card's "rebuild the list" button.
 *   ④ **a missing or outdated display name.** An entry written before the name
 *      computation existed carries `name` equal to each row's id — a string no
 *      human chose, and the only reason the improvement would otherwise stay
 *      invisible. Gated by `syncNamesOnBoot` and protected by `lastNames`: a
 *      name we have no record of writing is the user's and is never touched.
 *
 * ## The four properties that make an existing entry safe to touch
 *
 *   · **surgical, not rebuilt.** The object written back is the CURRENT entry
 *     with `headers.Authorization` replaced, `apiKeyEnv` added, new rows
 *     APPENDED, and — exclusively on rows whose name we own — the single `name`
 *     field replaced. `displayName`, `api`, `baseURL`, every other header, every
 *     other field of a model row and the row ORDER are carried through verbatim.
 *     This is not the place to clean anything up.
 *   · **nothing new ⇒ nothing written.** With no rotation, no `apiKeyEnv` to add,
 *     no new ids and no name of ours to improve, the answer is `present` with
 *     `(no write)`: no snapshot, no `mutate`, no mtime change. A boot that touches
 *     the user's configuration on every start is a boot nobody can reason about.
 *   · **one write, never two.** Renames and appended rows travel in the SAME
 *     `mutate` call; two writes would be two half-updated windows in the user's
 *     configuration and two chances to be interrupted in between.
 *   · **the same guard as every other write.** Snapshot outside the profile,
 *     write, re-read, demand the provider really holds exactly the rows we meant
 *     to leave, and put the file back verbatim if any of that fails. And because
 *     the name memory is only handed back on a write that LANDED, a rename that
 *     failed is retried next boot instead of being remembered as done.
 */
export async function syncProviderEntry(options: SyncOptions): Promise<SeedOutcome> {
  const { settings } = options
  if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
    return { kind: 'no-namespace', detail: 'settings 服务不可用（describe/mutate 缺失）' }
  }
  const namespace = findProviderNamespace(settings)
  if (namespace === undefined) {
    return { kind: 'no-namespace', detail: `没有任何「根级 providers 是 dict」的命名空间。看到的条目：${probeNamespaces(settings)}` }
  }
  const skippedInternal = [...new Set(options.skippedInternal ?? [])]
  const entry = namespace.providers[options.providerName]
  const apiKeyEnvWanted = typeof options.profile.apiKeyEnv === 'string' && options.profile.apiKeyEnv !== '' ? options.profile.apiKeyEnv : undefined

  // No entry yet: this is a creation, and the create path is exactly the one
  // `seedProvider` already owns (guard included). Delegating keeps ONE create
  // implementation instead of two that could drift.
  if (entry === undefined) {
    return seedProvider({
      settings,
      pluginName: options.pluginName,
      providerName: options.providerName,
      profile: options.profile,
      skippedInternal
    })
  }

  const record = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined
  if (record === undefined) {
    return { kind: 'failed', detail: `providers.${options.providerName} 不是一个对象（形状看不懂就不动它）` }
  }
  const headers = record['headers']
  if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
    return { kind: 'failed', detail: `providers.${options.providerName}.headers 不是一个对象（形状看不懂就不动它）` }
  }
  const rows = Array.isArray(record['models']) ? (record['models'] as unknown[]) : []
  const keptIds = new Set(rows.map((row) => (typeof row === 'object' && row !== null && !Array.isArray(row) ? (row as Record<string, unknown>)['id'] : undefined)).filter((id): id is string => typeof id === 'string'))

  const entryToken = bearerTokenOf(record)
  const tokenState: SyncTokenState = entryToken === options.token ? 'same' : entryToken === undefined ? 'missing' : 'rotated'
  const currentApiKeyEnv = typeof record['apiKeyEnv'] === 'string' ? (record['apiKeyEnv'] as string) : undefined
  const apiKeyEnvState: SyncApiKeyEnvState = apiKeyEnvWanted === undefined ? 'skipped' : currentApiKeyEnv === apiKeyEnvWanted ? 'present' : 'written'

  // "Only add", against BOTH halves of the memory: the ids the entry already has,
  // and the tombstone set of ids this plugin has ever offered. The second half is
  // what keeps a model the user deleted deleted — it was offered once, so it is
  // not new, so it is not added back.
  const tombstone = new Set(options.previouslyOffered ?? [])
  const added = options.refreshOnBoot === true ? options.profile.models.filter((model) => !keptIds.has(model.id) && !tombstone.has(model.id)) : []
  // The tombstone set grows by exactly what the entry HOLDS or has just been
  // given — never by everything the directory offers. An id that was never
  // offered cannot have been deleted by the user, and tombstoning it would make
  // the card's "rebuild the list" button unable to ever add it.
  const offeredModels = [...new Set([...keptIds, ...added.map((model) => model.id)])]

  // ── the display-name reconciliation ────────────────────────────────────────
  //
  // Same tombstone philosophy as `offeredModels`, applied to the one field a user
  // is most likely to hand-edit: a name we have a record of writing is ours to
  // improve, a name we have no record of is theirs and is never touched. See
  // `decideRowName` for the three branches and `SeedNameReport` for why the
  // memory is only updated on a write that really landed.
  const namesWanted = new Map<string, string>()
  for (const model of options.profile.models) if (typeof model.name === 'string' && model.name !== '') namesWanted.set(model.id, model.name)
  const plan = options.syncNamesOnBoot === true
    ? planNameSync({ rows, wanted: namesWanted, previous: options.lastNames })
    : { renames: new Map<string, string>(), changes: [], skippedUserNames: [], claimed: {} }
  // A row that arrives in THIS write carries the profile's name; it is ours too.
  const claimed: Record<string, string> = { ...plan.claimed }
  for (const model of added) if (typeof model.name === 'string' && model.name !== '') claimed[model.id] = model.name
  const nameSyncState: SeedNameReport['state'] = options.syncNamesOnBoot !== true ? 'off' : plan.changes.length > 0 ? 'written' : 'same'
  const nameReport = (extra: { names?: Record<string, string> }): SeedNameReport => ({
    state: nameSyncState,
    renamed: plan.changes,
    skippedUserNames: plan.skippedUserNames,
    ...(extra.names === undefined ? {} : { names: extra.names })
  })

  if (tokenState === 'same' && apiKeyEnvState !== 'written' && added.length === 0 && plan.changes.length === 0) {
    return {
      kind: 'present',
      ns: namespace.ns,
      modelCount: rows.length,
      offeredModels,
      skippedInternal,
      tokenState,
      apiKeyEnvState,
      // Nothing was written, but the memory may still grow by rows that already
      // carry exactly the computed name — that is a claim, not a write, and it is
      // what stops such a row from being mistaken for a user edit next boot.
      ...(options.syncNamesOnBoot === true ? { nameSync: nameReport({ names: mergeNames(options.lastNames, claimed) }) } : { nameSync: nameReport({}) })
    }
  }

  const patchPath = resolvePatchPath(options.pluginName)
  if (patchPath === undefined) {
    return { kind: 'no-guard', detail: `找不到本 profile 的 cordis.patch.yml（plugin=${options.pluginName}），已放弃写入 —— 没有退路就不改用户配置` }
  }
  const target: Record<string, unknown> = { ...record }
  target['headers'] = { ...((headers ?? {}) as Record<string, unknown>), Authorization: `Bearer ${options.token}` }
  if (apiKeyEnvWanted !== undefined) target['apiKeyEnv'] = apiKeyEnvWanted
  // `name` is the ONLY field touched on an existing row — id, contextWindow,
  // maxTokens, input, reasoningEfforts, compat and the row ORDER all survive
  // verbatim, because the row object is spread and one key replaced (which keeps
  // the key's original position in the file as well).
  const renamedRows =
    plan.renames.size === 0
      ? rows
      : rows.map((row) => {
          if (typeof row !== 'object' || row === null || Array.isArray(row)) return row
          const id = (row as Record<string, unknown>)['id']
          const to = typeof id === 'string' ? plan.renames.get(id) : undefined
          return to === undefined ? row : { ...(row as Record<string, unknown>), name: to }
        })
  // ONE write carries the renames AND the appended rows: two writes would mean two
  // windows in which the file is half-updated, two backups and two chances to be
  // interrupted between them.
  const models = added.length === 0 ? renamedRows : [...renamedRows, ...added.map((model) => ({ ...model }))]
  target['models'] = models
  // Key order rewritten to the profile's own reading order, so the line this write
  // adds lands where a human looks for it (right after `baseURL`) instead of after
  // 47 model rows. Purely cosmetic for the file's reader; the guard reads lines, not
  // positions, and no field's VALUE is touched here.
  const ordered: Record<string, unknown> = {}
  for (const key of ['displayName', 'api', 'apiKeyEnv', 'baseURL', 'headers', 'models']) if (key in target) ordered[key] = target[key]
  for (const [key, value] of Object.entries(target)) if (!(key in ordered)) ordered[key] = value

  const snapshot = snapshotPatch(patchPath)
  try {
    await settings.mutate(namespace.ns, [{ op: 'set', path: ['providers', options.providerName], value: ordered }], namespace.revision)
  } catch (error) {
    rollbackPatch(snapshot)
    return { kind: 'failed', detail: `写入抛出：${error instanceof Error ? error.message : String(error)}（已回滚）` }
  }
  const verdict = verifyPatch(snapshot, { provider: options.providerName, expectedModelCount: models.length })
  if (!verdict.ok) {
    rollbackPatch(snapshot)
    return { kind: 'rolled-back', ns: namespace.ns, reasons: verdict.reasons, backupPath: snapshot.backupPath }
  }
  if (added.length === 0) {
    return {
      kind: 'rotated',
      ns: namespace.ns,
      tokenState,
      apiKeyEnvState,
      keptModels: rows.length,
      backupPath: snapshot.backupPath,
      offeredModels,
      skippedInternal,
      nameSync: nameReport({ names: mergeNames(options.lastNames, claimed) })
    }
  }
  return {
    kind: 'rebuilt',
    ns: namespace.ns,
    addedModels: added.map((model) => model.id),
    keptModels: rows.length,
    backupPath: snapshot.backupPath,
    offeredModels,
    skippedInternal,
    tokenState,
    apiKeyEnvState,
    nameSync: nameReport({ names: mergeNames(options.lastNames, claimed) })
  }
}

/**
 * What a prune did — including the ids it removed, because "which ones went" is
 * the whole audit trail for a delete the user asked for once and cannot undo
 * except from the backup.
 */
export type PruneOutcome =
  | { kind: 'pruned'; ns: string; removed: string[]; keptModels: number; backupPath: string }
  | { kind: 'nothing'; ns: string; detail: string; keptModels: number }
  | { kind: 'absent'; ns: string; detail: string }
  | { kind: 'no-namespace'; detail: string }
  | { kind: 'no-guard'; detail: string }
  | { kind: 'rolled-back'; ns: string; reasons: string[]; backupPath: string }
  | { kind: 'failed'; detail: string }

/**
 * Remove ONLY the entry rows the caller judged internal — the explicit clean-up
 * for an entry an earlier version already wrote.
 *
 * ## Why this is a separate, clickable action and not part of seeding
 *
 * The 79-row entries already on disk were written before this plugin had a
 * criterion, and they will not fix themselves: `seedProvider` reports `present`
 * and deliberately writes nothing, because a user's pruning is theirs. So the
 * junk has to be removable WITHOUT the plugin ever deciding on its own to delete
 * from user configuration — that is what this function is for, and it runs only
 * when `POST /models/prune-internal` is called, i.e. when someone clicked the
 * button.
 *
 * ## The three properties that make deleting safe
 *
 *   ① **Only ids on the caller's internal list are candidates.** Rows the user
 *      deleted are not rows at all, and rows still present that the criterion
 *      called `chat` are never touched — a model the user pruned stays pruned and
 *      a model they kept stays kept.
 *   ② **Nothing is written without the guard.** Snapshot outside the profile,
 *      write, re-read, demand the provider really holds exactly the rows we meant
 *      to leave (`verifyPatch`), and put the file back verbatim if any of that
 *      fails. This is the same sequence every other write in this plugin uses.
 *   ③ **An empty candidate list is not a write.** With nothing to remove there is
 *      no snapshot, no `mutate` and no mtime change; the answer says so.
 *
 * Everything else in the entry (`displayName`, `api`, `baseURL`, `headers`, and
 * every model row) is carried through untouched: the object written back is the
 * current one with `models` replaced, not a profile this module rebuilt.
 */
export async function pruneInternalModels(options: {
  settings: SettingsServiceLike | undefined
  pluginName: string
  providerName: string
  /** Ids the LIVE directory judged internal. Only these may be removed. */
  internalIds: readonly string[]
}): Promise<PruneOutcome> {
  const { settings } = options
  if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
    return { kind: 'no-namespace', detail: 'settings 服务不可用（describe/mutate 缺失）' }
  }
  const namespace = findProviderNamespace(settings)
  if (namespace === undefined) {
    return { kind: 'no-namespace', detail: `没有任何「根级 providers 是 dict」的命名空间。看到的条目：${probeNamespaces(settings)}` }
  }
  const current = namespace.providers[options.providerName]
  if (current === undefined) {
    return { kind: 'absent', ns: namespace.ns, detail: `providers.${options.providerName} 不存在 —— 没有可清理的条目` }
  }
  const entry = typeof current === 'object' && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
  const rows = Array.isArray(entry['models']) ? (entry['models'] as unknown[]) : []
  const wanted = new Set(options.internalIds)
  const idOf = (row: unknown): string | undefined => {
    const id = typeof row === 'object' && row !== null && !Array.isArray(row) ? (row as Record<string, unknown>)['id'] : undefined
    return typeof id === 'string' ? id : undefined
  }
  const removed = rows.map(idOf).filter((id): id is string => id !== undefined && wanted.has(id))
  if (removed.length === 0) {
    return { kind: 'nothing', ns: namespace.ns, detail: '你的条目里没有被判定为内部组件的模型（要么已经清过了，要么这份条目里本来就没有）', keptModels: rows.length }
  }
  const kept = rows.filter((row) => {
    const id = idOf(row)
    return id === undefined || !wanted.has(id)
  })
  const patchPath = resolvePatchPath(options.pluginName)
  if (patchPath === undefined) {
    return { kind: 'no-guard', detail: `找不到本 profile 的 cordis.patch.yml（plugin=${options.pluginName}），已放弃写入 —— 没有退路就不改用户配置` }
  }
  const target = { ...entry, models: kept }
  const snapshot = snapshotPatch(patchPath)
  try {
    await settings.mutate(namespace.ns, [{ op: 'set', path: ['providers', options.providerName], value: target }], namespace.revision)
  } catch (error) {
    rollbackPatch(snapshot)
    return { kind: 'failed', detail: `写入抛出：${error instanceof Error ? error.message : String(error)}（已回滚）` }
  }
  const verdict = verifyPatch(snapshot, { provider: options.providerName, expectedModelCount: kept.length })
  if (!verdict.ok) {
    rollbackPatch(snapshot)
    return { kind: 'rolled-back', ns: namespace.ns, reasons: verdict.reasons, backupPath: snapshot.backupPath }
  }
  return { kind: 'pruned', ns: namespace.ns, removed, keptModels: kept.length, backupPath: snapshot.backupPath }
}

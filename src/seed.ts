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
  models: ProviderProfileModel[]
}

/**
 * Build the provider profile.
 *
 * `apiKeyEnv` is deliberately absent: a route that names no credential is
 * "deliberately unauthenticated" on the harness side
 * (dsh-llm-pi-ai/lib/index.js:818-838), and pi-ai's OpenAI-compatible API then
 * insists on an Authorization header of its own
 * (@earendil-works/pi-ai/dist/api/openai-completions.js:34-40) — which is exactly
 * the header we put the shim token in. No credentials service involved.
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
  return {
    displayName: options.displayName,
    api: 'openai-completions',
    baseURL: `${options.baseUrl.replace(/\/$/, '')}/v1`,
    headers: { Authorization: `Bearer ${options.token}` },
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
 */
export type SeedOutcome =
  | { kind: 'created'; ns: string; modelCount: number; backupPath: string; offeredModels: string[]; skippedInternal: string[] }
  | { kind: 'present'; ns: string; modelCount?: number; offeredModels: string[]; skippedInternal: string[] }
  | { kind: 'rebuilt'; ns: string; addedModels: string[]; keptModels: number; backupPath: string; offeredModels: string[]; skippedInternal: string[] }
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
      skippedInternal
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
  return { kind: 'created', ns: namespace.ns, modelCount: target.models.length, backupPath: snapshot.backupPath, offeredModels: target.models.map((model) => model.id), skippedInternal }
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

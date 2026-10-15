/**
 * The model directory: what Trae will actually serve, and the wire headers that
 * asking for it requires.
 *
 * Roster source (observed contract, see 设计稿.md §5):
 *   POST {gateway}/api/ide/v1/get_detail_param
 *   body { function, config_names: null, need_prompt: false, current_config_info: null,
 *          poly_prompt: true, mode_type: null, agent_type: null }
 * Every function in TRAE_DIRECTORY_FUNCTIONS[region] is asked and the answers are
 * UNIONED, first listing wins: Trae splits its roster across SOLO modes and a
 * model is only callable through the function that lists it, so asking one
 * function would silently hide the other's models.
 *
 * A directory response entry is read as:
 *   id            <- config_name
 *   name          <- display_config.display_name (falls back to the id)
 *   contextWindow <- model_detail_list[0].prompt_max_tokens, else context_window_tokens.dev
 *   maxTokens     <- model_detail_list[0].max_tokens
 *   reasoningEfforts <- reasoning_effort_config.options, ONLY when the entry really
 *                       declares a level we recognise (see parseReasoningEfforts)
 */
import { TRAE_DIRECTORY_FUNCTIONS } from './format.ts'
import type { TraeCredential } from './auth.ts'
import type { TraeIdentity } from './identity.ts'
import type { TraeRegion } from './paths.ts'

/** Verified gateway bases per region (chat is where both the roster and chat live). */
export const REGION_GATEWAYS: Readonly<Record<TraeRegion, { chat: string; remote: string; pay: string }>> = {
  cn: { chat: 'https://trae-api-cn.mchost.guru', remote: 'https://solo.trae.cn/api/remote/v1', pay: 'https://api.trae.cn' },
  ai: { chat: 'https://coresg-normal.trae.ai', remote: 'https://coresg-normal.trae.ai/api/remote/v1', pay: 'https://growsg-normal.trae.ai' }
}

export const TRAE_SOLO_MODELS_PATH = '/api/ide/v1/get_detail_param'
export const TRAE_SOLO_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
export const TRAE_SOLO_FUNCTION = 'solo_work_lite'

/** The client id Trae sends as `x-app-id` (a product constant, not a secret). */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
/** Numeric build code the gateway accepts when the persisted build is dotted. */
export const TRAE_VERSION_CODE_FALLBACK = '20260716'

export interface TraeModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  input: readonly string[]
  /**
   * Which pi-ai thinking levels this model offers, each carrying the spelling
   * Trae's gateway expects for it.
   *
   * ABSENT means "the directory declared nothing we could read" — never "no
   * reasoning". A missing field keeps whatever capability the host's installed
   * catalog already knows (dsh-llm-pi-ai/lib/index.js:567-590), so an
   * unparsed model is left alone rather than downgraded to non-reasoning.
   */
  reasoningEfforts?: TraeReasoningEfforts
  /**
   * The directory's own claim about image input — a THREE-state field:
   *
   *   true      a function declared this model multimodal
   *   false     a function declared it text-only
   *   absent    no function said anything
   *
   * Read from `display_config.multimodal`, the only home of the key (measured
   * 2026-10-14 over all 169 entries of all four functions: nothing at an entry's
   * top level — the original read path was permanently `false` because of that —
   * nothing in `model_detail_list`, nothing in `extra_config`;
   * `display_contact_config.multimodal.enable` mirrors it with zero
   * disagreements). `tool_response_multimodal` and `video_multimodal` sit in the
   * same object and mean something narrower, so they are not read.
   *
   * The two declared states are kept apart on purpose, because the cross-function
   * merge treats them differently ({@link mergeRicher}): "declared text-only"
   * outranks another function's "multimodal", while "said nothing" does not. That
   * is the conservative direction for a capability claim — under-report rather
   * than over-report — and it is why the live count is 33 of 79 ids and not 36:
   * `minimax-m3`, `custom_model_gemini` and `custom_model_kimi` are called
   * multimodal only by a function that is NOT the one their requests go through.
   * 33 is deliberate; do not "fix" it back to 36.
   *
   * `input` stays `['text']` regardless, until this shim can translate image
   * content parts; see the NOT IMPLEMENTED block in src/protocol.ts.
   */
  multimodal?: boolean
  /** The directory function that listed this model (replayed when calling it). */
  directoryFunction: string
}

/** The pi-ai thinking levels a Trae entry can advertise, mapped to Trae's wire spelling. */
export interface TraeReasoningEfforts {
  low?: string
  high?: string
  xhigh?: string
}

/**
 * Trae's working-point vocabulary, as pi-ai level names.
 *
 * Verified twice, in both directions, against the upstream client's own tables
 * (dsh-connect-trae@3.4.0 lib/index.js, read-only reference):
 *   · :3190-3194 `EFFORT_MAP` translates a remote model's `light`/`high`/
 *     `extra_high` option into `low`/`high`/`xhigh`;
 *   · :239-242 and :272-275 translate a pi level back out for the SOLO body as
 *     `low -> light`, `xhigh -> extra_high`, everything else -> `high`.
 *
 * The live CN directory named only `light` and `high` on 2026-10-14 (four
 * entries, all `["light","high"]`); `extra_high` is Trae's own published
 * spelling for the top level. Any other string is left unmapped: a level we
 * cannot spell correctly is worse than one we do not offer, because the
 * gateway would receive a parameter value it does not know.
 */
const REASONING_WIRE_TO_LEVEL: Readonly<Record<string, keyof TraeReasoningEfforts>> = {
  light: 'low',
  high: 'high',
  extra_high: 'xhigh'
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * Read one directory entry's reasoning block.
 *
 * The live shape (observed 2026-10-14, every function):
 *
 *   reasoning_effort_config: { options: ["light","high"], default_level: "high",
 *                              support_thinking: true }
 *
 * and most entries carry `{ support_thinking: false }`, or no field at all,
 * instead. `default_level` is deliberately ignored: the host's profile schema
 * has no notion of a default level (dsh-llm-pi-ai/lib/index.js:1001-1014), so
 * reading it would only invite writing a field nothing consumes.
 *
 * Returns undefined — and the caller then writes NO reasoning field at all —
 * when the entry is unreadable, declares nothing, declares only spellings we do
 * not know, or says `support_thinking: false` beside an option list (the two
 * never disagreed in the live directory, and a contradiction is not a licence
 * to guess).
 */
export function parseReasoningEfforts(entry: unknown): TraeReasoningEfforts | undefined {
  const config = recordOf(entry)
  if (config === undefined) return undefined
  const details = Array.isArray(config['model_detail_list']) ? config['model_detail_list'] : []
  const block = recordOf(config['reasoning_effort_config']) ?? recordOf(recordOf(details[0])?.['reasoning_effort_config'])
  if (block === undefined) return undefined
  if (block['support_thinking'] === false) return undefined
  const options = Array.isArray(block['options']) ? block['options'] : []
  const efforts: TraeReasoningEfforts = {}
  for (const option of options) {
    if (typeof option !== 'string') continue
    const level = REASONING_WIRE_TO_LEVEL[option]
    if (level === undefined || efforts[level] !== undefined) continue
    efforts[level] = option
  }
  return Object.keys(efforts).length === 0 ? undefined : efforts
}

/** Bootstrap rosters, used only while no live directory is available. */
export const FALLBACK_MODELS: Readonly<Record<TraeRegion, readonly TraeModel[]>> = {
  cn: [
    { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION }
  ],
  ai: [
    { id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro-Preview', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'gemini-3-flash-solo', name: 'Gemini-3-Flash-Preview', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'kimi-k2.5', name: 'Kimi-K2.5', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION },
    { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION }
  ]
}

export function normalizeVersionCode(buildVersion: string | undefined): string {
  if (buildVersion === undefined || buildVersion.trim() === '') return TRAE_VERSION_CODE_FALLBACK
  const trimmed = buildVersion.trim()
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK
}

/** Headers shared by every Trae gateway call (auth + identity + trace ids). */
export function buildTraeHeaders(credential: TraeCredential, identity: TraeIdentity, accept = 'text/event-stream'): Record<string, string> {
  const requestId = crypto.randomUUID()
  const traceId = requestId.replaceAll('-', '').slice(0, 32)
  return {
    Authorization: `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-Ide-Token': credential.accessToken,
    'X-Cloudide-Token': credential.accessToken,
    'x-uid': credential.userId,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${identity.appVersion ?? identity.buildVersion ?? 'unknown'}`,
    'x-app-id': TRAE_APP_ID,
    'x-machine-id': identity.machineId,
    'x-device-id': identity.deviceId,
    'x-app-version-code': normalizeVersionCode(identity.buildVersion),
    'x-ide-version-code': normalizeVersionCode(identity.buildVersion),
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    Accept: accept,
    'Content-Type': 'application/json'
  }
}

export function traeEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

export interface DirectoryAttempt {
  fn: string
  status?: number
  count?: number
  error?: string
}

export interface DirectoryResult {
  models: TraeModel[]
  attempts: DirectoryAttempt[]
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read one `config_info_list` entry. Unknown shapes are skipped, never guessed. */
export function parseModel(raw: unknown, directoryFunction: string): TraeModel | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const config = raw as Record<string, unknown>
  const id = typeof config['config_name'] === 'string' ? config['config_name'] : ''
  if (id === '') return undefined
  const display = typeof config['display_config'] === 'object' && config['display_config'] !== null ? (config['display_config'] as Record<string, unknown>) : {}
  const details = Array.isArray(config['model_detail_list']) ? config['model_detail_list'] : []
  const detail = typeof details[0] === 'object' && details[0] !== null ? (details[0] as Record<string, unknown>) : {}
  const contextTokens = typeof config['context_window_tokens'] === 'object' && config['context_window_tokens'] !== null ? (config['context_window_tokens'] as Record<string, unknown>) : {}
  const contextWindow = positive(detail['prompt_max_tokens']) ?? positive(contextTokens['dev'])
  const maxTokens = positive(detail['max_tokens'])
  // The live entry states this under `display_config` (verified 2026-10-14); the
  // top-level spelling never fires on live data but is kept as a harmless
  // fallback. THREE states, and the difference is load-bearing (see TraeModel):
  // `true` declared multimodal, `false` declared text-only, absent = nobody said.
  // The value is recorded truthfully and deliberately NOT turned into an `image`
  // input modality: src/protocol.ts translates no image content part, so
  // advertising images would let a user attach a picture that silently vanishes.
  // See the NOT IMPLEMENTED block in src/protocol.ts for what has to land first.
  const rawMultimodal = typeof display['multimodal'] === 'boolean' ? (display['multimodal'] as boolean) : config['multimodal']
  const multimodal = typeof rawMultimodal === 'boolean' ? rawMultimodal : undefined
  const displayName = typeof display['display_name'] === 'string' && display['display_name'] !== '' ? display['display_name'] : id
  const reasoningEfforts = parseReasoningEfforts(config)
  return {
    id,
    name: displayName,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    input: ['text'],
    ...(multimodal === undefined ? {} : { multimodal }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    directoryFunction
  }
}

/**
 * Fill in fields a later directory row states and the first one did not.
 *
 * The same `config_name` is listed by several SOLO functions, and they disagree:
 * `Doubao-Seed-2.1-Pro` is answered first by `solo_work_remote` (no thinking
 * options at all) and later by `solo_agent_remote` (light + high). Keeping the
 * first row verbatim — which is what this did until 2026-10-14 — silently cost
 * those models their reasoning levels.
 *
 * The FUNCTION is deliberately NOT part of the merge: wire resolution has to
 * replay the function that owns the id, so it stays first-wins.
 *
 * Only a field the first row left UNSET can be filled, and never a partial
 * top-up: a first row declaring `{ low: 'light' }` keeps exactly that, even when
 * a later row declares more levels. Filling is monotone — it can only add a
 * statement, never replace one — which is what keeps the value deterministic
 * instead of "whichever function the gateway happened to answer first".
 *
 * Measured on the live CN directory (2026-10-14, 79 ids from 169 entries):
 *   · thinking levels: 1 id before the merge, 3 after (Doubao-Seed-2.1-Pro and
 *     -Turbo gained `light+high` from `solo_agent_remote` while keeping
 *     `solo_work_remote` as their wire function);
 *   · image claims: 33 ids. `minimax-m3`, `custom_model_gemini` and
 *     `custom_model_kimi` say `multimodal: false` in the row that owns them and
 *     `true` only in a function their requests never go through, so the declared
 *     `false` stands. Without this rule the count would be 36 — 33 is the
 *     deliberate answer (capability claims under-report rather than over-report),
 *     and `multimodal` is not acted on yet anyway (see the NOT IMPLEMENTED block
 *     in src/protocol.ts).
 */
function mergeRicher(base: TraeModel, extra: TraeModel): TraeModel {
  return {
    ...base,
    ...(base.contextWindow === undefined && extra.contextWindow !== undefined ? { contextWindow: extra.contextWindow } : {}),
    ...(base.maxTokens === undefined && extra.maxTokens !== undefined ? { maxTokens: extra.maxTokens } : {}),
    ...(base.reasoningEfforts === undefined && extra.reasoningEfforts !== undefined ? { reasoningEfforts: extra.reasoningEfforts } : {}),
    // Three-state, so "declared text-only" is a statement the later row may not
    // overwrite: only an UNdeclared first row accepts a boolean. Both values are
    // accepted there — a later `false` is information too.
    ...(base.multimodal === undefined && extra.multimodal !== undefined ? { multimodal: extra.multimodal } : {})
  }
}

/**
 * Fetch the live roster for one region. Read-only: no session, no credit use.
 * Requires a usable credential + identity; without them the caller gets the
 * fallback roster instead (see FALLBACK_MODELS).
 */
export async function fetchDirectoryModels(
  region: TraeRegion,
  credential: TraeCredential,
  identity: TraeIdentity,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; baseUrl?: string } = {}
): Promise<DirectoryResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const base = options.baseUrl ?? REGION_GATEWAYS[region].chat
  const headers = buildTraeHeaders(credential, identity, 'application/json')
  const byId = new Map<string, TraeModel>()
  const attempts: DirectoryAttempt[] = []
  for (const fn of TRAE_DIRECTORY_FUNCTIONS[region] ?? []) {
    try {
      const response = await fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          function: fn,
          config_names: null,
          need_prompt: false,
          current_config_info: null,
          poly_prompt: true,
          mode_type: null,
          agent_type: null
        }),
        signal: options.signal ?? AbortSignal.timeout(30000)
      })
      if (!response.ok) {
        attempts.push({ fn, status: response.status, error: (await response.text().catch(() => '')).slice(0, 160) })
        continue
      }
      const document = (await response.json()) as Record<string, unknown>
      const list = Array.isArray(document['config_info_list']) ? document['config_info_list'] : []
      let count = 0
      for (const raw of list) {
        const model = parseModel(raw, fn)
        if (model === undefined) continue
        const existing = byId.get(model.id)
        if (existing === undefined) {
          byId.set(model.id, model)
          count += 1
          continue
        }
        // Same id, another function: keep the first row's function, take whatever
        // extra fields this row states (see mergeRicher).
        byId.set(model.id, mergeRicher(existing, model))
      }
      attempts.push({ fn, status: response.status, count })
    } catch (error) {
      attempts.push({ fn, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { models: [...byId.values()], attempts }
}

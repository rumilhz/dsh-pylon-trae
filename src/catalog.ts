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

/**
 * ═══════════════ 「对话模型」还是「IDE 内部流程组件」 ═══════════════
 *
 * 症状（委托方报告，2026-10-16）：写进「设置 → 模型」的 79 条里混着 Trae IDE 自己的
 * 流程组件 —— `title_generation`（起标题）· `input_optimization`（优化输入）·
 * `fast_apply`（快速套用）· `search_agent_qwen_fast`（搜索）· `custom_model_gpt-6`
 * （占位槽）· `glm-5.2_advisor_doubao`（顾问模式）…… 它们都是**真的可调用的
 * config_name**（所以它们确实能调通），但**不是对话模型**，出现在模型选择器里就是
 * 垃圾项。
 *
 * ─────────────────── 判据出处：实测 CN 网关目录，2026-10-16 ───────────────────
 *
 * `POST /api/ide/v1/get_detail_param`，四个 function 各答一次
 * （`solo_work_remote` 45 行 · `solo_agent_remote` 37 行 · `chat_v3` 46 行 ·
 * `solo_coder` 41 行），合计 **169 行 / 79 个不重复 config_name**。逐条 dump 之后，
 * 79 条里**唯一**声明「这个 config_name 是干什么用的」的字段是
 * `config_info_list[i].usage`：
 *
 *     chat_completion 56 · custom_model 18 · summary 1 · fast_apply 1 ·
 *     fast_apply_new 1 · title_generation 1 · input_optimization 1      = 79
 *
 * `chat_completion`（对话补全）是其中**唯一**表示「这个 config_name 在回答一次对话」
 * 的取值；其余五个取值是 Trae 自己给的用途名，逐字对应它 IDE 里的流程组件。
 *
 * 光看 `usage` 不够：`search_agent_qwen_fast` / `glm-5.2_advisor_doubao` 这类**别名槽**
 * 声明的用途也是 `chat_completion`。分开它们的是第二个字段
 * `config_info_list[i].model_detail_list[0].model_name` —— Trae 真正发给上游的模型名，
 * 79 条**全部**都有：
 *
 *     真模型   model_name = `<config_name>__dev` / `<config_name>__max`
 *     别名槽   model_name 落在**别的**模型（或别的组件）上：
 *              glm-5.1_advisor       → glm-5.1__dev              （与 glm-5.1 同一个线上模型）
 *              glm-5.2_advisor_default → glm-5.2__dev            （与 glm-5.2 同一个线上模型）
 *              glm-5.2_advisor_doubao  → glm-5.2__dev            （同上）
 *              search_agent_qwen_fast → search_agent_model__max
 *              browser_use_subagent   → browser_use_model__dev
 *              explore_sub_agent_v2   → qwen-3.6-explore-agent__dev
 *              file_search_agent      → file-search-qwen3.6__dev
 *              seed-code-pro-0430     → Doubao-Seed-2.1-Pro__dev
 *
 * 一句话：**一个 config_name 如果连自己的线上模型名里都不出现，它就不是一个模型，而是
 * 别的东西的槽位**。这就是规则 ②。
 *
 * ## 规则 ② 在「同一个 id 被多个 function 列出」时怎么判：任一行成立就算 chat
 *
 * 判据的**逐行**形式就是 {@link classifyDirectoryEntry}；同一个 id 会被最多四个
 * function 各列一次，而这几行会互相矛盾 —— 实测（CN，2026-10-16，同样的 169 行 / 79
 * 个 id）：
 *
 *     DeepSeek-V4-Flash     solo_work_remote → deepseek_v4_flash__dev     （别名，判 internal）
 *                           solo_agent_remote / chat_v3 / solo_coder → DeepSeek-V4-Flash__dev
 *     DeepSeek-V4-Pro       solo_work_remote → deepseek_v4_pro__dev       （别名）
 *                           solo_agent_remote / chat_v3 / solo_coder → DeepSeek-V4-Pro__dev
 *     Doubao-Seed-2.0-Code  solo_work_remote → Doubao-Seed-2.1-Turbo__dev （别名）
 *                           solo_coder       → Doubao-Seed-2.0-Code__max
 *
 * `solo_work_remote` 是**第一个**被问的 function（src/format.ts），所以「保留第一行」
 * 会让用户模型清单的数量取决于网关先答哪一行：实测同一份目录，**前一分钟 47 个、后一
 * 分钟 44 个**，三个真模型被静默丢掉。因此 `kind` 在合并时取「**任意一行说它是自己的
 * 模型就算 chat**」（{@link mergeRicher} 里唯一一个朝 chat 单调的字段），判据于是成为
 * 目录的属性、与回答顺序无关。
 *
 * 反方向的错误（某个流程组件靠名字巧合被提成 chat）也实测过：**32 个 internal id 的
 * 全部 169 行里，没有一行**的 `model_name` 含自己的 config_name（整份名单冻结在
 * `tools/test-catalog.ts` 的 `INTERNAL_ROSTER`）。所以这条 OR 漏不进组件，只会少丢模型。
 *
 * 命中数（CN，2026-10-16，任一行为准）：internal **32** / chat **47**（32+47 = 79）。
 * 32 个 id 全列在 {@link TRAE_INTERNAL_KINDS_DOC}。
 *
 * 规则 ①（usage）命中 23 个：summary · fast_apply · fast_apply_new · title_generation ·
 * input_optimization + 18 个 `custom_model_*`。
 * 规则 ②（线上模型名）另命中 9 个：browser_use_subagent · explore_sub_agent_v2 ·
 * file_search_agent · search_agent_qwen_fast · search_agent_qwen_fast-0710 ·
 * glm-5.1_advisor · glm-5.2_advisor_default · glm-5.2_advisor_doubao · seed-code-pro-0430。
 *
 * ─────────────────── 上游做了没有？—— 没有做等价的事 ───────────────────
 *
 * 钉死的 `dsh-connect-trae@3.4.0` lib/index.js **没有**任何按用途/类型的过滤：
 *   · `collectModels`（:2604-2640）只读 `config_name` / `display_config` /
 *     `model_detail_list` / `context_window_tokens`，把每一条都收进目录；
 *   · 它唯一的两个过滤都与用途无关：`sanitizeCatalog`（:283-290）丢掉自己早期版本造的
 *     `@1m` 变体，`dropDeadModels`（:5303）按「线上可调用的 key」过滤。
 *   · 它的 `fetchModels` 注释（:2571-2578）写着 "The remote directory remains the merge
 *     skeleton, so agent-internal entries (search_agent_*, paygo variants) never surface
 *     even though they appear here." —— 即上游**知道**这些条目会出现，靠的是「以 Remote
 *     用户面目录为骨架」这一条**结构性**假设，不是字段判据。本插件只用
 *     `get_detail_param`（设计稿 §5），没有那层骨架，所以必须自己判。
 *
 * 我们也试过上游那条路，并**放弃了**：拿 `GET {remote}/models` 的用户面目录（实测 32 个
 * 名字）与 79 个 config_name 求交，只剩 **30** 个 —— 它连 `glm-4.6` · `glm-4.7` ·
 * `kimi-k2` · `kimi-k2-0905` · `minimax-m2` · `minimax-m2.1` · `qwen3-coder` 这些**真
 * 模型**（Trae 已从自己的选择器下架、但账户仍可调用）一起丢掉。那是一次回归，不是这次
 * 委托要修的东西。所以判据留在本文件的字段上，离线可复现、不需要第二次网关调用。
 *
 * ─────────────────── 边界（缺字段 / 畸形行）───────────────────
 *
 * 一个既读不出 `usage`、也读不出 `model_name` 的条目**无法被证明**是对话模型，因此判为
 * internal（而不是 chat）。方向是刻意的：隐藏一个真模型的代价是「用户少看到一个选项」，
 * 而放进来一个流程组件的代价正是这次的投诉；而且被隐藏的 id 会经 `SeedOutcome.
 * skippedInternal`、`GET /models/all`、`boot.log` 三处报出来，所以这个方向是**可发现、
 * 可撤回**的。反过来（缺字段就当 chat）是静默地把垃圾写进用户配置。
 */
export const TRAE_CHAT_USAGE = 'chat_completion'

/** The 32 ids the criterion judged internal on the live CN directory, 2026-10-16. */
export const TRAE_INTERNAL_KINDS_DOC = [
  'browser_use_subagent',
  'custom_model_1M',
  'custom_model_1M_text',
  'custom_model_200k',
  'custom_model_200k_text',
  'custom_model_claude',
  'custom_model_deepseek_chat',
  'custom_model_deepseek_reasoner',
  'custom_model_deepseek_v4',
  'custom_model_doubao_1M',
  'custom_model_doubao_256k',
  'custom_model_gemini',
  'custom_model_gpt-5',
  'custom_model_gpt-6',
  'custom_model_kimi',
  'custom_model_no-fc',
  'custom_model_placeholder',
  'custom_model_vercel',
  'custom_model_vercel_gemini',
  'explore_sub_agent_v2',
  'fast_apply',
  'fast_apply_new',
  'file_search_agent',
  'glm-5.1_advisor',
  'glm-5.2_advisor_default',
  'glm-5.2_advisor_doubao',
  'input_optimization',
  'search_agent_qwen_fast',
  'search_agent_qwen_fast-0710',
  'seed-code-pro-0430',
  'summary',
  'title_generation'
] as const

/** `chat` = 一次对话的模型；`internal` = Trae IDE 自己的流程/别名槽位。 */
export type TraeModelKind = 'chat' | 'internal'

export interface TraeModelClassification {
  kind: TraeModelKind
  /** 为什么判成 internal（给人读的一句话）；`chat` 时不存在。 */
  internalReason?: string
}

/** `model_detail_list[0].model_name` — the model name Trae really sends upstream. */
export function wireModelName(entry: unknown): string | undefined {
  const config = recordOf(entry)
  if (config === undefined) return undefined
  const details = Array.isArray(config['model_detail_list']) ? config['model_detail_list'] : []
  const name = recordOf(details[0])?.['model_name']
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
}

/**
 * Judge ONE `config_info_list` entry: see the block comment above for the criterion,
 * its source, its measured hit count, and why the boundary leans towards `internal`.
 *
 * Pure and total: any JSON value is an answer, never a throw.
 */
export function classifyDirectoryEntry(entry: unknown, id: string): TraeModelClassification {
  const config = recordOf(entry)
  if (config === undefined) return { kind: 'internal', internalReason: '条目不是对象：读不出用途，无法证明它是对话模型' }
  const usage = config['usage']
  if (typeof usage !== 'string' || usage.trim() === '') {
    return { kind: 'internal', internalReason: '目录没有声明 usage，无法证明它是对话模型' }
  }
  if (usage !== TRAE_CHAT_USAGE) {
    return { kind: 'internal', internalReason: `usage=${usage}（Trae 自己声明的用途不是 ${TRAE_CHAT_USAGE}）` }
  }
  const wire = wireModelName(config)
  if (wire === undefined) {
    return { kind: 'internal', internalReason: '目录没有给出 model_detail_list[0].model_name，无法证明它是对话模型' }
  }
  if (!wire.toLowerCase().includes(id.toLowerCase())) {
    return { kind: 'internal', internalReason: `线上模型名是 ${wire}，不含自己的 config_name —— 它只是别的东西的槽位` }
  }
  return { kind: 'chat' }
}

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
  /**
   * 对话模型（`chat`）还是 Trae IDE 的内部流程组件（`internal`）。
   *
   * 这是**判据的结果**，判据本身与它的出处、命中数、边界方向都在上面那一大段注释和
   * {@link classifyDirectoryEntry} 里。它是**必需**字段而不是可选标志：一个写漏了
   * `kind` 的目录行必须被当作「没判过」，而不是被当作 chat —— src/seed.ts 只写
   * `kind === 'chat'`，所以漏判不会静默地放垃圾进用户配置。
   */
  kind: TraeModelKind
  /** 判成 internal 的原因（给人读）；`chat` 时不存在。 */
  internalReason?: string
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

/**
 * Bootstrap rosters, used only while no live directory is available.
 *
 * Every row is hand-written and is a conversation model by construction, hence
 * `kind: 'chat'` on all of them — `classifyDirectoryEntry` never runs here.
 */
export const FALLBACK_MODELS: Readonly<Record<TraeRegion, readonly TraeModel[]>> = {
  cn: [
    { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' }
  ],
  ai: [
    { id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro-Preview', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'gemini-3-flash-solo', name: 'Gemini-3-Flash-Preview', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'kimi-k2.5', name: 'Kimi-K2.5', contextWindow: 200000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' },
    { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272000, input: ['text'], directoryFunction: TRAE_SOLO_FUNCTION, kind: 'chat' }
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
  const classification = classifyDirectoryEntry(config, id)
  return {
    id,
    name: displayName,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    input: ['text'],
    ...(multimodal === undefined ? {} : { multimodal }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    directoryFunction,
    kind: classification.kind,
    ...(classification.internalReason === undefined ? {} : { internalReason: classification.internalReason })
  }
}

/**
 * The live catalogue, split by {@link classifyDirectoryEntry}'s verdict.
 *
 * `internalIds` is what src/seed.ts reports as `skippedInternal` and what
 * `POST /models/prune-internal` is allowed to remove — one derivation, so the
 * "hidden" count and the "removable" list can never disagree.
 */
export function partitionModels(models: readonly TraeModel[]): { chat: TraeModel[]; internal: TraeModel[]; internalIds: string[] } {
  const chat: TraeModel[] = []
  const internal: TraeModel[] = []
  for (const model of models) {
    // Strict on purpose: only an explicit `chat` is a conversation model. A row that
    // never went through parseModel (a hand-built literal missing `kind`) is NOT
    // silently promoted into the user's provider entry.
    if (model.kind === 'chat') chat.push(model)
    else internal.push(model)
  }
  return { chat, internal, internalIds: internal.map((model) => model.id) }
}

/**
 * ═══════════ 下拉框里的 4 类坏显示名，与「显示名唯一化」═══════════
 *
 * 症状（委托方 2026-10-16 复核 `模型清单.md` 后逐个核过 47 行对话模型）：
 *
 *   ① **名字是 `-`**：`aquila` · `sagitta` —— Trae 的 `display_config.display_name`
 *      就是一个横杠，用户在模型选择器里看到一行 `-`，不知道点的是什么；
 *   ② **名字撒谎**：`Doubao-Seed-2.0-Code` 的显示名是 `Doubao-Seed-2.1-Turbo`
 *      （**拥有**它的那条目录行 `solo_work_remote` 报出的线上名也是
 *      `Doubao-Seed-2.1-Turbo__dev`），与真正的 `Doubao-Seed-2.1-Turbo` 撞名；
 *   ③ **6 个 `-auto` 路由槽**：`doubao-for-auto` · `Doubao-Seed-2.0-Code-auto` ·
 *      `glm-4.6-auto` · `glm-4.7-auto` · `minimax-m2-auto` · `minimax-m2.1-auto`。
 *      它们是 Trae Auto 模式的路由端点（推断：命名规律 = 基础模型名 + `-auto`，线上名
 *      一律 `__max`），显示名要么撞正牌（`glm-4.6-auto` 的显示名就是 `GLM-4.6`），
 *      要么干脆是 id 本身（`doubao-for-auto`）。**不隐藏**（它们是真能调用的
 *      config，隐藏比显示更糟），但必须让用户一眼看出这是自动模式端点；
 *   ④ **7 组显示名完全撞车**（各 2 行）：`DeepSeek-V4-Flash` · `DeepSeek-V4-Pro` ·
 *      `Seed-Code` · `Kimi-K2-0905` · `GLM-4.6` · `MiniMax-M2` · `MiniMax-M2.1` ——
 *      下拉框里就是同名两行，用户没法分辨该点哪个。
 *
 * 出处：CN 网关 `POST /api/ide/v1/get_detail_param`（四个 function 各答一次），
 * 2026-10-16 用只读脚本 `tools/report-models.ts --json` 原样读回：79 个 config_name
 * → 对话模型 47 / 内部组件 32。这 47 行的 `display_name` 逐字冻结在
 * `tools/test-catalog.ts` 的 `LIVE_CN_CHAT_ROWS` 里，本节不再重复那张表。
 *
 * ## 四条规则（显示名唯一化，**不是**黑名单）
 *
 * 判据只读两个已有字段：`id` 与 `display_config.display_name`（→ `TraeModel.name`），
 * 外加 `directoryFunction` 作后缀。**没有任何 id 被写死在代码里** —— 名单会腐烂，
 * 判据不会。
 *
 *   ① 名字缺失 / 只有标点或空白（`-` 也算）⇒ 用 **id**。id 至少是诚实的：
 *      `aquila` 就显示成 `aquila`。
 *   ② 同一批里出现重复显示名 ⇒ **每一个**同名条目都附上短功能标签（来自
 *      `directoryFunction`：work / agent / chat / coder）。**不是**只改其中一个 ——
 *      只改一个会让没被改的那个看起来像"正牌"。标签还不足以分开（同一个 function 的
 *      两条争同一个名字）时，再补 id 片段，见 {@link uniquifyDisplayNames} 第三趟。
 *   ③ id 与显示名**完全对不上**（显示名里不包含 id）⇒ 用 id。判据是「显示名必须能
 *      证明它说的就是这个 id」，所以 `Seed-2.1-Turbo` 这类短名也会被换成
 *      `Doubao-Seed-2.1-Turbo`：**宁可显示 id，也不显示一个核对不上的漂亮名字**。
 *      `Doubao-Seed-2.0-Code` 正是被这条纠正的。
 *   ④ `-auto` 结尾的 id 额外带 `（Auto · <function 标签>）`，例如
 *      `glm-4.6-auto（Auto · coder）`、`doubao-for-auto（Auto · chat）`。
 *
 * ## 规则 ③ 为什么**不**去读线上 `model_name`（委托的原话里有这一半）
 *
 * 委托给的判据是「显示名里既不包含 id、也不包含线上 `model_name` 的主体」。前半句就是
 * 上面那条；后半句在这份目录上**推不出任何新结论**，所以没有实现 —— 理由是两条：
 *
 *   ① **一个 chat 模型的线上名一定含它自己的 id。** 那正是 {@link classifyDirectoryEntry}
 *      判它是 chat 的条件（`model_name` 里出现这个 config_name）；不满足的行是 internal，
 *      根本不公布。所以"显示名包含线上名主体" ⇒ "显示名包含 id"，是前一条的子集。
 *      `tools/test-catalog.ts` 把这 47 行的这个性质钉成了断言。
 *   ② 真去读它反而会**替谎话背书**。`TraeModel` 的线上名是 first-wins 的，而
 *      `Doubao-Seed-2.0-Code` 的**第一条**答案正是一个过期别名（实测 2026-10-16）：
 *
 *          solo_work_remote → Doubao-Seed-2.1-Turbo__dev   ← 先答的，也正是它显示名的来源
 *          solo_coder       → Doubao-Seed-2.0-Code__max    ← 真正自报家门的那条
 *
 *      拿 first-wins 的线上名当依据，显示名恰好等于它，规则 ③ 就永远抓不到本委托点名
 *      的那一条；要修就得再加一条"只认含自己 id 的那一行"的过滤 —— 而过滤完剩下的
 *      信息量还是等于"含 id"。既然结论相同、代码更少、还没有那条陷阱，就只读 id。
 *
 * ## 幂等 / 确定性（结果会进 profile patch，必须可重放）
 *
 *   · 只依赖输入本身：`displayNameOf` 是逐行的纯函数；撞名分组按 {@link nameKey}
 *     （大小写与分隔符不敏感）计数；补 id 片段用的是 id。没有随机数、没有时间、
 *     没有"谁是列表第一个"的隐含依赖（计数与顺序无关）。
 *   · 再跑一次结果相同：被改过的名字要么等于 id（含 id ⇒ 规则 ③ 直接通过），要么
 *     带着 `（标签）` / `（Auto · 标签）` 尾巴（同样含 id ⇒ 通过），而它们已经互不
 *     相同，所以第二趟既不会重命名、也不会再叠一层后缀；`-auto` 槽用
 *     {@link AUTO_NAME_MARKER} 认出"我这条已经带过 Auto 标记"，不会叠加。
 *   · 前置条件（两个调用点都保证）：同一批里 id 唯一 —— 目录按 config_name 去重
 *     （{@link fetchDirectoryModels} 的 `byId`），写条目时 `buildProviderProfile`
 *     也按 id 去重。
 *
 * ## 只动展示用的 `name`
 *
 * `id`（线上契约）永不改；`input` / `reasoningEfforts` / `multimodal` /
 * `contextWindow` / `maxTokens` 一个字不动。内部组件（Trae IDE 自己的流程槽）
 * **不参与改名**：它们默认根本不写进用户配置，`includeInternal: true` 这个逃生口
 * 写出来的也仍是 Trae 自己给的名字。
 *
 * ## 在哪执行
 *
 * 唯一化是**整份名单的属性**，不是某一行的属性，所以它不可能在 `parseModel`（逐行）
 * 里做；它在 {@link fetchDirectoryModels} 的出口执行 —— 目录在那里刚刚合并完，之后
 * 每一处下游（写条目 / `GET /models/all` / `/v1/models` / 只读报表）读到的就已经是
 * 最终名字。
 */

/** 目录 function → 短功能标签（撞名后缀与 Auto 标记都用它）。 */
const DIRECTORY_FUNCTION_LABELS: Readonly<Record<string, string>> = {
  solo_work_remote: 'work',
  solo_agent_remote: 'agent',
  chat_v3: 'chat',
  solo_coder: 'coder'
}

/**
 * The short tag a directory function contributes to a disambiguated display name.
 * Total: an unknown or missing function name still yields a deterministic tag
 * (its own name with the `solo_`/`_remote` scaffolding removed, else `unknown`).
 */
export function directoryFunctionLabel(directoryFunction: unknown): string {
  if (typeof directoryFunction !== 'string' || directoryFunction.trim() === '') return 'unknown'
  const known = DIRECTORY_FUNCTION_LABELS[directoryFunction]
  if (known !== undefined) return known
  const stripped = directoryFunction.replace(/^solo_/, '').replace(/_remote$/, '').trim()
  return stripped === '' ? directoryFunction : stripped
}

/** Case- and separator-insensitive form used for every "are these the same name" test. */
function nameKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** A name that carries no information: empty, whitespace, or nothing but punctuation (`-`, `—`, …). */
const NAMELESS_DISPLAY_NAME = /^[\s\-–—_·.]+$/u
/** An id shaped like an Auto-mode routing slot (`doubao-for-auto`, `minimax-m2.1-auto`, …). */
const AUTO_ID_SUFFIX = /-auto$/i
/** The marker this module appends, so a second run recognises its own work. */
const AUTO_NAME_MARKER = /（Auto · [^）]+）$/u

/**
 * Rule ③ for ONE chat model: the honest display name, before uniqueness is decided.
 *
 * Pure and total: any shape is an answer, never a throw. An empty id has nothing to fall
 * back to, so the raw name is returned unchanged (the caller drops such a row anyway).
 */
export function displayNameOf(model: TraeModel): string {
  const id = typeof model.id === 'string' ? model.id : ''
  const raw = typeof model.name === 'string' ? model.name.trim() : ''
  if (id === '') return raw
  if (raw === '' || NAMELESS_DISPLAY_NAME.test(raw)) return id
  return nameKey(raw).includes(nameKey(id)) ? raw : id
}

/**
 * Rules ② + ④ for a WHOLE roster: make every published conversation model's display
 * name unique, and mark the Auto-mode slots.
 *
 * `internal` rows are returned untouched (they are not published by default, and the
 * escape hatch that does publish them keeps Trae's own names). Returns a new array;
 * rows whose name did not change keep their identity.
 *
 * Idempotent and deterministic — see the section comment above for the argument.
 */
export function uniquifyDisplayNames(models: readonly TraeModel[]): TraeModel[] {
  const idOf = (model: TraeModel): string => (typeof model.id === 'string' ? model.id : '')
  const countByName = (names: readonly (string | undefined)[]): Map<string, number> => {
    const counts = new Map<string, number>()
    models.forEach((model, index) => {
      if (model.kind !== 'chat') return
      const key = nameKey(names[index] ?? '')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    return counts
  }
  // ① / ③ — the honest base name per chat row.
  const honest = models.map((model) => (model.kind === 'chat' ? displayNameOf(model) : model.name))
  const honestCounts = countByName(honest)
  // ② / ④ — what this row has to say about itself, if anything.
  const tags = models.map((model, index) => {
    if (model.kind !== 'chat') return undefined
    const base = honest[index] ?? model.name ?? ''
    const shared = (honestCounts.get(nameKey(base)) ?? 1) > 1
    const auto = AUTO_ID_SUFFIX.test(idOf(model))
    if (!shared && !auto) return undefined
    // Second run over an already-unique roster: my own marker is already there.
    if (auto && AUTO_NAME_MARKER.test(base)) return undefined
    return { auto, label: directoryFunctionLabel(model.directoryFunction) }
  })
  const render = (base: string, tag: { auto: boolean; label: string } | undefined, id: string, withId: boolean): string => {
    if (tag === undefined && !withId) return base
    const parts: string[] = []
    if (tag !== undefined) parts.push(tag.auto ? `Auto · ${tag.label}` : tag.label)
    if (withId) parts.push(id)
    return `${base}（${parts.join(' · ')}）`
  }
  const planned = models.map((model, index) => (model.kind === 'chat' ? render(honest[index] ?? model.name ?? '', tags[index], idOf(model), false) : model.name))
  // Third pass: the tag alone did not separate two rows (the same function claiming the
  // same name twice) — put the id inside the same pair of brackets. Ids are unique by
  // construction, so this can never collide again.
  const plannedCounts = countByName(planned)
  return models.map((model, index) => {
    if (model.kind !== 'chat') return model
    const base = honest[index] ?? model.name ?? ''
    const stillShared = (plannedCounts.get(nameKey(planned[index] ?? '')) ?? 1) > 1
    const finalName = render(base, tags[index], idOf(model), stillShared)
    return finalName === model.name ? model : { ...model, name: finalName }
  })
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
 * replay the function that owns the id, so it stays first-wins. `name` stays
 * first-wins for the same reason — it is an identity statement, and identity belongs
 * to the row that owns it. `kind` is the documented EXCEPTION: it is monotone
 * towards `chat` across the rows that list an id (see the block below), because a
 * stale alias in the first answer must not be able to hide a real model.
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
  const merged: TraeModel = {
    ...base,
    ...(base.contextWindow === undefined && extra.contextWindow !== undefined ? { contextWindow: extra.contextWindow } : {}),
    ...(base.maxTokens === undefined && extra.maxTokens !== undefined ? { maxTokens: extra.maxTokens } : {}),
    ...(base.reasoningEfforts === undefined && extra.reasoningEfforts !== undefined ? { reasoningEfforts: extra.reasoningEfforts } : {}),
    // Three-state, so "declared text-only" is a statement the later row may not
    // overwrite: only an UNdeclared first row accepts a boolean. Both values are
    // accepted there — a later `false` is information too.
    ...(base.multimodal === undefined && extra.multimodal !== undefined ? { multimodal: extra.multimodal } : {})
  }
  if (base.kind === 'chat' || extra.kind !== 'chat') return merged
  // ── the ONE field that is monotone TOWARDS `chat` ────────────────────────────
  //
  // Why the direction is argued rather than copied from the capability rules above:
  // `solo_work_remote` is asked FIRST (src/format.ts) and it sometimes serves a
  // STALE wire name for an id the other three functions spell correctly. Measured on
  // the live CN directory, 2026-10-16, same 169 rows / 79 ids, two calls minutes
  // apart:
  //
  //   DeepSeek-V4-Flash  solo_work_remote → deepseek_v4_flash__dev  (⇒ internal)
  //                      solo_agent_remote / chat_v3 / solo_coder → DeepSeek-V4-Flash__dev
  //   DeepSeek-V4-Pro    solo_work_remote → deepseek_v4_pro__dev    (⇒ internal)
  //                      solo_agent_remote / chat_v3 / solo_coder → DeepSeek-V4-Pro__dev
  //   Doubao-Seed-2.0-Code  solo_work_remote → Doubao-Seed-2.1-Turbo__dev (⇒ internal)
  //                         solo_coder       → Doubao-Seed-2.0-Code__max
  //
  // First-wins therefore made the size of the user's model list depend on which
  // answer the gateway happened to return first: the same live directory produced
  // 47 models one minute and 44 the next, with three REAL models silently dropped.
  // Taking "some row says this id is its own model" makes the verdict a property of
  // the DIRECTORY rather than of the answer order.
  //
  // The opposite error — a workflow component promoted to chat by a coincidental
  // name match — was measured over ALL 169 rows: not one of the 32 ids no row
  // self-identifies for ever has a row whose `model_name` contains it (the full
  // roster is frozen in `tools/test-catalog.ts`, `INTERNAL_ROSTER`). So the OR
  // cannot leak a component in; it can only stop losing a model.
  const chatModel: TraeModel = { ...merged, kind: 'chat' }
  // The reason belonged to the row that was reading a stale alias; keeping it on a
  // model the plugin will now publish would be a false accusation, and it must not
  // survive into `GET /models/all` either.
  delete chatModel.internalReason
  return chatModel
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
  // The ONE place where the merged roster becomes what the user may see and call:
  // the display names are made unique here, after the merge and before anything
  // downstream (the provider entry, /models/all, /v1/models, the read-only report)
  // can read a raw one. See the display-name section above.
  return { models: uniquifyDisplayNames([...byId.values()]), attempts }
}

/**
 * Reasoning mapping self-test — OFFLINE, no network, no quota, no credentials.
 *
 * It pins down the one rule this mapping lives or dies by: a thinking level is
 * written ONLY when the directory actually declared it. Everything else — an
 * absent block, a contradicting flag, a spelling we do not know, a malformed
 * response — must leave the field off, so the host keeps whatever capability its
 * installed catalog already knows instead of us downgrading a model to
 * non-reasoning.
 *
 * The samples are REAL entries captured from the live CN directory on
 * 2026-10-14 (`POST /api/ide/v1/get_detail_param`, all four functions). Two
 * opaque fields were dropped from each because they are huge and unread:
 * `model_detail_list[0].encrypted_model_params` and `model_detail_list[0].icon`.
 * `model_extra_config` is dropped for size. No field this code reads was edited.
 *
 * Ground truth for the emitted shape was taken from the host itself (read-only,
 * app.asar): `dsh-llm-pi-ai/lib/index.js:567-590` (declared efforts -> pi-ai
 * `thinkingLevelMap`), `:1001-1014` (the profile schema), `:382`/`:966` (the
 * `supportsReasoningEffort` gate), and `@earendil-works/pi-ai/dist/api/
 * openai-completions.js:712-716` (the branch that sends `reasoning_effort`).
 *
 * Run:  <dsh-node> tools/test-reasoning.ts        exit 0 = every check passed
 */
import type { TraeCredential } from '../src/auth.ts'
import type { TraeIdentity } from '../src/identity.ts'
import { FALLBACK_MODELS, fetchDirectoryModels, parseModel, parseReasoningEfforts } from '../src/catalog.ts'
import { buildProviderProfile, type ProviderProfileModel } from '../src/seed.ts'

let failures = 0
let passed = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failures += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
}

function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

// ---------------------------------------------------------------------- fixtures
/** Real directory entry, verbatim apart from the three omissions named above. */
const SEED_CODE = {
  config_name: 'Doubao-Seed-Code',
  config_source: 1,
  config_switch: true,
  context_window_tokens: { dev: 256000 },
  display_config: { display_name: 'Seed-Code', model_capability: 'reasoning_model', multimodal: true, is_custom_model: false, max_mode: false },
  display_contact_config:
    '{"access":{"data":{"identity_list":[0,5,1,2,3,100]}},"activity_discount":{"enable":true,"subKey":"subsidy_member_discount","data":{"current":{"discount_type":"subsidy","before_consumption_rate":0.12,"consumption_rate":0.06,"discount":50},"member":{"before_consumption_rate":0.12,"after_consumption_rate":0.03,"discount":25},"subsidy":{"before_consumption_rate":0.12,"after_consumption_rate":0.06,"discount":50}}},"consumption_rate":{"enable":true,"data":{"rate":0.06}},"multimodal":{"enable":true},"reasoning":{"enable":true}}',
  model_detail_list: [{ model_name: 'Doubao-Seed-Code__dev', prompt_max_tokens: 224000, max_tokens: 32000, max_turn: 500 }],
  reasoning_effort_config: { default_level: 'high', options: ['light', 'high'], support_thinking: true },
  // Verbatim from the live row. `usage` is the FIRST field the conversation-vs-internal
  // criterion reads (classifyDirectoryEntry, src/catalog.ts), so a partial copy that
  // omits it makes this real model look like a Trae internal component — which is
  // exactly what happened when this fixture first met the classifier.
  usage: 'chat_completion'
}

/** Same model id, but as `solo_work_remote` lists it: thinking off, no option list. */
const EVOLVING = {
  config_name: 'Doubao-Seed-Evolving',
  config_source: 1,
  config_switch: true,
  context_window_tokens: { dev: 256000 },
  display_config: { display_name: 'Seed-Evolving', model_capability: 'reasoning_model', multimodal: true, is_custom_model: false, max_mode: false },
  display_contact_config:
    '{"access":{"data":{"identity_list":[0,5,1,2,3,100]}},"consumption_rate":{"enable":true,"data":{"rate":0.08}},"multimodal":{"enable":true},"reasoning":{"enable":true}}',
  model_detail_list: [{ model_name: 'Doubao-Seed-Evolving__dev', prompt_max_tokens: 224000, max_tokens: 32000, max_turn: 500 }],
  reasoning_effort_config: { support_thinking: false },
  usage: 'chat_completion'
}

/**
 * The trap fixture: `display_contact_config` says `"reasoning":{"enable":true}`
 * while the entry declares no effort list at all. A feature flag is not a level
 * list, and treating one as the other is exactly the silent over-claim this test
 * exists to prevent.
 */
const GEMINI_CUSTOM = {
  config_name: 'custom_model_gemini',
  config_source: 1,
  config_switch: true,
  context_window_tokens: { dev: 300000, max: 300000 },
  display_config: { display_name: 'Gemini-3.1-Pro-Preview', model_capability: 'reasoning_model', multimodal: false, is_custom_model: false, max_mode: false },
  display_contact_config: '{"reasoning":{"enable":true},"access":{"data":{"identity_list":[0,5,1,2,3,100]}}}',
  model_detail_list: [{ model_name: 'custom_model_vercel_gemini__max', prompt_max_tokens: 268000, max_tokens: 32000, max_turn: 500 }]
}

/** The same id as SEED_CODE's sibling, listed by the other function WITH a list. */
const SEED_21_PRO_AGENT = {
  config_name: 'Doubao-Seed-2.1-Pro',
  config_source: 1,
  config_switch: true,
  context_window_tokens: { dev: 256000, max: 1000000 },
  display_config: { display_name: 'Seed-2.1-Pro-0915', model_capability: 'reasoning_model', multimodal: true, is_custom_model: false, max_mode: true },
  display_contact_config: '{"consumption_rate":{"enable":true,"data":{"rate":0.08}},"multimodal":{"enable":true},"reasoning":{"enable":true}}',
  model_detail_list: [{ model_name: 'Doubao-Seed-2.1-Pro__dev', prompt_max_tokens: 224000, max_tokens: 32000, max_turn: 500 }],
  reasoning_effort_config: { default_level: 'high', options: ['light', 'high'], support_thinking: true },
  // Real row, real `usage` (see the note in SEED_CODE). `custom_model_gemini`'s row
  // above deliberately keeps the live `custom_model` usage instead, because it IS one
  // of the 32 internal components — so the two ends of the classification are both
  // present in this one directory union.
  usage: 'chat_completion'
}

/** The same id as SEED_21_PRO_AGENT, but `solo_work_remote` is asked first. */
const SEED_21_PRO_WORK = { ...SEED_21_PRO_AGENT, context_window_tokens: { dev: 256000 }, display_config: { ...SEED_21_PRO_AGENT.display_config, max_mode: false }, reasoning_effort_config: { support_thinking: false } }

const CREDENTIAL = { id: 'test', edition: 'cn', region: 'cn', source: 'own', storagePath: '', userId: '0', host: '', expiresAtMs: 0, accessToken: 'test-token' } as TraeCredential
const IDENTITY = { edition: 'cn', machineId: 'test-machine', deviceId: 'test-device', appVersion: '0.0.0' } as TraeIdentity

// ------------------------------------------------------- 1. parse real samples
console.log('\n[1] real directory entries -> thinking levels')
check('Seed-Code declares light+high', same(parseReasoningEfforts(SEED_CODE), { low: 'light', high: 'high' }), JSON.stringify(parseReasoningEfforts(SEED_CODE)))
check('Seed-2.1-Pro (solo_agent_remote) declares light+high', same(parseReasoningEfforts(SEED_21_PRO_AGENT), { low: 'light', high: 'high' }))
check('support_thinking:false alone -> NO field', parseReasoningEfforts(EVOLVING) === undefined)
check('reasoning.enable=true without an option list -> NO field', parseReasoningEfforts(GEMINI_CUSTOM) === undefined)
check('missing reasoning_effort_config key -> NO field', parseReasoningEfforts({ config_name: 'x', model_detail_list: [{}] }) === undefined)

// ------------------------------------------------- 2. never guess (fail closed)
console.log('\n[2] unreadable or unknown shapes -> NO field')
check('unknown wire spellings only -> NO field', parseReasoningEfforts({ reasoning_effort_config: { options: ['ultra', 'medium'], support_thinking: true } }) === undefined)
check('option list beside support_thinking:false -> NO field (contradiction is not a licence)', parseReasoningEfforts({ reasoning_effort_config: { options: ['high'], support_thinking: false } }) === undefined)
check('options not an array -> NO field', parseReasoningEfforts({ reasoning_effort_config: { options: 'light' } }) === undefined)
check('empty options -> NO field', parseReasoningEfforts({ reasoning_effort_config: { options: [], support_thinking: true } }) === undefined)
check('entry null / string / array -> NO field, no throw', [parseReasoningEfforts(null), parseReasoningEfforts('x'), parseReasoningEfforts([1, 2])].every((value) => value === undefined))
check('non-string members ignored, the rest survive', same(parseReasoningEfforts({ reasoning_effort_config: { options: [7, 'light', null, 'high'] } }), { low: 'light', high: 'high' }))
check('duplicate spelling -> one key', same(parseReasoningEfforts({ reasoning_effort_config: { options: ['high', 'high'] } }), { high: 'high' }))
check('extra_high is Trae\'s xhigh spelling', same(parseReasoningEfforts({ reasoning_effort_config: { options: ['extra_high', 'light'] } }), { xhigh: 'extra_high', low: 'light' }))
check('block nested in model_detail_list[0] is read too', same(parseReasoningEfforts({ model_detail_list: [{ reasoning_effort_config: { options: ['high'] } }] }), { high: 'high' }))
check('default_level is NOT turned into a level on its own', parseReasoningEfforts({ reasoning_effort_config: { default_level: 'high', support_thinking: true } }) === undefined)

// ------------------------------------------------ 3. entry -> TraeModel -> row
console.log('\n[3] one entry, end to end: parseModel -> buildProviderProfile')
const codeModel = parseModel(SEED_CODE, 'solo_agent_remote')
const evolvingModel = parseModel(EVOLVING, 'solo_work_remote')
check('parseModel keeps the model identity', codeModel?.id === 'Doubao-Seed-Code' && codeModel?.name === 'Seed-Code', JSON.stringify(codeModel))
check('parseModel carries contextWindow/maxTokens', codeModel?.contextWindow === 224000 && codeModel?.maxTokens === 32000)
check('parseModel carries the parsed levels', same(codeModel?.reasoningEfforts, { low: 'light', high: 'high' }))
check('a model with no declared levels has NO key at all', evolvingModel !== undefined && !('reasoningEfforts' in evolvingModel), JSON.stringify(evolvingModel))
check('parseModel rejects an entry with no config_name', parseModel({ display_config: {} }, 'solo_work_remote') === undefined)
// Both of these are REAL conversation models, and the classification has to agree: a
// model that reaches the profile builder must carry `kind: 'chat'` or the builder
// (correctly) refuses to write it. Pinned here because a fixture that drifts back to
// a partial copy of the live row fails at a distance, in a different suite.
check('both real samples are classified chat', codeModel?.kind === 'chat' && evolvingModel?.kind === 'chat', JSON.stringify([codeModel?.kind, codeModel?.internalReason]))
// The image claim is READ (from display_config, where the live entry really keeps
// it) but never turned into an `image` modality — see section [7].
const geminiModel = parseModel(GEMINI_CUSTOM, 'solo_work_remote')
check('parseModel records the directory\'s image claim', evolvingModel?.multimodal === true && codeModel?.multimodal === true, JSON.stringify({ evolving: evolvingModel?.multimodal, code: codeModel?.multimodal }))
check('a row that says multimodal:false records the false (three-state)', geminiModel !== undefined && geminiModel.multimodal === false, JSON.stringify(geminiModel))
check('a row that says nothing leaves the field absent', !('multimodal' in (parseModel({ config_name: 'x', display_config: {} }, 'solo_work_remote') ?? {})))
check('the documented top-level fallback still answers (it never fires on live data)', parseModel({ config_name: 'x', multimodal: true }, 'solo_work_remote')?.multimodal === true)

const profile = buildProviderProfile({ displayName: 'Trae', baseUrl: 'http://127.0.0.1:7864', token: 'test-token', models: [codeModel!, evolvingModel!] })
const codeRow = profile.models.find((row) => row.id === 'Doubao-Seed-Code')
const evolvingRow = profile.models.find((row) => row.id === 'Doubao-Seed-Evolving')
check('reasoning row declares off:null plus the parsed levels', same(codeRow?.reasoningEfforts, { off: null, low: 'light', high: 'high' }), JSON.stringify(codeRow?.reasoningEfforts))
check('reasoning row turns the wire switch on', same(codeRow?.compat, { supportsReasoningEffort: true }))
check('non-reasoning row carries neither field', evolvingRow !== undefined && !('reasoningEfforts' in evolvingRow) && !('compat' in evolvingRow), JSON.stringify(evolvingRow))
check('the rest of the row is untouched', codeRow?.name === 'Seed-Code' && codeRow?.contextWindow === 224000 && codeRow?.maxTokens === 32000 && same(codeRow?.input, ['text']))
check('off:null survives the JSON the patch is written from', JSON.parse(JSON.stringify(profile)).models[0].reasoningEfforts.off === null)
check('nothing in the static fallback roster claims a level', FALLBACK_MODELS.cn.every((model) => model.reasoningEfforts === undefined))

// --------------------------------------------- 4. the shape the host will accept
console.log('\n[4] every emitted field is one the host schema declares')
/** dsh-llm-pi-ai/lib/index.js:1003-1010 — `modelFields` plus the required `id`. */
const HOST_MODEL_FIELDS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'])
/** dsh-llm-pi-ai/lib/index.js:966 — `compatProfile`. */
const HOST_COMPAT_FIELDS = new Set(['supportsReasoningEffort'])
/** dsh-llm-pi-ai/lib/index.js:296 — `THINKING_LEVELS`. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const unknownRowKeys = profile.models.flatMap((row) => Object.keys(row).filter((key) => !HOST_MODEL_FIELDS.has(key)))
const unknownCompatKeys = profile.models.flatMap((row) => Object.keys(row.compat ?? {}).filter((key) => !HOST_COMPAT_FIELDS.has(key)))
check('no unknown field on any model row', unknownRowKeys.length === 0, unknownRowKeys.join(','))
check('no unknown compat switch', unknownCompatKeys.length === 0, unknownCompatKeys.join(','))
check('compat is only ever written for a reasoning row', profile.models.every((row) => (row.compat === undefined) === (row.reasoningEfforts === undefined)))

const effortRows = profile.models.filter((row) => row.reasoningEfforts !== undefined)
const badLevelKeys = effortRows.flatMap((row) => Object.keys(row.reasoningEfforts!).filter((key) => !THINKING_LEVELS.includes(key)))
check('level keys come from pi-ai\'s own list', badLevelKeys.length === 0, badLevelKeys.join(','))
/** dsh-llm-pi-ai/lib/index.js:571-579: only `off` may be valueless, and a model must offer a thinking level beyond it. */
check('only "off" carries a null wire value', effortRows.every((row) => Object.entries(row.reasoningEfforts!).every(([level, wire]) => (wire === null ? level === 'off' : typeof wire === 'string' && wire.length > 0))))
check('every reasoning row offers a level beyond "off"', effortRows.every((row) => Object.keys(row.reasoningEfforts!).some((level) => level !== 'off')))
check('capacities stay positive integers', profile.models.every((row) => [row.contextWindow, row.maxTokens].every((value) => value === undefined || (Number.isInteger(value) && value > 0))))
check('input modalities stay inside pi-ai\'s list', profile.models.every((row) => (row.input ?? []).every((modality) => modality === 'text' || modality === 'image')))

// ------------------------------------------------- 5. the union over functions
console.log('\n[5] the whole directory, through the real fetch path (stub transport)')
const DOCUMENTS: Record<string, unknown> = {
  solo_work_remote: { config_info_list: [SEED_21_PRO_WORK, EVOLVING, GEMINI_CUSTOM] },
  solo_agent_remote: { config_info_list: [SEED_CODE, SEED_21_PRO_AGENT] }
}
const seenFunctions: string[] = []
const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const fn = String(JSON.parse(String(init?.body ?? '{}'))['function'] ?? '')
  seenFunctions.push(fn)
  const document = DOCUMENTS[fn]
  // chat_v3 / solo_coder are deliberately absent: a failing function must not
  // cost the roster the models another one already returned.
  return document === undefined ? new Response('not captured', { status: 404 }) : new Response(JSON.stringify(document), { status: 200 })
}) as unknown as typeof fetch

const union = await fetchDirectoryModels('cn', CREDENTIAL, IDENTITY, { fetchImpl })
const byId = new Map(union.models.map((model) => [model.id, model]))
check('all four functions were asked', same(seenFunctions, ['solo_work_remote', 'solo_agent_remote', 'chat_v3', 'solo_coder']), seenFunctions.join(','))
check('a 404 function is recorded, not fatal', union.attempts.filter((attempt) => attempt.status === 404).length === 2 && union.models.length === 4, JSON.stringify(union.attempts))
check('Seed-Code comes out with its levels', same(byId.get('Doubao-Seed-Code')?.reasoningEfforts, { low: 'light', high: 'high' }))
check('the quiet entries stay quiet', byId.get('Doubao-Seed-Evolving')?.reasoningEfforts === undefined && byId.get('custom_model_gemini')?.reasoningEfforts === undefined)
/**
 * Cross-function merge (2026-10-14 决定，规则见 catalog.ts 的 mergeRicher)：
 *   · function 归属仍 first-wins —— wire resolution 要靠它决定用哪条通道；
 *   · 但这一行**没说**的字段，由后列的那一行补进来；
 *   · 两边都说了就保留 first-wins 的值，一个字都不覆盖。
 *
 * 这个 id 正好是最典型的例子：`solo_work_remote` 先列出它（只有
 * `support_thinking:false`，没有档位），`solo_agent_remote` 后列出它并给了
 * light+high —— 合并前这两行永远丢掉档位，合并后既保住通道又拿回档位。
 */
const contested = byId.get('Doubao-Seed-2.1-Pro')
check(
  'a contested id keeps its first function but gains the later row\'s levels',
  contested?.directoryFunction === 'solo_work_remote' && contested?.reasoningEfforts?.low === 'light' && contested?.reasoningEfforts?.high === 'high',
  JSON.stringify(contested)
)
check('the merge never overwrites a value the first row already stated', contested?.contextWindow === 224000 && contested?.maxTokens === 32000, JSON.stringify({ ctx: contested?.contextWindow, max: contested?.maxTokens }))

const unionProfile = buildProviderProfile({ displayName: 'Trae', baseUrl: 'http://127.0.0.1:7864', token: 'test-token', models: union.models })
const reasoningRows = unionProfile.models.filter((row) => row.reasoningEfforts !== undefined)
check('exactly the merged models get a reasoning row', reasoningRows.length === 2 && reasoningRows.map((row) => row.id).sort().join(',') === 'Doubao-Seed-2.1-Pro,Doubao-Seed-Code', reasoningRows.map((row) => row.id).join(','))
check('the other rows are byte-identical to a no-reasoning build', same(unionProfile.models.filter((row) => row.reasoningEfforts === undefined), buildProviderProfile({ displayName: 'x', baseUrl: 'b', token: 't', models: union.models.filter((model) => model.id !== 'Doubao-Seed-Code' && model.id !== 'Doubao-Seed-2.1-Pro') }).models))
// The same union, seen through the classification: the two real models reach the
// profile, and the one internal component (`custom_model_gemini` — usage
// `custom_model`, one of the 32 measured on 2026-10-16) stops at the catalogue.
check('the union carries both verdicts, and only the chat half reaches the profile', byId.get('Doubao-Seed-2.1-Pro')?.kind === 'chat' && byId.get('Doubao-Seed-Code')?.kind === 'chat' && byId.get('custom_model_gemini')?.kind === 'internal', JSON.stringify([...byId.values()].map((model) => `${model.id}:${model.kind}`)))
check('...so the profile has 3 rows, not 4', unionProfile.models.length === 3 && !unionProfile.models.some((row) => row.id === 'custom_model_gemini'), unionProfile.models.map((row) => row.id).join(','))

const typedRows: ProviderProfileModel[] = unionProfile.models
check('the profile type still accepts every row', typedRows.length === unionProfile.models.length)

// ------------------------------------------- 6. the merge rule, one case at a time
console.log('\n[6] cross-function merge: fill a gap, never overwrite a statement')
/** Synthetic twin rows for the SAME id, shaped so each rule is observable alone. */
const THIN = { config_name: 'merge-probe', display_config: { display_name: 'Merge Probe' }, reasoning_effort_config: { options: ['light'], support_thinking: true } }
const FAT = {
  config_name: 'merge-probe',
  display_config: { display_name: 'Merge Probe', multimodal: true },
  context_window_tokens: { dev: 128000 },
  model_detail_list: [{ prompt_max_tokens: 64000, max_tokens: 4096 }],
  reasoning_effort_config: { options: ['extra_high', 'high'], support_thinking: true }
}
const WIDE = { config_name: 'merge-probe', display_config: { display_name: 'Merge Probe' }, context_window_tokens: { dev: 300000 }, model_detail_list: [{ prompt_max_tokens: 300000, max_tokens: 8192 }] }
/** Declares text-only. On live data this is what `minimax-m3` / `custom_model_*` do. */
const TEXT_ONLY = { config_name: 'merge-probe', display_config: { display_name: 'Merge Probe', multimodal: false } }

async function mergeWith(documents: Record<string, unknown>): Promise<import('../src/catalog.ts').TraeModel> {
  const impl = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const fn = String(JSON.parse(String(init?.body ?? '{}'))['function'] ?? '')
    const document = documents[fn]
    return document === undefined ? new Response('absent', { status: 404 }) : new Response(JSON.stringify(document), { status: 200 })
  }) as unknown as typeof fetch
  const result = await fetchDirectoryModels('cn', CREDENTIAL, IDENTITY, { fetchImpl: impl })
  const model = result.models[0]
  if (model === undefined) throw new Error('merge fixture produced no model')
  return model
}

const singleFunction = await mergeWith({ solo_work_remote: { config_info_list: [THIN] } })
check('one function only: the row is byte-identical to parseModel', same(singleFunction, parseModel(THIN, 'solo_work_remote')), JSON.stringify(singleFunction))

const filled = await mergeWith({ solo_work_remote: { config_info_list: [THIN] }, solo_agent_remote: { config_info_list: [FAT] } })
check('the first function still owns the id', filled.directoryFunction === 'solo_work_remote', filled.directoryFunction)
check('the later row fills the capacities it stated', filled.contextWindow === 64000 && filled.maxTokens === 4096, JSON.stringify({ contextWindow: filled.contextWindow, maxTokens: filled.maxTokens }))
check('the later row fills the image claim it stated', filled.multimodal === true)
check('a field the first row already stated is NOT topped up', same(filled.reasoningEfforts, { low: 'light' }), JSON.stringify(filled.reasoningEfforts))

const stated = await mergeWith({ solo_work_remote: { config_info_list: [WIDE] }, solo_agent_remote: { config_info_list: [FAT] } })
check('a stated capacity is never replaced by a conflicting one', stated.contextWindow === 300000 && stated.maxTokens === 8192, JSON.stringify({ contextWindow: stated.contextWindow, maxTokens: stated.maxTokens }))

const richFirst = await mergeWith({ solo_work_remote: { config_info_list: [FAT] }, solo_agent_remote: { config_info_list: [THIN] } })
check('a richer first row is left exactly as it was', richFirst.directoryFunction === 'solo_work_remote' && richFirst.multimodal === true && same(richFirst.reasoningEfforts, { xhigh: 'extra_high', high: 'high' }) && richFirst.contextWindow === 64000, JSON.stringify(richFirst))

/** 三态：`false` 是"声明了不支持"，后列的 `true` 不许改写它（宁可漏报，不可谎报）。 */
const declaredTextOnly = await mergeWith({ solo_work_remote: { config_info_list: [TEXT_ONLY] }, solo_agent_remote: { config_info_list: [FAT] } })
check('a declared multimodal:false is NOT overwritten by a later true', declaredTextOnly.multimodal === false, JSON.stringify(declaredTextOnly))
const declaredByLater = await mergeWith({ solo_work_remote: { config_info_list: [THIN] }, solo_agent_remote: { config_info_list: [TEXT_ONLY] } })
check('an undeclared first row accepts a later boolean (false too)', declaredByLater.multimodal === false, JSON.stringify(declaredByLater))
check('the id still belongs to the first function in both cases', declaredTextOnly.directoryFunction === 'solo_work_remote' && declaredByLater.directoryFunction === 'solo_work_remote')

// ------------------------------------------ 7. the deferral that must not slip
console.log('\n[7] image input stays declared-off until the shim can translate one')
check('no provider row advertises image', unionProfile.models.every((row) => !(row.input ?? []).includes('image')))
check('a multimodal model still ships as text-only', codeModel?.multimodal === true && same(codeModel?.input, ['text']), JSON.stringify({ multimodal: codeModel?.multimodal, input: codeModel?.input }))
check('catalog keeps the image claim for the day the shim lands', parseModel(SEED_CODE, 'solo_agent_remote')?.multimodal === true)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}  (${passed}/${passed + failures})`)
process.exit(failures === 0 ? 0 : 1)

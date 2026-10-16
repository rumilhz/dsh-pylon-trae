/**
 * `src/catalog.ts` self-test — OFFLINE. No network, no credentials, no quota.
 *
 * It pins the ONE judgement this plugin makes about the Trae directory: which
 * `config_name`s are conversation models and which are Trae IDE's own internal
 * workflow components (`title_generation` · `fast_apply` · the `custom_model_*`
 * placeholders · the `*_advisor` / `search_agent_*` aliases). Getting this wrong is
 * what put 32 junk rows into the user's「设置 → 模型」list.
 *
 * ## Where the samples come from
 *
 * `LIVE_CN_ROWS` below is the REAL measurement, taken from the CN gateway on
 * 2026-10-16 with `tools/probe-m1.ts`-style read-only requests: all four directory
 * functions (`solo_work_remote` 45 rows · `solo_agent_remote` 37 · `chat_v3` 46 ·
 * `solo_coder` 41) were asked, and the 169 rows collapsed to **79 distinct
 * `config_name`s**. For each of the 79 the table carries the three fields that
 * matter, copied verbatim:
 *
 *   · `config_name`
 *   · `usage`                            — Trae's declared purpose (rule ①)
 *   · `model_detail_list[0].model_name`  — the name Trae really sends upstream (rule ②)
 *
 * Four more rows carry the WHOLE entry, as the gateway answered it, with two fields
 * elided and named here so nobody has to take it on faith: `encrypted_model_params`
 * (an opaque multi-KiB blob nothing in this plugin reads) and
 * `display_contact_config` (a JSON string of billing/access hints, also unread).
 * `model_extra_config` and `icon` are kept on those four; they are large but they
 * are part of the real shape.
 *
 * ## What "the expected verdict" means
 *
 * `LIVE_CN_ROWS`'s 4th column is the expectation, and it is not a second opinion:
 * it is the classification the criterion must produce, and the counts it produces
 * (32 internal / 47 chat) are the ones reported to the requester. If a future
 * Trae change makes a row flip, this suite goes red and the flip gets looked at,
 * which is the entire point of freezing the measurement here.
 *
 * Run:  <dsh-node> tools/test-catalog.ts
 */
import {
  classifyDirectoryEntry,
  FALLBACK_MODELS,
  fetchDirectoryModels,
  parseModel,
  partitionModels,
  TRAE_CHAT_USAGE,
  TRAE_INTERNAL_KINDS_DOC,
  wireModelName,
  type TraeModel
} from '../src/catalog.ts'
import type { TraeCredential } from '../src/auth.ts'
import type { TraeIdentity } from '../src/identity.ts'

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!condition) failures += 1
}

/** One measured row: [config_name, usage, model_name, expected verdict]. */
type LiveRow = readonly [string, string, string, 'chat' | 'internal']

/* ───────────────── the 32 internal components (measured) ───────────────── */
const LIVE_CN_INTERNAL: readonly LiveRow[] = [
  ['browser_use_subagent', 'chat_completion', 'browser_use_model__dev', 'internal'],
  ['custom_model_1M', 'custom_model', 'custom_model_1M__dev', 'internal'],
  ['custom_model_1M_text', 'custom_model', 'custom_model_1M_text__dev', 'internal'],
  ['custom_model_200k', 'custom_model', 'custom_model_200k__dev', 'internal'],
  ['custom_model_200k_text', 'custom_model', 'custom_model_200k_text__dev', 'internal'],
  ['custom_model_claude', 'custom_model', 'custom_model_claude__dev', 'internal'],
  ['custom_model_deepseek_chat', 'custom_model', 'custom_model_deepseek_chat__dev', 'internal'],
  ['custom_model_deepseek_reasoner', 'custom_model', 'custom_model_deepseek_reasoner__dev', 'internal'],
  ['custom_model_deepseek_v4', 'custom_model', 'custom_model_deepseek_reasoner__dev', 'internal'],
  ['custom_model_doubao_1M', 'custom_model', 'custom_model_doubao_1M__dev', 'internal'],
  ['custom_model_doubao_256k', 'custom_model', 'custom_model_doubao_256k__dev', 'internal'],
  ['custom_model_gemini', 'custom_model', 'custom_model_gemini__dev', 'internal'],
  ['custom_model_gpt-5', 'custom_model', 'custom_model_gpt-5__dev', 'internal'],
  ['custom_model_gpt-6', 'custom_model', 'custom_model_gpt-6__dev', 'internal'],
  ['custom_model_kimi', 'custom_model', 'custom_model_placeholder__dev', 'internal'],
  ['custom_model_no-fc', 'custom_model', 'custom_model_no-fc__max', 'internal'],
  ['custom_model_placeholder', 'custom_model', 'custom_model_placeholder__dev', 'internal'],
  ['custom_model_vercel', 'custom_model', 'custom_model_placeholder__dev', 'internal'],
  ['custom_model_vercel_gemini', 'custom_model', 'custom_model_placeholder__dev', 'internal'],
  ['explore_sub_agent_v2', 'chat_completion', 'qwen-3.6-explore-agent__dev', 'internal'],
  ['fast_apply', 'fast_apply', 'fast_apply', 'internal'],
  ['fast_apply_new', 'fast_apply_new', 'fast_apply_new', 'internal'],
  ['file_search_agent', 'chat_completion', 'file-search-qwen3.6__dev', 'internal'],
  ['glm-5.1_advisor', 'chat_completion', 'glm-5.1__dev', 'internal'],
  ['glm-5.2_advisor_default', 'chat_completion', 'glm-5.2__dev', 'internal'],
  ['glm-5.2_advisor_doubao', 'chat_completion', 'glm-5.2__dev', 'internal'],
  ['input_optimization', 'input_optimization', 'no_thinking_model', 'internal'],
  ['search_agent_qwen_fast', 'chat_completion', 'search_agent_model__max', 'internal'],
  ['search_agent_qwen_fast-0710', 'chat_completion', 'search_agent_model__dev', 'internal'],
  ['seed-code-pro-0430', 'chat_completion', 'Doubao-Seed-2.1-Pro__dev', 'internal'],
  ['summary', 'summary', 'Doubao_1_6', 'internal'],
  ['title_generation', 'title_generation', 'no_thinking_model', 'internal']
]

/* ───────────────── the 47 conversation models (measured) ───────────────── */
const LIVE_CN_CHAT: readonly LiveRow[] = [
  ['aquila', 'chat_completion', 'aquila__dev', 'chat'],
  ['DeepSeek-V4-Flash', 'chat_completion', 'DeepSeek-V4-Flash__dev', 'chat'],
  ['DeepSeek-V4-Flash-Official', 'chat_completion', 'DeepSeek-V4-Flash-Official__dev', 'chat'],
  ['DeepSeek-V4-Pro', 'chat_completion', 'DeepSeek-V4-Pro__dev', 'chat'],
  ['DeepSeek-V4-Pro-Official', 'chat_completion', 'DeepSeek-V4-Pro-Official__dev', 'chat'],
  ['deepseek-v4.1-flash', 'chat_completion', 'deepseek-v4.1-flash__dev', 'chat'],
  ['Doubao_1_6', 'chat_completion', 'Doubao_1_6__max', 'chat'],
  ['doubao-for-auto', 'chat_completion', 'doubao-for-auto__max', 'chat'],
  ['Doubao-Seed-2.0-Code', 'chat_completion', 'Doubao-Seed-2.0-Code__max', 'chat'],
  ['Doubao-Seed-2.0-Code-auto', 'chat_completion', 'Doubao-Seed-2.0-Code-auto__max', 'chat'],
  ['Doubao-Seed-2.1-Pro', 'chat_completion', 'Doubao-Seed-2.1-Pro__dev', 'chat'],
  ['Doubao-Seed-2.1-Turbo', 'chat_completion', 'Doubao-Seed-2.1-Turbo__dev', 'chat'],
  ['Doubao-Seed-Code', 'chat_completion', 'Doubao-Seed-Code__max', 'chat'],
  ['Doubao-Seed-Evolving', 'chat_completion', 'Doubao-Seed-Evolving__dev', 'chat'],
  ['glm-4.6', 'chat_completion', 'glm-4.6__dev', 'chat'],
  ['glm-4.6-auto', 'chat_completion', 'glm-4.6-auto__max', 'chat'],
  ['glm-4.7', 'chat_completion', 'glm-4.7__dev', 'chat'],
  ['glm-4.7-auto', 'chat_completion', 'glm-4.7-auto__max', 'chat'],
  ['glm-5', 'chat_completion', 'glm-5__dev', 'chat'],
  ['glm-5-turbo', 'chat_completion', 'glm-5-turbo__dev', 'chat'],
  ['glm-5.1', 'chat_completion', 'glm-5.1__dev', 'chat'],
  ['glm-5.2', 'chat_completion', 'glm-5.2__dev', 'chat'],
  ['glm-5.3', 'chat_completion', 'glm-5.3__dev', 'chat'],
  ['glm-5.3-flash', 'chat_completion', 'glm-5.3-flash__dev', 'chat'],
  ['glm-5.3-flashx', 'chat_completion', 'glm-5.3-flashx__dev', 'chat'],
  ['glm-5v-turbo', 'chat_completion', 'glm-5v-turbo__dev', 'chat'],
  ['kimi-k2', 'chat_completion', 'kimi-k2__dev', 'chat'],
  ['kimi-k2-0905', 'chat_completion', 'kimi-k2-0905__dev', 'chat'],
  ['kimi-k2.5', 'chat_completion', 'kimi-k2.5__dev', 'chat'],
  ['kimi-k2.6', 'chat_completion', 'kimi-k2.6__dev', 'chat'],
  ['kimi-k2.7-code', 'chat_completion', 'kimi-k2.7-code__dev', 'chat'],
  ['kimi-k3', 'chat_completion', 'kimi-k3__dev', 'chat'],
  ['mimo-v2.6-flash', 'chat_completion', 'mimo-v2.6-flash__dev', 'chat'],
  ['mimo-v2.6-pro', 'chat_completion', 'mimo-v2.6-pro__dev', 'chat'],
  ['minimax-m2', 'chat_completion', 'minimax-m2__dev', 'chat'],
  ['minimax-m2-auto', 'chat_completion', 'minimax-m2-auto__max', 'chat'],
  ['minimax-m2.1', 'chat_completion', 'minimax-m2.1__dev', 'chat'],
  ['minimax-m2.1-auto', 'chat_completion', 'minimax-m2.1-auto__max', 'chat'],
  ['minimax-m2.7', 'chat_completion', 'minimax-m2.7__dev', 'chat'],
  ['minimax-m3', 'chat_completion', 'minimax-m3__dev', 'chat'],
  ['qwen-3.5', 'chat_completion', 'qwen-3.5__dev', 'chat'],
  ['qwen-3.6-plus', 'chat_completion', 'qwen-3.6-plus__dev', 'chat'],
  ['qwen-3.7-plus', 'chat_completion', 'qwen-3.7-plus__dev', 'chat'],
  ['qwen3-coder', 'chat_completion', 'openai_qwen3-coder-plus__dev', 'chat'],
  ['qwen3.8-max', 'chat_completion', 'qwen3.8-max__dev', 'chat'],
  ['sagitta', 'chat_completion', 'sagitta__dev', 'chat'],
  ['step-5-preview', 'chat_completion', 'step-5-preview__dev', 'chat']
]

const LIVE_CN_ROWS: readonly LiveRow[] = [...LIVE_CN_INTERNAL, ...LIVE_CN_CHAT]

/** Build the entry shape the classifier reads, from one measured row. */
function rowEntry(row: LiveRow): Record<string, unknown> {
  return { config_name: row[0], usage: row[1], model_detail_list: [{ model_name: row[2] }] }
}

/* ───────────────────────── 1. the live samples ───────────────────────── */
console.log('\n[1] the 79 measured config_names, judged one by one')
check(`the frozen measurement is 79 rows (32 internal + 47 chat)`, LIVE_CN_ROWS.length === 79 && LIVE_CN_INTERNAL.length === 32 && LIVE_CN_CHAT.length === 47, `${LIVE_CN_ROWS.length} = ${LIVE_CN_INTERNAL.length} + ${LIVE_CN_CHAT.length}`)
check('...and the ids are distinct', new Set(LIVE_CN_ROWS.map((row) => row[0])).size === 79)

{
  const wrong = LIVE_CN_INTERNAL.filter((row) => classifyDirectoryEntry(rowEntry(row), row[0]).kind !== 'internal')
  check(`every one of the ${LIVE_CN_INTERNAL.length} internal samples is judged internal`, wrong.length === 0, wrong.map((row) => row[0]).join('、'))
  const wrongChat = LIVE_CN_CHAT.filter((row) => classifyDirectoryEntry(rowEntry(row), row[0]).kind !== 'chat')
  check(`every one of the ${LIVE_CN_CHAT.length} chat samples is judged chat`, wrongChat.length === 0, wrongChat.map((row) => row[0]).join('、'))
  check('...i.e. 47 stayed and 32 went', LIVE_CN_ROWS.filter((row) => classifyDirectoryEntry(rowEntry(row), row[0]).kind === 'chat').length === 47)
}

// The six the requester named, checked by name so a regression names itself.
console.log('\n[2] the six components the requester named are all internal')
for (const id of ['title_generation', 'input_optimization', 'fast_apply', 'search_agent_qwen_fast', 'custom_model_gpt-6', 'glm-5.2_advisor_doubao']) {
  const row = LIVE_CN_ROWS.find((candidate) => candidate[0] === id)
  const verdict = row === undefined ? undefined : classifyDirectoryEntry(rowEntry(row), row[0])
  check(`${id} -> internal`, verdict?.kind === 'internal', verdict === undefined ? 'NOT IN THE MEASUREMENT' : String(verdict.internalReason))
}

console.log('\n[3] real conversation models are NOT filtered away')
for (const id of ['glm-5.2', 'kimi-k2.6', 'qwen3-coder', 'kimi-k2']) {
  const row = LIVE_CN_ROWS.find((candidate) => candidate[0] === id)
  const verdict = row === undefined ? undefined : classifyDirectoryEntry(rowEntry(row), row[0])
  check(`${id} -> chat`, verdict?.kind === 'chat', verdict === undefined ? 'NOT IN THE MEASUREMENT' : String(verdict.internalReason))
}
{
  // The two that the REMOTE user-facing directory would have dropped — they are real
  // models Trae retired from its own picker while the account can still call them.
  // The criterion must keep them; that is the regression the design note records.
  for (const id of ['glm-4.6', 'minimax-m2.1']) {
    const row = LIVE_CN_ROWS.find((candidate) => candidate[0] === id)
    check(`${id}（Trae 已从自己的选择器下架，但账户仍可调用）-> chat`, row !== undefined && classifyDirectoryEntry(rowEntry(row), row[0]).kind === 'chat')
  }
  // `qwen3-coder`'s wire name is `openai_qwen3-coder-plus__dev`: the config_name is a
  // SUFFIX of it, not a prefix. A `startsWith` rule would have hidden a real model.
  const coder = LIVE_CN_CHAT.find((row) => row[0] === 'qwen3-coder')!
  check('the match is containment, not a prefix (qwen3-coder)', classifyDirectoryEntry(rowEntry(coder), coder[0]).kind === 'chat')
}

console.log('\n[4] the frozen id list matches the code\'s own record')
{
  const judged = LIVE_CN_INTERNAL.map((row) => row[0]).sort()
  const documented = [...TRAE_INTERNAL_KINDS_DOC].sort()
  check('TRAE_INTERNAL_KINDS_DOC is exactly the 32 judged ids', JSON.stringify(judged) === JSON.stringify(documented), `${judged.length} vs ${documented.length}`)
  check('TRAE_CHAT_USAGE is the one wire value Trae uses for a conversation', TRAE_CHAT_USAGE === 'chat_completion')
}

/* ─────────────────── 5. whole real entries through parseModel ─────────────────── */
console.log('\n[5] parseModel on WHOLE entries as the gateway answered them')
{
  // `glm-5.2`, verbatim except `encrypted_model_params` / `display_contact_config`.
  const glm = {
    config_name: 'glm-5.2',
    config_source: 1,
    config_switch: true,
    context_window_tokens: { dev: 116000 },
    display_config: {
      can_use_super_model: false,
      commercial_info: { info: '', manual_usage: 0 },
      display_name: 'GLM-5.2',
      fee_model_level: 2,
      is_beta: false,
      is_custom_model: false,
      is_new: false,
      max_mode: false,
      memory_display_config: {},
      model_capability: 'reasoning_model',
      multimodal: false,
      tags: []
    },
    extra_config: '{"apply_file_path":true,"is_new_pe":true,"native_function_call":true,"use_v2_process":true}',
    is_default: false,
    is_invisible_to_user: false,
    model_detail_list: [
      {
        max_tokens: 16000,
        max_turn: 70,
        model_entitlement_usage_cost: 1,
        model_name: 'glm-5.2__dev',
        prompt_max_tokens: 100000,
        tool_call_history_max_tokens: 0
      }
    ],
    usage: 'chat_completion'
  }
  const parsedGlm = parseModel(glm, 'solo_work_remote')
  check('a real chat entry keeps its id/name/window', parsedGlm?.id === 'glm-5.2' && parsedGlm.name === 'GLM-5.2' && parsedGlm.contextWindow === 100000 && parsedGlm.maxTokens === 16000)
  check('...and is classified chat, with no reason attached', parsedGlm?.kind === 'chat' && parsedGlm.internalReason === undefined, JSON.stringify(parsedGlm?.internalReason))
  check('...and the reason field is ABSENT, not an empty string', parsedGlm !== undefined && !('internalReason' in parsedGlm))

  // `title_generation`, verbatim except the two elided fields. Note it has NO
  // `display_config.display_name` at all — Trae never gave this component a name.
  const title = {
    config_name: 'title_generation',
    config_source: 1,
    config_switch: true,
    context_window_tokens: { dev: 44096 },
    display_config: { can_use_super_model: false, commercial_info: { manual_usage: 1 }, display_name: '', fee_model_level: 2, is_custom_model: false, memory_display_config: {}, model_capability: '', tags: [] },
    extra_config: 'null',
    is_default: false,
    model_detail_list: [{ max_tokens: 128, max_turn: 1, model_entitlement_usage_cost: 1, model_name: 'no_thinking_model', prompt_max_tokens: 44096, tool_call_history_max_tokens: 0 }],
    usage: 'title_generation'
  }
  const parsedTitle = parseModel(title, 'chat_v3')
  check('a real internal entry is classified internal', parsedTitle?.kind === 'internal', String(parsedTitle?.internalReason))
  check('...and the reason quotes Trae\'s own usage word', parsedTitle?.internalReason?.includes('title_generation') === true, String(parsedTitle?.internalReason))

  // `search_agent_qwen_fast`: usage IS chat_completion, so only rule ② catches it.
  const search = {
    config_name: 'search_agent_qwen_fast',
    config_source: 1,
    config_switch: true,
    context_window_tokens: { dev: 184000, max: 184000 },
    display_config: { can_use_super_model: false, commercial_info: { info: '', manual_usage: 0 }, display_name: '', fee_model_level: 2, is_custom_model: false, is_new: false, max_mode: false, memory_display_config: {}, model_capability: 'reasoning_model', multimodal: false, tags: [] },
    extra_config: '{"apply_file_path":true,"native_function_call":true,"open_optimize":true,"use_v2_process":true}',
    is_default: false,
    is_invisible_to_user: true,
    model_detail_list: [{ max_tokens: 8000, max_turn: 20, model_entitlement_usage_cost: 1, model_name: 'search_agent_model__max', prompt_max_tokens: 184000, tool_call_history_max_tokens: 0 }],
    usage: 'chat_completion'
  }
  const parsedSearch = parseModel(search, 'solo_agent_remote')
  check('a wire-name alias is caught even though its usage says chat_completion', parsedSearch?.kind === 'internal', String(parsedSearch?.internalReason))
  check('...and the reason names the wire model it really is', parsedSearch?.internalReason?.includes('search_agent_model__max') === true, String(parsedSearch?.internalReason))
  check('wireModelName reads the real field', wireModelName(search) === 'search_agent_model__max')

  // A row with no usable config_name is still dropped entirely (unchanged behaviour).
  check('a row without config_name is still no model at all', parseModel({ usage: 'chat_completion', model_detail_list: [{ model_name: 'x__dev' }] }, 'chat_v3') === undefined)
}

/* ─────────────────────── 6. boundaries: never crash, never assume ─────────────────────── */
console.log('\n[6] boundaries — a row that cannot be judged is NOT judged to be chat')
{
  const degenerate = [undefined, null, 0, '', 'x', [], {}, { usage: null }, { usage: 42 }, { usage: '' }, { usage: '  ' }, { usage: 'chat_completion' }, { usage: 'chat_completion', model_detail_list: 'nope' }, { usage: 'chat_completion', model_detail_list: [] }, { usage: 'chat_completion', model_detail_list: [null] }, { usage: 'chat_completion', model_detail_list: [{ model_name: 42 }] }, { usage: 'chat_completion', model_detail_list: [{ model_name: '' }] }, { usage: 'chat_completion', model_detail_list: [{ model_name: '   ' }] }, { config_name: 'x', usage: 'chat_completion' }]
  let threw = ''
  let escaped = ''
  for (const input of degenerate) {
    let verdict
    try {
      verdict = classifyDirectoryEntry(input, 'x')
    } catch (error) {
      threw = `${JSON.stringify(input)} threw ${error instanceof Error ? error.message : String(error)}`
      continue
    }
    if (verdict.kind !== 'internal') escaped = `${JSON.stringify(input)} -> ${verdict.kind}`
  }
  check(`no degenerate row throws (${degenerate.length} shapes)`, threw === '', threw)
  check('...and every unjudgeable row is internal, never chat', escaped === '', escaped)

  const noUsage = classifyDirectoryEntry({ config_name: 'x', model_detail_list: [{ model_name: 'x__dev' }] }, 'x')
  check('a row with a matching wire name but no usage is still internal', noUsage.kind === 'internal')
  check('...and the reason says the usage was missing', noUsage.internalReason?.includes('usage') === true, String(noUsage.internalReason))

  const numericUsage = classifyDirectoryEntry({ usage: 7, model_detail_list: [{ model_name: 'x__dev' }] }, 'x')
  check('a non-string usage is not read as a usage', numericUsage.kind === 'internal' && numericUsage.internalReason?.includes('usage') === true)

  const alienWire = classifyDirectoryEntry({ usage: 'chat_completion', model_detail_list: [{ model_name: 'some-other-model__dev' }] }, 'mine')
  check('a wire name belonging to another model is internal', alienWire.kind === 'internal')
  check('...and the reason quotes that wire name', alienWire.internalReason?.includes('some-other-model__dev') === true, String(alienWire.internalReason))

  check('the wire-name match ignores case', classifyDirectoryEntry({ usage: 'chat_completion', model_detail_list: [{ model_name: 'GLM-5.2__DEV' }] }, 'glm-5.2').kind === 'chat')
  check('an empty id cannot match an empty wire name (both blank)', classifyDirectoryEntry({ usage: 'chat_completion', model_detail_list: [{ model_name: '   ' }] }, '').kind === 'internal')
}

/* ───────────────────────── 7. partitionModels / fallbacks ───────────────────────── */
console.log('\n[7] partitionModels, and the hand-written fallback roster')
{
  const rows = ['title_generation', 'glm-5.2', 'fast_apply', 'kimi-k2.6']
  const models: TraeModel[] = rows.map((id) => {
    const row = LIVE_CN_ROWS.find((candidate) => candidate[0] === id)!
    return parseModel(rowEntry(row), 'chat_v3')!
  })
  const split = partitionModels(models)
  check('the split keeps the two real models', split.chat.map((model) => model.id).join(',') === 'glm-5.2,kimi-k2.6', split.chat.map((model) => model.id).join(','))
  check('...and lists the two components as internalIds', split.internalIds.join(',') === 'title_generation,fast_apply', split.internalIds.join(','))
  check('chat + internal always adds up to the input', split.chat.length + split.internal.length === models.length)
  // Strict: `kind` is REQUIRED, so a hand-built TraeModel with no verdict is internal.
  const unjudged = [{ id: 'hand-built', name: 'Hand', input: ['text'], directoryFunction: 'chat_v3' } as unknown as TraeModel]
  const unjudgedSplit = partitionModels(unjudged)
  check('a model with no kind at all is NOT silently promoted to chat', unjudgedSplit.chat.length === 0 && unjudgedSplit.internalIds.join(',') === 'hand-built')
  check('...and an empty catalogue splits into two empty lists', JSON.stringify(partitionModels([])) === JSON.stringify({ chat: [], internal: [], internalIds: [] }))

  const fallbackChat = [...FALLBACK_MODELS.cn, ...FALLBACK_MODELS.ai]
  check(`every hand-written fallback model is kind=chat (${fallbackChat.length} rows)`, fallbackChat.every((model) => model.kind === 'chat'))
  check('the fallback roster still has the counts it had before', FALLBACK_MODELS.cn.length === 4 && FALLBACK_MODELS.ai.length === 7, `${FALLBACK_MODELS.cn.length} + ${FALLBACK_MODELS.ai.length}`)
}

/* ─────────────────────── 8. the cross-function merge ─────────────────────── */
//
// The same id is listed by up to four functions, and they DISAGREE about its wire
// model. `solo_work_remote` is asked first and sometimes serves a stale alias, so a
// first-wins verdict made the size of the user's list depend on the answer order:
// the same live directory measured 47 models one minute and 44 the next. These are
// the real multi-row shapes that produced that, taken from the live CN directory on
// 2026-10-16 — every row below is verbatim (function, usage, model_name).
console.log('\n[8] a stale/aliased row must not be able to hide a real model')
{
  /** [config_name, [[function, usage, model_name], …]] — the OTHER end of the criterion. */
  const INTERNAL_ROSTER: readonly (readonly [string, readonly (readonly [string, string, string])[]])[] = [
    ['browser_use_subagent', [['solo_work_remote', 'chat_completion', 'browser_use_model__dev'], ['solo_agent_remote', 'chat_completion', 'browser_use_model__dev']]],
    ['custom_model_1M', [['solo_work_remote', 'custom_model', 'custom_model_1M__dev'], ['solo_agent_remote', 'custom_model', 'custom_model_1M__dev'], ['chat_v3', 'custom_model', 'custom_model_1M__dev']]],
    ['custom_model_1M_text', [['solo_work_remote', 'custom_model', 'custom_model_1M_text__dev'], ['solo_agent_remote', 'custom_model', 'custom_model_1M_text__dev'], ['chat_v3', 'custom_model', 'custom_model_1M_text__dev']]],
    ['custom_model_200k', [['chat_v3', 'custom_model', 'custom_model_200k__dev'], ['solo_coder', 'custom_model', 'custom_model_200k__dev']]],
    ['custom_model_200k_text', [['chat_v3', 'custom_model', 'custom_model_200k_text__dev'], ['solo_coder', 'custom_model', 'custom_model_200k_text__dev']]],
    ['custom_model_claude', [['solo_work_remote', 'custom_model', 'custom_model_claude__max'], ['solo_agent_remote', 'custom_model', 'custom_model_claude__dev'], ['solo_coder', 'custom_model', 'custom_model_claude__dev']]],
    ['custom_model_deepseek_chat', [['solo_work_remote', 'custom_model', 'custom_model_deepseek_chat__max'], ['solo_agent_remote', 'custom_model', 'custom_model_deepseek_chat__dev'], ['chat_v3', 'custom_model', 'custom_model_deepseek_chat__dev'], ['solo_coder', 'custom_model', 'custom_model_deepseek_chat__dev']]],
    ['custom_model_deepseek_reasoner', [['solo_work_remote', 'custom_model', 'custom_model_deepseek_reasoner__max'], ['solo_agent_remote', 'custom_model', 'custom_model_deepseek_reasoner__dev'], ['chat_v3', 'custom_model', 'custom_model_deepseek_reasoner__dev'], ['solo_coder', 'custom_model', 'custom_model_deepseek_reasoner__dev']]],
    ['custom_model_deepseek_v4', [['solo_work_remote', 'custom_model', 'custom_model_deepseek_v4__max'], ['solo_agent_remote', 'custom_model', 'custom_model_deepseek_v4__dev'], ['chat_v3', 'custom_model', 'custom_model_deepseek_reasoner__dev'], ['solo_coder', 'custom_model', 'custom_model_deepseek_reasoner__dev']]],
    ['custom_model_doubao_1M', [['solo_work_remote', 'custom_model', 'custom_model_doubao_1M__dev'], ['solo_agent_remote', 'custom_model', 'custom_model_doubao_1M__dev']]],
    ['custom_model_doubao_256k', [['solo_work_remote', 'custom_model', 'custom_model_doubao_256k__dev'], ['solo_agent_remote', 'custom_model', 'custom_model_doubao_256k__dev']]],
    ['custom_model_gemini', [['solo_work_remote', 'custom_model', 'custom_model_vercel_gemini__max'], ['solo_agent_remote', 'custom_model', 'gemini-3-pro__dev'], ['chat_v3', 'custom_model', 'custom_model_gemini__dev'], ['solo_coder', 'custom_model', 'custom_model_gemini__dev']]],
    ['custom_model_gpt-5', [['solo_work_remote', 'custom_model', 'custom_model_gpt-5__max'], ['solo_agent_remote', 'custom_model', 'custom_model_gpt-5__dev'], ['chat_v3', 'custom_model', 'custom_model_gpt-5__dev'], ['solo_coder', 'custom_model', 'custom_model_gpt-5__dev']]],
    ['custom_model_gpt-6', [['solo_work_remote', 'custom_model', 'custom_model_gpt-6__max'], ['solo_agent_remote', 'custom_model', 'custom_model_gpt-6__dev'], ['chat_v3', 'custom_model', 'custom_model_gpt-6__dev']]],
    ['custom_model_kimi', [['solo_work_remote', 'custom_model', 'custom_model_kimi__max'], ['solo_agent_remote', 'custom_model', 'custom_model_placeholder__dev'], ['chat_v3', 'custom_model', 'custom_model_placeholder__dev'], ['solo_coder', 'custom_model', 'custom_model_placeholder__dev']]],
    ['custom_model_no-fc', [['solo_work_remote', 'custom_model', 'custom_model_no-fc__max'], ['solo_agent_remote', 'custom_model', 'custom_model_no-fc__dev'], ['chat_v3', 'custom_model', 'custom_model_no-fc__dev'], ['solo_coder', 'custom_model', 'custom_model_no-fc__max']]],
    ['custom_model_placeholder', [['solo_work_remote', 'custom_model', 'custom_model_placeholder__max'], ['solo_agent_remote', 'custom_model', 'custom_model_placeholder__dev'], ['chat_v3', 'custom_model', 'custom_model_placeholder__dev'], ['solo_coder', 'custom_model', 'custom_model_placeholder__dev']]],
    ['custom_model_vercel', [['chat_v3', 'custom_model', 'custom_model_placeholder__dev'], ['solo_coder', 'custom_model', 'custom_model_placeholder__dev']]],
    ['custom_model_vercel_gemini', [['chat_v3', 'custom_model', 'custom_model_placeholder__dev'], ['solo_coder', 'custom_model', 'custom_model_placeholder__dev']]],
    ['explore_sub_agent_v2', [['solo_work_remote', 'chat_completion', 'qwen-3.6-explore-agent__dev']]],
    ['fast_apply', [['chat_v3', 'fast_apply', 'fast_apply']]],
    ['fast_apply_new', [['chat_v3', 'fast_apply_new', 'fast_apply_new']]],
    ['file_search_agent', [['solo_work_remote', 'chat_completion', 'file-search-qwen3.6__dev']]],
    ['glm-5.1_advisor', [['chat_v3', 'chat_completion', 'glm-5.1__dev']]],
    ['glm-5.2_advisor_default', [['solo_agent_remote', 'chat_completion', 'glm-5.2__dev']]],
    ['glm-5.2_advisor_doubao', [['chat_v3', 'chat_completion', 'glm-5.2__dev']]],
    ['input_optimization', [['chat_v3', 'input_optimization', 'no_thinking_model'], ['solo_coder', 'input_optimization', 'no_thinking_model']]],
    ['search_agent_qwen_fast', [['solo_agent_remote', 'chat_completion', 'search_agent_model__dev'], ['solo_coder', 'chat_completion', 'search_agent_model__max']]],
    ['search_agent_qwen_fast-0710', [['solo_agent_remote', 'chat_completion', 'search_agent_model__dev']]],
    ['seed-code-pro-0430', [['solo_work_remote', 'chat_completion', 'Doubao-Seed-2.1-Pro__dev']]],
    ['summary', [['solo_work_remote', 'summary', 'Doubao_1_6'], ['solo_agent_remote', 'summary', 'Doubao_1_6'], ['chat_v3', 'summary', 'Doubao_1_6'], ['solo_coder', 'summary', 'Doubao_1_6']]],
    ['title_generation', [['chat_v3', 'title_generation', 'no_thinking_model'], ['solo_coder', 'title_generation', 'no_thinking_model']]]
  ]

  const rowOf = (fn: string, usage: string, wire: string, name: string): Record<string, unknown> => ({ config_name: name, usage, model_detail_list: [{ model_name: wire }] })

  /**
   * Feed row groups through the REAL `fetchDirectoryModels` (fake transport, no
   * network): one row per id per function, exactly as the gateway answers.
   */
  async function mergeDirectory(groups: readonly (readonly [string, readonly (readonly [string, string, string])[]])[]): Promise<TraeModel[]> {
    const fetchImpl = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const fn = String((JSON.parse(String(init?.body)) as Record<string, unknown>)['function'])
      const list: unknown[] = []
      for (const [name, rows] of groups) {
        const row = rows.find(([rowFn]) => rowFn === fn)
        if (row !== undefined) list.push(rowOf(row[0], row[1], row[2], name))
      }
      return new Response(JSON.stringify({ config_info_list: list }), { status: 200 })
    }) as unknown as typeof fetch
    const credential = { id: 't', edition: 'cn', region: 'cn', source: 'own', storagePath: '', userId: '0', expiresAtMs: 0, accessToken: 't' } as unknown as TraeCredential
    const identity = { edition: 'cn', machineId: 'm', deviceId: 'd' } as unknown as TraeIdentity
    const result = await fetchDirectoryModels('cn', credential, identity, { fetchImpl })
    return result.models
  }

  // The three real ids whose FIRST answer is a stale alias. All three must survive.
  const STALE_FIRST: readonly (readonly [string, readonly (readonly [string, string, string])[]])[] = [
    ['DeepSeek-V4-Flash', [['solo_work_remote', 'chat_completion', 'deepseek_v4_flash__dev'], ['solo_agent_remote', 'chat_completion', 'DeepSeek-V4-Flash__dev'], ['chat_v3', 'chat_completion', 'DeepSeek-V4-Flash__dev'], ['solo_coder', 'chat_completion', 'DeepSeek-V4-Flash__dev']]],
    ['DeepSeek-V4-Pro', [['solo_work_remote', 'chat_completion', 'deepseek_v4_pro__dev'], ['solo_agent_remote', 'chat_completion', 'DeepSeek-V4-Pro__dev'], ['chat_v3', 'chat_completion', 'DeepSeek-V4-Pro__dev'], ['solo_coder', 'chat_completion', 'DeepSeek-V4-Pro__dev']]],
    ['Doubao-Seed-2.0-Code', [['solo_work_remote', 'chat_completion', 'Doubao-Seed-2.1-Turbo__dev'], ['solo_coder', 'chat_completion', 'Doubao-Seed-2.0-Code__max']]]
  ]
  const staleMerged = await mergeDirectory(STALE_FIRST)
  check('the stale first row is judged internal on its own', classifyDirectoryEntry(rowOf('solo_work_remote', 'chat_completion', 'deepseek_v4_flash__dev', 'DeepSeek-V4-Flash'), 'DeepSeek-V4-Flash').kind === 'internal')
  check(`all ${STALE_FIRST.length} real models survive a stale FIRST answer`, staleMerged.length === STALE_FIRST.length && staleMerged.every((model) => model.kind === 'chat'), staleMerged.map((model) => `${model.id}:${model.kind}`).join(','))
  check('...and the stale accusation is not carried along', staleMerged.every((model) => model.internalReason === undefined && !('internalReason' in model)), JSON.stringify(staleMerged.map((model) => model.internalReason)))
  check('...and the wire function is still the FIRST one (unchanged: first-wins)', staleMerged.find((model) => model.id === 'DeepSeek-V4-Flash')?.directoryFunction === 'solo_work_remote', String(staleMerged.find((model) => model.id === 'DeepSeek-V4-Flash')?.directoryFunction))
  // Same two facts, the stale row carried by the SECOND function instead of the
  // first: the verdict may not depend on which answer the gateway sent first.
  const staleSecond = await mergeDirectory([
    ['DeepSeek-V4-Flash', [['solo_work_remote', 'chat_completion', 'DeepSeek-V4-Flash__dev'], ['solo_agent_remote', 'chat_completion', 'deepseek_v4_flash__dev']]]
  ])
  check('the verdict is the same when the stale row comes SECOND', staleSecond.length === 1 && staleSecond[0]?.kind === 'chat', staleSecond.map((model) => `${model.id}:${model.kind}`).join(','))
  check('...and first-wins still decides the wire function in that shape too', staleSecond[0]?.directoryFunction === 'solo_work_remote', String(staleSecond[0]?.directoryFunction))

  // The other direction, over ALL 32 internal ids and every real row each one has:
  // no row self-identifies, so the OR can never promote a component.
  {
    const promoted = INTERNAL_ROSTER.filter(([name, rows]) => rows.some(([, usage, wire]) => classifyDirectoryEntry(rowOf('x', usage, wire, name), name).kind === 'chat'))
    check(`none of the ${INTERNAL_ROSTER.length} internal ids has a row that self-identifies`, promoted.length === 0, promoted.map(([name]) => name).join('、'))
    check('...and their id set is exactly the frozen 32', JSON.stringify(INTERNAL_ROSTER.map(([name]) => name).slice().sort()) === JSON.stringify([...TRAE_INTERNAL_KINDS_DOC].slice().sort()))
    check(`...and they carry every row they really have (${INTERNAL_ROSTER.reduce((sum, [, rows]) => sum + rows.length, 0)} rows, 169 - the 92 chat rows)`, INTERNAL_ROSTER.reduce((sum, [, rows]) => sum + rows.length, 0) === 77)
    const merged = await mergeDirectory(INTERNAL_ROSTER)
    check(`...so merging all ${INTERNAL_ROSTER.length} of them still yields internal`, merged.length === INTERNAL_ROSTER.length && merged.every((model) => model.kind === 'internal'), merged.filter((model) => model.kind === 'chat').map((model) => model.id).join(','))
    check('...and each one keeps a reason a human can read', merged.every((model) => typeof model.internalReason === 'string' && model.internalReason.length > 0))
  }
}

/* ─────────────────────────────── summary ─────────────────────────────── */
console.log('\n' + '-'.repeat(72))
console.log(`${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

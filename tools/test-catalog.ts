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
  directoryFunctionLabel,
  displayNameOf,
  FALLBACK_MODELS,
  fetchDirectoryModels,
  parseModel,
  partitionModels,
  TRAE_CHAT_USAGE,
  TRAE_INTERNAL_KINDS_DOC,
  uniquifyDisplayNames,
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

/**
 * The 47 conversation models EXACTLY as the CN gateway answered them on 2026-10-16,
 * read back with `tools/report-models.ts --json` (read-only, no quota, no generation):
 *
 *   [config_name, display_config.display_name, [[function, model_detail_list[0].model_name], …]]
 *
 * `display_name` is the one the FIRST function answered with (display names are
 * first-wins, exactly like the wire function), and every wire below is verbatim from
 * that snapshot. `tools/report-models.ts` prints the same fields, so this table can be
 * re-derived without a network call of its own — and the three rows the display-name
 * rules turn on (`aquila` · `sagitta` with display name `-`, `Doubao-Seed-2.0-Code`
 * claiming `Doubao-Seed-2.1-Turbo`, the seven duplicate display names) are all in here
 * as MEASURED, not as invented examples.
 */
const LIVE_CN_CHAT_ROWS: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  ['aquila', '-', [['solo_work_remote', 'aquila__dev']]],
  ['DeepSeek-V4-Flash', 'DeepSeek-V4-Flash', [['solo_work_remote', 'deepseek_v4_flash__dev'], ['solo_agent_remote', 'DeepSeek-V4-Flash__dev'], ['chat_v3', 'DeepSeek-V4-Flash__dev'], ['solo_coder', 'DeepSeek-V4-Flash__dev']]],
  ['DeepSeek-V4-Flash-Official', 'DeepSeek-V4-Flash', [['solo_work_remote', 'DeepSeek-V4-Flash-Official__dev'], ['solo_agent_remote', 'DeepSeek-V4-Flash-Official__dev'], ['chat_v3', 'DeepSeek-V4-Flash-Official__dev']]],
  ['DeepSeek-V4-Pro', 'DeepSeek-V4-Pro', [['solo_work_remote', 'deepseek_v4_pro__dev'], ['solo_agent_remote', 'DeepSeek-V4-Pro__dev'], ['chat_v3', 'DeepSeek-V4-Pro__dev'], ['solo_coder', 'DeepSeek-V4-Pro__dev']]],
  ['DeepSeek-V4-Pro-Official', 'DeepSeek-V4-Pro', [['solo_work_remote', 'DeepSeek-V4-Pro-Official__dev'], ['solo_agent_remote', 'DeepSeek-V4-Pro-Official__dev'], ['chat_v3', 'DeepSeek-V4-Pro-Official__dev']]],
  ['deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', [['solo_work_remote', 'deepseek-v4.1-flash__dev']]],
  ['Doubao_1_6', 'Seed-Code', [['solo_agent_remote', 'Doubao_1_6__dev'], ['chat_v3', 'Doubao_1_6__dev'], ['solo_coder', 'Doubao_1_6__max']]],
  ['doubao-for-auto', 'doubao-for-auto', [['chat_v3', 'doubao-for-auto__dev'], ['solo_coder', 'doubao-for-auto__max']]],
  ['Doubao-Seed-2.0-Code', 'Doubao-Seed-2.1-Turbo', [['solo_work_remote', 'Doubao-Seed-2.1-Turbo__dev'], ['solo_coder', 'Doubao-Seed-2.0-Code__max']]],
  ['Doubao-Seed-2.0-Code-auto', 'Doubao-Seed-2.0-Code', [['solo_coder', 'Doubao-Seed-2.0-Code-auto__max']]],
  ['Doubao-Seed-2.1-Pro', 'Seed-2.1-Pro-0915', [['solo_work_remote', 'Doubao-Seed-2.1-Pro__dev'], ['solo_agent_remote', 'Doubao-Seed-2.1-Pro__dev'], ['chat_v3', 'Doubao-Seed-2.1-Pro__dev']]],
  ['Doubao-Seed-2.1-Turbo', 'Seed-2.1-Turbo', [['solo_work_remote', 'Doubao-Seed-2.1-Turbo__dev'], ['solo_agent_remote', 'Doubao-Seed-2.1-Turbo__dev'], ['chat_v3', 'Doubao-Seed-2.1-Turbo__dev']]],
  ['Doubao-Seed-Code', 'Seed-Code', [['solo_agent_remote', 'Doubao-Seed-Code__dev'], ['chat_v3', 'Doubao-Seed-Code__dev'], ['solo_coder', 'Doubao-Seed-Code__max']]],
  ['Doubao-Seed-Evolving', 'Seed-Evolving', [['solo_work_remote', 'Doubao-Seed-Evolving__dev'], ['solo_agent_remote', 'Doubao-Seed-Evolving__dev']]],
  ['glm-4.6', 'GLM-4.6', [['chat_v3', 'glm-4.6__dev'], ['solo_coder', 'glm-4.6__dev']]],
  ['glm-4.6-auto', 'GLM-4.6', [['solo_coder', 'glm-4.6-auto__max']]],
  ['glm-4.7', 'GLM-4.7', [['chat_v3', 'glm-4.7__dev'], ['solo_coder', 'glm-4.7__dev']]],
  ['glm-4.7-auto', 'glm-4.7-auto', [['chat_v3', 'glm-4.7-auto__dev'], ['solo_coder', 'glm-4.7-auto__max']]],
  ['glm-5', 'GLM-5', [['solo_work_remote', 'glm-5__dev'], ['solo_agent_remote', 'glm-5__dev'], ['chat_v3', 'glm-5__dev'], ['solo_coder', 'glm-5__dev']]],
  ['glm-5-turbo', 'GLM-5-Turbo', [['solo_work_remote', 'glm-5-turbo__dev']]],
  ['glm-5.1', 'GLM-5.1', [['solo_agent_remote', 'glm-5.1__dev'], ['chat_v3', 'glm-5.1__dev'], ['solo_coder', 'glm-5.1__dev']]],
  ['glm-5.2', 'GLM-5.2', [['solo_work_remote', 'glm-5.2__dev'], ['solo_agent_remote', 'glm-5.2__dev'], ['chat_v3', 'glm-5.2__dev']]],
  ['glm-5.3', 'GLM-5.3', [['solo_work_remote', 'glm-5.3__dev']]],
  ['glm-5.3-flash', 'GLM-5.3-Flash', [['solo_work_remote', 'glm-5.3-flash__dev']]],
  ['glm-5.3-flashx', 'GLM-5.3-FlashX', [['solo_work_remote', 'glm-5.3-flashx__dev']]],
  ['glm-5v-turbo', 'GLM-5V-Turbo', [['solo_coder', 'glm-5v-turbo__dev']]],
  ['kimi-k2', 'Kimi-K2-0905', [['chat_v3', 'kimi-k2__dev']]],
  ['kimi-k2-0905', 'Kimi-K2-0905', [['solo_coder', 'kimi-k2-0905__dev']]],
  ['kimi-k2.5', 'Kimi-K2.5', [['solo_coder', 'kimi-k2.5__dev']]],
  ['kimi-k2.6', 'Kimi-K2.6', [['solo_work_remote', 'kimi-k2.6__dev'], ['solo_agent_remote', 'kimi-k2.6__dev'], ['solo_coder', 'kimi-k2.6__dev']]],
  ['kimi-k2.7-code', 'Kimi-K2.7-Code', [['solo_work_remote', 'kimi-k2.7-code__dev'], ['solo_agent_remote', 'kimi-k2.7-code__dev'], ['chat_v3', 'kimi-k2.7-code__dev']]],
  ['kimi-k3', 'Kimi-K3', [['solo_work_remote', 'kimi-k3__dev'], ['solo_agent_remote', 'kimi-k3__dev'], ['chat_v3', 'kimi-k3__dev']]],
  ['mimo-v2.6-flash', 'MiMo-V2.6-Flash', [['solo_work_remote', 'mimo-v2.6-flash__dev']]],
  ['mimo-v2.6-pro', 'MiMo-V2.6-Pro', [['solo_work_remote', 'mimo-v2.6-pro__dev']]],
  ['minimax-m2', 'MiniMax-M2', [['chat_v3', 'minimax-m2__dev'], ['solo_coder', 'minimax-m2__dev']]],
  ['minimax-m2-auto', 'MiniMax-M2', [['solo_coder', 'minimax-m2-auto__max']]],
  ['minimax-m2.1', 'MiniMax-M2.1', [['chat_v3', 'minimax-m2.1__dev'], ['solo_coder', 'minimax-m2.1__dev']]],
  ['minimax-m2.1-auto', 'MiniMax-M2.1', [['solo_coder', 'minimax-m2.1-auto__max']]],
  ['minimax-m2.7', 'MiniMax-M2.7', [['solo_coder', 'minimax-m2.7__dev']]],
  ['minimax-m3', 'MiniMax-M3', [['solo_work_remote', 'minimax-m3__dev'], ['solo_agent_remote', 'minimax-m3__dev'], ['chat_v3', 'minimax-m3__dev']]],
  ['qwen-3.5', 'Qwen3.5-Plus', [['solo_agent_remote', 'qwen-3.5__dev'], ['chat_v3', 'qwen-3.5__dev'], ['solo_coder', 'qwen-3.5__dev']]],
  ['qwen-3.6-plus', 'Qwen3.6-Plus', [['solo_coder', 'qwen-3.6-plus__dev']]],
  ['qwen-3.7-plus', 'Qwen3.7-Plus', [['solo_work_remote', 'qwen-3.7-plus__dev'], ['solo_agent_remote', 'qwen-3.7-plus__dev'], ['chat_v3', 'qwen-3.7-plus__dev']]],
  ['qwen3-coder', 'Qwen3-Coder-Next', [['chat_v3', 'openai_qwen3-coder-plus__dev']]],
  ['qwen3.8-max', 'Qwen3.8-Max', [['solo_work_remote', 'qwen3.8-max__dev']]],
  ['sagitta', '-', [['solo_work_remote', 'sagitta__dev']]],
  ['step-5-preview', 'Step-5-Preview', [['solo_work_remote', 'step-5-preview__dev']]]
]

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

/* ═══════ 9. 显示名唯一化 —— 用户在「模型」下拉框里真正读到的名字 ═══════ */
//
// The requester (2026-10-16) found four classes of bad display names in the dropdown:
//   ① two rows named `-` (`aquila` · `sagitta`);
//   ② one row whose name belongs to ANOTHER model (`Doubao-Seed-2.0-Code` says
//      `Doubao-Seed-2.1-Turbo`);
//   ③ six `-auto` routing slots that either collide with the real model or show their
//      raw id;
//   ④ seven display names that appear on two rows each.
// Every check below runs on the measured 47 rows above, through the REAL fetch/merge
// path — no invented sample carries one of the four defects. Two checks at the end use
// hand-built rows, and say so: the tag-alone-still-collides branch and the wire-name
// rescue have no representative in the live roster.
console.log('\n[9] display names: the four defects, and the uniqueness rule that fixes them')
{
  /** Serve the measured rows through the real fetch path (fake transport, no network). */
  async function fetchLiveChat(): Promise<TraeModel[]> {
    const fetchImpl = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const fn = String((JSON.parse(String(init?.body)) as Record<string, unknown>)['function'])
      const list: unknown[] = []
      for (const [id, display, rows] of LIVE_CN_CHAT_ROWS) {
        const wire = rows.find(([rowFn]) => rowFn === fn)?.[1]
        if (wire === undefined) continue
        list.push({ config_name: id, usage: TRAE_CHAT_USAGE, display_config: { display_name: display }, model_detail_list: [{ model_name: wire }] })
      }
      return new Response(JSON.stringify({ config_info_list: list }), { status: 200 })
    }) as unknown as typeof fetch
    const credential = { id: 't', edition: 'cn', region: 'cn', source: 'own', storagePath: '', userId: '0', expiresAtMs: 0, accessToken: 't' } as unknown as TraeCredential
    const identity = { edition: 'cn', machineId: 'm', deviceId: 'd' } as unknown as TraeIdentity
    return (await fetchDirectoryModels('cn', credential, identity, { fetchImpl })).models
  }

  const live = await fetchLiveChat()
  const chat = live.filter((model) => model.kind === 'chat')
  const modelOf = (id: string): TraeModel => {
    const found = chat.find((model) => model.id === id)
    if (found === undefined) throw new Error(`the measured roster lost ${id}`)
    return found
  }
  const rawNameOf = (id: string): string => LIVE_CN_CHAT_ROWS.find((row) => row[0] === id)?.[1] ?? '(not measured)'
  const dashOrBlank = (value: string): boolean => value.trim() === '' || /^[\s\-–—_·.]+$/u.test(value.trim())

  check(`all ${LIVE_CN_CHAT_ROWS.length} measured conversation models survive the merge as chat`, chat.length === LIVE_CN_CHAT_ROWS.length && live.length === LIVE_CN_CHAT_ROWS.length, `${chat.length}/${live.length}`)
  check('none of them is hidden by the naming rule', LIVE_CN_CHAT_ROWS.every((row) => chat.some((model) => model.id === row[0])))

  /* ---- the ONE total assertion the requester asked for ---- */
  {
    const names = chat.map((model) => model.name)
    const folded = names.map((name) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))
    check(`the ${names.length} final display names are pairwise distinct`, new Set(names).size === names.length, `${names.length - new Set(names).size} duplicate(s)`)
    check('...and still pairwise distinct with case and separators folded away', new Set(folded).size === folded.length)
    const bad = names.filter(dashOrBlank)
    check('...and not one of them is blank, `-`, or punctuation only', bad.length === 0, JSON.stringify(bad))
  }

  /* ---- ① the two rows Trae left nameless ---- */
  check('aquila\'s `-` became its own id', modelOf('aquila').name === 'aquila' && rawNameOf('aquila') === '-')
  check('sagitta\'s `-` became its own id', modelOf('sagitta').name === 'sagitta' && rawNameOf('sagitta') === '-')

  /* ---- ② the lying name ---- */
  check(
    'Doubao-Seed-2.0-Code no longer claims to be Doubao-Seed-2.1-Turbo',
    modelOf('Doubao-Seed-2.0-Code').name === 'Doubao-Seed-2.0-Code' && rawNameOf('Doubao-Seed-2.0-Code') === 'Doubao-Seed-2.1-Turbo',
    modelOf('Doubao-Seed-2.0-Code').name
  )
  check('...while the real Doubao-Seed-2.1-Turbo keeps its own row and name', modelOf('Doubao-Seed-2.1-Turbo').name === 'Doubao-Seed-2.1-Turbo')
  check(
    '...and the FIRST answer\'s stale alias does not save it (the rule reads the id, never the first-wins wire)',
    (() => {
      const row = LIVE_CN_CHAT_ROWS.find((entry) => entry[0] === 'Doubao-Seed-2.0-Code')!
      const firstWire = row[2][0]?.[1] ?? ''
      const ownWire = row[2].find(([, wire]) => wire.toLowerCase().includes('doubao-seed-2.0-code'))?.[1] ?? ''
      const fold = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
      // The lie would have been "confirmed" by the first answer's wire name …
      return fold(row[1]).includes(fold(firstWire.replace(/__[A-Za-z0-9]+$/, ''))) && ownWire === 'Doubao-Seed-2.0-Code__max' && modelOf('Doubao-Seed-2.0-Code').name === 'Doubao-Seed-2.0-Code'
    })(),
    LIVE_CN_CHAT_ROWS.find((entry) => entry[0] === 'Doubao-Seed-2.0-Code')?.[2].map(([fn, wire]) => `${fn}:${wire}`).join(' · ')
  )
  check('...also the legacy `Doubao_1_6` no longer borrows Doubao-Seed-Code\'s name', modelOf('Doubao_1_6').name === 'Doubao_1_6' && rawNameOf('Doubao_1_6') === 'Seed-Code')

  /* ---- ③ the six Auto-mode routing slots ---- */
  {
    const autoIds = LIVE_CN_CHAT_ROWS.map((row) => row[0]).filter((id) => /-auto$/i.test(id))
    const unmarked = autoIds.filter((id) => !modelOf(id).name.includes('Auto'))
    check(`all ${autoIds.length} measured -auto slots are still offered (never hidden)`, autoIds.length === 6 && autoIds.every((id) => chat.some((model) => model.id === id)), autoIds.join(','))
    check('...and every one of them says "Auto" in the name a user reads', unmarked.length === 0, unmarked.join(','))
    const partners: readonly (readonly [string, string])[] = [['glm-4.6-auto', 'glm-4.6'], ['glm-4.7-auto', 'glm-4.7'], ['minimax-m2-auto', 'minimax-m2'], ['minimax-m2.1-auto', 'minimax-m2.1'], ['doubao-for-auto', ''], ['Doubao-Seed-2.0-Code-auto', 'Doubao-Seed-2.0-Code']]
    const collided = partners.filter(([auto, real]) => real !== '' && modelOf(auto).name === modelOf(real).name)
    check('...so an -auto slot can never share a name with the real model again', collided.length === 0, collided.map(([auto]) => `${auto}=${modelOf(auto).name}`).join(' · '))
    check('...and the marker carries the directory function it routes through', modelOf('glm-4.6-auto').name === 'glm-4.6-auto（Auto · coder）' && modelOf('doubao-for-auto').name === 'doubao-for-auto（Auto · chat）', `${modelOf('glm-4.6-auto').name} · ${modelOf('doubao-for-auto').name}`)
  }

  /* ---- ④ the seven duplicate display names ---- */
  {
    const groups = new Map<string, string[]>()
    for (const [id, display] of LIVE_CN_CHAT_ROWS) groups.set(display, [...(groups.get(display) ?? []), id])
    const collisions = [...groups.entries()].filter(([, ids]) => ids.length > 1)
    const dashed = collisions.filter(([name]) => name === '-')
    const named = collisions.filter(([name]) => name !== '-')
    check(`the measurement really carries the 7 duplicate display names the requester counted (plus the two \`-\`)`, named.length === 7 && dashed.length === 1 && dashed[0]?.[1].length === 2, collisions.map(([name, ids]) => `${name}×${ids.length}`).join(' · '))
    const split = named.filter(([, ids]) => new Set(ids.map((id) => modelOf(id).name)).size !== ids.length)
    check('every one of those 7 groups ends up with pairwise different names', split.length === 0, split.map(([name]) => name).join(' · '))
    // "Every same-named entry gets a suffix" — not "one of them does". Six of the seven
    // groups are dissolved a step earlier by rule ③ (the liar becomes its own id), so the
    // rows this actually applies to are the ones whose HONEST base name is still shared.
    // The honest base is computed from the DIRECTORY name (`rawNameOf`), not from the
    // already-uniquified name the fetch returns — otherwise the question is circular.
    const honestBaseOf = (model: TraeModel): string => displayNameOf({ ...model, name: rawNameOf(model.id) })
    const honestCounts = new Map<string, number>()
    for (const model of chat) honestCounts.set(honestBaseOf(model), (honestCounts.get(honestBaseOf(model)) ?? 0) + 1)
    const shared = chat.filter((model) => (honestCounts.get(honestBaseOf(model)) ?? 1) > 1)
    check('...and where the honest base name is STILL shared, every such row carries a suffix (not just one of them)', shared.length === 2 && shared.every((model) => model.name !== honestBaseOf(model) && /（[^）]+）$/.test(model.name)), shared.map((model) => `${model.id}->${model.name}`).join(' · '))
    check('...namely both Kimi rows, tagged with the function each one routes through', modelOf('kimi-k2').name === 'Kimi-K2-0905（chat）' && modelOf('kimi-k2-0905').name === 'Kimi-K2-0905（coder）')
    check('the function tag comes from the directory function, not from a hand-written table', directoryFunctionLabel('solo_work_remote') === 'work' && directoryFunctionLabel('solo_agent_remote') === 'agent' && directoryFunctionLabel('chat_v3') === 'chat' && directoryFunctionLabel('solo_coder') === 'coder')
  }

  /* ---- ⑤ the frozen outcome: ids, the untouched rows, and the whole table ---- */
  check('no id was changed by the naming rule', JSON.stringify(chat.map((model) => model.id).slice().sort()) === JSON.stringify(LIVE_CN_CHAT_ROWS.map((row) => row[0]).slice().sort()))
  // Why rule ③ can stop at the id: every published conversation model has a row whose
  // wire name contains its own id (that IS the `classifyDirectoryEntry` criterion), so
  // "the display name contains the wire model's body" can never hold where "the display
  // name contains the id" fails. Pinned as a property of the measurement, not assumed.
  {
    const fold = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const notSelfIdentifying = LIVE_CN_CHAT_ROWS.filter((row) => !row[2].some(([, wire]) => fold(wire).includes(fold(row[0]))))
    check('every published chat model has a row whose wire name contains its own id (the wire clause of rule ③ is therefore a subset of the id clause)', notSelfIdentifying.length === 0, notSelfIdentifying.map((row) => row[0]).join('、'))
    const laundered = LIVE_CN_CHAT_ROWS.filter((row) => {
      const bodies = row[2].map(([, wire]) => fold(wire.replace(/__[A-Za-z0-9]+$/, '')))
      return bodies.some((body) => body !== '' && fold(row[1]).includes(body)) && !fold(row[1]).includes(fold(row[0]))
    })
    check('...and exactly ONE row would have been "confirmed" by a first-wins alias — the lying row itself (which is why the wire is not read)', laundered.length === 1 && laundered[0]?.[0] === 'Doubao-Seed-2.0-Code', laundered.map((row) => row[0]).join('、'))
  }
  {
    const EXPECTED_FINAL_NAMES: readonly (readonly [string, string])[] = [
      ['aquila', 'aquila'],
      ['DeepSeek-V4-Flash', 'DeepSeek-V4-Flash'],
      ['DeepSeek-V4-Flash-Official', 'DeepSeek-V4-Flash-Official'],
      ['DeepSeek-V4-Pro', 'DeepSeek-V4-Pro'],
      ['DeepSeek-V4-Pro-Official', 'DeepSeek-V4-Pro-Official'],
      ['deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'],
      ['Doubao_1_6', 'Doubao_1_6'],
      ['doubao-for-auto', 'doubao-for-auto（Auto · chat）'],
      ['Doubao-Seed-2.0-Code', 'Doubao-Seed-2.0-Code'],
      ['Doubao-Seed-2.0-Code-auto', 'Doubao-Seed-2.0-Code-auto（Auto · coder）'],
      ['Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.1-Pro'],
      ['Doubao-Seed-2.1-Turbo', 'Doubao-Seed-2.1-Turbo'],
      ['Doubao-Seed-Code', 'Doubao-Seed-Code'],
      ['Doubao-Seed-Evolving', 'Doubao-Seed-Evolving'],
      ['glm-4.6', 'GLM-4.6'],
      ['glm-4.6-auto', 'glm-4.6-auto（Auto · coder）'],
      ['glm-4.7', 'GLM-4.7'],
      ['glm-4.7-auto', 'glm-4.7-auto（Auto · chat）'],
      ['glm-5', 'GLM-5'],
      ['glm-5-turbo', 'GLM-5-Turbo'],
      ['glm-5.1', 'GLM-5.1'],
      ['glm-5.2', 'GLM-5.2'],
      ['glm-5.3', 'GLM-5.3'],
      ['glm-5.3-flash', 'GLM-5.3-Flash'],
      ['glm-5.3-flashx', 'GLM-5.3-FlashX'],
      ['glm-5v-turbo', 'GLM-5V-Turbo'],
      ['kimi-k2', 'Kimi-K2-0905（chat）'],
      ['kimi-k2-0905', 'Kimi-K2-0905（coder）'],
      ['kimi-k2.5', 'Kimi-K2.5'],
      ['kimi-k2.6', 'Kimi-K2.6'],
      ['kimi-k2.7-code', 'Kimi-K2.7-Code'],
      ['kimi-k3', 'Kimi-K3'],
      ['mimo-v2.6-flash', 'MiMo-V2.6-Flash'],
      ['mimo-v2.6-pro', 'MiMo-V2.6-Pro'],
      ['minimax-m2', 'MiniMax-M2'],
      ['minimax-m2-auto', 'minimax-m2-auto（Auto · coder）'],
      ['minimax-m2.1', 'MiniMax-M2.1'],
      ['minimax-m2.1-auto', 'minimax-m2.1-auto（Auto · coder）'],
      ['minimax-m2.7', 'MiniMax-M2.7'],
      ['minimax-m3', 'MiniMax-M3'],
      ['qwen-3.5', 'Qwen3.5-Plus'],
      ['qwen-3.6-plus', 'Qwen3.6-Plus'],
      ['qwen-3.7-plus', 'Qwen3.7-Plus'],
      ['qwen3-coder', 'Qwen3-Coder-Next'],
      ['qwen3.8-max', 'Qwen3.8-Max'],
      ['sagitta', 'sagitta'],
      ['step-5-preview', 'Step-5-Preview']
    ]
    const actual = LIVE_CN_CHAT_ROWS.map((row) => [row[0], modelOf(row[0]).name] as const)
    const wrong = actual.filter(([id, name], index) => EXPECTED_FINAL_NAMES[index]?.[0] !== id || EXPECTED_FINAL_NAMES[index]?.[1] !== name)
    check('the 47 final names are exactly the names this rule is documented to produce', EXPECTED_FINAL_NAMES.length === 47 && wrong.length === 0, wrong.map(([id, name]) => `${id}=${name}`).join(' · '))
  }
  check('a renamed row keeps every other field the directory stated (only `name` moves)', (() => {
    const before = modelOf('Doubao-Seed-Code')
    const after = uniquifyDisplayNames([before])[0]!
    return after.contextWindow === before.contextWindow && after.maxTokens === before.maxTokens && JSON.stringify(after.input) === JSON.stringify(before.input) && after.directoryFunction === before.directoryFunction && after.kind === before.kind && JSON.stringify(after.reasoningEfforts) === JSON.stringify(before.reasoningEfforts)
  })())
  check('internal components do NOT take part in the renaming', (() => {
    const internal: TraeModel[] = [
      { id: 'custom_model_gemini', name: 'Gemini-3.1-Pro-Preview', input: ['text'], directoryFunction: 'solo_work_remote', kind: 'internal', internalReason: 'usage=custom_model' },
      { id: 'search_agent_qwen_fast', name: '', input: ['text'], directoryFunction: 'solo_agent_remote', kind: 'internal', internalReason: '线上模型名不含自己' }
    ]
    const out = uniquifyDisplayNames(internal)
    return out[0]?.name === 'Gemini-3.1-Pro-Preview' && out[1]?.name === '' && out.every((model) => model.kind === 'internal')
  })(), JSON.stringify(uniquifyDisplayNames([{ id: 'custom_model_gemini', name: 'Gemini-3.1-Pro-Preview', input: ['text'], directoryFunction: 'solo_work_remote', kind: 'internal', internalReason: 'usage=custom_model' }]).map((model) => model.name)))
  check('...and an internal row sharing a chat row\'s name cannot push that chat row into a suffix', (() => {
    const chatRow = chat.find((model) => model.id === 'glm-5.2')!
    const out = uniquifyDisplayNames([chatRow, { id: 'glm-5.2_advisor_doubao', name: 'GLM-5.2', input: ['text'], directoryFunction: 'chat_v3', kind: 'internal', internalReason: '槽位' }])
    return out[0]?.name === 'GLM-5.2' && out[1]?.name === 'GLM-5.2'
  })())
  check('parseModel still reports the directory name verbatim — the rename is a list-level projection', (() => {
    const row = LIVE_CN_CHAT_ROWS.find((entry) => entry[0] === 'Doubao-Seed-2.0-Code')!
    const parsed = parseModel({ config_name: row[0], usage: TRAE_CHAT_USAGE, display_config: { display_name: row[1] }, model_detail_list: [{ model_name: row[2][0]?.[1] }] }, 'solo_work_remote')
    // …and that first row alone is judged internal (stale alias); it is the cross-function
    // merge that makes the model chat. Two layers, neither of them touched by the rename.
    return parsed?.name === 'Doubao-Seed-2.1-Turbo' && parsed?.kind === 'internal'
  })())

  /* ---- ⑥ idempotence + determinism (the names land in a profile patch) ---- */
  {
    const once = uniquifyDisplayNames(live)
    const twice = uniquifyDisplayNames(once)
    check('running the rule twice changes nothing (idempotent)', JSON.stringify(twice.map((model) => model.name)) === JSON.stringify(once.map((model) => model.name)))
    check('...and a third run is still byte-identical', JSON.stringify(uniquifyDisplayNames(twice).map((model) => model.name)) === JSON.stringify(once.map((model) => model.name)))
    const again = await fetchLiveChat()
    check('a second fetch of the same directory produces the same names (deterministic)', JSON.stringify(again.map((model) => `${model.id}=${model.name}`)) === JSON.stringify(live.map((model) => `${model.id}=${model.name}`)))
    const shuffled = await fetchLiveChat()
    shuffled.reverse()
    check('...and the answer does not depend on the order the rows arrive in', JSON.stringify(uniquifyDisplayNames(shuffled).map((model) => `${model.id}=${model.name}`).sort()) === JSON.stringify(once.map((model) => `${model.id}=${model.name}`).sort()))
    check('every final name passes the identity test it was produced by (the reason a second run is silent)', chat.every((model) => displayNameOf({ ...model, name: model.name }) === model.name))
    check('...including every Auto marker, which is recognised instead of being appended twice', chat.filter((model) => /-auto$/i.test(model.id)).every((model) => displayNameOf({ ...model, name: model.name }) === model.name && (model.name.match(/（Auto · /gu) ?? []).length === 1))
  }

  /* ---- ⑦ boundaries: malformed names never throw, and the two branches the live
         roster has no representative for ---- */
  {
    const degenerate: readonly (readonly [string, unknown])[] = [['', ''], ['   ', ' '], ['-', '-'], ['—', '—'], ['—', '–—_.·'], ['x-1', undefined], ['x-1', 42], ['x-1', null]]
    let threw = ''
    let wrong = ''
    for (const [id, name] of degenerate) {
      let answer: string
      try {
        answer = displayNameOf({ id, name, input: ['text'], directoryFunction: 'chat_v3', kind: 'chat' } as unknown as TraeModel)
      } catch (error) {
        threw = `${JSON.stringify([id, name])} threw ${error instanceof Error ? error.message : String(error)}`
        continue
      }
      const expected = id === '' ? String(name ?? '') : id
      if (answer !== expected) wrong = `${JSON.stringify([id, name])} -> ${JSON.stringify(answer)}`
    }
    check(`no malformed display name throws (${degenerate.length} shapes)`, threw === '', threw)
    check('...and every one of them falls back to the id (or to the raw name when there is no id at all)', wrong === '', wrong)
    check('`-` in the middle of a name is NOT treated as nameless', displayNameOf({ id: 'kimi-k2', name: 'Kimi-K2', input: ['text'], directoryFunction: 'chat_v3', kind: 'chat' }) === 'Kimi-K2')
  }
  {
    // Synthetic pair, REAL ids and REAL functions: two different ids whose display name
    // contains both, routing through the same function — the only way the function tag
    // alone cannot separate them, i.e. the third pass.
    const ambiguous = uniquifyDisplayNames([
      { id: 'glm-5.3', name: 'GLM-5.3', input: ['text'], directoryFunction: 'solo_work_remote', kind: 'chat' },
      { id: 'glm-5', name: 'GLM-5.3', input: ['text'], directoryFunction: 'solo_work_remote', kind: 'chat' }
    ])
    check('when the function tag alone still collides, the id goes into the same brackets', ambiguous[0]?.name === 'GLM-5.3（work · glm-5.3）' && ambiguous[1]?.name === 'GLM-5.3（work · glm-5）', ambiguous.map((model) => model.name).join(' · '))
    check('...and that outcome is unique, idempotent and order-independent too', JSON.stringify(uniquifyDisplayNames(ambiguous).map((model) => model.name)) === JSON.stringify(ambiguous.map((model) => model.name)) && new Set(ambiguous.map((model) => model.name)).size === 2)
    // The two branches rule ③ deliberately does NOT have, documented as behaviour: a
    // display name that is a legitimate SHORT form of the id is kept (containment is
    // enough), and one that merely matches an alias is not — see the measurement
    // assertions above for why reading the wire name adds nothing.
    check('a display name is kept only when it CONTAINS the id: a short form is replaced, a longer one with a tail is kept', displayNameOf({ id: 'Doubao-Seed-2.1-Turbo', name: 'Seed-2.1-Turbo', input: ['text'], directoryFunction: 'solo_work_remote', kind: 'chat' }) === 'Doubao-Seed-2.1-Turbo' && displayNameOf({ id: 'kimi-k2', name: 'Kimi-K2-0905', input: ['text'], directoryFunction: 'chat_v3', kind: 'chat' }) === 'Kimi-K2-0905')
    check('...while a name that only matches a DIFFERENT model is replaced by the id', displayNameOf({ id: 'Doubao-Seed-2.0-Code', name: 'Doubao-Seed-2.1-Turbo', input: ['text'], directoryFunction: 'solo_work_remote', kind: 'chat' }) === 'Doubao-Seed-2.0-Code')
    check('...and the hand-written fallback roster is total under the same rule', (() => {
      const out = uniquifyDisplayNames(FALLBACK_MODELS.cn)
      return out.length === FALLBACK_MODELS.cn.length && new Set(out.map((model) => model.name)).size === out.length && out.every((model) => !dashOrBlank(model.name))
    })())
  }
}

/* ─────────────────────────────── summary ─────────────────────────────── */
console.log('\n' + '-'.repeat(72))
console.log(`${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

/**
 * report-models.ts — 只读的「模型清单」复核脚本。
 *
 *   <dsh-node> tools/report-models.ts              # 打两张表：对话模型 / 内部组件
 *   <dsh-node> tools/report-models.ts --json       # 同上，但输出 JSON（便于以后 diff）
 *   <dsh-node> tools/report-models.ts --internal   # 只打内部组件那一张
 *
 * 它做什么：拉一次 Trae 目录（四个 function 全部问一遍，与插件上线时的行为一致），
 * 然后按 src/catalog.ts 的判据把每个 config_name 分成 chat / internal，并把这些字段
 * 打出来供人工核对：
 *
 *   id · 显示名 · kind · contextWindow · maxTokens · 多模态声明 · 推理档位 ·
 *   由哪个 function 提供 · 目录声明的 usage · Trae 真正发给上游的 model_name
 *
 * 「显示名」这一列是**最终写入名**，不是 Trae 目录里的原始 `display_name`：目录在
 * `fetchDirectoryModels` 的出口已经过 `uniquifyDisplayNames`（见 src/catalog.ts 的
 * 「显示名唯一化」一节），写进用户配置、`GET /models/all`、`/v1/models` 的都是这一列。
 * 报表因此可以直接核对"下拉框里到底会看到什么名字"。
 *
 * 它不做什么：不写任何文件、不改任何配置、不发对话请求、不打印凭据。
 * 唯一的一次网络往返就是读目录本身（与 `tools/trae.ts models` 相同，不消耗额度）。
 */
import {
  buildTraeHeaders,
  fetchDirectoryModels,
  REGION_GATEWAYS,
  TRAE_SOLO_MODELS_PATH,
  traeEndpoint,
  type TraeModel
} from '../src/catalog.ts'
import { TRAE_DIRECTORY_FUNCTIONS } from '../src/format.ts'
import { scanCredentials } from '../src/auth.ts'
import { readTraeIdentity } from '../src/identity.ts'
import { traeStorageCandidates } from '../src/paths.ts'

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)

/** 每个 id 在原始目录里的「证据」：各 function 声明的 usage 与 model_name。 */
interface RawEvidence {
  usage: string[]
  wire: string[]
  /** fn -> 该 function 为这个 id 声明的 model_name */
  wireByFunction: Record<string, string>
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function wireOf(entry: Record<string, unknown>): string | undefined {
  const details = Array.isArray(entry['model_detail_list']) ? entry['model_detail_list'] : []
  const name = recordOf(details[0])?.['model_name']
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
}

/** 直接读原始目录（不经 parseModel），只为了拿到 usage / model_name 这两个原始字段。 */
async function rawEvidence(
  region: string,
  credential: Parameters<typeof buildTraeHeaders>[0],
  identity: Parameters<typeof buildTraeHeaders>[1]
): Promise<{ byId: Map<string, RawEvidence>; attempts: { fn: string; status?: number; count?: number; error?: string }[] }> {
  const base = REGION_GATEWAYS[region as keyof typeof REGION_GATEWAYS].chat
  const headers = buildTraeHeaders(credential, identity, 'application/json')
  const byId = new Map<string, RawEvidence>()
  const attempts: { fn: string; status?: number; count?: number; error?: string }[] = []
  for (const fn of TRAE_DIRECTORY_FUNCTIONS[region] ?? []) {
    try {
      const response = await fetch(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
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
        signal: AbortSignal.timeout(30000)
      })
      if (!response.ok) {
        attempts.push({ fn, status: response.status, error: (await response.text().catch(() => '')).slice(0, 160) })
        continue
      }
      const document = (await response.json()) as Record<string, unknown>
      const list = Array.isArray(document['config_info_list']) ? document['config_info_list'] : []
      let count = 0
      for (const raw of list) {
        const entry = recordOf(raw)
        const id = typeof entry?.['config_name'] === 'string' ? (entry['config_name'] as string) : ''
        if (entry === undefined || id === '') continue
        count += 1
        const current = byId.get(id) ?? { usage: [], wire: [], wireByFunction: {} }
        const usage = typeof entry['usage'] === 'string' ? (entry['usage'] as string) : '(无)'
        if (!current.usage.includes(usage)) current.usage.push(usage)
        const wire = wireOf(entry)
        if (wire !== undefined) {
          if (!current.wire.includes(wire)) current.wire.push(wire)
          current.wireByFunction[fn] = wire
        }
        byId.set(id, current)
      }
      attempts.push({ fn, status: response.status, count })
    } catch (error) {
      attempts.push({ fn, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { byId, attempts }
}

function fmtEfforts(model: TraeModel): string {
  const efforts = model.reasoningEfforts
  if (efforts === undefined) return '-'
  const parts: string[] = []
  if (efforts.low !== undefined) parts.push(`low=${efforts.low}`)
  if (efforts.high !== undefined) parts.push(`high=${efforts.high}`)
  if (efforts.xhigh !== undefined) parts.push(`xhigh=${efforts.xhigh}`)
  return parts.join(' ')
}

function fmtMultimodal(model: TraeModel): string {
  if (model.multimodal === true) return '声明支持图像'
  if (model.multimodal === false) return '声明纯文本'
  return '未声明'
}

function esc(value: string): string {
  return value.replaceAll('|', '\\|')
}

async function main(): Promise<void> {
  const scan = scanCredentials(traeStorageCandidates())
  const credential = scan.credentials.find((entry) => entry.source === 'desktop') ?? scan.credentials[0]
  if (credential === undefined) throw new Error('本机读不到任何 Trae 凭据')
  const identity = readTraeIdentity(credential.storagePath, credential.edition)
  const region = credential.region

  const directory = await fetchDirectoryModels(region, credential, identity)
  const raw = await rawEvidence(region, credential, identity)

  const models = directory.models.slice().sort((left, right) => left.id.localeCompare(right.id))
  const chat = models.filter((model) => model.kind === 'chat')
  const internal = models.filter((model) => model.kind !== 'chat')

  if (flag('json')) {
    const payload = {
      region,
      fetchedAt: new Date().toISOString(),
      attempts: directory.attempts,
      count: { total: models.length, chat: chat.length, internal: internal.length },
      chat: chat.map((model) => ({ ...model, evidence: raw.byId.get(model.id) ?? null })),
      internal: internal.map((model) => ({ ...model, evidence: raw.byId.get(model.id) ?? null }))
    }
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  const header = ['id', '显示名（最终写入名）', 'ctx', 'max', '多模态', '推理档位', 'function', 'usage', '线上 model_name']
  const row = (model: TraeModel): string => {
    const evidence = raw.byId.get(model.id)
    return [
      esc(model.id),
      esc(model.name),
      model.contextWindow === undefined ? '?' : String(model.contextWindow),
      model.maxTokens === undefined ? '?' : String(model.maxTokens),
      fmtMultimodal(model),
      fmtEfforts(model),
      model.directoryFunction,
      evidence === undefined ? '(无)' : evidence.usage.join('/'),
      evidence === undefined || evidence.wire.length === 0 ? '(无)' : evidence.wire.join(' , ')
    ].join(' | ')
  }

  console.log(`# Trae 目录只读报表 · region=${region} · ${new Date().toISOString()}`)
  console.log(`# 目录请求：${directory.attempts.map((attempt) => `${attempt.fn}=${attempt.count ?? attempt.status ?? attempt.error}`).join(' · ')}`)
  console.log(`# 合计 ${models.length} 个 config_name —— 对话模型 ${chat.length} · 内部组件 ${internal.length}`)
  // The 显示名 column is what the user will read in the model dropdown (the fetch
  // boundary already uniquified it), so "two identical rows" would be visible right
  // here — this line is the read-only corroboration of that invariant.
  {
    const distinct = new Set(chat.map((model) => model.name)).size
    const renamed = chat.filter((model) => model.name !== model.id).length
    const auto = chat.filter((model) => /-auto$/i.test(model.id)).length
    console.log(`# 显示名唯一化：${chat.length} 个对话模型两两不同名 ${distinct === chat.length ? '是 ✓' : `否 ✗（只有 ${distinct} 个不同）`} · ${renamed} 个名字与 id 不同 · ${auto} 个 -auto 槽带 Auto 标记`)
  }

  if (!flag('internal')) {
    console.log('')
    console.log(`## 对话模型（${chat.length}）`)
    console.log(`| ${header.join(' | ')} |`)
    console.log(`| ${header.map(() => '---').join(' | ')} |`)
    for (const model of chat) console.log(`| ${row(model)} |`)
  }

  console.log('')
  console.log(`## 内部组件（${internal.length}）—— 默认不写进用户配置`)
  console.log(`| ${header.join(' | ')} | 判为 internal 的原因 |`)
  console.log(`| ${header.map(() => '---').join(' | ')} | --- |`)
  for (const model of internal) console.log(`| ${row(model)} | ${esc(model.internalReason ?? '(未记录)')} |`)
}

await main()

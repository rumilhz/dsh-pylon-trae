/**
 * dsh-pylon-trae CLI — drive the plugin's own API without any UI.
 *
 *   <dsh-node> tools/trae.ts status                 who we are, which account, how many models
 *   <dsh-node> tools/trae.ts credential             the token we bill with: source, expiry, whether
 *                                                    it has expired, whether it can be refreshed
 *                                                    (READ-ONLY, no network, no token value printed)
 *   <dsh-node> tools/trae.ts credential-store       the credential entry the Models page draws the
 *                                                    green dot from: is TRAE_API_KEY in
 *                                                    $DSH_HOME/.credentials.yaml, does it hold the
 *                                                    SAME token as the shim, and what would the
 *                                                    next boot change? (READ-ONLY, no network, no
 *                                                    value printed — only length + sha256[0..12])
 *   <dsh-node> tools/trae.ts models [--limit 20]     the live directory as the provider sees it
 *   <dsh-node> tools/trae.ts usage                   CN credits (read-only, no quota spent)
 *   <dsh-node> tools/trae.ts checkin                 today's check-in status (read-only)
 *   <dsh-node> tools/trae.ts checkin --claim         CLAIM today's reward  ← changes account state
 *   <dsh-node> tools/trae.ts test --model <id>       one minimal real call (SPENDS A LITTLE QUOTA)
 *   <dsh-node> tools/trae.ts refresh --host          ask the RUNNING plugin to rebuild the model list
 *                                                    (needs the host: it owns the settings write)
 *
 * Everything except `--claim`, `test` and the directory request is read-only.
 * Tokens are never printed; only a 12-hex fingerprint.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { handleApi, type ApiDeps } from '../src/api.ts'
import {
  canRefresh,
  credentialStorePath,
  credentialsDocumentPath,
  credentialsRefValue,
  isExpired,
  listCredentialBackups,
  preferValidStoredCredential,
  readCredentials,
  readStoredCredential,
  scanCredentials,
  tokenFingerprint,
  type TraeCredential
} from '../src/auth.ts'
import { FALLBACK_MODELS, fetchDirectoryModels, type TraeModel } from '../src/catalog.ts'
import { dshHome } from '../src/guard.ts'
import { readTraeIdentity } from '../src/identity.ts'
import { TRAE_API_KEY_REF } from '../src/seed.ts'
import { traeStorageCandidates } from '../src/paths.ts'

const argv = process.argv.slice(2)
const command = argv.find((value) => !value.startsWith('-')) ?? 'status'
const flag = (name: string): boolean => argv.includes(`--${name}`)
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const line = (char = '-', width = 78): string => char.repeat(width)

async function remote(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const tokenPath = join(dshHome(), '.dsh-pylon-trae', 'cn-shim-token.json')
  let token: string
  try {
    token = readFileSync(tokenPath, 'utf8').trim()
  } catch {
    throw new Error(`读不到回环 token（${tokenPath}）—— 插件还没在这台机器上启动过？`)
  }
  const url = `http://127.0.0.1:${option('port') ?? '7864'}/admin${path}`
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await response.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`宿主回答的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
}

function print(label: string, value: unknown): void {
  console.log(`${label.padEnd(16)} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

async function builtDeps(): Promise<{ deps: ApiDeps; credential: TraeCredential; models: readonly TraeModel[] }> {
  const scan = scanCredentials(traeStorageCandidates())
  const credential = scan.credentials.find((entry) => entry.source === 'desktop') ?? scan.credentials[0]
  if (credential === undefined) throw new Error('本机读不到任何 Trae 凭据')
  const identity = readTraeIdentity(credential.storagePath, credential.edition)
  let models: readonly TraeModel[] = FALLBACK_MODELS[credential.region]
  const directory = await fetchDirectoryModels(credential.region, credential, identity)
  if (directory.models.length > 0) models = directory.models
  const deps: ApiDeps = {
    region: credential.region,
    port: Number(option('port') ?? 7864),
    credential: async () => credential,
    identity: async () => identity,
    models: () => models,
    accounts: async () => scan.credentials.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      ...(entry.accountName === undefined ? {} : { accountName: entry.accountName }),
      edition: entry.edition,
      source: entry.source,
      expiresAtMs: entry.expiresAtMs,
      active: entry.id === credential.id
    })),
    selectAccount: async () => ({ ok: false, detail: 'CLI 不能切账号（要写插件状态）—— 请用宿主里的卡片或 POST /admin/account' }),
    refresh: async () => ({ outcome: { kind: 'no-guard', detail: 'CLI 里没有 settings 服务，重建清单要交给宿主' }, modelCount: models.length })
  }
  return { deps, credential, models }
}

try {
  if (command === 'refresh') {
    if (!flag('host')) {
      console.log('refresh 需要宿主（它才有 settings 写路径）。加 --host 让正在运行的插件去做：')
      console.log(`  ${process.argv[1]} refresh --host`)
      process.exit(2)
    }
    const result = await remote('/models/refresh', 'POST', {})
    console.log(line('='))
    print('kind', result['kind'])
    print('modelCount', result['modelCount'])
    const outcome = result['outcome'] as Record<string, unknown> | undefined
    if (outcome !== undefined && typeof outcome['addedModels'] === 'object') print('addedModels', outcome['addedModels'])
    if (outcome !== undefined && outcome['detail'] !== undefined) print('detail', outcome['detail'])
    console.log(line('='))
    process.exit(result['ok'] === true ? 0 : 1)
  }

  if (command === 'credential-store') {
    // READ-ONLY and entirely local: no gateway request, no host request, and no
    // value on screen. It answers the one question the Models page cannot: "is the
    // green dot TRUE, and would the next boot change anything?" — which is
    // `describe(TRAE_API_KEY).configured` on the one side and "is that value still
    // the token this plugin will authenticate its shim with" on the other. A
    // mismatch is worth seeing BEFORE restarting DSH: the next boot syncs it (and
    // that is the fix), but until then the route would answer 401.
    const home = dshHome()
    const path = credentialsDocumentPath(home)
    const read = readCredentials(home)
    const shimTokenPath = join(home, '.dsh-pylon-trae', 'cn-shim-token.json')
    let shimToken: string | undefined
    try {
      shimToken = readFileSync(shimTokenPath, 'utf8').trim() || undefined
    } catch {
      shimToken = undefined
    }
    const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12)
    console.log(line('='))
    console.log('dsh-pylon-trae CLI · credential-store · 只读、不联网（值不打印，只有长度 + sha256 前 12 位）')
    console.log(line('='))
    print('document', path)
    if ('detail' in read) {
      print('readable', `否 —— ${read.detail}`)
      print('consequence', '文档读不回来时插件不写：宁可不点亮绿点，也不冒红点的险')
    } else {
      const stored = read.refs.get(TRAE_API_KEY_REF)
      print('readable', `是（version ${String(read.version ?? 1)}，refs ${read.refs.size} 个）`)
      print('refs', [...read.refs.keys()].join(', '))
      print('greenDotRef', `${TRAE_API_KEY_REF} = ${stored === undefined ? '缺失 ⇒ 模型页没有绿点' : `已配置（len ${stored.length}, sha256 ${fingerprint(stored)}）`}`)
      print('shimToken', shimToken === undefined ? `不存在（${shimTokenPath}）—— 下次启动会生成新 token 并同步` : `len ${shimToken.length}, sha256 ${fingerprint(shimToken)}`)
      print('sameValue', stored === undefined || shimToken === undefined ? '无法比较' : stored === shimToken ? '是 —— 下次启动一个字节都不写' : '否 —— 下次启动会同步条目与凭据库（旧值轮换后必然失效）')
      print('otherRefs', read.refs.size - (stored === undefined ? 0 : 1))
    }
    print('backups', `${listCredentialBackups(home).length} 个（在 .dsh-pylon-trae/backups 里，只增改我们的键）`)
    print('probeValue', credentialsRefValue(home, TRAE_API_KEY_REF) === undefined ? '不在文档里' : '在文档里（磁盘读回）')
    console.log(line('='))
    process.exit('detail' in read ? 1 : 0)
  }

  if (command === 'credential') {
    // READ-ONLY and entirely local: no gateway request, no host request, and no
    // token value on screen — the only token output is a 12-hex fingerprint. It
    // answers the three questions the user actually has when a call fails: which
    // source is being billed, when its token runs out (and whether that has already
    // happened), and whether this plugin can renew it by itself.
    const scan = scanCredentials(traeStorageCandidates())
    const credential = scan.credentials.find((entry) => entry.source === 'desktop') ?? scan.credentials[0]
    console.log(line('='))
    console.log('dsh-pylon-trae CLI · credential · 只读、不联网（token 值不打印）')
    console.log(line('='))
    if (credential === undefined) {
      console.log('本机读不到任何 Trae 凭据')
      for (const failure of scan.failures) console.log(`  ${failure}`)
      console.log(line('='))
      process.exit(1)
    }
    const now = Date.now()
    const stamp = (value: number | undefined): string =>
      value === undefined || value <= 0
        ? '未知（文档里没写）'
        : `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)}Z（${Math.round((value - now) / 60000)} min）`
    print('account', credential.accountName ?? (credential.userId || '(none)'))
    print('source', `${credential.source}/${credential.edition} · region=${credential.region}`)
    print('host', credential.host || '(none)')
    print('expiresAt', stamp(credential.expiresAtMs))
    print('expired', isExpired(credential))
    print('refreshable', canRefresh(credential, now))
    print('refreshToken', credential.refreshToken === undefined ? '没有 —— 只能重新登录 Trae' : '有（值不打印）')
    print('refreshExpiresAt', stamp(credential.refreshExpiresAtMs))
    let storePath: string
    try {
      storePath = credentialStorePath(dshHome(), credential.id)
    } catch (error) {
      storePath = `(id 拼不出路径：${error instanceof Error ? error.message : String(error)})`
    }
    const stored = readStoredCredential(storePath, credential.edition)
    // The plugin's own refreshed copy: what it is, and whether it would be used.
    print('ownCopy', stored === undefined ? `不存在（${storePath}）` : `${isExpired(stored) ? '已过期' : '有效'}（${storePath}）`)
    print('willUse', preferValidStoredCredential(credential, stored) === undefined ? 'Trae 桌面端凭据' : '本插件自己的副本（桌面端凭据已过期）')
    print('tokenSha256', tokenFingerprint(credential))
    console.log(line('='))
    process.exit(0)
  }

  const { deps, credential, models } = await builtDeps()
  console.log(line('='))
  console.log(`dsh-pylon-trae CLI · ${command} · region=${deps.region} · credential=${credential.source}/${credential.edition} fp=${tokenFingerprint(credential)}`)
  console.log(line('='))

  if (command === 'status') {
    const response = await handleApi({ method: 'GET', path: '/status' }, deps)
    print('ok', response.body['ok'])
    print('modelCount', response.body['modelCount'])
    print('credential', response.body['credential'])
    print('accounts', response.body['accounts'])
  } else if (command === 'models') {
    const limit = Number(option('limit') ?? 20)
    for (const model of models.slice(0, limit)) {
      const window = model.contextWindow === undefined ? '?' : String(model.contextWindow)
      console.log(`  ${model.id.padEnd(34)} ${model.name.padEnd(26)} ctx=${window.padStart(7)} ${model.input.join('+').padEnd(11)} ${model.directoryFunction}`)
    }
    console.log(`  … 共 ${models.length} 个`)
  } else if (command === 'usage') {
    const response = await handleApi({ method: 'GET', path: '/usage' }, deps)
    print('ok', response.body['ok'])
    if (response.body['ok'] === true) {
      print('credits', response.body['credits'])
      print('payloadKeys', response.body['payloadKeys'])
    } else print('detail', response.body['detail'])
  } else if (command === 'checkin') {
    if (flag('claim')) {
      console.log('⚠️  --claim 会真的领取今日签到（唯一会改变账号状态的调用）')
      const response = await handleApi({ method: 'POST', path: '/checkin', body: {} }, deps)
      print('ok', response.body['ok'])
      print('claimed', response.body['claimed'])
      print('code', response.body['code'])
      print('message', response.body['message'])
    } else {
      const response = await handleApi({ method: 'GET', path: '/checkin' }, deps)
      print('ok', response.body['ok'])
      if (response.body['ok'] === true) {
        print('checkedIn', response.body['checkedIn'])
        print('didCheckedIn', response.body['didCheckedIn'])
        print('credits', response.body['credits'])
        print('enabled', response.body['enabled'])
      } else print('detail', response.body['detail'])
    }
  } else if (command === 'test') {
    const model = option('model')
    if (model === undefined) {
      console.log('test 需要 --model <id>（它会发一条极小的真实消息，消耗一点点额度）')
      process.exit(2)
    }
    console.log('⚠️  这会向 Trae 发一条真实消息（最小 ping），消耗一点点额度')
    const response = await handleApi({ method: 'POST', path: '/models/test', body: { modelIds: [model] } }, deps)
    print('ok', response.body['ok'])
    print('results', response.body['results'])
  } else {
    console.log(`未知命令 ${command}`)
    process.exit(2)
  }
  console.log(line('='))
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

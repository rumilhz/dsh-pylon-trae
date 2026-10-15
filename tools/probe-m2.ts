/**
 * M2 probe — turns the shim on, then talks to it over real HTTP.
 *
 *   ... probe-m2.ts                 models + /healthz only        (no generation)
 *   ... probe-m2.ts --chat          also one minimal chat call    (SPENDS A LITTLE QUOTA)
 *   ... probe-m2.ts --chat --tool   that call declares one tool   (proves tool_calls)
 *
 * It binds the real fixed port (7864 by default) so a port collision shows up
 * here rather than at plugin start. Nothing is written to disk.
 */
import { scanCredentials, tokenFingerprint, type TraeCredential } from '../src/auth.ts'
import { fetchDirectoryModels, FALLBACK_MODELS, type TraeModel } from '../src/catalog.ts'
import { readTraeIdentity, type TraeIdentity } from '../src/identity.ts'
import { traeStorageCandidates } from '../src/paths.ts'
import { createShim } from '../src/shim.ts'

const argv = process.argv.slice(2)
const wantChat = argv.includes('--chat')
const wantTool = argv.includes('--tool')
const portArg = argv.find((value) => value.startsWith('--port='))
const port = portArg === undefined ? 7864 : Number(portArg.slice('--port='.length))
const token = 'probe-m2-token'

const line = (char = '-', width = 78): string => char.repeat(width)

const scan = scanCredentials(traeStorageCandidates())
const credential: TraeCredential | undefined = scan.credentials.find((entry) => entry.region === 'cn') ?? scan.credentials[0]
if (credential === undefined) {
  console.log('no usable Trae credential on this machine — nothing to probe')
  process.exit(1)
}
console.log(line('='))
console.log(`M2 probe · region=${credential.region} · port=${port} · credential=${credential.source} token=${tokenFingerprint(credential)}`)
console.log(line('='))

const identity: TraeIdentity = readTraeIdentity(credential.storagePath, credential.edition)
console.log(`identity: machine=${identity.machineId.slice(0, 8)}… device=${identity.deviceId.slice(0, 8)}… appVersion=${identity.appVersion ?? '(none)'}`)

let models: readonly TraeModel[] = FALLBACK_MODELS[credential.region]
const directory = await fetchDirectoryModels(credential.region, credential, identity)
if (directory.models.length > 0) {
  models = directory.models
  console.log(`directory: ${directory.models.length} models live (${directory.attempts.map((a) => `${a.fn}:${a.status ?? 'err'}`).join(' ')})`)
} else {
  console.log(`directory: unreachable, using ${models.length} fallback models (${directory.attempts.map((a) => `${a.fn}:${a.error ?? a.status}`).join(' ')})`)
}

const shim = createShim({
  region: credential.region,
  port,
  token,
  credential: async () => credential,
  identity: async () => identity,
  models: () => models,
  logger: { info: (m, d) => console.log(`  [shim] ${m}`, d ?? ''), warn: (m, d) => console.log(`  [shim:warn] ${m}`, d ?? ''), error: (m, d) => console.log(`  [shim:error] ${m}`, d ?? '') }
})

try {
  await shim.ready
} catch (error) {
  console.log(`\nSHIM FAILED TO START: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
console.log(`\nshim listening on ${shim.baseUrl()}  (GET /healthz, GET /v1/models, POST /v1/chat/completions)`)

const auth = { Authorization: `Bearer ${token}` }
const health = await fetch(`${shim.baseUrl()}/healthz`, { headers: auth })
console.log(`[1] GET /healthz -> ${health.status} ${await health.text()}`)
const unauth = await fetch(`${shim.baseUrl()}/healthz`)
console.log(`[2] GET /healthz without bearer -> ${unauth.status} (expected 401)`)
const listed = (await (await fetch(`${shim.baseUrl()}/v1/models`, { headers: auth })).json()) as { data?: { id: string }[] }
console.log(`[3] GET /v1/models -> ${listed.data?.length ?? 0} models; first: ${listed.data?.slice(0, 3).map((m) => m.id).join(', ')}`)

if (!wantChat) {
  console.log('\n(no --chat: no generation was requested, no quota touched)')
} else {
  const chosen = models.find((model) => /flash/i.test(model.id)) ?? models[0]
  if (chosen === undefined) {
    console.log('\nno model to call')
  } else {
    console.log(`\n[4] POST /v1/chat/completions  model=${chosen.id}  function=${chosen.directoryFunction}${wantTool ? '  + tool' : ''}`)
    const body = {
      model: chosen.id,
      stream: true,
      messages: [{ role: 'user', content: wantTool ? 'What time is it? Use the get_time tool.' : 'Reply with exactly: pong' }],
      ...(wantTool
        ? {
            tools: [
              {
                type: 'function',
                function: {
                  name: 'get_time',
                  description: 'Return the current time',
                  parameters: { type: 'object', properties: {}, required: [] }
                }
              }
            ]
          }
        : {})
    }
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    console.log(`    HTTP ${response.status} ${response.headers.get('content-type') ?? ''}`)
    if (response.status !== 200) {
      console.log(`    body: ${(await response.text()).slice(0, 400)}`)
    } else {
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let chunks = 0
      let text = ''
      let thinking = ''
      const toolCalls: string[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n\n')
        while (index !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const payload = frame.replace(/^data: /, '')
          if (payload !== '[DONE]') {
            chunks += 1
            try {
              const parsed = JSON.parse(payload) as { choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[]; error?: { message?: string } }
              if (parsed.error !== undefined) console.log(`    ERROR CHUNK: ${parsed.error.message}`)
              const delta = parsed.choices?.[0]?.delta ?? {}
              if (typeof delta['content'] === 'string') text += delta['content']
              if (typeof delta['reasoning_content'] === 'string') thinking += delta['reasoning_content']
              if (Array.isArray(delta['tool_calls'])) {
                for (const call of delta['tool_calls'] as { function?: { name?: string; arguments?: string } }[]) {
                  toolCalls.push(`${call.function?.name ?? '?'}(${call.function?.arguments ?? ''})`)
                }
              }
              const finish = parsed.choices?.[0]?.finish_reason
              if (finish !== null && finish !== undefined) console.log(`    finish_reason=${finish}`)
            } catch {
              console.log(`    (unparsable chunk) ${payload.slice(0, 120)}`)
            }
          }
          index = buffer.indexOf('\n\n')
        }
      }
      console.log(`    chunks=${chunks}  text=${JSON.stringify(text.slice(0, 200))}`)
      if (thinking !== '') console.log(`    thinking=${JSON.stringify(thinking.slice(0, 120))}`)
      if (toolCalls.length > 0) console.log(`    tool_calls=${JSON.stringify(toolCalls)}`)
    }
  }
}

await shim.close()
console.log(line('='))
console.log('done (nothing was written)')

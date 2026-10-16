/**
 * The loopback shim: a FIXED-PORT, token-guarded OpenAI-compatible endpoint that
 * speaks Trae SOLO on the other side.
 *
 * Fixed port on purpose. The provider entry we seed into `llm-pi-ai` is static
 * configuration (baseURL lives in cordis.patch.yml), so the address cannot move
 * between starts — unlike the upstream plugin, which binds port 0 and hides the
 * real token behind a per-process secret. Here:
 *
 *   - the port comes from our own config (default 7864 CN / 7865 AI);
 *   - the token is persisted in our own settings namespace and written into the
 *     provider's `headers`, so pi-ai sends it and we can verify it;
 *   - a port collision is a LOUD failure, never a silent port change (a moved
 *     port would leave the stored baseURL pointing at nothing).
 *
 * Guard rails mirror what the upstream shim does: loopback Host and Origin only,
 * constant-time bearer comparison, and a request-body cap.
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { TraeCredential } from './auth.ts'
import { buildTraeHeaders, REGION_GATEWAYS, TRAE_SOLO_CHAT_PATH, traeEndpoint, type TraeModel } from './catalog.ts'
import type { TraeIdentity } from './identity.ts'
import type { TraeRegion } from './paths.ts'
import { buildTraeBody, parseSseStream, pumpTraeStream, statusForTraeError, wireTargetOf } from './protocol.ts'

const BODY_LIMIT = 32 * 1024 * 1024

export interface ShimLogger {
  info?(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export interface ShimOptions {
  region: TraeRegion
  port: number
  /** The bearer token pi-ai will send (persisted by the plugin, not a Trae secret). */
  token: string
  credential(): Promise<TraeCredential>
  identity(): Promise<TraeIdentity>
  /** The WHOLE catalogue this shim resolves a request's `model` id against. */
  models(): readonly TraeModel[]
  /**
   * The rows `GET /v1/models` may ADVERTISE — not necessarily every row
   * {@link models} answers with.
   *
   * The filter belongs to the CALLER, not to this file, and that is deliberate:
   * shim.ts moves bytes, so it must not hold a second copy of "what counts as a
   * conversation model". That criterion lives in `src/catalog.ts`
   * (`classifyDirectoryEntry` / `partitionModels`), and `src/seed.ts` already
   * applies it to the provider entry pi-ai reads. `src/index.ts` passes the very
   * same `partitionModels(models).chat` here, so the ids advertised on this route
   * ARE the ids the provider entry got — the two surfaces cannot drift apart,
   * which is the whole point of the option existing.
   *
   * CONTRACT: the returned rows are a subset of {@link models}; `GET /healthz`
   * reports the difference as `internal`.
   *
   * Omitted = no filtering (advertise everything `models()` answers), so a
   * composition that injects only `models()` keeps its old behaviour.
   */
  advertisedModels?(): readonly TraeModel[]
  /**
   * The plugin's own API, exposed behind the same bearer on two prefixes:
   * `/admin/*` (our CLI) and `/plugins/dsh-pylon-trae/*` (the shape the settings card
   * will use once it talks to the host web server instead).
   */
  api?(request: { method: string; path: string; body?: unknown }): Promise<{ status: number; body: Record<string, unknown> }>
  fetchImpl?: typeof fetch
  logger?: ShimLogger
}

export interface TraeShim {
  ready: Promise<void>
  port(): number
  baseUrl(): string
  close(): Promise<void>
}

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false
  const name = host.replace(/^\[/, '').split(']')[0]?.split(':')[0] ?? ''
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createShim(options: ShimOptions): TraeShim {
  const fetchImpl = options.fetchImpl ?? fetch
  /**
   * What `GET /v1/models` advertises. Called through `options` every time (never
   * captured) so the caller's list is read at request time, exactly like
   * `options.models()`.
   */
  const advertised = (): readonly TraeModel[] =>
    options.advertisedModels === undefined ? options.models() : options.advertisedModels()
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((req, res) => {
    void handle(req, res)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `dsh-pylon-trae: loopback port ${options.port} is already in use, so the provider's stored baseURL cannot be honoured. ` +
                `Free the port or change regionPorts.${options.region} in this plugin's settings; the shim will NOT silently move to another port.`
            )
          : error
      )
    })
    server.listen(options.port, '127.0.0.1')
  })

  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null
    if (match === null) return false
    const actual = Buffer.from(match[1] ?? '')
    const expected = Buffer.from(options.token)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) return writeError(res, 403, 'host_not_allowed', 'Host must be loopback')
      if (!originIsLoopback(req.headers.origin)) return writeError(res, 403, 'origin_not_allowed', 'Origin must be loopback')
      if (!bearerOk(req)) return writeError(res, 401, 'unauthorized', 'Missing or invalid bearer')
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        /**
         * Named parts, never one bare total.
         *
         * `models` used to be `options.models().length` — the whole directory — while
         * `GET /v1/models` below listed only the subset the caller advertises. One
         * plugin answering "79" here and "47" there reads as "the filter never ran",
         * and anyone cross-checking the two numbers has no way to tell which one is
         * the mistake.
         *
         * So: `models` is the count this endpoint actually serves on `/v1/models`
         * (kept under its old name so the existing readers keep working — tools/
         * doctor.ts identifies our shim by it, tools/coldstart-verify.mjs asserts it
         * is positive), `chat` is the same number under the classification's own
         * name, `internal` is how many catalogue rows are deliberately NOT
         * advertised, and `total` is the catalogue `models()` returns. A reader
         * comparing `/v1/models` with this answer now sees 47 on both sides.
         */
        const total = options.models().length
        const chat = advertised().length
        // By contract `advertised()` is a subset of `models()`, so this difference is
        // the hidden-internal count. The clamp only stops a mis-wired caller from
        // reporting a NEGATIVE part; a caller that violates the subset contract shows
        // it as `total !== chat + internal` rather than as a plausible number.
        const internal = total > chat ? total - chat : 0
        return writeJson(res, 200, { ok: true, region: options.region, port: options.port, models: chat, chat, internal, total })
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        // `advertised()`, NOT `options.models()`: the caller decides which rows this
        // route offers (see `advertisedModels`). The chat route below still resolves
        // ids against the FULL catalogue on purpose — a user may type an id in
        // themselves, and passing it upstream is more truthful than refusing it.
        return writeJson(res, 200, {
          object: 'list',
          data: advertised().map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: `trae-${options.region}` }))
        })
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        return await handleChat(req, res)
      }
      // Our own API, same bearer. `/admin/*` is what the CLI uses; the
      // `/plugins/dsh-pylon-trae/*` spelling matches what a settings card would call if
      // it ever reached this port directly.
      if (options.api !== undefined && (url.startsWith('/admin/') || url.startsWith('/plugins/dsh-pylon-trae/'))) {
        const relative = url.replace(/^\/admin/, '').replace(/^\/plugins\/dsh-pylon-trae/, '') || '/status'
        let payload: unknown
        if (req.method === 'POST' || req.method === 'PUT') {
          const raw = await readBody(req)
          try {
            payload = raw === '' ? {} : JSON.parse(raw)
          } catch {
            return writeError(res, 400, 'invalid_json', 'Request body must be JSON')
          }
        }
        const result = await options.api({ method: req.method ?? 'GET', path: relative, body: payload })
        return writeJson(res, result.status, result.body)
      }
      return writeError(res, 404, 'not_found', `No such route: ${req.method} ${url}`)
    } catch (error) {
      options.logger?.error('dsh-pylon-trae: shim request failed', error)
      if (!res.headersSent) writeError(res, 500, 'internal', 'Internal shim error')
      else if (!res.writableEnded) res.end()
    }
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      return writeError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
    }
    const raw = await readBody(req)
    let request: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be an object')
      request = parsed as Record<string, unknown>
    } catch {
      return writeError(res, 400, 'invalid_json', 'Request body must be a JSON object')
    }
    const modelId = typeof request['model'] === 'string' ? request['model'] : ''
    if (modelId === '') return writeError(res, 400, 'missing_model', 'Request body needs a model id')
    const known = options.models().find((model) => model.id === modelId)
    // An unknown id is passed through with the default function rather than refused:
    // a user may have typed a model into the Models page that the live directory has
    // not caught up with, and Trae's own 4001 answer is more truthful than ours.
    const target = known === undefined ? { configName: modelId, fn: 'solo_work_lite' } : wireTargetOf(known)
    let body: string
    try {
      body = buildTraeBody(request, target)
    } catch (error) {
      return writeError(res, 400, 'invalid_request', error instanceof Error ? error.message : String(error))
    }
    const [credential, identity] = await Promise.all([options.credential(), options.identity()])
    const upstream = await fetchImpl(traeEndpoint(REGION_GATEWAYS[options.region].chat, TRAE_SOLO_CHAT_PATH), {
      method: 'POST',
      headers: buildTraeHeaders(credential, identity),
      body
    }).catch((error: unknown) => {
      options.logger?.warn('dsh-pylon-trae: upstream transport failed', error)
      return undefined
    })
    if (upstream === undefined) return writeError(res, 502, 'upstream_unreachable', 'Trae gateway could not be reached')
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 512)
      options.logger?.warn('dsh-pylon-trae: llm_utils_chat rejected', { status: upstream.status, model: modelId, detail })
      return writeError(res, upstream.status === 401 || upstream.status === 403 ? 401 : 502, 'upstream_rejected', `Trae answered HTTP ${upstream.status}: ${detail}`)
    }
    if (upstream.body === null) return writeError(res, 502, 'upstream_empty', 'Trae answered with an empty body')
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    let first = true
    const writer = {
      write(payload: unknown): void {
        const line = typeof payload === 'string' ? payload : JSON.stringify(payload)
        if (first) {
          first = false
          options.logger?.info?.(`dsh-pylon-trae: streaming ${target.configName} via ${target.fn}`)
        }
        res.write(`data: ${line}\n\n`)
      }
    }
    try {
      await pumpTraeStream(parseSseStream(upstream.body), writer, { model: modelId, onUsage: (usage) => options.logger?.info?.('dsh-pylon-trae: usage', usage) })
    } catch (error) {
      options.logger?.warn('dsh-pylon-trae: stream failed mid-flight', error)
    } finally {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }
  }

  return {
    ready,
    port: () => options.port,
    baseUrl: () => `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
  }
}

export { statusForTraeError }

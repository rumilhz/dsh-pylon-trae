/**
 * Reading (and decrypting) the credential Trae already stores locally.
 *
 * The desktop app keeps its auth document as a single encrypted string inside
 * `User/globalStorage/storage.json` under `iCubeAuthInfo://icube.cloudide`.
 * The ciphertext layout and key derivation are properties of Trae's own file
 * format, recorded in `./format.ts` (generated, with provenance):
 *
 *   base64 -> [ header:6 | random:32 | aes-128-cbc ciphertext ]
 *   header  74 63 05 10 00 00 -> salt pair A/B ; 12 39 20 20 02 03 -> C/D
 *   derived = sha512( sha512(random) || xor(saltX, saltY) )
 *   key     = derived[0..16]   iv = derived[16..32]
 *   plain   = [ sha512(rest):64 | rest ]  -> rest is UTF-8 JSON
 *
 * Nothing here writes anything, and the token never leaves this module's caller:
 * `TraeCredential.accessToken` is the only field that must never be logged.
 *
 * ## Expiry and the refresh path (added 2026-10-14)
 *
 * Trae's desktop token expires, and until now the plugin could only tell the user
 * to reopen the Trae app: `refreshToken` was parsed into {@link TraeCredential}
 * and never used. The pinned upstream (`dsh-connect-trae@3.4.0`) DOES have a
 * refresh path, and this module now mirrors its contract rather than inventing
 * one — see {@link refreshTraeCredential} for the endpoints, the two contracts
 * (signed / legacy) and the exact envelope, each cited to the upstream line it
 * was read from.
 *
 * 🔴 The one rule that cannot bend: **the refreshed token is never written back
 * into Trae's own `storage.json`.** It lands in this plugin's own file
 * (`$DSH_HOME/.dsh-pylon-trae/credentials-<id>.json`, written `.part` → `renameSync`)
 * and is preferred from memory; {@link writeCredentialAtomic} refuses any path
 * outside that directory outright, so a future edit cannot quietly break it.
 */
import { createDecipheriv, createHash, randomBytes, sign } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { BACKUP_INFIX, DEFAULT_KEEP_BACKUPS, backupDir, dshHome } from './guard.ts'
import { SALT_A, SALT_B, SALT_C, SALT_D, TRAE_AUTH_STORAGE_KEY } from './format.ts'
import { regionOfEdition, type TraeEdition, type TraeRegion, type TraeStorageCandidate } from './paths.ts'

export interface TraeCredential {
  /** Stable, non-secret id: sha256(edition + '\0' + userId)[0..24]. */
  id: string
  edition: TraeEdition
  region: TraeRegion
  source: 'desktop' | 'cli' | 'own'
  storagePath: string
  userId: string
  accountName?: string
  host: string
  userRegion?: string
  expiresAtMs: number
  refreshToken?: string
  /**
   * When the REFRESH token itself stops being usable (upstream reads
   * `refreshExpiredAt`; `Result.RefreshExpireAt` on the way back). Absent or 0
   * means the document did not say, never "expired at the epoch".
   */
  refreshExpiresAtMs?: number
  /** SECRET. Never log, never serialise into settings or an HTTP response. */
  accessToken: string
}

const AES_HEADER = Buffer.from([116, 99, 5, 16, 0, 0])
const AES_PRIVATE_HEADER = Buffer.from([18, 57, 32, 32, 2, 3])

function xor(a: Uint8Array, b: Uint8Array): Buffer {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)))
}

function encryptionType(header: Buffer): 'aes' | 'aes-private' {
  if (header.equals(AES_HEADER)) return 'aes'
  if (header.equals(AES_PRIVATE_HEADER)) return 'aes-private'
  throw new Error('unsupported Trae auth encryption header')
}

/** Decrypt one Trae storage value. Throws on a malformed or tampered input. */
export function decryptTraeStorageValue(encoded: string): string {
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length <= 102) throw new Error('Trae auth ciphertext is too short')
  const type = encryptionType(buffer.subarray(0, 6))
  const random = buffer.subarray(6, 38)
  const encrypted = buffer.subarray(38)
  const salt = type === 'aes-private' ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B)
  const first = createHash('sha512').update(random).digest()
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (decrypted.length < 64) throw new Error('Trae auth plaintext is too short')
  const expected = decrypted.subarray(0, 64)
  const plaintext = decrypted.subarray(64)
  if (!expected.equals(createHash('sha512').update(plaintext).digest())) throw new Error('Trae auth integrity check failed')
  return plaintext.toString('utf8')
}

/** A storage value is either already plain JSON or an encrypted blob. */
export function parseTraeAuthValue(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('Trae auth value is empty')
  return JSON.parse(trimmed.startsWith('{') ? trimmed : decryptTraeStorageValue(trimmed))
}

/** Read the auth object out of a `storage.json` document. */
export function parseTraeStorageDocument(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Trae storage document must be an object')
  const value = (parsed as Record<string, unknown>)[TRAE_AUTH_STORAGE_KEY]
  if (typeof value !== 'string') throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`)
  return parseTraeAuthValue(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function userRegionOf(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)['region'] : value
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 0xe8d4a51000 ? value : value * 1e3
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 0xe8d4a51000 ? numeric : numeric * 1e3
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Stable, non-secret account id (the same account id DSH sees in ported code). */
export function traeAccountId(edition: TraeEdition, userId: string, accountName?: string): string {
  return createHash('sha256').update(`${edition}\0${userId || accountName || 'unknown'}`).digest('hex').slice(0, 24)
}

/** Normalise the auth document into our credential shape (or undefined when unusable). */
export function normalizeCredential(
  raw: unknown,
  edition: TraeEdition,
  source: TraeCredential['source'],
  storagePath: string
): TraeCredential | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const accessToken = optionalString(value['token']) ?? optionalString(value['accessToken'])
  if (accessToken === undefined) return undefined
  const account = typeof value['account'] === 'object' && value['account'] !== null && !Array.isArray(value['account'])
    ? (value['account'] as Record<string, unknown>)
    : undefined
  const accountName = optionalString(account?.['username'])
  const userId = optionalString(value['userId']) ?? ''
  const refreshToken = optionalString(value['refreshToken'])
  const refreshExpiresAtMs = timeToMs(value['refreshExpiredAt'] ?? value['refreshExpiresAt'])
  const userRegion = userRegionOf(value['userRegion'])
  return {
    id: traeAccountId(edition, userId, accountName),
    edition,
    region: regionOfEdition(edition),
    source,
    storagePath,
    userId,
    ...(accountName === undefined ? {} : { accountName }),
    host: optionalString(value['host']) ?? '',
    ...(userRegion === undefined ? {} : { userRegion }),
    expiresAtMs: timeToMs(value['expiredAt'] ?? value['expiresAt']) ?? 0,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    accessToken
  }
}

/** Parse a Trae CLI token file: a bare three-part JWT (or a JSON envelope around one). */
export function parseTraeCliToken(text: string): { accessToken: string; userId: string; expiresAtMs?: number } {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('Trae CLI token file is empty')
  let token = trimmed
  if (trimmed.startsWith('{')) {
    const envelope: unknown = JSON.parse(trimmed)
    const record = typeof envelope === 'object' && envelope !== null ? (envelope as Record<string, unknown>) : {}
    const candidate = record['token'] ?? record['accessToken'] ?? record['jwt']
    if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error('Trae CLI token document has no token field')
    token = candidate.trim()
  }
  const segments = token.split('.')
  if (segments.length !== 3 || segments.some((segment) => segment === '')) throw new Error('Trae CLI token is not a three-part JWT')
  const padded = (segments[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    throw new Error('Trae CLI token payload is not decodable JSON')
  }
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const data = typeof record['data'] === 'object' && record['data'] !== null ? (record['data'] as Record<string, unknown>) : undefined
  const userId = optionalString(data?.['user_id'])
  if (userId === undefined) throw new Error('Trae CLI token has no data.user_id claim')
  const exp = record['exp']
  return {
    accessToken: token,
    userId,
    ...(typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? { expiresAtMs: exp * 1e3 } : {})
  }
}

export interface CredentialScan {
  /** Viable credentials, desktop copies first (the app's live sign-in leads). */
  credentials: TraeCredential[]
  /** One line per candidate that existed but could not be used — path + reason. */
  failures: string[]
  /** Candidates that exist on disk, viable or not. */
  found: string[]
}

/**
 * How many characters of candidate table a diagnostic line may carry.
 *
 * The table is a diagnostic, and there are ~24 candidates on Windows (4 editions
 * x 2 registry roots x several spellings, plus the CLI homes). Printed whole it
 * is long enough that nobody reads it — which is the same as not printing it,
 * except slower. The cap is applied by {@link renderCandidateTable}.
 */
export const CANDIDATE_TABLE_CHARS = 420

/** One candidate as a diagnostic fact: what it is, where, and whether it is there. */
export interface CandidateReport {
  /** `desktop/cn` — the two facts that decide which gateway an install belongs to. */
  label: string
  path: string
  exists: boolean
}

/**
 * Every candidate with its existence, as data.
 *
 * The reason this exists (the "找不到" rule): a failure line that names only the
 * path it tried cannot tell "the desktop app is not installed on this machine"
 * apart from "it is installed, but nobody is signed in" — and those two need
 * completely different things from the user. Reporting the whole probed list,
 * with `exists` per row, puts the observed scene on screen and lets the reader
 * decide; it is the same treatment `explainPatchLookup` gives to a missing
 * profile. `found` alone is not enough either: it is empty in BOTH cases.
 */
export function candidateReports(candidates: readonly TraeStorageCandidate[]): CandidateReport[] {
  return candidates.map((candidate) => ({
    label: `${candidate.source}/${candidate.edition}`,
    path: candidate.path,
    exists: candidate.exists
  }))
}

/** One bounded line naming every candidate: `desktop/cn 存在 · desktop/sg 无 · …` */
export function renderCandidateTable(candidates: readonly TraeStorageCandidate[]): string {
  const rows = candidateReports(candidates).map((report) => `${report.label} ${report.exists ? '存在' : '无'}`)
  const joined = rows.join(' · ')
  if (joined.length <= CANDIDATE_TABLE_CHARS) return joined
  // The marker is part of the bound, not an addition to it: a diagnostic that grows
  // by its own truncation notice is still unbounded.
  const marker = `…（共 ${rows.length} 个候选）`
  return `${joined.slice(0, Math.max(0, CANDIDATE_TABLE_CHARS - marker.length))}${marker}`
}

/** The same table WITH paths — the fuller scene, for a multi-line message. */
export function renderCandidateReport(candidates: readonly TraeStorageCandidate[]): string {
  return candidateReports(candidates)
    .map((report) => `${report.exists ? '存在' : '不存在'} ${report.label} ${report.path}`)
    .join('\n')
}

/**
 * Scan every candidate. Read-only.
 *
 * Order matters and is deliberate: a desktop copy describes the account Trae is
 * signed in to right now, while an older CLI token may name a different one.
 * Callers choose; this function never silently prefers a different account.
 */
export function scanCredentials(candidates: TraeStorageCandidate[]): CredentialScan {
  const credentials: TraeCredential[] = []
  const failures: string[] = []
  const found: string[] = []
  for (const candidate of candidates) {
    if (!candidate.exists) continue
    found.push(candidate.path)
    try {
      if (candidate.source === 'cli') {
        const parsed = parseTraeCliToken(readFileSync(candidate.path, 'utf8'))
        credentials.push({
          id: traeAccountId(candidate.edition, parsed.userId),
          edition: candidate.edition,
          region: candidate.region,
          source: 'cli',
          storagePath: candidate.path,
          userId: parsed.userId,
          host: '',
          expiresAtMs: parsed.expiresAtMs ?? 0,
          accessToken: parsed.accessToken
        })
        continue
      }
      const document = parseTraeStorageDocument(readFileSync(candidate.path, 'utf8'))
      const credential = normalizeCredential(document, candidate.edition, 'desktop', candidate.path)
      if (credential === undefined) {
        failures.push(`${candidate.path}: auth document carries no token`)
        continue
      }
      credentials.push(credential)
    } catch (error) {
      // The reason is a parse error, and on its own it cannot answer the question a
      // user actually has ("is Trae even installed here?"). Both halves of the
      // failure branch now carry the whole probed table — see `candidateReports`.
      failures.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { credentials, failures, found }
}

/**
 * Turn a scan into ONE user-facing sentence that names the observed scene.
 *
 * Called on the failure paths only. "Nothing usable" has four very different
 * causes — no Trae at all, an install with no auth key, an install whose
 * ciphertext will not decrypt, a CLI token that expired — and a line that says
 * only "没有可用凭据" makes the caller guess which one. So the answer always
 * carries: how many candidates were probed, each one's existence, and every
 * reason a candidate that DID exist could not be used.
 *
 * Empty `failures` is not a contradiction: a candidate can exist, parse fine and
 * still be unusable for the requested edition, and the table says which.
 */
export function describeCredentialScan(scan: CredentialScan, candidates: readonly TraeStorageCandidate[]): string {
  const head = `已探测 ${candidates.length} 个候选（${renderCandidateTable(candidates)}）`
  if (scan.found.length === 0) return `${head}；没有任何一个存在 —— Trae 桌面板与 CLI 都没装（或装在其他用户目录下）`
  return `${head}；其中 ${scan.found.length} 个存在但都读不出凭据：${scan.failures.join(' | ')}`
}

/** A short, non-reversible fingerprint — the only thing safe to print about a token. */
export function tokenFingerprint(credential: TraeCredential): string {
  return createHash('sha256').update(credential.accessToken).digest('hex').slice(0, 12)
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 1. Is this credential still usable?
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * How much of a credential's remaining life already counts as "gone".
 *
 * Every use of the token is a real request against a real quota, so a token that
 * expires while a request is in flight turns that request into a failure. 60 s is
 * the margin used here; the pinned upstream ships 300 s of its own
 * (`dsh-connect-trae@3.4.0` `lib/index.js:1319` `refreshMarginMs ?? 3e5`), which
 * is the same idea with a bigger cushion. A caller can pass 0 to ask the literal
 * question "is it past its expiry?".
 */
export const DEFAULT_EXPIRY_SKEW_MS = 60_000

/**
 * Whether a credential must not be spent as-is any more.
 *
 * `expiresAtMs === 0` means "the document carried no expiry" (see `timeToMs`),
 * NOT "expired at the epoch". A CLI token with no `exp` claim must keep working,
 * so an UNKNOWN deadline is reported as NOT expired: the opposite would demand a
 * re-login the facts do not support. `now` is a parameter, not `Date.now()`, so
 * the boundary is testable without a clock.
 */
export function isExpired(
  credential: Pick<TraeCredential, 'expiresAtMs'>,
  skewMs: number = DEFAULT_EXPIRY_SKEW_MS,
  now: number = Date.now()
): boolean {
  const expiresAtMs = credential.expiresAtMs
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return false
  return expiresAtMs <= now + Math.max(0, skewMs)
}

/**
 * Whether this credential has everything a refresh needs, right now.
 *
 * Structural only (the gateway may still refuse); used to decide between "the
 * plugin will try to renew this by itself" and "only a re-login in Trae helps",
 * which are two very different things to tell the user.
 */
export function canRefresh(
  credential: Pick<TraeCredential, 'edition' | 'host' | 'refreshToken' | 'refreshExpiresAtMs'>,
  now: number = Date.now()
): boolean {
  if (TRAE_REFRESH_CONTRACTS[credential.edition] === undefined) return false
  if (typeof credential.refreshToken !== 'string' || credential.refreshToken === '') return false
  if (typeof credential.host !== 'string' || credential.host.trim() === '') return false
  const refreshExpiresAtMs = credential.refreshExpiresAtMs
  if (typeof refreshExpiresAtMs === 'number' && Number.isFinite(refreshExpiresAtMs) && refreshExpiresAtMs > 0 && refreshExpiresAtMs <= now) return false
  return true
}

/** Real wall clock, `YYYY-MM-DD HH:mm`, local — the same spelling the card uses. */
function clockOf(ms: number): string {
  const date = new Date(ms)
  const two = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

/** What the plugin already did about an expired credential. */
export type CredentialExpiryAction =
  /** Nothing yet — a refresh is still ahead of us. */
  | 'not-attempted'
  /** A refresh was attempted and failed; `note` says why. */
  | 'refresh-failed'
  /** No refresh is possible at all (no refresh token, or no gateway host). */
  | 'refresh-unavailable'

export interface CredentialExpiryState {
  now?: number
  action: CredentialExpiryAction
  /** The failure reason, appended verbatim (bounded). */
  note?: string
}

/**
 * ONE readable sentence for the user, or `undefined` when there is nothing wrong.
 *
 * This is the text that reaches the card's account block through the EXISTING
 * `accountWarning` channel (`src/api.ts` `/status` → `lib/client.js` account row),
 * so it is written for a person: what is wrong, when, what the plugin did about it,
 * and what only the user can do. It returns nothing for an expired-but-known-good
 * credential and nothing when the deadline is unknown.
 */
export function describeCredentialExpiry(
  credential: Pick<TraeCredential, 'expiresAtMs'>,
  state: CredentialExpiryState
): string | undefined {
  const now = state.now ?? Date.now()
  const expiresAtMs = credential.expiresAtMs
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return undefined
  if (!isExpired(credential, DEFAULT_EXPIRY_SKEW_MS, now)) return undefined
  const head =
    expiresAtMs <= now
      ? `Trae 凭据已过期（到期 ${clockOf(expiresAtMs)}）`
      : `Trae 凭据即将过期（到期 ${clockOf(expiresAtMs)}，只剩 ${Math.max(0, Math.round((expiresAtMs - now) / 1000))} 秒）`
  if (state.action === 'refresh-unavailable') {
    return `${head}；这份凭据没有可用的 refreshToken 或网关地址，插件无法自行刷新 —— 请在 Trae 桌面端重新登录（重开 Trae 也会刷新它），再重启 DSH`
  }
  if (state.action === 'refresh-failed') {
    const note = typeof state.note === 'string' ? state.note.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    return `${head}；插件已用 refreshToken 尝试自动刷新但失败${note === '' ? '' : `（${note}）`} —— 请在 Trae 桌面端重新登录后重启 DSH`
  }
  return `${head}；插件会尝试用 refreshToken 自动刷新（只写本插件自己的副本，不改动 Trae 桌面端）`
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 2. The refresh contract — read from the pinned upstream, not invented
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Every constant, header, field name and signature below was read out of the
 * pinned upstream snapshot `dsh-connect-trae@3.4.0` (`lib/index.js`), kept under
 * `$DSH_HOME/trae-pin/` (`DSH_HOME` defaults to `~/.dsh`)
 * (`src/refresh.ts` region, :1649-1852). The line numbers in the comments are the
 * evidence; this module reproduces the shape and nothing else.
 */

/** Endpoint the shipped clients use — upstream `:1651`. */
export const TRAE_EXCHANGE_TOKEN_PATH = '/trae/api/v3/oauth/ExchangeToken'
/** Superseded endpoint, kept as the fallback — upstream `:1653`. */
export const TRAE_LEGACY_EXCHANGE_TOKEN_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'

/** One refresh contract: where to POST, and which OAuth client to claim. */
export interface TraeRefreshContract {
  path: string
  clientId: string
  platformCode: string
}

/**
 * The CURRENT contract, per edition — upstream `:1659-1680`.
 *
 * The ClientID split belongs to the OAuth CLIENT, not to the endpoint: it is the
 * same table on both paths (upstream `:1772-1781` measured it on 2026-10-11, four
 * editions × both paths). Getting it wrong answers `10101 refresh token is not
 * matched to the client`, which is why the split is a table here too rather than
 * a single hardcoded desktop id.
 */
export const TRAE_REFRESH_CONTRACTS: Readonly<Record<TraeEdition, TraeRefreshContract>> = {
  cn: { path: TRAE_EXCHANGE_TOKEN_PATH, clientId: 'ono9krqynydwx5', platformCode: 'IDE_PC' },
  sg: { path: TRAE_EXCHANGE_TOKEN_PATH, clientId: 'ono9krqynydwx5', platformCode: 'IDE_PC' },
  solo: { path: TRAE_EXCHANGE_TOKEN_PATH, clientId: 'en1oxy7wnw8j9n', platformCode: 'SOLO_PC' },
  'solo-sg': { path: TRAE_EXCHANGE_TOKEN_PATH, clientId: 'en1oxy7wnw8j9n', platformCode: 'SOLO_PC' }
}

/** `storage.json` keys that hold the install's device keypair, beside the auth document. */
export const TRAE_DEVICE_CENTER_PREFIX = 'iCubeAuthInfo://icube-dc:'

export interface TraeDeviceKeyPair {
  privateKeyPEM: string
  publicKeyPEM: string
}

/**
 * The install's own device keypair, or `undefined`.
 *
 * Upstream `:1871-1889` (`deviceKeyPairOf`): tolerant by design — an older install
 * that never refreshed on the new contract simply has no keypair, and a malformed
 * entry is treated as ABSENT rather than failing the read, because only the
 * signed contract degrades without it.
 */
export function deviceKeyPairOf(storage: Record<string, unknown>): TraeDeviceKeyPair | undefined {
  const key = Object.keys(storage).find((name) => name.startsWith(TRAE_DEVICE_CENTER_PREFIX))
  if (key === undefined) return undefined
  const encoded = storage[key]
  if (typeof encoded !== 'string' || encoded.trim() === '') return undefined
  try {
    const plaintext = parseTraeAuthValue(encoded)
    if (typeof plaintext !== 'object' || plaintext === null || Array.isArray(plaintext)) return undefined
    const value = plaintext as Record<string, unknown>
    const privateKeyPEM = optionalString(value['privateKeyPEM'])
    const publicKeyPEM = optionalString(value['publicKeyPEM'])
    return privateKeyPEM === undefined || publicKeyPEM === undefined ? undefined : { privateKeyPEM, publicKeyPEM }
  } catch {
    return undefined
  }
}

/**
 * The device-centre id this install registered, when exactly one is recorded.
 *
 * Upstream `:1858-1861` (`deviceCenterId`): the suffix of the single
 * `iCubeAuthInfo://icube-dc:` key, and it OUTRANKS `telemetry.devDeviceId` when
 * picking the `DeviceID` the signed contract sends (`:1903`
 * `dcDevice ?? devDevice ?? sha256(machineId)`). Two ids, two very different
 * values on a real machine (a numeric id and a UUID), and the server compares
 * what it was told against the device it knows — so the precedence is copied
 * rather than approximated. Ambiguity (more than one key) yields `undefined`
 * instead of a coin flip.
 */
export function deviceCenterIdOf(storage: Record<string, unknown>): string | undefined {
  const ids = Object.keys(storage)
    .filter((name) => name.startsWith(TRAE_DEVICE_CENTER_PREFIX))
    .map((name) => name.slice(TRAE_DEVICE_CENTER_PREFIX.length))
    .filter((id) => id !== '')
  return ids.length === 1 ? ids[0] : undefined
}

/** What `storage.json` says about this device (read-only, never throws). */
export interface TraeStorageDevice {
  /** `iCubeAuthInfo://icube-dc:<id>` suffix, when exactly one is present. */
  deviceId?: string
  keyPair?: TraeDeviceKeyPair
}

/**
 * The device facts one refresh needs, from a `storage.json` path.
 *
 * Both halves come from the SAME document and the same read: a missing or
 * malformed entry is treated as absent (upstream `:1871-1889`), because only the
 * signed contract degrades without them.
 */
export function readStorageDevice(storagePath: string): TraeStorageDevice {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storagePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const storage = parsed as Record<string, unknown>
    const deviceId = deviceCenterIdOf(storage)
    const keyPair = deviceKeyPairOf(storage)
    return {
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(keyPair === undefined ? {} : { keyPair })
    }
  } catch {
    return {}
  }
}

/** Everything the signed contract needs about this machine. */
export interface TraeRefreshDevice {
  machineId: string
  deviceId: string
  deviceName?: string
  appVersion?: string
  osVersion?: string
  deviceKeyPair?: TraeDeviceKeyPair
}

export interface TraeDeviceProofMessageInput {
  path: string
  clientId: string
  refreshToken: string
  timestamp: number
  nonce: string
}

/**
 * The exact string the official client signs — upstream `:1699-1707`.
 *
 * The separator is a NEWLINE. This is load-bearing, not cosmetic: a space-joined
 * message of the same six fields is refused with `20403 Token device not match`,
 * which looks exactly like a wrong key and sends debugging the wrong way. The
 * test suite pins both ends of that (signs, then verifies newline-joined and
 * fails space-joined).
 */
export function traeDeviceProofMessage(input: TraeDeviceProofMessageInput): string {
  return ['POST', input.path, input.clientId, input.refreshToken, String(input.timestamp), input.nonce].join('\n')
}

export interface TraeDeviceProofInput {
  path: string
  clientId: string
  refreshToken: string
  privateKeyPEM: string
  /** Injectable so a test can pin a deterministic signature — upstream `:1716-1731`. */
  timestamp?: number
  nonce?: string
}

/** ECDSA P-256 / SHA-256 over {@link traeDeviceProofMessage}, base64 — upstream `:1716-1731`. */
export function signTraeDeviceProof(input: TraeDeviceProofInput): { Signature: string; Timestamp: number; Nonce: string } {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1e3)
  const nonce = input.nonce ?? randomBytes(16).toString('hex')
  const message = traeDeviceProofMessage({
    path: input.path,
    clientId: input.clientId,
    refreshToken: input.refreshToken,
    timestamp,
    nonce
  })
  return { Signature: sign('sha256', Buffer.from(message), input.privateKeyPEM).toString('base64'), Timestamp: timestamp, Nonce: nonce }
}

/** `OSInfo` is a bare platform word on the wire — upstream `:1687-1689`. */
function osInfoOf(platform: string): string {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : platform
}

/** The `DeviceInfo` block, field for field with upstream `:1733-1749`. */
function refreshDeviceInfoBody(contract: TraeRefreshContract, device: TraeRefreshDevice): Record<string, unknown> {
  const os = osInfoOf(process.platform)
  return {
    DeviceID: device.deviceId,
    MachineID: device.machineId,
    PlatformCode: contract.platformCode,
    DeviceType: 'PC',
    ...(device.deviceName === undefined ? {} : { DeviceName: device.deviceName }),
    ...(device.appVersion === undefined ? {} : { ClientVersion: device.appVersion }),
    ...(device.deviceKeyPair === undefined ? {} : { DevicePublicKey: device.deviceKeyPair.publicKeyPEM }),
    OSInfo: os,
    OSVersion: device.osVersion ?? `${os} ${hostname()}`
  }
}

/** The signed contract's body — upstream `:1751-1765`. */
function currentRefreshBody(
  credential: TraeCredential,
  contract: TraeRefreshContract,
  device: TraeRefreshDevice & { deviceKeyPair: TraeDeviceKeyPair },
  refreshToken: string
): Record<string, unknown> {
  return {
    ClientID: contract.clientId,
    ClientSecret: '',
    RefreshToken: credential.refreshToken,
    DeviceInfo: refreshDeviceInfoBody(contract, device),
    DeviceProof: signTraeDeviceProof({
      path: contract.path,
      clientId: contract.clientId,
      refreshToken,
      privateKeyPEM: device.deviceKeyPair.privateKeyPEM
    }),
    ...(device.appVersion === undefined ? {} : { IDEVersion: device.appVersion })
  }
}

/** The superseded body: no device block, SAME per-edition ClientID — upstream `:1782-1789`. */
function legacyRefreshBody(credential: TraeCredential, clientId: string): Record<string, unknown> {
  return { ClientID: clientId, ClientSecret: '-', RefreshToken: credential.refreshToken, UserID: credential.userId }
}

/** What one exchange answer carries. */
interface RefreshOutcome {
  accessToken: string
  expiresAtMs: number
  refreshToken?: string
  refreshExpiresAtMs?: number
}

/**
 * Read `payload.Result` into an outcome, or throw with the reason — upstream `:1790-1808`.
 *
 * `TokenExpireAt` goes through this module's own `timeToMs`, which is the point:
 * the upstream reader accepts a number (ms) or a date string, and Trae's other
 * documents in this codebase have been seen spelling the same instant in SECONDS.
 * One reader for both directions, so a seconds-spelled deadline cannot be read as
 * a 1970 timestamp (which would make the plugin refresh on every single request).
 */
function refreshOutcomeOf(payload: unknown, label: string): RefreshOutcome {
  const result = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['Result'] : undefined
  const record = typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined
  const accessToken = optionalString(record?.['Token'])
  if (accessToken === undefined) throw new Error(`${label} 的回答里没有 Token`)
  const expiresAtMs = timeToMs(record?.['TokenExpireAt'])
  if (expiresAtMs === undefined) throw new Error(`${label} 的回答里 TokenExpireAt 无法解析`)
  const refreshToken = optionalString(record?.['RefreshToken'])
  const refreshExpiresAtMs = timeToMs(record?.['RefreshExpireAt'])
  return {
    accessToken,
    expiresAtMs,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs })
  }
}

/** Host without a trailing slash, or a readable refusal — upstream `:1681-1685`. */
function normalizeHost(host: unknown): string {
  const value = typeof host === 'string' ? host.trim() : ''
  if (value === '') throw new Error('这份凭据没有网关地址（host），无法刷新')
  return value.replace(/\/+$/, '')
}

/** One POST, one parsed outcome; every failure is labelled with the path tried. */
async function postExchangeToken(
  host: string,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  label: string
): Promise<RefreshOutcome> {
  const response = await fetchImpl(`${host}${path}`, {
    method: 'POST',
    // Upstream sends exactly this one header (`:1811-1816`): no Authorization, no
    // identity headers — the refresh token IS the credential.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`${label} failed (http ${response.status})`)
  return refreshOutcomeOf(await response.json(), label)
}

/**
 * The refreshed credential: the same account, a new token, and `source: 'own'`.
 *
 * `storagePath` deliberately stays the DESKTOP file: that is where the identity
 * (`machineid`, the device keypair) is read from, and it is the path the user's
 * Trae installation owns. The refreshed secret itself lives in this plugin's own
 * file and in memory — never in Trae's document.
 */
function refreshedCredential(original: TraeCredential, outcome: RefreshOutcome): TraeCredential {
  const next: TraeCredential = {
    ...original,
    source: 'own',
    expiresAtMs: outcome.expiresAtMs,
    accessToken: outcome.accessToken
  }
  if (outcome.refreshToken === undefined) delete next.refreshToken
  else next.refreshToken = outcome.refreshToken
  // Carrying the OLD refresh deadline forward would refuse a refresh that is
  // really available, so an answer without `RefreshExpireAt` drops the claim
  // instead of keeping a stale one.
  if (outcome.refreshExpiresAtMs === undefined) delete next.refreshExpiresAtMs
  else next.refreshExpiresAtMs = outcome.refreshExpiresAtMs
  return next
}

export interface TraeRefreshDeps {
  /** Injected transport: the offline suite passes its own and never goes online. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Absent when this machine has no readable identity — the legacy contract needs none. */
  device?: TraeRefreshDevice
}

export type TraeRefreshResult =
  | { ok: true; credential: TraeCredential; via: 'current' | 'legacy'; path: string }
  | { ok: false; detail: string }

/**
 * Exchange the refresh token for a fresh access token. Never throws.
 *
 * Order and degradation are upstream's (`:1820-1852`): the SIGNED current
 * contract is attempted first whenever it is possible at all, and is SKIPPED —
 * not sent to be refused with `20405` — when the install has no keypair to sign
 * with; the unsigned legacy contract is then tried, which is what keeps older
 * installs and CLI-only machines working. When both are impossible or both fail,
 * the detail names every attempt, so a "sign in again" verdict is diagnosable.
 */
export async function refreshTraeCredential(
  credential: TraeCredential,
  deps: TraeRefreshDeps = {}
): Promise<TraeRefreshResult> {
  const contract = TRAE_REFRESH_CONTRACTS[credential.edition]
  if (contract === undefined) return { ok: false, detail: `Trae ${credential.edition} 的刷新契约没有记录，拒绝发明一个` }
  const refreshToken = credential.refreshToken
  if (refreshToken === undefined || refreshToken === '') return { ok: false, detail: '这份凭据没有 refreshToken，无法自行刷新' }
  const refreshExpiresAtMs = credential.refreshExpiresAtMs
  if (typeof refreshExpiresAtMs === 'number' && refreshExpiresAtMs > 0 && refreshExpiresAtMs <= Date.now()) {
    return { ok: false, detail: `refreshToken 自身也已过期（${clockOf(refreshExpiresAtMs)}），只能重新登录` }
  }
  let host: string
  try {
    host = normalizeHost(credential.host)
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 30000
  const attempts: string[] = []
  const device = deps.device

  const accept = (outcome: RefreshOutcome, via: 'current' | 'legacy', path: string): TraeRefreshResult => {
    if (outcome.expiresAtMs <= Date.now()) {
      // A token that arrives already expired is not a fix; adopting it would leave
      // the plugin reporting a healthy credential that cannot send a single request.
      return { ok: false, detail: `换回来的 Token 自己就是过期的（${clockOf(outcome.expiresAtMs)}），拒绝采用` }
    }
    return { ok: true, credential: refreshedCredential(credential, outcome), via, path }
  }

  if (device?.deviceKeyPair === undefined) {
    attempts.push(`${contract.path}: 本机 storage.json 里没有设备密钥对，无法签署当前契约（跳过，不发注定被 20405 拒绝的请求）`)
  } else {
    const signable = device as TraeRefreshDevice & { deviceKeyPair: TraeDeviceKeyPair }
    try {
      const outcome = await postExchangeToken(host, contract.path, currentRefreshBody(credential, contract, signable, refreshToken), fetchImpl, timeoutMs, 'Trae token refresh')
      return accept(outcome, 'current', contract.path)
    } catch (error) {
      attempts.push(`${contract.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    const outcome = await postExchangeToken(host, TRAE_LEGACY_EXCHANGE_TOKEN_PATH, legacyRefreshBody(credential, contract.clientId), fetchImpl, timeoutMs, 'Trae token refresh (legacy)')
    return accept(outcome, 'legacy', TRAE_LEGACY_EXCHANGE_TOKEN_PATH)
  } catch (error) {
    attempts.push(`${TRAE_LEGACY_EXCHANGE_TOKEN_PATH}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: false, detail: `自动刷新失败（两条契约都试过）—— ${attempts.join('；')}` }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 3. This plugin's OWN credential file (never Trae's)
 * ════════════════════════════════════════════════════════════════════════════ */

/** Directory this plugin owns under `$DSH_HOME`, the only place it writes. */
export const OWN_STORE_DIR_NAME = '.dsh-pylon-trae'
/** Envelope version of the file below; an unknown version is not read as data. */
export const OWN_CREDENTIAL_VERSION = 1

/**
 * Where a refreshed credential for one account is kept.
 *
 * One file PER ACCOUNT ID, so two Trae installs (or an install plus a CLI token)
 * can never overwrite each other's refreshed token. The id is a hex digest; an id
 * that is not one is refused rather than pasted into a path.
 */
export function credentialStorePath(dshHome: string, credentialId: string): string {
  const id = typeof credentialId === 'string' ? credentialId.trim() : ''
  if (!/^[0-9a-f]{8,64}$/i.test(id)) throw new Error(`凭据 id 不是十六进制摘要，拒绝用它拼路径：${JSON.stringify(id.slice(0, 32))}`)
  return join(dshHome, OWN_STORE_DIR_NAME, `credentials-${id}.json`)
}

/**
 * Does this path point into Trae's OWN per-user data?
 *
 * Deliberately Trae-shaped rather than "anything under AppData": a DSH home can
 * legitimately live under `AppData\Roaming` too, and refusing that would break
 * this plugin's own store for a reason that has nothing to do with Trae.
 */
export function looksLikeTraeDataPath(path: string): boolean {
  const flat = path.replace(/\\/g, '/').toLowerCase()
  if (flat.endsWith('/storage.json')) return true
  if (flat.includes('/user/globalstorage/')) return true
  return (
    /\/library\/application support\/trae/.test(flat) ||
    /\/appdata\/roaming\/trae/.test(flat) ||
    /\/appdata\/local\/programs\/trae/.test(flat)
  )
}

/**
 * 🔴 The iron rule, enforced here rather than remembered.
 *
 * Two refusals: a Trae-owned path (its `storage.json`, its globalStorage, its app
 * data roots), and ANY path whose parent is not this plugin's own `.dsh-pylon-trae`
 * directory. A refreshed token that lands in Trae's document would be written by
 * us and read by the desktop app — the exact cross-write this design exists to
 * avoid — so the writer cannot be pointed there even by a future edit that gets
 * the path wrong.
 */
export function assertOwnCredentialPath(path: string): void {
  const flat = path.replace(/\\/g, '/')
  if (looksLikeTraeDataPath(path)) throw new Error(`拒绝写入 Trae 自己的数据目录（刷新结果只落本插件自己的副本）：${path}`)
  const segments = flat.split('/').filter((segment) => segment !== '')
  const parent = segments.length >= 2 ? segments[segments.length - 2] : ''
  if (parent !== OWN_STORE_DIR_NAME) throw new Error(`拒绝写入 ${OWN_STORE_DIR_NAME} 之外的路径（刷新结果只落本插件自己的副本）：${path}`)
}

/** One stored credential as the envelope written by {@link writeCredentialAtomic}. */
function storeDocument(credential: TraeCredential): Record<string, unknown> {
  return {
    version: OWN_CREDENTIAL_VERSION,
    savedAt: new Date().toISOString(),
    credential: {
      edition: credential.edition,
      // SECRET. This file is ours, mode 0600, and outside every profile.
      accessToken: credential.accessToken,
      ...(credential.refreshToken === undefined ? {} : { refreshToken: credential.refreshToken }),
      userId: credential.userId,
      ...(credential.accountName === undefined ? {} : { accountName: credential.accountName }),
      host: credential.host,
      // The DESKTOP file this token belongs to, recorded so a copy read back on a
      // later run still names a real installation: `storagePath` is where the
      // identity (`machineid`, the device keypair) is read from, and our own file
      // has neither. Without it, adopting a copy would break `identity()`.
      storagePath: credential.storagePath,
      ...(credential.userRegion === undefined ? {} : { userRegion: credential.userRegion }),
      expiresAtMs: credential.expiresAtMs,
      ...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs })
    }
  }
}

/**
 * Write one refreshed credential, atomically: `<path>.part` → `renameSync`.
 *
 * The `.part` step is the same rule the sibling plugin's binary installer follows:
 * a crash mid-write must leave a file that is obviously incomplete, never a
 * half-written credential that reads as valid. A failure removes the part file.
 */
export function writeCredentialAtomic(path: string, credential: TraeCredential): void {
  assertOwnCredentialPath(path)
  mkdirSync(dirname(path), { recursive: true })
  const part = `${path}.part`
  try {
    writeFileSync(part, `${JSON.stringify(storeDocument(credential), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(part, path)
  } catch (error) {
    try {
      rmSync(part, { force: true })
    } catch {
      // nothing to clean up
    }
    throw error
  }
}

/**
 * Read one of our own copies back; `undefined` for absent, foreign or unreadable.
 *
 * The credential's `storagePath` is the one recorded in the envelope — the desktop
 * file the token belongs to — falling back to the copy's own path only for a file
 * written before that field existed. It must never be our own path: `storagePath`
 * is what `identity()` reads the machine id from, and `.dsh-pylon-trae/credentials-*.json`
 * holds no machine id at all.
 */
export function readStoredCredential(path: string, edition: TraeEdition): TraeCredential | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const document = parsed as Record<string, unknown>
    if (document['version'] !== OWN_CREDENTIAL_VERSION) return undefined
    const stored = document['credential']
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined
    const value = stored as Record<string, unknown>
    const accountName = optionalString(value['accountName'])
    const identityPath = optionalString(value['storagePath']) ?? path
    // Fed through the same normaliser as a Trae document, so one shape decides what
    // a credential is: a copy that cannot be normalised is simply not a credential.
    return normalizeCredential(
      {
        token: value['accessToken'],
        refreshToken: value['refreshToken'],
        userId: value['userId'],
        host: value['host'],
        userRegion: value['userRegion'],
        account: accountName === undefined ? undefined : { username: accountName },
        expiredAt: value['expiresAtMs'],
        refreshExpiredAt: value['refreshExpiresAtMs']
      },
      edition,
      'own',
      identityPath
    )
  } catch {
    return undefined
  }
}

/**
 * Whether a copy WE wrote should be used instead of the desktop credential.
 *
 * Four rules, each one a case that would otherwise go wrong:
 *   · our copy is the SAME account — a copy must never change WHO is billed; the
 *     Trae app's live sign-in decides that, and this only supplies its token;
 *   · the desktop credential really is out of time — while the app's own token is
 *     usable, it leads (the upstream preference order, `:1388-1398`);
 *   · our copy is itself still usable — no gain otherwise;
 *   · absent copies change nothing.
 *
 * The returned credential carries the DESKTOP `storagePath`, not our own: `storagePath`
 * is where the machine identity is read from, and the copy has none. "Borrow a
 * token, never an identity" is one rule, so it lives in one place.
 */
export function preferValidStoredCredential(
  desktop: TraeCredential,
  stored: TraeCredential | undefined,
  now: number = Date.now(),
  skewMs: number = DEFAULT_EXPIRY_SKEW_MS
): TraeCredential | undefined {
  if (stored === undefined) return undefined
  if (stored.id !== desktop.id) return undefined
  if (!isExpired(desktop, skewMs, now)) return undefined
  if (isExpired(stored, skewMs, now)) return undefined
  return { ...stored, storagePath: desktop.storagePath }
}

export interface TraeStoredRefreshResult {
  ok: boolean
  /** The outcome in one line: the refusal reason, or what was written where. */
  detail: string
  credential?: TraeCredential
  via?: 'current' | 'legacy'
  storePath: string
  persisted: boolean
}

/**
 * The whole production step: refresh, and persist ONLY on success.
 *
 * 🔴 A failed refresh writes NOTHING. The file on disk may hold the last token
 * that worked, and overwriting it with a failure would destroy the only copy for
 * no gain — so the write is behind the success check, not beside it. A write that
 * fails after a successful refresh is NOT a failed refresh either: the token is
 * still good, it is used from memory, and the detail says so.
 */
export async function refreshCredentialIntoStore(
  credential: TraeCredential,
  storePath: string,
  deps: TraeRefreshDeps = {}
): Promise<TraeStoredRefreshResult> {
  const result = await refreshTraeCredential(credential, deps)
  if (!result.ok) return { ok: false, detail: result.detail, storePath, persisted: false }
  try {
    writeCredentialAtomic(storePath, result.credential)
    return {
      ok: true,
      detail: `已刷新（${result.via === 'current' ? '签名契约' : '旧契约'}），写入 ${storePath}`,
      credential: result.credential,
      via: result.via,
      storePath,
      persisted: true
    }
  } catch (error) {
    return {
      ok: true,
      detail: `已刷新（${result.via === 'current' ? '签名契约' : '旧契约'}）但落盘失败（${error instanceof Error ? error.message : String(error)}）—— 本次只在内存里使用`,
      credential: result.credential,
      via: result.via,
      storePath,
      persisted: false
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 4. The HARNESS credential document ($DSH_HOME/.credentials.yaml)
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The harness's own credential store, seen from this plugin.
 *
 * Why this plugin touches it at all: the Models page shows a GREEN dot beside a
 * provider name when the profile entry names a credential reference
 * (`apiKeyEnv`) and `credentials.describe(ref).configured === true`
 * (`dsh-client-ui-settings-models/lib/client.js:2158`), and a RED dot when it
 * names one that resolves to nothing (`:2159`). Red is not cosmetic — the route
 * then dies at request time with `MISSING_CREDENTIAL`
 * (`dsh-llm-pi-ai/lib/index.js:2564-2569`). So a green dot may only ever be
 * written AFTER the value it promises is really in the store; that ordering is
 * enforced by the caller (`ensureCredentialRef` runs first, and `seed.ts` writes
 * `apiKeyEnv` only from its verified answer).
 *
 * ## The document's real shape (measured 2026-10-16, this machine)
 *
 * ```text
 * version: 1
 * records:
 *   <scope>/<id>: { kind: grant, payload: … }      # OAuth grants, untouched here
 * refs:
 *   DEEPSEEK_API_KEY: sk-…                          # plain, 2-space indent
 * ```
 *
 * `dsh-credentials-local` parses it strictly (unknown top-level key, unversioned
 * root, a non-mapping section or an empty value are all REJECTED), so this module
 * reads it as strictly as the provider does rather than "well enough".
 *
 * ## The write discipline (same as every other write in this plugin)
 *
 * The actual `set` is delegated to the credentials service, which holds the
 * cross-process writer lock and patches only the one key
 * (`dsh-credentials-local/lib/index.js:604-629`, `renderRef`). That is where the
 * safety does NOT end: a snapshot of the file is taken OUTSIDE every profile
 * first, the file is re-read from disk afterwards, and {@link judgeCredentialsWrite}
 * demands that our key is there WITH the value we asked for, that no other key
 * appeared, changed or vanished, and that everything outside the `refs` body is
 * byte-identical. Any failure restores the snapshot wholesale — because "the
 * write returned" and "the other keys are still there" are two different facts,
 * which is the same lesson `guard.ts` records for the profile patch.
 */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** The only shape this plugin will write into. Any other version is left alone. */
export const CREDENTIALS_DOCUMENT_VERSION = 1

/** How many backups of one credentials document are kept (mirrors guard.ts). */
export const DEFAULT_KEEP_CREDENTIAL_BACKUPS = DEFAULT_KEEP_BACKUPS

/** A credential reference name, exactly the grammar the seam enforces. */
const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `refs:` at column 0 — the section header, with an optional comment. */
const REFS_HEADER_RE = /^refs:[ \t]*(#.*)?$/
/** One `  NAME: value` line inside the refs section. */
const REF_LINE_RE = /^([ \t]+)([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/
/** A comment line inside the section. */
const COMMENT_RE = /^[ \t]*#/

/** Where the harness keeps its credential document. */
export function credentialsDocumentPath(home: string = dshHome()): string {
  return join(home, CREDENTIALS_FILENAME)
}

/**
 * One scalar value out of a YAML line, or `undefined` when this module cannot
 * prove what the bytes mean.
 *
 * Deliberately narrow: the store writes plain base64url/`sk-…` scalars, and the
 * one case where the YAML writer quotes a value is a spelling that would
 * otherwise re-read as a number or boolean (`"123"`). Quoted, plain and
 * comment-suffixed forms are admitted; every block scalar, anchor, alias, flow
 * collection and tag is REFUSED, because a value this module cannot read back
 * verbatim must never be judged "unchanged" by a comparison.
 */
export function parseCredentialScalar(raw: string): string | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  if (/^[|>&*!{[]/.test(text)) return undefined
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) return undefined
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  const hash = text.indexOf(' #')
  return hash === -1 ? text : text.slice(0, hash).trim()
}

/** What this module read out of the credentials document. */
export interface CredentialsDocument {
  path: string
  /** The document's exact bytes, or `''` when the file is absent. */
  text: string
  /** Whether the file exists at all — the difference between "create" and "edit". */
  exists: boolean
  /** `refs` entries, in document order. */
  refs: Map<string, string>
  /**
   * The document with the whole `refs` BODY (and its header) replaced by one
   * marker line. Two documents with equal markers hold the same records,
   * comments, top-level keys and formatting — everything this plugin must not
   * disturb — regardless of which references they hold.
   */
  outsideRefs: string
  version: number | undefined
}

export interface CredentialsReadFailure {
  /** One line naming what could not be read. Never contains a value. */
  detail: string
}

/**
 * Read the credentials document, strictly.
 *
 * Returns a failure — never a guess — for anything this module cannot account
 * for: an unversioned root, a version it does not know, a line inside `refs` it
 * cannot parse into name + scalar. `dsh-credentials-local` would refuse such a
 * file too, and a plugin that "best-effort" parsed it could then compare two
 * different documents and call them equal.
 */
export function readCredentialsDocument(text: string, path: string): CredentialsDocument | CredentialsReadFailure {
  const lines = text.split(/\r?\n/)
  const refs = new Map<string, string>()
  const outside: string[] = []
  let inRefs = false
  let version: number | undefined
  for (const [index, line] of lines.entries()) {
    if (!inRefs && REFS_HEADER_RE.test(line)) {
      inRefs = true
      outside.push('<<refs>>')
      continue
    }
    if (inRefs) {
      if (line.trim() === '' || COMMENT_RE.test(line)) continue
      const match = REF_LINE_RE.exec(line)
      if (match === null) {
        // A dedent ends the section; anything else inside it is a shape we do not write.
        if (/^[ \t]/.test(line)) return { detail: `第 ${index + 1} 行在 refs 段内但不是「名字: 值」—— 拒绝解析（不猜）` }
        inRefs = false
      } else {
        const name = match[2] ?? ''
        const value = parseCredentialScalar(match[3] ?? '')
        if (!CREDENTIAL_REF_RE.test(name)) return { detail: `第 ${index + 1} 行的 refs 名字不合规：拒绝解析` }
        if (value === undefined) return { detail: `第 ${index + 1} 行的 refs 值不是本模块能逐字读回的标量：拒绝解析` }
        if (refs.has(name)) return { detail: `第 ${index + 1} 行重复定义了 ${name}：拒绝解析` }
        refs.set(name, value)
      }
    }
    if (!inRefs) {
      outside.push(line)
      const versionMatch = /^version:[ \t]*(\S+)[ \t]*$/.exec(line)
      if (versionMatch !== null) {
        const parsed = Number(versionMatch[1])
        version = Number.isInteger(parsed) ? parsed : undefined
      }
    }
  }
  if (version !== undefined && version !== CREDENTIALS_DOCUMENT_VERSION) {
    return { detail: `文档声明 version ${String(version)}，本插件只写 version ${CREDENTIALS_DOCUMENT_VERSION}` }
  }
  return { path, text, exists: text !== '', refs, outsideRefs: outside.join('\n'), version }
}

/** Narrow a read result. */
export function isCredentialsReadFailure(value: CredentialsDocument | CredentialsReadFailure): value is CredentialsReadFailure {
  return 'detail' in value
}

/** `20261016-221530`: fixed width, so name order is time order (see guard.ts). */
function credentialBackupStamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
}

/** Every backup of the credentials document, oldest name first. */
export function listCredentialBackups(home: string = dshHome()): string[] {
  const dir = backupDir(home)
  if (!existsSync(dir)) return []
  const prefix = `${CREDENTIALS_FILENAME}${BACKUP_INFIX}`
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => join(dir, name))
}

/** Keep only the newest `keep` backups of the credentials document. */
export function pruneCredentialBackups(keep = DEFAULT_KEEP_CREDENTIAL_BACKUPS, home: string = dshHome()): number {
  if (!Number.isFinite(keep) || keep <= 0) return 0
  try {
    const names = listCredentialBackups(home)
    let removed = 0
    for (const path of names.slice(0, Math.max(0, names.length - keep))) {
      try {
        rmSync(path, { force: true })
        removed += 1
      } catch {
        // one undeletable file must not stop the rest
      }
    }
    return removed
  } catch {
    return 0
  }
}

/** The pre-write state of the credentials document, with its escape hatch. */
export interface CredentialsSnapshot {
  path: string
  /** `undefined` when the file could not be read as this plugin understands it. */
  before?: CredentialsDocument
  /** Why there is nothing to compare against; the write is refused when set. */
  unsupported?: string
  /** A copy OUTSIDE every profile, or `undefined` when the file did not exist. */
  backupPath?: string
}

/**
 * Read the credentials document from disk, strictly, without copying anything.
 *
 * The read half exists on its own because the DECISION ("do we need to write?")
 * must not cost a file copy: a boot that finds the value already in place has to
 * be able to walk away without touching the disk at all, and a backup taken for a
 * write that never happens would grow this plugin's backup directory on every
 * start — the exact "a directory that only grows" shape `guard.ts` documents.
 */
export function readCredentials(home: string = dshHome()): CredentialsDocument | CredentialsReadFailure {
  const path = credentialsDocumentPath(home)
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    text = ''
  }
  return readCredentialsDocument(text, path)
}

/**
 * Copy the credentials document out of the home before touching it.
 *
 * The backup lives in the same directory as the profile-patch backups
 * (`guard.ts`'s {@link backupDir}) — outside every profile, and pruned by name
 * so this directory keeps cleaning up only after its own files. A file that
 * cannot be parsed gets NO backup and NO write: copying something we do not
 * understand would only make the failure later and quieter.
 */
export function snapshotCredentials(home: string = dshHome(), at: Date = new Date()): CredentialsSnapshot {
  const path = credentialsDocumentPath(home)
  const parsed = readCredentials(home)
  if (isCredentialsReadFailure(parsed)) return { path, unsupported: parsed.detail }
  const snapshot: CredentialsSnapshot = { path, before: parsed }
  if (!parsed.exists) return snapshot
  try {
    const dir = backupDir(home)
    mkdirSync(dir, { recursive: true })
    const backupPath = join(dir, `${basename(path)}${BACKUP_INFIX}${credentialBackupStamp(at)}-${parsed.refs.size}refs.bak`)
    copyFileSync(path, backupPath)
    pruneCredentialBackups(DEFAULT_KEEP_CREDENTIAL_BACKUPS, home)
    snapshot.backupPath = backupPath
  } catch (error) {
    // No backup ⇒ no verified way back ⇒ the caller must not write. Reported as
    // "unsupported" so there is exactly one refusal path to reason about.
    return { path, unsupported: `无法把凭据文档备份到 profile 之外（${error instanceof Error ? error.message : String(error)}）—— 没有退路就不写` }
  }
  return snapshot
}

/** Put the file back exactly as it was: the copy, or absence. */
export function restoreCredentials(snapshot: CredentialsSnapshot): void {
  try {
    if (snapshot.backupPath !== undefined && existsSync(snapshot.backupPath)) {
      copyFileSync(snapshot.backupPath, snapshot.path)
      return
    }
    if (snapshot.before !== undefined && !snapshot.before.exists) rmSync(snapshot.path, { force: true })
  } catch {
    // The rollback is the last resort; a failure here is reported by the caller's
    // own reason line, not swallowed into a success.
  }
}

export interface CredentialsVerdict {
  ok: boolean
  reasons: string[]
}

/**
 * Judge one credential write by comparing the document before and after it.
 * **Pure** — the file system and the clock stay outside, so the rules that are
 * easiest to lose silently can be asserted directly in a unit test.
 *
 * Five rules, in the order they fail:
 *   ① the document is still one this plugin can read — a write that produced an
 *      unparseable file is the worst case, not a technicality;
 *   ② our key is there, holding exactly the value we asked for;
 *   ③ no reference appeared or vanished besides ours (a store that dropped a
 *      `refs` entry would silently un-authenticate another provider);
 *   ④ every other reference still holds the same value, byte for byte;
 *   ⑤ everything outside the `refs` body is byte-identical — records, comments,
 *      top-level keys and formatting included.
 *
 * Rules ③-⑤ are what make this a "only ever adds or edits our own key" check
 * rather than a promise: the plugin did not write the other keys, so only a
 * comparison can prove it did not lose them.
 *
 * ## The one case where ③-⑤ do not apply: there was no document
 *
 * On a machine that has never stored a credential, `$DSH_HOME/.credentials.yaml`
 * does not exist and this write CREATES it — so "everything outside refs is
 * byte-identical" would compare a document against nothing and reject exactly the
 * case this feature exists for. Loss needs a prior state to lose FROM, so with
 * `before.exists === false` the contract is readability (①) plus our key holding
 * our value (②), and nothing else. Another writer creating its own key in the
 * same file at the same moment is not damage either, and must not fail our write.
 */
export function judgeCredentialsWrite(
  before: CredentialsDocument,
  afterText: string,
  ref: string,
  expectedValue: string
): CredentialsVerdict {
  const parsed = readCredentialsDocument(afterText, before.path)
  if (isCredentialsReadFailure(parsed)) return { ok: false, reasons: [`写入后的凭据文档读不回来：${parsed.detail}`] }
  const after = parsed
  const reasons: string[] = []
  const actual = after.refs.get(ref)
  if (actual !== expectedValue) {
    reasons.push(actual === undefined ? `${ref} 不在写入后的 refs 里（这次写入没有落地）` : `${ref} 的值不是我们写入的那个`)
  }
  if (!before.exists) return reasons.length === 0 ? { ok: true, reasons: [] } : { ok: false, reasons }
  for (const key of after.refs.keys()) {
    if (key !== ref && !before.refs.has(key)) reasons.push(`写入多出了别的键：${key}`)
  }
  for (const [key, value] of before.refs) {
    if (key === ref) continue
    const still = after.refs.get(key)
    if (still === undefined) reasons.push(`写入丢掉了别的键：${key}`)
    else if (still !== value) reasons.push(`写入改了别的键的值：${key}`)
  }
  if (after.outsideRefs !== before.outsideRefs) reasons.push('refs 段之外的内容变了（records/注释/顶层键必须一字不动）')
  return reasons.length === 0 ? { ok: true, reasons: [] } : { ok: false, reasons }
}

/**
 * The slice of the harness credentials service this module uses.
 *
 * Typed structurally on purpose: the service lives inside `app.asar` and this
 * plugin has no dependency on it. `set` is the write half
 * (`dsh-credentials-local`, id `credentials`, mounted by `dsh-base`); `resolve`
 * is used only as a second opinion.
 */
export interface CredentialStoreFace {
  resolve?: (ref: string) => Promise<{ value?: string } | undefined> | { value?: string } | undefined
  describe?: (ref: string) => Promise<{ configured?: boolean } | undefined> | { configured?: boolean } | undefined
  set?: (ref: string, value: string) => Promise<unknown>
}

export type EnsureCredentialStatus =
  /** The store already held exactly this value: not one byte written. */
  | 'present'
  /** We wrote it, verified it, and the rest of the document is untouched. */
  | 'written'
  /** The launching environment supplies this reference; writing would be shadowed. */
  | 'env'
  /** No credentials service in this composition — nothing to write to. */
  | 'no-service'
  /** The document is missing, unreadable or not a shape we write. */
  | 'unreadable'
  /** The store refused, or the value did not land. Nothing changed. */
  | 'failed'
  /** The write changed something it must not have; the document was restored. */
  | 'rolled-back'

export interface EnsureCredentialResult {
  status: EnsureCredentialStatus
  ref: string
  /** One line for `boot.log`. Never contains a value. */
  detail: string
  /** Whether the document was modified (only `written` is true). */
  wrote: boolean
  backupPath?: string
  /** Independent read-back of the file after a write. */
  verified?: boolean
}

/**
 * Make sure `ref` holds `value` in the harness credential document — and prove
 * it, in that order.
 *
 * The four decisions, each one a case that would otherwise produce the red dot:
 *
 *   · **the environment wins.** `dsh-credentials-local` resolves an inherited
 *     environment variable ABOVE the file and refuses to write a shadowed
 *     reference (`assertUnshadowed`). A reference the launch environment already
 *     supplies is therefore green WITHOUT this write, and attempting it would
 *     only produce a refusal — reported as `env`, not as a failure.
 *   · **same value ⇒ no write.** Not "write the same bytes again": a file whose
 *     mtime changes on every boot is a file whose watcher keeps waking up, and
 *     the credential document is shared with every other provider.
 *   · **the write is verified from DISK**, not from the store's return value.
 *   · **anything unexpected is restored wholesale** and reported as a failure, so
 *     the caller refuses to write `apiKeyEnv` and the route keeps the
 *     header-only authentication it had before.
 *
 * @param options.store - the `credentials` service, or `undefined` when absent.
 * @param options.ref - the credential reference name (e.g. `TRAE_API_KEY`).
 * @param options.value - the secret to store. Never logged, never returned.
 * @param options.home - the DSH home; injectable so tests can use a scratch one.
 * @param options.env - the environment to check for a shadowing variable.
 */
export async function ensureCredentialRef(options: {
  store: CredentialStoreFace | undefined
  ref: string
  value: string
  home?: string
  env?: Record<string, string | undefined>
}): Promise<EnsureCredentialResult> {
  const home = options.home ?? dshHome()
  const env = options.env ?? process.env
  const ref = options.ref
  if (!CREDENTIAL_REF_RE.test(ref)) {
    return { status: 'failed', ref, detail: `凭据引用名不合规（${JSON.stringify(ref)}），不写`, wrote: false }
  }
  if (typeof options.value !== 'string' || options.value === '') {
    return { status: 'failed', ref, detail: '空值不写（凭据库拒绝空值，写了等于没有）', wrote: false }
  }
  const shadow = env[ref]
  if (typeof shadow === 'string' && shadow !== '') {
    return { status: 'env', ref, detail: `${ref} 由启动环境提供（长度 ${shadow.length}）—— 环境层高于文件层，写入会被遮蔽，因此不写`, wrote: false }
  }
  if (options.store === undefined || typeof options.store.set !== 'function') {
    return { status: 'no-service', ref, detail: '这个组合里没有 credentials 服务（dsh-credentials-local），无处可写', wrote: false }
  }
  // The decision first, WITHOUT copying anything: a boot that finds the value in
  // place must leave no trace at all (no backup, no mtime, nothing for a watcher
  // to react to).
  const read = readCredentials(home)
  if (isCredentialsReadFailure(read)) {
    return { status: 'unreadable', ref, detail: read.detail, wrote: false }
  }
  if (read.refs.get(ref) === options.value) {
    return {
      status: 'present',
      ref,
      detail: `${ref} 已在凭据库里且与当前 token 相同（长度 ${options.value.length}）—— 一个字节都不写`,
      wrote: false,
      verified: true
    }
  }
  const snapshot = snapshotCredentials(home)
  if (snapshot.before === undefined) {
    return { status: 'unreadable', ref, detail: snapshot.unsupported ?? '凭据文档读不出来', wrote: false }
  }
  try {
    await options.store.set(ref, options.value)
  } catch (error) {
    return { status: 'failed', ref, detail: `凭据服务拒绝写入：${error instanceof Error ? error.message : String(error)}`, wrote: false }
  }
  let after = ''
  try {
    after = readFileSync(snapshot.path, 'utf8')
  } catch (error) {
    restoreCredentials(snapshot)
    return {
      status: 'rolled-back',
      ref,
      detail: `写入后读不回来（${error instanceof Error ? error.message : String(error)}），已整份盖回`,
      wrote: false,
      ...(snapshot.backupPath === undefined ? {} : { backupPath: snapshot.backupPath })
    }
  }
  const verdict = judgeCredentialsWrite(snapshot.before, after, ref, options.value)
  if (!verdict.ok) {
    restoreCredentials(snapshot)
    return {
      status: 'rolled-back',
      ref,
      detail: `${verdict.reasons.join('；')} —— 已整份盖回写入前的文档`,
      wrote: false,
      ...(snapshot.backupPath === undefined ? {} : { backupPath: snapshot.backupPath })
    }
  }
  return {
    status: 'written',
    ref,
    detail: `${ref} 已写入凭据库并由磁盘读回核对（其它键逐字节未变）`,
    wrote: true,
    verified: true,
    ...(snapshot.backupPath === undefined ? {} : { backupPath: snapshot.backupPath })
  }
}

/**
 * The ONE place the "may this entry name that credential?" decision is made.
 *
 * Deliberately a function rather than an inline boolean at the call site, for the
 * same reason `seed.ts` keeps its `kind === 'chat'` filter in one line: this
 * decision is the difference between a green dot and a route that answers
 * `MISSING_CREDENTIAL` forever (`dsh-llm-pi-ai/lib/index.js:2564-2569`), it is
 * made from a value a human has no way to check by looking at the settings page,
 * and there must be exactly one expression that can be wrong.
 *
 * `written` and `present` are the two states in which the store demonstrably
 * holds the value; `env` means the launch environment supplies it, which
 * `credentials.describe` reports as configured too — so a route naming it is
 * green there as well. Every other status (no service, unreadable document,
 * refused write, rolled-back write) leaves the entry header-authenticated only.
 */
export function verifiedCredentialRef(result: EnsureCredentialResult, ref: string): string | undefined {
  return result.status === 'written' || result.status === 'present' || result.status === 'env' ? ref : undefined
}

/** Read one reference straight out of the document (durable truth, not the cache). */
export function credentialsRefValue(home: string, ref: string): string | undefined {
  try {
    const parsed = readCredentialsDocument(readFileSync(credentialsDocumentPath(home), 'utf8'), credentialsDocumentPath(home))
    return isCredentialsReadFailure(parsed) ? undefined : parsed.refs.get(ref)
  } catch {
    return undefined
  }
}

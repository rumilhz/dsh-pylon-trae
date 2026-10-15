/**
 * `src/auth.ts` self-test — OFFLINE. No network, no credentials, no quota.
 *
 * The suite is built around two rules this project learned the hard way:
 *
 *   1. **A real network call is a failure, not a slow test.** The global `fetch`
 *      is replaced with a throwing stub for the whole run, and every refresh is
 *      driven through an injected `fetchImpl`. If a code path ever ignores the
 *      injected transport, this file fails loudly instead of quietly going online
 *      (the same belt-and-braces `tools/test-api.ts` wears).
 *   2. **Nothing is written outside a temp directory.** Every path in here is
 *      derived from `mkdtempSync`, and one assertion checks that the plugin's own
 *      store path can never be a Trae path — the iron rule as a test rather than
 *      a comment.
 *
 * What it pins down:
 *   · `isExpired` boundaries, INCLUDING the skew: inside it = spent, outside it =
 *     usable, and an UNKNOWN deadline (`0`) is never reported as expired
 *   · `timeToMs`'s dual format through a real normalise: one instant spelled in
 *     seconds, in milliseconds and as an ISO string must land on the same number
 *   · `canRefresh`: the four reasons a credential cannot be renewed by itself
 *   · the refresh contract read from the pinned upstream: endpoint, the per-edition
 *     ClientID, the header set, the `Result` envelope, and `via` for both contracts
 *   · the DeviceProof trap: the signed message is NEWLINE-joined (a space-joined
 *     message of the same six fields must FAIL to verify)
 *   · a failed refresh writes NOTHING (byte-identical file, no `.part` left)
 *   · a successful refresh persists atomically and round-trips through the same
 *     normaliser, so it can be adopted on the next boot
 *   · `preferValidStoredCredential`: our copy may supply a TOKEN, never a different
 *     ACCOUNT
 *   · `describeCredentialExpiry`: the one sentence, and when it stays silent
 *   · `GET /status`: `credentialExpiresAtMs` + `credentialExpired`, with the
 *     sentence travelling on the EXISTING `accountWarning` channel
 *
 * Run:  <dsh-node> tools/test-auth.ts        exit 0 = every check passed
 */
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_EXPIRY_SKEW_MS,
  assertOwnCredentialPath,
  canRefresh,
  credentialStorePath,
  describeCredentialExpiry,
  deviceCenterIdOf,
  deviceKeyPairOf,
  isExpired,
  looksLikeTraeDataPath,
  normalizeCredential,
  preferValidStoredCredential,
  readStorageDevice,
  readStoredCredential,
  refreshCredentialIntoStore,
  refreshTraeCredential,
  tokenFingerprint,
  traeAccountId,
  traeDeviceProofMessage,
  writeCredentialAtomic,
  type TraeCredential,
  type TraeRefreshDevice
} from '../src/auth.ts'
import { joinWarnings } from '../src/index.ts'
import { handleApi, type ApiDeps } from '../src/api.ts'

let failures = 0
let passed = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failures += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const same = (actual: unknown, expected: unknown): boolean => JSON.stringify(actual) === JSON.stringify(expected)
/** A token fingerprint — the only spelling of a token this file may ever show. */
const fp = (secret: string): string => createHash('sha256').update(secret).digest('hex').slice(0, 12)
const throws = (run: () => unknown): boolean => {
  try {
    run()
    return false
  } catch {
    return true
  }
}

// --------------------------------------------------------------- offline guard
globalThis.fetch = (() => {
  throw new Error('test-auth: a real network call was attempted; pass deps.fetchImpl')
}) as typeof fetch

// ------------------------------------------------------------------ fixtures
/** A pinned instant: every boundary below is arithmetic on it, never on the clock. */
const NOW = 1_800_000_000_000
const at = (expiresAtMs: number): { expiresAtMs: number } => ({ expiresAtMs })

const ID = traeAccountId('cn', 'u1', 'tester')
const STORAGE_PATH = 'C:/Users/tester/AppData/Roaming/Trae CN/User/globalStorage/storage.json'

const DESKTOP: TraeCredential = {
  id: ID,
  edition: 'cn',
  region: 'cn',
  source: 'desktop',
  storagePath: STORAGE_PATH,
  userId: 'u1',
  accountName: 'tester',
  host: 'https://api.trae.cn',
  expiresAtMs: NOW - 60_000,
  refreshToken: 'refresh-token-one',
  accessToken: 'old-access-token'
}

/** A real P-256 pair: the proof is signed and verified for real, offline. */
const { privateKey: PRIVATE_PEM, publicKey: PUBLIC_PEM } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
})
const DEVICE: TraeRefreshDevice = {
  machineId: 'machine-1',
  deviceId: '1599141713047850',
  deviceName: 'tester',
  appVersion: '3.3.104',
  osVersion: 'Windows 10.0.26100',
  deviceKeyPair: { privateKeyPEM: PRIVATE_PEM, publicKeyPEM: PUBLIC_PEM }
}

const OK_BODY = {
  Result: {
    Token: 'new-access-token',
    TokenExpireAt: '2030-01-01T00:00:00.000Z',
    RefreshToken: 'refresh-token-two',
    RefreshExpireAt: '2031-01-01T00:00:00.000Z'
  }
}

interface Calls {
  url: string
  init: RequestInit
}

/** Route a fake transport by URL and record every call — same shape as test-api.ts. */
function transport(handler: (url: string, init: RequestInit) => Response): { impl: typeof fetch; calls: Calls[] } {
  const calls: Calls[] = []
  const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const request = init ?? {}
    calls.push({ url: String(url), init: request })
    return handler(String(url), request)
  }) as unknown as typeof fetch
  return { impl, calls }
}

const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status })
const bodyOf = (call: Calls): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>

// ------------------------------------------------------------ 1. isExpired
console.log('\n[1] isExpired — the skew is the verdict')
check('outside the skew (now + 90s, margin 60s) -> still usable', isExpired(at(NOW + 90_000), 60_000, NOW) === false)
check('inside the skew (now + 30s) -> spent', isExpired(at(NOW + 30_000), 60_000, NOW) === true)
check('exactly at the boundary (now + 60s) -> spent (the margin is inclusive)', isExpired(at(NOW + 60_000), 60_000, NOW) === true)
check('one millisecond past the margin -> usable again', isExpired(at(NOW + 60_001), 60_000, NOW) === false)
check('already in the past -> spent', isExpired(at(NOW - 1), 60_000, NOW) === true)
check('skew 0 asks the literal question (now + 1ms) -> usable', isExpired(at(NOW + 1), 0, NOW) === false)
check('skew 0 and exactly now -> spent', isExpired(at(NOW), 0, NOW) === true)
check('an UNKNOWN deadline (0) is never "expired" (a CLI token without exp keeps working)', isExpired(at(0), 60_000, NOW) === false)
check('a non-finite deadline is treated the same as unknown', isExpired(at(Number.NaN), 60_000, NOW) === false)
check('the default margin is 60s', DEFAULT_EXPIRY_SKEW_MS === 60_000)

// ------------------------------------------------- 2. one instant, three spellings
console.log('\n[2] timeToMs through a real normalise (seconds / ms / ISO)')
{
  const base = { token: 'a-token', userId: 'u1', host: 'https://api.trae.cn' }
  const normalise = (extra: Record<string, unknown>, edition: 'cn' = 'cn'): TraeCredential | undefined =>
    normalizeCredential({ ...base, ...extra }, edition, 'desktop', STORAGE_PATH)
  const seconds = normalise({ expiredAt: 1792506420, refreshExpiredAt: 1800000000 })
  const millis = normalise({ expiredAt: 1792506420000, refreshExpiresAt: 1800000000000 })
  const iso = normalise({ expiredAt: '2026-10-21T11:47:00.000Z', refreshExpiredAt: '2027-02-14T00:00:00.000Z' })
  const none = normalise({})
  check('seconds are scaled to ms', seconds?.expiresAtMs === 1792506420000, String(seconds?.expiresAtMs))
  check('milliseconds are left alone', millis?.expiresAtMs === 1792506420000, String(millis?.expiresAtMs))
  check('an ISO string is parsed', iso?.expiresAtMs === Date.parse('2026-10-21T11:47:00.000Z'), String(iso?.expiresAtMs))
  check('the seconds and the ms spelling of one instant agree', seconds?.expiresAtMs === millis?.expiresAtMs)
  check('refreshExpiredAt is parsed on the same reader (upstream :1257)', seconds?.refreshExpiresAtMs === 1800000000000, String(seconds?.refreshExpiresAtMs))
  check('its millisecond spelling agrees too', millis?.refreshExpiresAtMs === seconds?.refreshExpiresAtMs)
  check('a document with no expiry stays 0 / absent — never 1970', none?.expiresAtMs === 0 && none?.refreshExpiresAtMs === undefined)
}

// ------------------------------------------------------------ 3. canRefresh
console.log('\n[3] canRefresh — what "the plugin can renew this by itself" requires')
check('host + refreshToken + a known edition -> yes', canRefresh(DESKTOP, NOW))
check('no refreshToken -> no', canRefresh({ ...DESKTOP, refreshToken: undefined }, NOW) === false)
check('an empty refreshToken -> no', canRefresh({ ...DESKTOP, refreshToken: '' }, NOW) === false)
check('no gateway host -> no', canRefresh({ ...DESKTOP, host: '' }, NOW) === false)
check('a refreshToken that has itself expired -> no', canRefresh({ ...DESKTOP, refreshExpiresAtMs: NOW - 1 }, NOW) === false)
check('a refreshToken still in date -> yes', canRefresh({ ...DESKTOP, refreshExpiresAtMs: NOW + 1 }, NOW))
check('all four editions have a contract', (['cn', 'sg', 'solo', 'solo-sg'] as const).every((edition) => canRefresh({ ...DESKTOP, edition }, NOW)))

// ------------------------------------------------- 4. our own file, never Trae's
console.log('\n[4] the iron rule, as a path')
{
  const home = join('C:', 'Users', 'tester', '.dsh')
  const storePath = credentialStorePath(home, ID)
  check('the store path is $DSH_HOME/.dsh-pylon-trae/credentials-<id>.json', storePath === join(home, '.dsh-pylon-trae', `credentials-${ID}.json`), storePath)
  check('...and it never names AppData or storage.json', !/appdata|storage\.json/i.test(storePath), storePath)
  check('a real desktop storage.json IS a Trae path', looksLikeTraeDataPath(STORAGE_PATH))
  check('...and so is its globalStorage directory', looksLikeTraeDataPath('C:/Users/t/AppData/Roaming/Trae/User/globalStorage/other.json'))
  check('a macOS install path is one too', looksLikeTraeDataPath('/Users/t/Library/Application Support/Trae/User/globalStorage/storage.json'))
  check('a DSH home that happens to live under AppData is NOT (the guard is Trae-shaped)', looksLikeTraeDataPath(join('C:', 'Users', 't', 'AppData', 'Roaming', 'dsh', '.dsh-pylon-trae', 'credentials-x.json')) === false)
  check('our own path passes the assertion', !throws(() => assertOwnCredentialPath(storePath)))
  check('...but the desktop storage.json is refused outright', throws(() => assertOwnCredentialPath(STORAGE_PATH)))
  check('...and so is any path outside .dsh-pylon-trae', throws(() => assertOwnCredentialPath(join(home, 'elsewhere', 'credentials-x.json'))))
  check('a credential id that is not a hex digest is refused, not pasted into a path', throws(() => credentialStorePath(home, '../../evil')))
}

// --------------------------------------- 5. the signed contract (a real keypair)
console.log('\n[5] refresh — the signed contract, field for field')
const store = mkdtempSync(join(tmpdir(), 'dsh-pylon-trae-auth-'))
const storePath = credentialStorePath(store, ID)
{
  const { impl, calls } = transport(() => json(OK_BODY))
  const result = await refreshTraeCredential(DESKTOP, { fetchImpl: impl, device: DEVICE })
  check('one request, to the current endpoint', calls.length === 1 && calls[0].url === 'https://api.trae.cn/trae/api/v3/oauth/ExchangeToken', calls[0]?.url)
  check('POST with Content-Type only (no Authorization, no identity headers)', calls[0].init.method === 'POST' && same(calls[0].init.headers, { 'Content-Type': 'application/json' }), JSON.stringify(calls[0].init.headers))
  check('the refresh succeeded through the SIGNED contract', result.ok && result.via === 'current', JSON.stringify(result.ok ? result.via : result.detail))
  const body = bodyOf(calls[0])
  check('envelope: ClientID (desktop) + empty ClientSecret + the refresh token', body['ClientID'] === 'ono9krqynydwx5' && body['ClientSecret'] === '' && body['RefreshToken'] === 'refresh-token-one', JSON.stringify({ ClientID: body['ClientID'], ClientSecret: body['ClientSecret'] }))
  const info = body['DeviceInfo'] as Record<string, unknown>
  check('DeviceInfo carries the device-centre id + platform code + public key', info['DeviceID'] === '1599141713047850' && info['PlatformCode'] === 'IDE_PC' && info['DevicePublicKey'] === PUBLIC_PEM, JSON.stringify({ ID: info['DeviceID'], code: info['PlatformCode'] }))
  check('DeviceInfo carries the machine id and the OS pair', info['MachineID'] === 'machine-1' && info['OSInfo'] === 'windows' && String(info['OSVersion']).startsWith('Windows'), JSON.stringify(info['OSInfo']))
  check('IDEVersion is the install\'s own app version', body['IDEVersion'] === '3.3.104' && info['ClientVersion'] === '3.3.104')
  if (result.ok) {
    check('the NEW token is adopted (compared by fingerprint, never printed)', tokenFingerprint(result.credential) === fp('new-access-token'))
    check('the new expiry comes from the envelope', result.credential.expiresAtMs === Date.parse('2030-01-01T00:00:00.000Z'), String(result.credential.expiresAtMs))
    check('the rotated refresh token replaces the old one', result.credential.refreshToken === 'refresh-token-two')
    check('the refresh deadline is carried over too', result.credential.refreshExpiresAtMs === Date.parse('2031-01-01T00:00:00.000Z'))
    check('source becomes own — this is OUR copy, not the desktop one', result.credential.source === 'own')
    check('storagePath still points at the DESKTOP file (identity is read there)', result.credential.storagePath === STORAGE_PATH)
    check('the account is unchanged (same id, same user)', result.credential.id === DESKTOP.id && result.credential.userId === 'u1')
  } else {
    check('the signed contract must not fail in this fixture', false, result.detail)
  }

  // ---------------------------------------------------------- 6. the proof trap
  console.log('\n[6] DeviceProof — newline-joined, and the space-joined twin must fail')
  const proof = body['DeviceProof'] as { Signature: string; Timestamp: number; Nonce: string }
  const fields = ['POST', '/trae/api/v3/oauth/ExchangeToken', 'ono9krqynydwx5', 'refresh-token-one', String(proof.Timestamp), proof.Nonce]
  check('the signature covers the NEWLINE-joined six fields (upstream :1699-1707)', verify('sha256', Buffer.from(fields.join('\n')), PUBLIC_PEM, Buffer.from(proof.Signature, 'base64')))
  check('a SPACE-joined message of the same fields does NOT verify (the trap this pins)', verify('sha256', Buffer.from(fields.join(' ')), PUBLIC_PEM, Buffer.from(proof.Signature, 'base64')) === false)
  check('the message helper and the signer agree', traeDeviceProofMessage({ path: fields[1] ?? '', clientId: fields[2] ?? '', refreshToken: fields[3] ?? '', timestamp: proof.Timestamp, nonce: proof.Nonce }) === fields.join('\n'))
  check('the timestamp is whole seconds', Number.isInteger(proof.Timestamp) && String(proof.Timestamp).length === 10, String(proof.Timestamp))
  check('the nonce is 16 random bytes in hex', /^[0-9a-f]{32}$/.test(proof.Nonce))
}

// ------------------------------------- 7. the legacy fallback and its degradations
console.log('\n[7] the legacy contract, and what happens without a keypair')
{
  const legacy = transport(() => json(OK_BODY))
  const noKeyPair = await refreshTraeCredential(DESKTOP, { fetchImpl: legacy.impl, device: { machineId: 'machine-1', deviceId: 'dev-1' } })
  check('without a keypair the signed contract is SKIPPED, not sent', legacy.calls.length === 1 && legacy.calls[0].url === 'https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken', legacy.calls.map((c) => c.url).join(' '))
  const legacyBody = bodyOf(legacy.calls[0])
  check('the legacy envelope is ClientID + "-" + RefreshToken + UserID', legacyBody['ClientID'] === 'ono9krqynydwx5' && legacyBody['ClientSecret'] === '-' && legacyBody['RefreshToken'] === 'refresh-token-one' && legacyBody['UserID'] === 'u1', JSON.stringify({ ClientID: legacyBody['ClientID'], ClientSecret: legacyBody['ClientSecret'], UserID: legacyBody['UserID'] }))
  check('...and it reports via=legacy', noKeyPair.ok && noKeyPair.via === 'legacy')

  // The signed contract refused (401) -> the legacy one is still tried.
  const fallback = transport((url) => (url.includes('/cloudide/') ? json(OK_BODY) : new Response('nope', { status: 401 })))
  const afterRefusal = await refreshTraeCredential(DESKTOP, { fetchImpl: fallback.impl, device: DEVICE })
  check('a refused signed contract falls back to the legacy one', afterRefusal.ok && afterRefusal.via === 'legacy' && fallback.calls.length === 2, JSON.stringify(afterRefusal.ok ? afterRefusal.via : afterRefusal.detail))

  // The SOLO client split belongs to the OAuth client, not the endpoint (upstream :1772-1781).
  const solo = transport(() => json(OK_BODY))
  await refreshTraeCredential({ ...DESKTOP, edition: 'solo', region: 'cn' }, { fetchImpl: solo.impl, device: DEVICE })
  const soloBody = bodyOf(solo.calls[0])
  check('a SOLO credential claims the SOLO ClientID and SOLO_PC (a wrong one answers 10101)', soloBody['ClientID'] === 'en1oxy7wnw8j9n' && (soloBody['DeviceInfo'] as Record<string, unknown>)['PlatformCode'] === 'SOLO_PC')

  // A credential with nothing to refresh with is refused BEFORE any request.
  const untouched = transport(() => json(OK_BODY))
  const noToken = await refreshTraeCredential({ ...DESKTOP, refreshToken: undefined }, { fetchImpl: untouched.impl, device: DEVICE })
  const noHost = await refreshTraeCredential({ ...DESKTOP, host: '' }, { fetchImpl: untouched.impl, device: DEVICE })
  check('no refreshToken -> refused with zero requests on the wire', noToken.ok === false && untouched.calls.length === 0 && noToken.detail.includes('refreshToken'))
  check('no host -> refused with zero requests on the wire', noHost.ok === false && untouched.calls.length === 0 && noHost.detail.includes('host'))

  const expiredRefresh = transport(() => json(OK_BODY))
  const stale = await refreshTraeCredential({ ...DESKTOP, refreshExpiresAtMs: Date.now() - 1000 }, { fetchImpl: expiredRefresh.impl, device: DEVICE })
  check('a refresh token that has itself expired -> refused locally, no request', stale.ok === false && expiredRefresh.calls.length === 0 && stale.detail.includes('过期'))

  const alreadyDead = transport(() => json({ Result: { Token: 'dead-token', TokenExpireAt: '2001-01-01T00:00:00.000Z' } }))
  const dead = await refreshTraeCredential(DESKTOP, { fetchImpl: alreadyDead.impl, device: DEVICE })
  check('a token that arrives already expired is refused, not adopted', dead.ok === false && dead.detail.includes('过期'))

  const malformed = transport(() => json({ Result: { Token: 'x' } }))
  const bad = await refreshTraeCredential({ ...DESKTOP, refreshToken: 'rt' }, { fetchImpl: malformed.impl, device: DEVICE })
  check('an answer with no parseable expiry is a refusal, not a 0-expiry credential', bad.ok === false && bad.detail.includes('TokenExpireAt'))
}

// ------------------------------------------- 8. a failure writes NOTHING at all
console.log('\n[8] a failed refresh changes no file')
{
  // Seed the "last good" copy, exactly as an earlier successful refresh would have.
  writeCredentialAtomic(storePath, DESKTOP)
  const before = readFileSync(storePath, 'utf8')
  const beforeNames = readdirSync(dirname(storePath)).join(',')
  const failing = transport(() => new Response('gateway says no', { status: 500 }))
  const result = await refreshCredentialIntoStore(DESKTOP, storePath, { fetchImpl: failing.impl, device: DEVICE })
  check('the refusal is ok:false and names BOTH contracts tried', result.ok === false && result.detail.includes('/trae/api/v3/oauth/ExchangeToken') && result.detail.includes('/cloudide/api/v3/trae/oauth/ExchangeToken'), result.detail)
  check('persisted is false', result.persisted === false)
  check('the existing file is BYTE-IDENTICAL', readFileSync(storePath, 'utf8') === before)
  check('no .part is left behind', !existsSync(`${storePath}.part`) && readdirSync(dirname(storePath)).join(',') === beforeNames, readdirSync(dirname(storePath)).join(','))

  const offline = transport(() => {
    throw new Error('offline')
  })
  const transportDown = await refreshCredentialIntoStore(DESKTOP, storePath, { fetchImpl: offline.impl, device: DEVICE })
  check('a transport that throws is a readable refusal, not an exception', transportDown.ok === false && transportDown.detail.length > 0)
  check('...and it also wrote nothing', readFileSync(storePath, 'utf8') === before)

  // The write itself refuses a Trae path even if a caller hands it one.
  const desktopWrite = throws(() => writeCredentialAtomic(STORAGE_PATH, DESKTOP))
  check('writeCredentialAtomic refuses Trae\'s storage.json outright', desktopWrite)
  check('...and refuses a sibling file outside .dsh-pylon-trae', throws(() => writeCredentialAtomic(join(store, 'credentials-x.json'), DESKTOP)))
}

// ------------------------------- 9. success persists atomically and round-trips
console.log('\n[9] a successful refresh persists atomically')
{
  const { impl } = transport(() => json(OK_BODY))
  const stored = await refreshCredentialIntoStore(DESKTOP, storePath, { fetchImpl: impl, device: DEVICE })
  check('ok + persisted + the store path it wrote', stored.ok && stored.persisted === true && stored.storePath === storePath, stored.detail)
  check('the file exists and NO .part survived the rename', existsSync(storePath) && !existsSync(`${storePath}.part`))
  const read = readStoredCredential(storePath, 'cn')
  check('our own copy round-trips through the same normaliser', read !== undefined && read.id === ID && read.source === 'own' && read.userId === 'u1')
  check('...with the NEW token (by fingerprint) and the new refresh token', read !== undefined && tokenFingerprint(read) === fp('new-access-token') && read.refreshToken === 'refresh-token-two')
  check('...and it is still usable, so the next boot can adopt it', read !== undefined && !isExpired(read))
  check('...with the desktop path kept for identity, the store path only for the secret', read?.storagePath === STORAGE_PATH && read?.source === 'own')
  check('a foreign or corrupt file is not read as a credential', readStoredCredential(join(store, 'nope.json'), 'cn') === undefined && (writeFileSync(join(store, 'junk.json'), '{ not json'), readStoredCredential(join(store, 'junk.json'), 'cn') === undefined))
  check('an unknown envelope version is not read as a credential', (writeFileSync(join(store, 'v9.json'), JSON.stringify({ version: 9, credential: { accessToken: 'x' } })), readStoredCredential(join(store, 'v9.json'), 'cn') === undefined))
}

// ----------------------------------------- 10. whose token, and WHOSE ACCOUNT
console.log('\n[10] preferValidStoredCredential — a token may be borrowed, an account may not')
{
  const expiredDesktop: TraeCredential = { ...DESKTOP, expiresAtMs: NOW - 1000 }
  const validCopy: TraeCredential = { ...DESKTOP, source: 'own', expiresAtMs: NOW + 3_600_000, accessToken: 'stored-access-token' }
  const adopted = preferValidStoredCredential(expiredDesktop, validCopy, NOW)
  check('an expired desktop credential is replaced by our still-valid copy', adopted !== undefined && tokenFingerprint(adopted) === fp('stored-access-token'))
  check('...and it carries the DESKTOP storagePath, so identity still resolves', adopted?.storagePath === STORAGE_PATH)
  check('a still-valid desktop credential always leads (the app is the source of truth)', preferValidStoredCredential({ ...expiredDesktop, expiresAtMs: NOW + 600_000 }, validCopy, NOW) === undefined)
  check('a copy for a DIFFERENT account is never adopted — billing must not move', preferValidStoredCredential(expiredDesktop, { ...validCopy, id: 'someone-else' }, NOW) === undefined)
  check('an expired copy is no better than the desktop one', preferValidStoredCredential(expiredDesktop, { ...validCopy, expiresAtMs: NOW - 1 }, NOW) === undefined)
  check('no copy at all changes nothing', preferValidStoredCredential(expiredDesktop, undefined, NOW) === undefined)
}

// ------------------------------------------------ 11. the one readable sentence
console.log('\n[11] describeCredentialExpiry — when it speaks, and when it stays silent')
{
  check('a healthy credential has nothing to say', describeCredentialExpiry({ expiresAtMs: NOW + 600_000 }, { action: 'not-attempted', now: NOW }) === undefined)
  check('an unknown deadline has nothing to say either', describeCredentialExpiry({ expiresAtMs: 0 }, { action: 'refresh-unavailable', now: NOW }) === undefined)
  const unavailable = describeCredentialExpiry({ expiresAtMs: NOW - 1000 }, { action: 'refresh-unavailable', now: NOW }) ?? ''
  check('expired with no refresh path -> 已过期 + what only the user can do', unavailable.includes('已过期') && unavailable.includes('重新登录'))
  const failed = describeCredentialExpiry({ expiresAtMs: NOW - 1000 }, { action: 'refresh-failed', note: 'http 401', now: NOW }) ?? ''
  check('a failed refresh names what was tried', failed.includes('刷新') && failed.includes('http 401'))
  const soon = describeCredentialExpiry({ expiresAtMs: NOW + 30_000 }, { action: 'not-attempted', now: NOW }) ?? ''
  check('inside the margin it says 即将过期 — the fact is not overstated', soon.includes('即将过期') && !soon.includes('已过期'), soon)
  const long = describeCredentialExpiry({ expiresAtMs: NOW - 1000 }, { action: 'refresh-failed', note: 'x'.repeat(2000), now: NOW }) ?? ''
  check('a pathological reason cannot become the whole line', long.length < 700, String(long.length))
}

// ------------------------------------------------- 12. /status carries both facts
console.log('\n[12] GET /status — the fields, and the sentence on the existing channel')
{
  const depsFor = (credential: TraeCredential, extra: Partial<ApiDeps> = {}): ApiDeps => ({
    region: 'cn',
    port: 7864,
    credential: async () => credential,
    identity: async () => ({ edition: 'cn', machineId: 'machine-1', deviceId: 'dev-1' }),
    models: () => [],
    accounts: async () => [],
    selectAccount: async () => ({ ok: true }),
    refresh: async () => ({ outcome: { kind: 'present', ns: 'llm-pi-ai' }, modelCount: 0 }),
    ...extra
  })
  // `/status` reads the REAL clock (`isExpired` with no injected `now`), so these two
  // fixtures are anchored to `Date.now()` rather than to the pinned `NOW` above —
  // which is itself a future instant, and "expired in the future" is not a state.
  const expired = { ...DESKTOP, expiresAtMs: Date.now() - 60_000 }
  const sentence = describeCredentialExpiry(expired, { action: 'refresh-failed', note: 'http 401', now: Date.now() })
  const expiredBody = (await handleApi({ method: 'GET', path: '/status' }, depsFor(expired, { accountWarning: () => sentence }))).body
  check('an expired credential: credentialExpired === true', expiredBody['credentialExpired'] === true)
  check('...and the deadline is the same number as the credential\'s own', expiredBody['credentialExpiresAtMs'] === expired.expiresAtMs)
  check('...both are TOP-LEVEL, so a card need not dig for them', 'credentialExpired' in expiredBody && 'credentialExpiresAtMs' in expiredBody)
  check('...and the sentence travels on the EXISTING accountWarning channel', String(expiredBody['accountWarning']).includes('已过期'), String(expiredBody['accountWarning']).slice(0, 60))
  const freshBody = (await handleApi({ method: 'GET', path: '/status' }, depsFor({ ...DESKTOP, expiresAtMs: Date.now() + 600_000 }))).body
  check('a healthy credential: credentialExpired is false, not missing', freshBody['credentialExpired'] === false && 'credentialExpired' in freshBody)
  check('...and nothing is invented in accountWarning', !('accountWarning' in freshBody))
  const credentialBlock = freshBody['credential'] as Record<string, unknown>
  check('the credential block still carries no secret (no token, no refresh token)', !('accessToken' in credentialBlock) && !('refreshToken' in credentialBlock), JSON.stringify(Object.keys(credentialBlock)))
  check('joinWarnings joins the real reasons and drops the empty ones', joinWarnings(undefined, '已选账号不在', '', '凭据已过期') === '已选账号不在；凭据已过期')
  check('joinWarnings with nothing to say is undefined, never an empty string', joinWarnings(undefined, '') === undefined)
}

// ------------------------------------------------------- 13. the device document
console.log('\n[13] the device facts read out of storage.json')
{
  const dcKey = 'iCubeAuthInfo://icube-dc:1599141713047850'
  const pair = deviceKeyPairOf({ [dcKey]: JSON.stringify({ privateKeyPEM: 'P', publicKeyPEM: 'K' }), 'iCubeAuthInfo://usertag': 'x' })
  check('a plain-JSON device entry yields the keypair', pair?.privateKeyPEM === 'P' && pair?.publicKeyPEM === 'K')
  check('an entry with no keypair is ABSENT, not an error', deviceKeyPairOf({ [dcKey]: '{}' }) === undefined && deviceKeyPairOf({}) === undefined)
  check('a malformed entry is treated as absent (upstream :1871-1889)', deviceKeyPairOf({ [dcKey]: 'not-json' }) === undefined)
  check('the device-centre id is the single dc key\'s suffix', deviceCenterIdOf({ [dcKey]: '{}', 'iCacheAuthInfo://usertag': 'x', 'iCubeAuthInfo://icube.cloudide': 'x' }) === '1599141713047850')
  check('two dc keys are ambiguous -> undefined, never a coin flip', deviceCenterIdOf({ 'iCubeAuthInfo://icube-dc:a': '{}', 'iCubeAuthInfo://icube-dc:b': '{}' }) === undefined)
  const deviceDoc = join(store, 'storage.json')
  writeFileSync(deviceDoc, JSON.stringify({ [dcKey]: JSON.stringify({ privateKeyPEM: 'P', publicKeyPEM: 'K' }) }))
  const read = readStorageDevice(deviceDoc)
  check('one read returns both halves of the device facts', read.deviceId === '1599141713047850' && read.keyPair?.privateKeyPEM === 'P')
  check('a missing or unreadable document is {} — never a throw', same(readStorageDevice(join(store, 'absent.json')), {}) && same(readStorageDevice(store), {}))
}

// ---------------------------------------------------------------- housekeeping
console.log('\n[14] nothing this suite wrote escaped the temp directory')
{
  const written: string[] = [storePath, `${storePath}.part`, join(store, 'storage.json'), join(store, 'junk.json'), join(store, 'v9.json')]
  check('every path written to is inside the mkdtemp directory', written.every((path) => path.startsWith(store)), store)
  check('...and the plugin\'s OWN paths are never Trae data paths', !looksLikeTraeDataPath(storePath) && !looksLikeTraeDataPath(`${storePath}.part`))
  check('the desktop fixture path was never created', !existsSync(STORAGE_PATH))
  rmSync(store, { recursive: true, force: true })
  check('the temp directory is gone', !existsSync(store))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}  (${passed}/${passed + failures})`)
process.exit(failures === 0 ? 0 : 1)

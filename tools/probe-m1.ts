/**
 * M1 probe — READ ONLY. Answers, on this machine:
 *   1. which Trae installations/data directories exist
 *   2. whether their credentials can be read and decrypted
 *   3. whether the live model directory is reachable with those credentials
 *
 * It writes nothing, contacts only the Trae gateway its own credential names, and
 * never prints a token: the only token output is a 12-hex SHA-256 fingerprint.
 * No Trae desktop app needs to be running; only its files need to exist.
 *
 * Run:  <dsh-node> tools/probe-m1.ts [--no-network]
 */
import { readTraeIdentity } from '../src/identity.ts'
import { scanCredentials, tokenFingerprint, type TraeCredential } from '../src/auth.ts'
import { FALLBACK_MODELS, fetchDirectoryModels, REGION_GATEWAYS } from '../src/catalog.ts'
import { traeStorageCandidates, type TraeRegion } from '../src/paths.ts'

const noNetwork = process.argv.includes('--no-network')

function line(char = '-', width = 78): string {
  return char.repeat(width)
}

function when(ms: number): string {
  if (ms === 0) return 'unknown'
  const iso = new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
  const left = Math.round((ms - Date.now()) / 60000)
  return `${iso}Z (${left >= 0 ? 'in ' : ''}${left} min)`
}

const candidates = traeStorageCandidates()
console.log(line('='))
console.log(`M1 probe · platform=${process.platform} · candidates=${candidates.length} · network=${noNetwork ? 'off' : 'on'}`)
console.log(line('='))
console.log('\n[1] candidates that exist on disk')
const existing = candidates.filter((candidate) => candidate.exists)
if (existing.length === 0) console.log('    (none) — no Trae installation data directory was found')
for (const candidate of existing) console.log(`    ${candidate.source.padEnd(7)} ${candidate.edition.padEnd(8)} ${candidate.path}`)

console.log('\n[2] credentials')
const scan = scanCredentials(candidates)
if (scan.credentials.length === 0) console.log('    (none readable)')
for (const credential of scan.credentials) {
  console.log(
    `    id=${credential.id}  ${credential.edition}/${credential.region}  source=${credential.source}  ` +
      `user=${credential.userId || '(none)'}  account=${credential.accountName ?? '(none)'}  host=${credential.host || '(none)'}`
  )
  console.log(`      expires=${when(credential.expiresAtMs)}  token-sha256[0:12]=${tokenFingerprint(credential)}`)
}
if (scan.failures.length > 0) {
  console.log('    failures:')
  for (const failure of scan.failures) console.log(`      ${failure}`)
}

const byRegion = new Map<TraeRegion, TraeCredential>()
for (const credential of scan.credentials) if (!byRegion.has(credential.region)) byRegion.set(credential.region, credential)

console.log('\n[3] live model directory (one request per directory function)')
for (const region of ['cn', 'ai'] as const) {
  const credential = byRegion.get(region)
  console.log(line())
  console.log(`region ${region}  gateway=${REGION_GATEWAYS[region].chat}`)
  if (credential === undefined) {
    console.log(`  no credential for ${region} — fallback roster would be used (${FALLBACK_MODELS[region].length} models)`)
    continue
  }
  let identity
  try {
    identity = readTraeIdentity(credential.storagePath, credential.edition)
  } catch (error) {
    console.log(`  identity unavailable: ${error instanceof Error ? error.message : String(error)}`)
    console.log(`  fallback roster would be used (${FALLBACK_MODELS[region].length} models)`)
    continue
  }
  console.log(`  identity machine=${identity.machineId.slice(0, 8)}… device=${identity.deviceId.slice(0, 8)}… appVersion=${identity.appVersion ?? identity.buildVersion ?? '(none)'}`)
  if (noNetwork) {
    console.log('  network off — skipping')
    continue
  }
  try {
    const result = await fetchDirectoryModels(region, credential, identity)
    for (const attempt of result.attempts) {
      console.log(`    ${attempt.fn.padEnd(20)} ${attempt.status === undefined ? 'transport-error' : `HTTP ${attempt.status}`}${attempt.count === undefined ? '' : `  +${attempt.count} models`}${attempt.error === undefined ? '' : `  ${attempt.error}`}`)
    }
    console.log(`  total: ${result.models.length} models`)
    for (const model of result.models.slice(0, 12)) {
      const window = model.contextWindow === undefined ? '?' : String(model.contextWindow)
      console.log(`    · ${model.id.padEnd(34)} ${model.name.padEnd(28)} ctx=${window.padStart(7)}  ${model.input.join('+')}`)
    }
    if (result.models.length > 12) console.log(`    … ${result.models.length - 12} more`)
  } catch (error) {
    console.log(`  directory request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(line('='))
console.log('done (nothing was written)')

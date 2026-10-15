/**
 * Trae's stable machine identity, read from Trae-owned files.
 *
 * The upstream gateways bind `x-machine-id` / `x-device-id` on every request, and
 * those values come from the installation itself, not from us:
 *   - `telemetry.machineId` in storage.json, else the `machineid` file beside
 *     the user-data directory;
 *   - `telemetry.devDeviceId` when the app has recorded one, else a SHA-256 of
 *     the machine id (the same derivation the observed client uses);
 *   - optional `appVersion` from the install's `product.json`, used only for the
 *     User-Agent string.
 *
 * Nothing here invents an identity: a missing machine id is an error, never a
 * random substitute.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cpus, homedir, release, userInfo } from 'node:os'
import { join } from 'node:path'
import { appDataRoot, desktopAppNames, type TraeEdition } from './paths.ts'

export interface TraeIdentity {
  edition: TraeEdition
  machineId: string
  deviceId: string
  appVersion?: string
  buildVersion?: string
  osVersion?: string
  deviceName?: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Candidate `product.json` paths (Windows install layout) for one edition. */
export function productJsonCandidates(edition: TraeEdition, platform = process.platform, home = homedir(), env = process.env): string[] {
  if (platform === 'darwin') return desktopAppNames(edition, platform).map((name) => join('/Applications', `${name}.app`, 'Contents', 'Resources', 'app', 'product.json'))
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, join(home, 'AppData', 'Local')].filter((v): v is string => typeof v === 'string' && v !== '')
    return roots.flatMap((root) => desktopAppNames(edition, platform).map((name) => join(root, 'Programs', name, 'resources', 'app', 'product.json')))
  }
  return []
}

/**
 * Read the identity of one installation. `storagePath` must exist; the caller has
 * already established that (the credential scan reports it).
 */
export function readTraeIdentity(
  storagePath: string,
  edition: TraeEdition,
  platform = process.platform,
  home = homedir(),
  env = process.env
): TraeIdentity {
  const storage = readJson(storagePath)
  if (storage === undefined) throw new Error('Trae storage document is not readable JSON')
  let machineFile: string | undefined
  try {
    machineFile = nonEmpty(readFileSync(join(appDataRoot(storagePath), 'machineid'), 'utf8'))
  } catch {
    machineFile = undefined
  }
  const machineId = nonEmpty(storage['telemetry.machineId']) ?? machineFile
  if (machineId === undefined) throw new Error(`Trae ${edition} has no stable machine identity (neither telemetry.machineId nor machineid)`)
  const deviceId =
    nonEmpty(storage['telemetry.devDeviceId']) ?? createHash('sha256').update(machineId).digest('hex').slice(0, 32)
  const buildVersion = nonEmpty(storage['iCubeLastVersion'])
  let appVersion: string | undefined
  for (const path of productJsonCandidates(edition, platform, home, env)) {
    const product = readJson(path)
    if (product !== undefined) {
      appVersion = nonEmpty(product['appVersion'])
      break
    }
  }
  let deviceName: string | undefined
  try {
    deviceName = nonEmpty(userInfo().username)
  } catch {
    deviceName = undefined
  }
  const deviceCpu = cpus()[0]?.model.split(' ')[0]
  return {
    edition,
    machineId,
    deviceId,
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(buildVersion === undefined ? {} : { buildVersion }),
    ...(deviceCpu === undefined ? {} : {}),
    osVersion: `${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform} ${release()}`
  }
}

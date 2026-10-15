/**
 * Where Trae keeps its things (paths only — no reading, no decrypting).
 *
 * Trae is a VS Code-family Electron app, so its per-user directory is named from
 * the installer's product name (`win32DirName`), which on Windows happens to
 * match the macOS bundle spelling while the lowercase `applicationName` spelling
 * is what the Linux config directory uses. We probe the distinct spellings for
 * the installed edition and keep them in a fixed order so a caller can report
 * "which spelling worked" instead of guessing.
 *
 * All functions are pure: the process platform, home and env are parameters so a
 * probe can run against any of the three layouts.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TRAE_EDITIONS = ['cn', 'sg', 'solo', 'solo-sg'] as const
export type TraeEdition = (typeof TRAE_EDITIONS)[number]
export type TraeRegion = 'cn' | 'ai'

/** Trae storage.json key holding the encrypted auth document. */
export interface TraeStorageCandidate {
  edition: TraeEdition
  region: TraeRegion
  /** `storage.json` on disk (the file that holds the auth value). */
  path: string
  source: 'desktop' | 'cli'
  exists: boolean
}

const DESKTOP_APP_NAMES: Readonly<Record<TraeEdition, string>> = {
  cn: 'Trae CN',
  sg: 'Trae',
  solo: 'TRAE SOLO CN',
  'solo-sg': 'TRAE SOLO'
}

const WINDOWS_APP_NAMES: Readonly<Record<TraeEdition, readonly string[]>> = {
  cn: ['Trae CN', 'trae-cn'],
  sg: ['Trae'],
  solo: ['TRAE SOLO CN', 'trae-solo-cn'],
  'solo-sg': ['TRAE SOLO']
}

const LINUX_APP_NAMES: Readonly<Record<TraeEdition, readonly string[]>> = {
  cn: ['trae-cn', 'Trae CN'],
  sg: ['trae', 'Trae'],
  solo: ['trae-solo-cn', 'TRAE SOLO CN'],
  'solo-sg': ['TRAE SOLO']
}

/** The CLI keeps a dotfile home per edition, not an Application Support entry. */
export const CLI_HOME_NAMES = ['.trae-cn', '.trae'] as const
export const TRAE_CLI_TOKEN_FILENAME = 'trae-jwt-token'

/** The international installs belong to the `ai` bucket; everything else is `cn`. */
export function regionOfEdition(edition: TraeEdition): TraeRegion {
  return edition === 'sg' || edition === 'solo-sg' ? 'ai' : 'cn'
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

/** Per-user desktop data roots, most specific first. */
export function desktopRoots(platform = process.platform, home = homedir(), env = process.env): string[] {
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support')]
  if (platform === 'win32') return dedupe([env.APPDATA, join(home, 'AppData', 'Roaming')].filter((v): v is string => typeof v === 'string' && v !== ''))
  if (platform === 'linux') return [env.XDG_CONFIG_HOME || join(home, '.config')]
  return []
}

/** App directory spellings to probe for one edition on this platform. */
export function desktopAppNames(edition: TraeEdition, platform = process.platform): readonly string[] {
  if (platform === 'win32') return WINDOWS_APP_NAMES[edition]
  if (platform === 'linux') return LINUX_APP_NAMES[edition]
  return [DESKTOP_APP_NAMES[edition]]
}

/** Every plausible desktop `storage.json`, before existence is checked. */
export function desktopStorageCandidates(platform = process.platform, home = homedir(), env = process.env): TraeStorageCandidate[] {
  const out: TraeStorageCandidate[] = []
  for (const edition of TRAE_EDITIONS) {
    for (const root of desktopRoots(platform, home, env)) {
      for (const appName of desktopAppNames(edition, platform)) {
        out.push({
          edition,
          region: regionOfEdition(edition),
          path: join(root, appName, 'User', 'globalStorage', 'storage.json'),
          source: 'desktop',
          exists: false
        })
      }
    }
  }
  return out
}

/** CLI token files (`~/.trae-cn/trae-jwt-token`). Only CN/SOLO are targeted. */
export function cliTokenCandidates(platform = process.platform, home = homedir(), env = process.env): TraeStorageCandidate[] {
  const roots: string[] = []
  if (platform === 'win32') {
    for (const value of [env.USERPROFILE, home]) if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value)
  } else {
    roots.push(home)
  }
  const out: TraeStorageCandidate[] = []
  for (const root of roots) {
    for (const name of CLI_HOME_NAMES) {
      out.push({
        edition: name === '.trae-cn' ? 'cn' : 'sg',
        region: name === '.trae-cn' ? 'cn' : 'ai',
        path: join(root, name, TRAE_CLI_TOKEN_FILENAME),
        source: 'cli',
        exists: false
      })
    }
  }
  return out
}

/** Desktop candidates first (the live sign-in), CLI last, with `exists` filled in. */
export function traeStorageCandidates(platform = process.platform, home = homedir(), env = process.env): TraeStorageCandidate[] {
  return [...desktopStorageCandidates(platform, home, env), ...cliTokenCandidates(platform, home, env)].map((candidate) => ({
    ...candidate,
    exists: existsSync(candidate.path)
  }))
}

/**
 * Trae's own model cache lives beside the credential document, so a candidate's
 * `storage.json` path is the authority for its `state.vscdb` — never re-spelled.
 */
export function stateDatabasePath(storagePath: string): string {
  return join(dirname(storagePath), 'state.vscdb')
}

/** The Trae user-data directory (holding `machineid`, one level above `User`). */
export function appDataRoot(storagePath: string): string {
  return dirname(dirname(dirname(storagePath)))
}

/** Where this plugin keeps its own refreshed copy, per region (never the real token in settings). */
export function ownCopyPath(dshHome: string, region: TraeRegion): string {
  return join(dshHome, '.dsh-pylon-trae', `${region}.json`)
}

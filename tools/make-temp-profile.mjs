/**
 * Build a scratch DSH home with ONE minimal profile that mounts only this plugin.
 *
 * Deliberately minimal and deliberately isolated:
 *  - its own DSH_HOME, so the operator's real home is never touched;
 *  - its own node_modules holding a junction for THIS plugin only — never a
 *    junction to the real profile's node_modules, because a pnpm run inside the
 *    temp profile would then write into the profile the operator is using;
 *  - no third-party bundles: if the cold start misbehaves, the only suspect is us.
 *
 * Run:  <dsh-node> tools/make-temp-profile.mjs
 * Clean: delete the printed profile dir, then `rmdir` the junction (not a recursive delete).
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// import.meta.dirname (Node >= 20.11) keeps non-ASCII path segments intact.
// The `new URL(import.meta.url).pathname` form percent-encodes them, which
// silently creates a parallel tree under a %E4%BB%A3... directory.
const PLUGIN_DIR = resolve(import.meta.dirname, '..')
const SCRATCH = resolve(PLUGIN_DIR, '..', '..', '_trae-coldstart')
const HOME = join(SCRATCH, 'home')
const NAME = process.argv[2] ?? 'zz-trae'
const PROFILE = join(HOME, 'profiles', NAME)

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })

// cordis.yml: an empty entry list; the tree is composed from the bundles + patch.
writeFileSync(
  join(PROFILE, 'cordis.yml'),
  '# scratch profile for the dsh-pylon-trae cold start — an empty entry list.\n[]\n',
  'utf8'
)

// package.json: our plugin only. `link:` keeps the plugin's files in the repo.
writeFileSync(
  join(PROFILE, 'package.json'),
  `${JSON.stringify(
    {
      name: `dsh-profile-${NAME}`,
      private: true,
      dependencies: { 'dsh-pylon-trae': `link:${PLUGIN_DIR.replaceAll('\\', '/')}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-pylon-trae'] } }
    },
    null,
    2
  )}\n`,
  'utf8'
)

// An empty user patch: everything our plugin writes lands here.
// It MUST be a top-level YAML array — the boot refuses a patch that parses to
// null ("must be a top-level YAML array of loader patch entries").
writeFileSync(
  join(PROFILE, 'cordis.patch.yml'),
  '# scratch profile patch (user layer) — our plugin writes its provider entry here\n[]\n',
  'utf8'
)

// The single junction, so `import 'dsh-pylon-trae'` resolves.
const link = join(PROFILE, 'node_modules', 'dsh-pylon-trae')
if (!existsSync(link)) symlinkSync(PLUGIN_DIR, link, 'junction')

console.log(`DSH_HOME=${HOME}`)
console.log(`profile=${NAME}`)
console.log(`profile dir=${PROFILE}`)
console.log(`link=${link} -> ${PLUGIN_DIR}`)

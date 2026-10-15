/**
 * Entry smoke test — no DSH needed.
 *
 * Loads src/index.ts the way the host would (Node type stripping, real imports)
 * and checks the three things the host looks for: a name, a Config whose
 * Standard-Schema validate() produces defaults, and an apply function.
 *
 * It also pins the MODULE-LOAD signal. `trace()` (→ `~/.dsh-pylon-trae/boot.log`)
 * answers "what did the plugin do", and cannot answer "was the plugin imported at
 * all" — a module nobody imports never runs a line of it, so an empty boot.log has
 * two causes it cannot tell apart. A module-scope `console.log` runs the instant
 * the module body is evaluated, with no `ctx`, no service and no `apply`, so its
 * absence is evidence about LOADING.
 *
 * That is checked BEHAVIOURALLY, not by grepping for the string: `console.log` is
 * captured around the import (esm module bodies run synchronously inside it, in
 * order, so the signal is visible), and the line has to be there — while nothing
 * resembling `apply` has run. Moving the signal into `apply` fails this, which is
 * the point: there it would answer a different question.
 *
 * Run:  <dsh-node> tools/check-entry.ts
 */
const LOAD_SIGNAL = '[dsh-pylon-trae] module loaded'

const said: string[] = []
const realLog = console.log
console.log = (...args: unknown[]): void => {
  said.push(args.map(String).join(' '))
  realLog(...args)
}
let mod: Record<string, unknown>
try {
  mod = (await import('../src/index.ts')) as Record<string, unknown>
} finally {
  console.log = realLog
}

const problems: string[] = []
if (mod['name'] !== 'dsh-pylon-trae') problems.push(`name is ${String(mod['name'])}`)
if (typeof mod['apply'] !== 'function') problems.push('apply is not a function')
if ('inject' in mod) problems.push('inject is exported (this workspace has been bitten by that twice)')
const config = mod['Config'] as { '~standard'?: { validate(input: unknown): { value?: unknown; issues?: unknown } } } | undefined
if (config?.['~standard'] === undefined) problems.push('Config is not a Standard Schema')

const signals = said.filter((line) => line.includes(LOAD_SIGNAL))
if (signals.length !== 1) problems.push(`the module-load signal appeared ${signals.length} time(s), expected exactly 1 — an absent one means the module was never imported`)
if (said.length > 0 && said[0] !== signals[0]) problems.push(`the module-load signal is not the first thing the module says (${JSON.stringify(said[0])})`)
if (said.length > 1) problems.push(`the module said ${said.length} things at import time; only the load signal belongs there`)
console.log(`${LOAD_SIGNAL}  (captured at import, count=${signals.length})`)

const validated = config?.['~standard']?.validate({ port: 7864, mode: 'refresh' })
console.log('validate({port:7864,mode:refresh}) ->', JSON.stringify(validated))
const defaults = config?.['~standard']?.validate({})
console.log('validate({})                     ->', JSON.stringify(defaults))
const bad = config?.['~standard']?.validate({ port: 'nope' })
console.log("validate({port:'nope'})          ->", JSON.stringify(bad))
if (bad !== undefined && bad.issues === undefined) problems.push('a bad port was accepted')

console.log(problems.length === 0 ? '\nENTRY OK' : `\nENTRY PROBLEMS:\n  ${problems.join('\n  ')}`)
process.exit(problems.length === 0 ? 0 : 1)

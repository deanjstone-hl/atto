// Fills the `@@ATTO_<KEY>@@` placeholders in wrangler.jsonc (atto1/104, atto1/108) and writes the
// result to a gitignored file that wrangler reads with --config. The private values (D1 database
// id, Access team domain and audience, the collector's service token id, the owner's Access
// subject) are not committed. A placeholder name is both the environment variable and the Secrets
// Manager key (`ATTO_ACCESS_AUD`, the `<REPO>_<KEY>` layout of argus-config/1414). The deploy
// workflow hands each one over as an Actions secret in the environment, so CI never calls Secrets
// Manager (the pattern of argus's with-d1-id.sh); by hand, a value missing from the environment is
// read from Secrets Manager (`bws secret list`, with your own BWS_ACCESS_TOKEN). A value is never
// printed and never put in an error.
//
//   node scripts/render-wrangler.ts [--template wrangler.jsonc] [--out wrangler.deploy.jsonc]
//
// Under GitHub Actions each value is first registered with `::add-mask::` so the runner redacts
// it from every later log line.
import { execFile } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

export type Exec = (file: string, args: string[]) => Promise<string>

const PLACEHOLDER = /@@([A-Z][A-Z0-9_]*)@@/g

export const templateKeys = (template: string): string[] => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1])),
]

async function bwsValues(exec: Exec): Promise<Map<string, string>> {
  const output = await exec('bws', ['secret', 'list', '--output', 'json'])
  let listing: unknown
  try {
    listing = JSON.parse(output)
  } catch {
    throw new Error('bws secret list did not print JSON')
  }
  const values = new Map<string, string>()
  if (Array.isArray(listing)) {
    for (const entry of listing) {
      if (typeof entry?.key === 'string' && typeof entry?.value === 'string' && !values.has(entry.key)) {
        values.set(entry.key, entry.value)
      }
    }
  }
  return values
}

export async function resolveValues(
  keys: string[],
  env: Record<string, string | undefined>,
  exec: Exec,
): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const missing = keys.filter((key) => {
    const value = env[key]
    if (value) found[key] = value
    return !value
  })
  if (missing.length > 0) {
    const values = await bwsValues(exec).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'bws secret list did not print JSON') throw error
      throw new Error(
        `no value for: ${missing.join(', ')}; the environment lacks ${missing.join(', ')} and the Secrets Manager listing failed (is BWS_ACCESS_TOKEN set?)`,
      )
    })
    const absent: string[] = []
    for (const key of missing) {
      const value = values.get(key)
      if (value) found[key] = value
      else absent.push(key)
    }
    if (absent.length > 0) {
      throw new Error(
        `no value for: ${absent.join(', ')} (set ${absent.join(', ')} or add the Bitwarden Secrets Manager secret by that name)`,
      )
    }
  }
  for (const key of keys) {
    if (/[\r\n]/.test(found[key])) throw new Error(`the value for ${key} spans more than one line`)
  }
  return found
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  const absent = templateKeys(template).filter((key) => !values[key])
  if (absent.length > 0) throw new Error(`no value for: ${absent.join(', ')}`)
  return template.replace(PLACEHOLDER, (_match, key: string) => JSON.stringify(values[key]).slice(1, -1))
}

const execFileAsync = promisify(execFile)
const exec: Exec = async (file, args) => (await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 })).stdout

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

async function main(): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, '..')
  const argv = process.argv.slice(2)
  const templatePath = resolve(repoRoot, option(argv, '--template') ?? 'wrangler.jsonc')
  const outPath = resolve(repoRoot, option(argv, '--out') ?? 'wrangler.deploy.jsonc')
  const template = readFileSync(templatePath, 'utf8')
  const keys = templateKeys(template)
  const values = await resolveValues(keys, process.env, exec)
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const key of keys) console.log(`::add-mask::${values[key]}`)
  }
  writeFileSync(outPath, renderTemplate(template, values), { mode: 0o600 })
  chmodSync(outPath, 0o600)
  console.log(`render-wrangler: wrote ${outPath} (${keys.length} values)`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`render-wrangler: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

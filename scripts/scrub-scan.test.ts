import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/scrub-scan.sh is the gate that keeps private values out of the public tree
// (atto1/104): gitleaks' default rules plus the personal-data rules in .gitleaks.toml. Each
// planted value is built at run time, so this file never holds a value the scan would flag.
// A host without gitleaks skips the file rather than failing the deploy Test step.

const root = join(import.meta.dirname, '..')
const script = join(root, 'scripts/scrub-scan.sh')
const hasGitleaks = spawnSync('gitleaks', ['version']).status === 0

const scan = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'atto1-scrub-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  const result = spawnSync('bash', [script, dir], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const dotted = (...parts: (string | number)[]) => parts.join('.')
const hex = (length: number) => 'abcdef0123456789'.repeat(8).slice(0, length)

describe.skipIf(!hasGitleaks)('scripts/scrub-scan.sh', () => {
  it('passes a tree with no private value', () => {
    const { status, output } = scan({ 'a.md': 'Nothing private here. Contact owner@example.com. See 8.8.8.8.\n' })
    expect(output).toContain('scrub-scan: pass')
    expect(status).toBe(0)
  })

  it.each([
    ['a tailnet IP', `host ${dotted(100, 101, 102, 103)}\n`, dotted(100, 101, 102, 103)],
    ['a LAN IP', `router ${dotted(192, 168, 1, 20)}\n`, dotted(192, 168, 1, 20)],
    ['a tailnet hostname', `ssh box.${['tail', 'abc12'].join('')}.${['ts', 'net'].join('.')}\n`, ['ts', 'net'].join('.')],
    ['a personal email address', `mail ${['someone', ['proton', 'me'].join('.')].join('@')}\n`, ['proton', 'me'].join('.')],
    ['an Access team domain', `iss https://${['curly', 'haze'].join('-')}.${['cloudflareaccess', 'com'].join('.')}\n`, ['curly', 'haze'].join('-')],
    ['a Cloudflare-style 32 hex id', `id = "${hex(32)}"\n`, hex(32)],
    ['a 64 hex Access audience tag', `AUD = "${hex(64)}"\n`, hex(64)],
    ['an AU mobile number', `call ${['0412', '345', '678'].join(' ')}\n`, ['345', '678'].join(' ')],
  ])('fails on %s, and prints no value', (_name, text, value) => {
    const { status, output } = scan({ 'a.txt': text })
    expect(status).toBe(1)
    expect(output).toContain('scrub-scan: FAIL')
    expect(output).not.toContain(value)
  })

  it('fails on a UUID such as a D1 database id', () => {
    const uuid = ['0a1b2c3d', '4e5f', '4a6b', '8c7d', '9e0f1a2b3c4d'].join('-')
    const { status, output } = scan({ 'a.txt': `database_id = "${uuid}"\n` })
    expect(status).toBe(1)
    expect(output).not.toContain(uuid)
  })

  // deploy.yml maps each Secrets Manager secret id to its environment variable for
  // bitwarden/sm-action (atto/10). An id names a secret and reads nothing without a token, but the
  // UUID rule still flags it, so exactly that map line is allowed and no other line is.
  it('allows a Secrets Manager id on an sm-action map line, and the same id anywhere else still fails', () => {
    const uuid = ['0a1b2c3d', '4e5f', '4a6b', '8c7d', '9e0f1a2b3c4d'].join('-')
    const allowed = scan({ 'a.yml': `          secrets: |\n            ${uuid} > ATTO_D1_DATABASE_ID\n` })
    expect(allowed.output).toContain('scrub-scan: pass')
    expect(allowed.status).toBe(0)
    expect(scan({ 'a.yml': `          D1: ${uuid} > ATTO_D1_DATABASE_ID trailing\n` }).status).toBe(1)
    expect(scan({ 'a.txt': `database_id = "${uuid}"\n` }).status).toBe(1)
  })
})

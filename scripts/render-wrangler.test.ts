import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderTemplate, resolveValues, templateKeys, type Exec } from './render-wrangler.ts'

// wrangler.jsonc is committed with `@@ATTO_<KEY>@@` placeholders (atto1/104, atto1/108); this fills them
// at deploy time from the environment or Bitwarden Secrets Manager, by name, into a gitignored
// file that wrangler reads with --config. No value is ever printed or put in an error.

const root = join(import.meta.dirname, '..')
const template = '{ "vars": { "A": "@@ATTO_ONE@@", "B": "@@ATTO_TWO@@" }, "again": "@@ATTO_ONE@@" }'

const listing = JSON.stringify([
  { key: 'ATTO_ONE', value: 'value-from-bws-1' },
  { key: 'ATTO_TWO', value: 'value-from-bws-2' },
  { key: 'unrelated', value: 'nope' },
])

describe('templateKeys', () => {
  it('lists each placeholder once, in order', () => {
    expect(templateKeys(template)).toEqual(['ATTO_ONE', 'ATTO_TWO'])
  })
})

describe('a placeholder name', () => {
  it('is the Secrets Manager key and the environment variable at once (ATTO_<KEY>, argus-config/1414)', () => {
    expect(templateKeys('"@@ATTO_ACCESS_AUD@@"')).toEqual(['ATTO_ACCESS_AUD'])
  })

  it('ignores a name that is not UPPER_SNAKE_CASE, so an old @@atto1-…@@ placeholder is left as it is', () => {
    expect(templateKeys('"@@atto1-access-aud@@" "@@lower_case@@"')).toEqual([])
  })
})

describe('resolveValues', () => {
  it('takes values from the environment and does not ask bws', async () => {
    const calls: string[][] = []
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args])
      return listing
    }
    const values = await resolveValues(['ATTO_ONE', 'ATTO_TWO'], { ATTO_ONE: 'e1', ATTO_TWO: 'e2' }, exec)
    expect(values).toEqual({ 'ATTO_ONE': 'e1', 'ATTO_TWO': 'e2' })
    expect(calls).toEqual([])
  })

  it('fetches the rest from Secrets Manager by secret name, in one call', async () => {
    const calls: string[][] = []
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args])
      return listing
    }
    const values = await resolveValues(['ATTO_ONE', 'ATTO_TWO'], { ATTO_ONE: 'e1' }, exec)
    expect(values).toEqual({ 'ATTO_ONE': 'e1', 'ATTO_TWO': 'value-from-bws-2' })
    expect(calls).toEqual([['bws', 'secret', 'list', '--output', 'json']])
  })

  it('names every missing key and prints no value', async () => {
    const exec: Exec = async () => JSON.stringify([{ key: 'ATTO_ONE', value: 'value-from-bws-1' }])
    const failure = await resolveValues(['ATTO_ONE', 'ATTO_TWO', 'ATTO_THREE'], {}, exec).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('ATTO_TWO, ATTO_THREE')
    expect((failure as Error).message).not.toContain('value-from-bws-1')
  })

  it('treats an empty value as missing', async () => {
    const exec: Exec = async () => JSON.stringify([{ key: 'ATTO_ONE', value: '' }])
    await expect(resolveValues(['ATTO_ONE'], {}, exec)).rejects.toThrow('ATTO_ONE')
  })

  it('does not echo what bws printed when it is not JSON', async () => {
    const exec: Exec = async () => 'secret-looking-output'
    const failure = await resolveValues(['ATTO_ONE'], {}, exec).catch((error: Error) => error)
    expect((failure as Error).message).toContain('did not print JSON')
    expect((failure as Error).message).not.toContain('secret-looking-output')
  })
})

describe('renderTemplate', () => {
  it('replaces every placeholder', () => {
    const out = renderTemplate(template, { 'ATTO_ONE': 'x1', 'ATTO_TWO': 'x2' })
    expect(JSON.parse(out)).toEqual({ vars: { A: 'x1', B: 'x2' }, again: 'x1' })
    expect(out).not.toContain('@@')
  })

  it('escapes a value so the result stays valid JSON', () => {
    const out = renderTemplate('{ "A": "@@ATTO_ONE@@" }', { 'ATTO_ONE': 'a"b\\c' })
    expect(JSON.parse(out)).toEqual({ A: 'a"b\\c' })
  })

  it('refuses a placeholder with no value', () => {
    expect(() => renderTemplate(template, { 'ATTO_ONE': 'x1' })).toThrow('ATTO_TWO')
  })
})

describe('the committed wrangler.jsonc', () => {
  const text = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')

  it('holds only placeholders for the private values, named as Secrets Manager keys in the actions project', () => {
    expect(templateKeys(text)).toEqual([
      'ATTO_D1_DATABASE_ID',
      'ATTO_ACCESS_TEAM_DOMAIN',
      'ATTO_ACCESS_AUD',
      'ATTO_INGEST_CLIENT_ID',
      'ATTO_INGEST_OWNER_SUBJECT',
    ])
  })
})

describe('scripts/render-wrangler.ts as a command', () => {
  const run = (args: string[], env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'atto1-render-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'bws'), `#!/bin/bash\n[ -n "$BWS_ACCESS_TOKEN" ] || exit 1\ncat <<'EOF'\n${listing}\nEOF\n`)
    chmodSync(join(bin, 'bws'), 0o755)
    const input = join(dir, 'in.jsonc')
    writeFileSync(input, `// a comment\n${template}\n`)
    const out = join(dir, 'out.jsonc')
    const result = spawnSync('node', [join(root, 'scripts/render-wrangler.ts'), '--template', input, '--out', out, ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env },
    })
    return { out, result, output: `${result.stdout}${result.stderr}` }
  }

  it('writes the rendered file, mode 600, and prints no value', () => {
    const { out, result, output } = run([], { BWS_ACCESS_TOKEN: 'token', ATTO_ONE: 'from-env-1' })
    expect(result.status).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('from-env-1')
    expect(readFileSync(out, 'utf8')).toContain('value-from-bws-2')
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(output).not.toContain('from-env-1')
    expect(output).not.toContain('value-from-bws-2')
  })

  it('writes nothing and names the problem when the values cannot be read', () => {
    const { out, result, output } = run([], {})
    expect(result.status).toBe(1)
    expect(existsSync(out)).toBe(false)
    expect(output).toContain('ATTO_')
  })

  it('masks each value for the Actions log before anything else, under GitHub Actions', () => {
    const { result } = run([], { BWS_ACCESS_TOKEN: 'token', GITHUB_ACTIONS: 'true' })
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter(Boolean)
    expect(lines[0]).toBe('::add-mask::value-from-bws-1')
    expect(lines[1]).toBe('::add-mask::value-from-bws-2')
  })
})

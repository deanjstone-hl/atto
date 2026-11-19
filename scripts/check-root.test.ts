import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// scripts/check.sh must check atto1's own tree whatever directory it is called from
// (atto1#103): another repo's pre-push gate runs it from its own checkout. Fake
// executables (pnpm and bats) on PATH record the directory each step runs in, so the test never
// recurses into the real lint, build and test run.

const root = realpathSync(join(import.meta.dirname, '..'))
const script = join(root, 'scripts/check.sh')
const identity = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

describe('scripts/check.sh root resolution', () => {
  let scratch: string
  let stubBin: string
  let log: string

  const runFrom = (cwd: string) =>
    spawnSync('bash', [script], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...identity, PATH: `${stubBin}:${process.env.PATH}` },
    })
  const stepDirectories = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => realpathSync(line))

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'check-root-')))
    stubBin = join(scratch, 'bin')
    log = join(scratch, 'step-dirs.log')
    mkdirSync(stubBin)
    writeFileSync(log, '')
    for (const tool of ['pnpm', 'bats']) {
      const stub = join(stubBin, tool)
      writeFileSync(stub, `#!/usr/bin/env bash\npwd -P >> ${JSON.stringify(log)}\n`)
      chmodSync(stub, 0o755)
    }
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it("checks atto1's tree when run from another git repo", () => {
    const other = join(scratch, 'other-repo')
    execFileSync('git', ['init', '-q', '-b', 'main', other])
    execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', 'chore: init'], {
      env: { ...process.env, ...identity },
    })
    const otherSha = execFileSync('git', ['-C', other, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const ownSha = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()

    const result = runFrom(other)

    expect(result.status).toBe(0)
    const directories = stepDirectories()
    expect(directories.length).toBeGreaterThan(0)
    expect(directories.every((directory) => directory === root)).toBe(true)
    expect(result.stdout.trim()).toBe(`check: pass ${ownSha}`)
    expect(result.stdout).not.toContain(otherSha)
  })

  it("checks atto1's tree when run from a directory outside any repo", () => {
    const result = runFrom(scratch)

    expect(result.status).toBe(0)
    const directories = stepDirectories()
    expect(directories.length).toBeGreaterThan(0)
    expect(directories.every((directory) => directory === root)).toBe(true)
  })
})

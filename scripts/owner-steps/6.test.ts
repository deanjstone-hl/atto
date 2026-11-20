import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/owner-steps/6.sh is run live by the owner (atto/6, docs/carplay-shortcut.md). These
// cases prove what it does against a throwaway HOME with systemctl stubbed, and that it
// refuses, changing nothing, when its pre-flight fails. Glue, so characterisation tests.

const root = join(import.meta.dirname, '..', '..')
const script = join(root, 'scripts/owner-steps/6.sh')

const gitEnv = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

function git(repo: string, args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...gitEnv } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function write(path: string, body: string, mode = 0o644) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, mode)
}

// A throwaway checkout whose origin/deploy either equals HEAD or sits one commit behind it,
// holding the two trigger units unless `withUnits` is false.
function makeCheckout(state: 'at-deploy' | 'ahead-of-deploy', withUnits = true) {
  const repo = mkdtempSync(join(tmpdir(), 'atto1-checkout-'))
  git(repo, ['init', '--quiet'])
  if (withUnits) {
    write(join(repo, 'collector/systemd/atto1-collector-trigger.service'), '[Service]\n')
    write(join(repo, 'collector/systemd/atto1-collector-trigger.timer'), '[Timer]\n')
    git(repo, ['add', '-A'])
  }
  git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'promoted'])
  const promoted = git(repo, ['rev-parse', 'HEAD'])
  if (state === 'ahead-of-deploy') git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'not promoted'])
  git(repo, ['update-ref', 'refs/remotes/origin/deploy', promoted])
  return repo
}

type Host = { home: string; bin: string; calls: string }

// A fake HOME in which every pre-flight check passes: the collector's drop-in (77.sh ran),
// the Secrets Manager token, node, flock on the PATH, and a systemctl that records its calls.
function makeHost(options: { dropIn?: boolean; flock?: boolean } = {}): Host {
  const home = mkdtempSync(join(tmpdir(), 'atto1-owner-steps-6-'))
  const bin = join(home, 'stub-bin')
  const calls = join(home, 'systemctl-calls')
  writeFileSync(calls, '')
  write(join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> "${calls}"\n`, 0o755)
  if (options.flock !== false) write(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', 0o755)
  write(join(home, '.bws_token'), 'stub')
  write(join(home, '.local/share/fnm/aliases/default/bin/node'), '#!/bin/sh\nexit 0\n', 0o755)
  if (options.dropIn !== false) {
    write(
      join(home, '.config/systemd/user/atto1-collector.service.d/collector.conf'),
      '[Service]\nEnvironment=ATTO1_PYTHON=/fake/venv/bin/python\nEnvironment=ATTO1_BATTERY_KWH=30\n',
    )
  }
  return { home, bin, calls }
}

function run(args: string[], host: Host, repo: string) {
  // Only the stub bin, git and the basic tools: a real flock or systemctl must never be reached.
  const system = ['/usr/bin', '/bin'].join(':')
  return spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${host.bin}:${system}`, HOME: host.home, ATTO1_REPO: repo },
  })
}

const failedChecks = (stderr: string) => stderr.split('\n').filter((line) => line.startsWith('pre-flight FAILED'))
const userUnits = (home: string) => join(home, '.config/systemd/user')

describe('scripts/owner-steps/6.sh', () => {
  it('refuses an unknown argument', () => {
    const host = makeHost()
    expect(run(['--now'], host, makeCheckout('at-deploy')).status).toBe(2)
  })

  it('refuses a checkout that is not at origin/deploy, changing nothing', () => {
    const host = makeHost()
    const result = run([], host, makeCheckout('ahead-of-deploy'))
    expect(result.status).toBe(1)
    expect(failedChecks(result.stderr)).toHaveLength(1)
    expect(result.stderr).toMatch(/pre-flight FAILED: .* is at origin\/deploy/)
    expect(result.stderr).toMatch(/nothing was changed/)
    expect(existsSync(join(userUnits(host.home), 'atto1-collector-trigger.timer'))).toBe(false)
    expect(readFileSync(host.calls, 'utf8')).toBe('')
  })

  it('refuses a checkout that does not hold the trigger units yet', () => {
    const host = makeHost()
    const result = run([], host, makeCheckout('at-deploy', false))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/pre-flight FAILED: .*atto1-collector-trigger\.service/)
    expect(readFileSync(host.calls, 'utf8')).toBe('')
  })

  it('refuses before 77.sh has installed the collector: there is no drop-in to copy', () => {
    const host = makeHost({ dropIn: false })
    const result = run([], host, makeCheckout('at-deploy'))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/pre-flight FAILED: .*collector\.conf/)
    expect(result.stderr).toMatch(/77\.sh/)
    expect(readFileSync(host.calls, 'utf8')).toBe('')
  })

  it('refuses a host with no flock, since both units take the shared lock with it', () => {
    const host = makeHost({ flock: false })
    const result = spawnSync('/bin/bash', [script], {
      encoding: 'utf8',
      // No /usr/bin on the PATH, so the system flock is out of reach too.
      env: { PATH: `${host.bin}:/nonexistent`, HOME: host.home, ATTO1_REPO: makeCheckout('at-deploy') },
    })
    expect(result.stderr).toMatch(/pre-flight FAILED: flock is on the PATH/)
  })

  it('changes nothing under --dry-run, and says what it would do', () => {
    const host = makeHost()
    const result = run(['--dry-run'], host, makeCheckout('at-deploy'))
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/\[dry-run\] systemctl --user enable --now atto1-collector-trigger\.timer/)
    expect(existsSync(join(userUnits(host.home), 'atto1-collector-trigger.timer'))).toBe(false)
    expect(readFileSync(host.calls, 'utf8')).toBe('')
  })

  it('links both units, gives the trigger service the collector\'s interpreter and capacity, and enables the timer', () => {
    const host = makeHost()
    const repo = makeCheckout('at-deploy')
    const result = run([], host, repo)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)

    for (const unit of ['atto1-collector-trigger.service', 'atto1-collector-trigger.timer']) {
      const link = join(userUnits(host.home), unit)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join(repo, 'collector/systemd', unit))
    }
    expect(readFileSync(join(userUnits(host.home), 'atto1-collector-trigger.service.d/collector.conf'), 'utf8')).toBe(
      readFileSync(join(userUnits(host.home), 'atto1-collector.service.d/collector.conf'), 'utf8'),
    )
    expect(readFileSync(host.calls, 'utf8').trim().split('\n')).toEqual([
      '--user daemon-reload',
      '--user enable --now atto1-collector-trigger.timer',
      '--user is-enabled atto1-collector-trigger.timer',
      '--user list-timers atto1-collector-trigger.timer --no-pager',
    ])
  })

  it('is safe to run twice', () => {
    const host = makeHost()
    const repo = makeCheckout('at-deploy')
    expect(run([], host, repo).status).toBe(0)
    expect(run([], host, repo).status).toBe(0)
  })

  it('handles no secret, and never promotes or pushes deploy', () => {
    const code = readFileSync(script, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/promote\.sh|git push|workflow run|bws secret|CLIENT_SECRET|PASSWORD/)
  })
})

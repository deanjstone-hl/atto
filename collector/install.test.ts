import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/owner-steps/77.sh is run live by the owner; these cases only prove that it
// refuses, changing nothing, when its pre-flight fails, and that the shipped units say
// what ADR-006 says. Glue, so these are characterisation tests, not red-green ones.

const root = join(import.meta.dirname, '..')
const script = join(root, 'scripts/owner-steps/77.sh')

// The script's pre-flight reads the host (git checkout, node and uv under $HOME, bws,
// ~/.bws_token). A case that is about one check must not depend on the others, or it
// passes on a dev machine and fails on the deploy runner, whose checkout IS origin/deploy
// (atto1/85). So each case builds its own checkout and, when it needs the rest to pass,
// stubs them in its throwaway HOME and PATH.
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

// A throwaway checkout with an origin/deploy ref that either equals HEAD (the runner's
// state) or sits one commit behind it (a checkout on main ahead of deploy).
function makeCheckout(state: 'at-deploy' | 'ahead-of-deploy') {
  const repo = mkdtempSync(join(tmpdir(), 'atto1-checkout-'))
  git(repo, ['init', '--quiet'])
  git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'promoted'])
  const promoted = git(repo, ['rev-parse', 'HEAD'])
  if (state === 'ahead-of-deploy') git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'not promoted'])
  git(repo, ['update-ref', 'refs/remotes/origin/deploy', promoted])
  return repo
}

function stub(path: string, body: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// Fake home and PATH in which every host-dependent pre-flight check passes.
function stubHost(home: string) {
  const bin = join(home, 'stub-bin')
  stub(join(home, '.local/share/fnm/aliases/default/bin/node'), 'exit 0')
  // uv makes a venv whose python runs; the script's pre-flight proves it in a scratch dir (atto1/95).
  stub(
    join(home, '.local/bin/uv'),
    'for dir; do :; done\nmkdir -p "$dir/bin"\nprintf \'#!/bin/sh\\nexit 0\\n\' > "$dir/bin/python"\nchmod +x "$dir/bin/python"',
  )
  stub(join(bin, 'bws'), 'exit 0')
  writeFileSync(join(home, '.bws_token'), 'stub')
  return bin
}

function run(args: string[], env: Record<string, string>, options: { stubbedHost?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'atto1-owner-steps-'))
  const path = process.env.PATH ?? ''
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: options.stubbedHost ? `${stubHost(home)}:${path}` : path, HOME: home, ...env },
  })
  return { ...result, home }
}

// Runs a unit's ExecStart as systemd would hand it to bash, with `node` replaced by a stub
// that runs `nodeBody`: $HOME/.bws_token holds a stub token and %t is a scratch runtime dir
// whose lock file the stub can find as $LOCK.
function runExecStart(unit: string, nodeBody: string) {
  const code = unit.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  const execStart = code.match(/^ExecStart=\/bin\/bash -c '(.*)'$/m)?.[1]
  expect(execStart).toBeDefined()
  const home = mkdtempSync(join(tmpdir(), 'atto1-unit-'))
  const runtime = mkdtempSync(join(tmpdir(), 'atto1-runtime-'))
  writeFileSync(join(home, '.bws_token'), 'BWS_ACCESS_TOKEN=stub\n')
  stub(join(home, '.local/share/fnm/aliases/default/bin/node'), `LOCK="${runtime}/atto1-collector.lock"\n${nodeBody}`)
  return spawnSync('/bin/bash', ['-c', (execStart ?? '').replaceAll('%t', runtime)], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: home },
    cwd: home,
  })
}

const failedChecks = (stderr: string) => stderr.split('\n').filter((line) => line.startsWith('pre-flight FAILED'))

describe('scripts/owner-steps/77.sh', () => {
  it('refuses an unknown argument', () => {
    expect(run(['--now'], {}).status).toBe(2)
  })

  it.each([['abc'], ['0'], ['']])('refuses a battery capacity of %j and changes nothing', (kwh) => {
    const result = run([], { ATTO1_BATTERY_KWH: kwh, ATTO1_REPO: join(root) })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/pre-flight FAILED: ATTO1_BATTERY_KWH/)
    expect(result.stderr).toMatch(/nothing was changed/)
    expect(existsSync(join(result.home, '.config'))).toBe(false)
    expect(existsSync(join(result.home, '.local'))).toBe(false)
  })

  it('refuses a checkout that is not at origin/deploy, under --dry-run too', () => {
    const result = run(
      ['--dry-run'],
      { ATTO1_BATTERY_KWH: '30', ATTO1_REPO: makeCheckout('ahead-of-deploy') },
      { stubbedHost: true },
    )
    expect(result.status).toBe(1)
    expect(failedChecks(result.stderr)).toHaveLength(1)
    expect(result.stderr).toMatch(/pre-flight FAILED: .* is at origin\/deploy/)
    expect(result.stderr).toMatch(/nothing was changed/)
  })

  it('passes pre-flight and changes nothing under --dry-run on a checkout at origin/deploy', () => {
    const result = run(['--dry-run'], { ATTO1_BATTERY_KWH: '30', ATTO1_REPO: makeCheckout('at-deploy') }, { stubbedHost: true })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/pre-flight ok: .* is at origin\/deploy/)
    expect(result.stdout).toMatch(/\[dry-run\] systemctl --user enable --now atto1-collector.timer/)
    expect(existsSync(join(result.home, '.config'))).toBe(false)
    expect(existsSync(join(result.home, '.local/share/atto1-collector'))).toBe(false)
  })

  it('never promotes or pushes deploy', () => {
    const source = readFileSync(script, 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/promote\.sh|git push|workflow run/)
  })
})

describe('the shipped units', () => {
  const service = readFileSync(join(root, 'collector/systemd/atto1-collector.service'), 'utf8')
  const timer = readFileSync(join(root, 'collector/systemd/atto1-collector.timer'), 'utf8')
  const live = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')

  it('runs collector/run.ts once, from the deploy copy', () => {
    expect(live(service)).toMatch(/Type=oneshot/)
    expect(live(service)).toMatch(/WorkingDirectory=%h\/repos\/atto1?$/m)
    expect(live(service)).toMatch(/collector\/run\.ts/)
  })

  it('exports the Secrets Manager access token to the collector and the bws it runs (atto1/87)', () => {
    // ~/.bws_token is a bare BWS_ACCESS_TOKEN=… assignment; sourcing it without `set -a`
    // leaves a shell variable that node and bws never see.
    expect(runExecStart(service, '[ "${BWS_ACCESS_TOKEN:-}" = stub ]').status).toBe(0)
  })

  // One collector run at a time (atto/6): the timer run and the trigger pick-up both read the
  // car and write state.json, so both units hold the same lock while node runs.
  it('runs the collector under the lock the trigger pick-up shares', () => {
    expect(runExecStart(service, 'if flock -n "$LOCK" true; then exit 1; fi').status).toBe(0)
  })

  it('puts ~/.local/bin on the PATH of the unit, so the collector finds bws (atto1/106)', () => {
    // A systemd user unit does not source a shell profile: without its own PATH, secrets.ts's
    // `bws` fails with `spawn bws ENOENT`. Resolve the unit's PATH with only its own
    // environment set, as systemd would, and look bws up on it.
    const assignment = live(service).match(/^Environment=(?:"PATH=([^"]*)"|PATH=(\S+))$/m)
    const unitPath = assignment?.[1] ?? assignment?.[2]
    expect(unitPath).toBeDefined()
    const home = mkdtempSync(join(tmpdir(), 'atto1-unit-path-'))
    stub(join(home, '.local/bin/bws'), 'echo found-bws')
    const result = spawnSync('/usr/bin/env', ['-i', `PATH=${(unitPath ?? '').replaceAll('%h', home)}`, 'bws'], {
      encoding: 'utf8',
    })
    expect(result.stdout.trim()).toBe('found-bws')
  })

  it('carries no secret and no credential name', () => {
    expect(live(service)).not.toMatch(/PASSWORD|SECRET=|CLIENT_ID=|BYD_USERNAME/)
  })

  it('polls every 30 minutes, no faster', () => {
    expect(live(timer)).toMatch(/OnCalendar=\*:00,30/)
    expect(live(timer)).toMatch(/WantedBy=timers.target/)
  })
})

describe('the trigger pick-up units (atto/6)', () => {
  const service = readFileSync(join(root, 'collector/systemd/atto1-collector-trigger.service'), 'utf8')
  const collector = readFileSync(join(root, 'collector/systemd/atto1-collector.service'), 'utf8')
  const timer = readFileSync(join(root, 'collector/systemd/atto1-collector-trigger.timer'), 'utf8')
  const live = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')

  it('runs collector/trigger.ts once, from the deploy copy', () => {
    expect(live(service)).toMatch(/Type=oneshot/)
    expect(live(service)).toMatch(/WorkingDirectory=%h\/repos\/atto1?$/m)
    expect(live(service)).toMatch(/collector\/trigger\.ts/)
    expect(live(service)).not.toMatch(/collector\/run\.ts/)
  })

  it('exports the Secrets Manager access token, as the collector unit does', () => {
    expect(runExecStart(service, '[ "${BWS_ACCESS_TOKEN:-}" = stub ]').status).toBe(0)
  })

  it('holds the same lock as the collector unit while it runs, so the two never read the car together', () => {
    expect(runExecStart(service, 'if flock -n "$LOCK" true; then exit 1; fi').status).toBe(0)
    const lockOf = (unit: string) => live(unit).match(/flock [^']*?(%t\/[\w.-]+)/)?.[1]
    expect(lockOf(service)).toBeDefined()
    expect(lockOf(service)).toBe(lockOf(collector))
  })

  it('waits for the lock for less time than the unit may run', () => {
    const wait = Number(live(service).match(/flock -w (\d+)/)?.[1])
    const timeout = Number(live(service).match(/TimeoutStartSec=(\d+)/)?.[1])
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThan(timeout)
  })

  it('shares the collector state directory and PATH, and carries no secret', () => {
    expect(live(service)).toMatch(/^StateDirectory=atto1-collector$/m)
    expect(live(service)).toMatch(/^Environment=PATH=%h\/\.local\/bin:/m)
    expect(live(service)).not.toMatch(/PASSWORD|SECRET=|CLIENT_ID=|BYD_USERNAME/)
  })

  it('is asked every minute, and only starts the car read when something is pending', () => {
    expect(live(timer)).toMatch(/OnCalendar=minutely/)
    expect(live(timer)).toMatch(/WantedBy=timers.target/)
    expect(live(timer)).toMatch(/^Persistent=false$/m)
  })
})

describe('the push listener unit (atto/8)', () => {
  const service = readFileSync(join(root, 'collector/systemd/atto1-collector-push.service'), 'utf8')
  const live = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')

  it('runs collector/push.ts and nothing else, from the deploy copy', () => {
    expect(live(service)).toMatch(/WorkingDirectory=%h\/repos\/atto1?$/m)
    expect(live(service)).toMatch(/collector\/push\.ts/)
    expect(live(service)).not.toMatch(/collector\/(run|trigger)\.ts/)
  })

  it('exports the Secrets Manager access token, as the other units do', () => {
    expect(runExecStart(service, '[ "${BWS_ACCESS_TOKEN:-}" = stub ]').status).toBe(0)
  })

  // The listener lives for hours: holding the collector lock for that long would starve the
  // timer and the pick-up. It takes the lock per run, inside push.ts.
  it('does not hold the collector lock while it listens', () => {
    expect(live(service)).not.toMatch(/flock/)
  })

  it('stays up, restarts slowly and stops restarting a refused login', () => {
    expect(live(service)).toMatch(/^Type=simple$/m)
    expect(live(service)).toMatch(/^Restart=always$/m)
    expect(Number(live(service).match(/^RestartSec=(\d+)/m)?.[1])).toBeGreaterThanOrEqual(300)
    expect(live(service)).toMatch(/^StartLimitBurst=\d+$/m)
    expect(live(service)).toMatch(/^StartLimitIntervalSec=\d+$/m)
  })

  it('renews its sign-in with a restart at least daily', () => {
    expect(Number(live(service).match(/^RuntimeMaxSec=(\d+)/m)?.[1])).toBeLessThanOrEqual(86_400)
  })

  it('shares the collector state directory and PATH, and carries no secret', () => {
    expect(live(service)).toMatch(/^StateDirectory=atto1-collector$/m)
    expect(live(service)).toMatch(/^Environment=PATH=%h\/\.local\/bin:/m)
    expect(live(service)).not.toMatch(/PASSWORD|SECRET=|CLIENT_ID=|BYD_USERNAME/)
  })
})

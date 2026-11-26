import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/install-homelab.sh runs on the homelab runner when `deploy` moves (install-homelab.yml,
// atto/18): it moves the collector checkout ~/repos/atto to the promoted SHA and links, reloads and
// starts every collector/systemd unit. These cases run it against throwaway repos with a local
// bare origin, a throwaway HOME and a stubbed systemctl, so nothing touches the real host.

const root = join(import.meta.dirname, '..')
const script = join(root, 'scripts/install-homelab.sh')
const guard = join(root, 'scripts/require-deploy-checkout.sh')
const realUnits = join(root, 'collector/systemd')

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

function commitAll(repo: string, message: string) {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', message])
  return git(repo, ['rev-parse', 'HEAD'])
}

const unitNames = readdirSync(realUnits).filter((name) => /\.(service|timer)$/.test(name))
const timers = unitNames.filter((name) => name.endsWith('.timer'))
const listener = 'atto1-collector-push.service'

type World = {
  home: string
  bin: string
  workspace: string
  host: string
  promoted: string
  before: string
  unitDir: string
  systemctlLog: string
}

// `workspace` is the runner's checkout of the pushed SHA (where the script runs from). `host` is
// ~/repos/atto, detached at the commit before it, so the promotion has to move it.
// `before` and `promoted` differ in collector/run.ts; `unitsChanged` also changes a unit file.
function makeWorld(options: { unitsChanged?: boolean; extraUnit?: boolean; collectorChanged?: boolean } = {}): World {
  const { unitsChanged = false, extraUnit = false, collectorChanged = true } = options
  const base = mkdtempSync(join(tmpdir(), 'atto1-install-homelab-'))
  const origin = join(base, 'origin.git')
  const workspace = join(base, 'workspace')
  const host = join(base, 'host')
  spawnSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin])
  spawnSync('git', ['init', '--quiet', '-b', 'main', workspace])
  git(workspace, ['remote', 'add', 'origin', origin])

  write(join(workspace, 'scripts/install-homelab.sh'), readFileSync(script, 'utf8'), 0o755)
  write(join(workspace, 'scripts/require-deploy-checkout.sh'), readFileSync(guard, 'utf8'), 0o755)
  for (const name of unitNames) write(join(workspace, 'collector/systemd', name), readFileSync(join(realUnits, name), 'utf8'))
  write(join(workspace, 'collector/run.ts'), '// before\n')
  const before = commitAll(workspace, 'before')
  git(workspace, ['push', '--quiet', 'origin', 'HEAD:main'])

  if (collectorChanged) write(join(workspace, 'collector/run.ts'), '// promoted\n')
  else write(join(workspace, 'README.md'), 'promoted\n')
  if (unitsChanged) write(join(workspace, 'collector/systemd', listener), `${readFileSync(join(realUnits, listener), 'utf8')}# changed\n`)
  if (extraUnit) {
    write(join(workspace, 'collector/systemd/atto1-collector-new.service'), '[Service]\nType=simple\nExecStart=/bin/true\n\n[Install]\nWantedBy=default.target\n')
  }
  const promoted = commitAll(workspace, 'promoted')
  git(workspace, ['push', '--quiet', 'origin', 'HEAD:refs/heads/deploy'])

  spawnSync('git', ['clone', '--quiet', origin, host])
  git(host, ['switch', '--quiet', '--detach', before])

  const home = join(base, 'home')
  const unitDir = join(home, '.config/systemd/user')
  write(join(unitDir, 'atto1-collector.service.d/collector.conf'), '[Service]\nEnvironment=ATTO1_PYTHON=/venv/bin/python\nEnvironment=ATTO1_BATTERY_KWH=30\n')
  write(join(home, '.bws_token'), 'BWS_ACCESS_TOKEN=stub\n')
  write(join(home, '.local/share/fnm/aliases/default/bin/node'), '#!/bin/sh\nexit 0\n', 0o755)
  const bin = join(home, 'stub-bin')
  const systemctlLog = join(base, 'systemctl.log')
  // is-active answers from $STUB_ACTIVE (default `active`); everything else succeeds and is logged.
  write(
    join(bin, 'systemctl'),
    `#!/bin/sh\necho "$*" >> "${systemctlLog}"\ncase "$*" in\n  *is-active*) echo "\${STUB_ACTIVE:-active}"; [ "\${STUB_ACTIVE:-active}" = active ];;\n  *is-enabled*) echo enabled;;\nesac\nexit 0\n`,
    0o755,
  )
  return { home, bin, workspace, host, promoted, before, unitDir, systemctlLog }
}

function run(world: World, args: string[] = [], env: Record<string, string> = {}, scriptDir = world.workspace) {
  const result = spawnSync('bash', [join(scriptDir, 'scripts/install-homelab.sh'), ...args], {
    cwd: scriptDir,
    encoding: 'utf8',
    env: {
      PATH: `${world.bin}:${process.env.PATH ?? ''}`,
      HOME: world.home,
      ATTO1_REPO: world.host,
      ARGUS_DEPLOY_LOCK: 'off',
      ...gitEnv,
      ...env,
    },
  })
  return { ...result, calls: existsSync(world.systemctlLog) ? readFileSync(world.systemctlLog, 'utf8').split('\n').filter(Boolean) : [] }
}

const failedChecks = (stderr: string) => stderr.split('\n').filter((line) => line.startsWith('pre-flight FAILED'))
const nothingInstalled = (world: World) => !existsSync(join(world.unitDir, listener))

describe('scripts/install-homelab.sh', () => {
  it('refuses an unknown argument', () => {
    const world = makeWorld()
    expect(run(world, ['--now']).status).toBe(2)
  })

  it('moves the collector checkout to the promoted SHA, detached and clean', () => {
    const world = makeWorld()
    const result = run(world)
    expect(result.stderr).not.toMatch(/FAILED|Refusing/)
    expect(result.status).toBe(0)
    expect(git(world.host, ['rev-parse', 'HEAD'])).toBe(world.promoted)
    expect(readFileSync(join(world.host, 'collector/run.ts'), 'utf8')).toBe('// promoted\n')
    expect(git(world.host, ['status', '--porcelain', '--untracked-files=no'])).toBe('')
  })

  // The gap atto/18 closed: a unit file added under collector/systemd was never installed unless
  // the owner ran a per-issue script. Every file there, a new one included, is linked now.
  it('links every unit in collector/systemd, a new one included, into the user unit dir', () => {
    const world = makeWorld({ extraUnit: true })
    const result = run(world)
    expect(result.status, result.stderr).toBe(0)
    const names = readdirSync(join(world.host, 'collector/systemd')).filter((name) => /\.(service|timer)$/.test(name))
    expect(names).toContain('atto1-collector-new.service')
    expect(names.length).toBeGreaterThanOrEqual(unitNames.length + 1)
    for (const name of names) {
      const link = join(world.unitDir, name)
      expect(lstatSync(link).isSymbolicLink(), name).toBe(true)
      expect(readlinkSync(link), name).toBe(join(world.host, 'collector/systemd', name))
    }
  })

  it("gives every service but the collector's own a copy of the collector's drop-in", () => {
    const world = makeWorld({ extraUnit: true })
    expect(run(world).status).toBe(0)
    const dropIn = readFileSync(join(world.unitDir, 'atto1-collector.service.d/collector.conf'), 'utf8')
    for (const name of unitNames.filter((unit) => unit.endsWith('.service') && unit !== 'atto1-collector.service').concat('atto1-collector-new.service')) {
      expect(readFileSync(join(world.unitDir, `${name}.d/collector.conf`), 'utf8'), name).toBe(dropIn)
    }
    expect(existsSync(join(world.unitDir, 'atto1-collector.timer.d'))).toBe(false)
  })

  it('reloads after linking, then enables every timer and the listener', () => {
    const world = makeWorld()
    const result = run(world, [], { STUB_ACTIVE: 'inactive' })
    expect(result.status, result.stderr).toBe(0)
    const reload = result.calls.indexOf('--user daemon-reload')
    expect(reload).toBeGreaterThanOrEqual(0)
    for (const timer of timers) {
      const enable = result.calls.indexOf(`--user enable --now ${timer}`)
      expect(enable, timer).toBeGreaterThan(reload)
    }
    expect(result.calls.indexOf(`--user enable ${listener}`)).toBeGreaterThan(reload)
    expect(result.calls).toContain(`--user start ${listener}`)
  })

  // A one-shot service is started by its timer. Starting it here would read the car.
  it('never starts or restarts a one-shot collector service', () => {
    const world = makeWorld()
    const result = run(world, [], { STUB_ACTIVE: 'inactive' })
    expect(result.status).toBe(0)
    for (const name of ['atto1-collector.service', 'atto1-collector-trigger.service']) {
      expect(result.calls.filter((call) => /\b(start|restart|enable)\b/.test(call) && call.includes(name)), name).toEqual([])
    }
  })

  it('restarts the running listener when collector code changed, so it runs the promoted code', () => {
    const world = makeWorld()
    const result = run(world, [], { STUB_ACTIVE: 'active' })
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`--user restart ${listener}`)
  })

  it('leaves the running listener alone when nothing under collector/ changed', () => {
    const world = makeWorld({ collectorChanged: false })
    const result = run(world, [], { STUB_ACTIVE: 'active' })
    expect(result.status).toBe(0)
    expect(result.calls.filter((call) => call.includes('restart'))).toEqual([])
  })

  // atto/26: a requested stop ends the listener `inactive` (push.ts exits 0 on SIGTERM), and an
  // install brings it back whatever the promotion changed, not only when collector code moved.
  it('starts a stopped listener even when nothing under collector/ changed', () => {
    const world = makeWorld({ collectorChanged: false })
    const result = run(world, [], { STUB_ACTIVE: 'inactive' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls).toContain(`--user start ${listener}`)
  })

  // docs/byd-collector.md: a login BYD keeps refusing stays down until the owner resets it.
  it('does not reset or restart a failed listener, and says so', () => {
    const world = makeWorld()
    const result = run(world, [], { STUB_ACTIVE: 'failed' })
    expect(result.status).toBe(0)
    expect(result.calls.filter((call) => /reset-failed|restart|start /.test(call) && call.includes(listener))).toEqual([])
    expect(`${result.stdout}${result.stderr}`).toMatch(new RegExp(`${listener}.*failed`))
  })

  it('is idempotent: a second run on the same SHA changes nothing and restarts nothing', () => {
    const world = makeWorld()
    expect(run(world).status).toBe(0)
    rmSync(world.systemctlLog)
    const second = run(world, [], { STUB_ACTIVE: 'active' })
    expect(second.status, second.stderr).toBe(0)
    expect(git(world.host, ['rev-parse', 'HEAD'])).toBe(world.promoted)
    expect(second.calls.filter((call) => call.includes('restart') && !call.includes('.timer'))).toEqual([])
  })

  it('refuses, changing nothing, when the collector checkout has uncommitted changes to tracked files', () => {
    const world = makeWorld()
    writeFileSync(join(world.host, 'collector/run.ts'), '// edited by hand\n')
    const result = run(world)
    expect(result.status).toBe(1)
    expect(failedChecks(result.stderr).join('\n')).toMatch(/uncommitted|clean/)
    expect(result.stderr).toMatch(/nothing was changed/)
    expect(git(world.host, ['rev-parse', 'HEAD'])).toBe(world.before)
    expect(nothingInstalled(world)).toBe(true)
  })

  it("refuses, changing nothing, when the collector's drop-in is missing (owner-steps/77.sh installs it)", () => {
    const world = makeWorld()
    rmSync(join(world.unitDir, 'atto1-collector.service.d/collector.conf'))
    const result = run(world)
    expect(result.status).toBe(1)
    expect(failedChecks(result.stderr)).toHaveLength(1)
    expect(result.stderr).toMatch(/collector\.conf/)
    expect(git(world.host, ['rev-parse', 'HEAD'])).toBe(world.before)
    expect(nothingInstalled(world)).toBe(true)
  })

  it('refuses when ~/.bws_token is missing', () => {
    const world = makeWorld()
    rmSync(join(world.home, '.bws_token'))
    const result = run(world)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/pre-flight FAILED: .*bws_token/)
    expect(nothingInstalled(world)).toBe(true)
  })

  it('refuses when the runner checkout is not what origin/deploy holds, because deploy moved on', () => {
    const world = makeWorld()
    git(world.workspace, ['commit', '--quiet', '--allow-empty', '-m', 'promoted later'])
    git(world.workspace, ['push', '--quiet', 'origin', 'HEAD:refs/heads/deploy'])
    git(world.workspace, ['reset', '--quiet', '--hard', world.promoted])
    const result = run(world)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Refusing to deploy/)
    expect(git(world.host, ['rev-parse', 'HEAD'])).toBe(world.before)
    expect(nothingInstalled(world)).toBe(true)
  })

  it('fails when the collector checkout is not at the promoted SHA afterwards', () => {
    const world = makeWorld()
    // A `git` that fetches but never switches: the final check must catch it.
    write(join(world.bin, 'git'), `#!/bin/sh\ncase "$*" in *" switch "*) exit 0;; esac\nexec ${spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()} "$@"\n`, 0o755)
    const result = run(world)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/not at/)
  })

  it('--dry-run prints every unit it would install and changes nothing', () => {
    const world = makeWorld({ extraUnit: true })
    const result = run(world, ['--dry-run'])
    expect(result.status, result.stderr).toBe(0)
    for (const name of [...unitNames, 'atto1-collector-new.service']) {
      expect(result.stdout, name).toMatch(new RegExp(`\\[dry-run\\] ln -sfn \\S*/${name} \\S*/${name}`))
    }
    expect(git(world.host, ['rev-parse', 'HEAD'])).toBe(world.before)
    expect(nothingInstalled(world)).toBe(true)
    expect(result.calls).toEqual([])
  })

  it('never promotes, pushes deploy or touches a secret store', () => {
    const code = readFileSync(script, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && !line.includes('echo'))
      .join('\n')
    expect(code).not.toMatch(/promote\.sh|git push|workflow run|\bbws\b|\bwrangler\b|reset-failed/)
  })
})

describe('.github/workflows/install-homelab.yml', () => {
  const text = readFileSync(join(root, '.github/workflows/install-homelab.yml'), 'utf8')
  const code = text.replace(/^\s*#.*$/gm, '')

  it('runs on a push to deploy or a manual dispatch, never on a pull request', () => {
    expect(code).toMatch(/^on:\n {2}push:\n {4}branches: \[deploy\]\n {2}workflow_dispatch:/m)
    expect(code).not.toMatch(/pull_request/)
  })

  it('runs on the homelab runner, only for the deploy branch', () => {
    expect(code).toMatch(/runs-on: \[self-hosted, homelab, deploy\]/)
    expect(code).toMatch(/if: github\.ref == 'refs\/heads\/deploy'/)
  })

  it('serialises runs, never cancelling one midway, and has read-only permissions', () => {
    expect(code).toMatch(/concurrency:\n {2}group: install-homelab-atto1\n {2}cancel-in-progress: false/)
    expect(code).toMatch(/permissions:\n {2}contents: read/)
  })

  it('holds no secret and runs scripts/install-homelab.sh from the pushed checkout', () => {
    expect(code).not.toMatch(/secrets\.|sm-action|CLOUDFLARE|wrangler/)
    expect(code).toMatch(/uses: actions\/checkout@/)
    expect(code).toMatch(/run: bash scripts\/install-homelab\.sh/)
  })
})

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/owner-steps/77.sh installs the BYD collector's timer on the homelab (atto1/77).
// Its first live run failed because python3 -m venv needs ensurepip, which the homelab lacks
// (atto1/95). These cases run it against a throwaway HOME with stub uv, node, bws, systemctl
// and a python3 that fails the way the homelab's does, so they prove which commands it would
// run and what it would leave behind, without touching a real venv, unit or timer.

const root = join(import.meta.dirname, '../..')
const script = join(root, 'scripts/owner-steps/77.sh')
const PYBYD = 'pybyd==0.0.80'

// Mirrors `uv venv`: an existing directory is an error unless --clear, and --clear empties it.
const uvStub = [
  '#!/bin/bash',
  'echo "uv $*" >> "$STUB_DIR/uv.log"',
  'case "$1 $2" in',
  '  "venv "*)',
  '    shift; clear=0; dir=""',
  '    while [ $# -gt 0 ]; do case "$1" in --clear) clear=1; shift ;; -*) shift ;; *) dir=$1; shift ;; esac; done',
  '    [ -z "${STUB_UV_VENV_FAIL:-}" ] || { echo "uv: simulated venv failure" >&2; exit 1; }',
  '    if [ -e "$dir" ] && [ "$clear" = 0 ]; then echo "uv: $dir already exists" >&2; exit 2; fi',
  '    rm -rf "$dir"; mkdir -p "$dir/bin"',
  '    printf \'#!/bin/bash\\nexit 0\\n\' > "$dir/bin/python"; chmod +x "$dir/bin/python"',
  '    echo "Creating virtual environment at: $dir" >&2 ;;',
  '  "pip install")',
  '    shift 2; py=""',
  '    while [ $# -gt 0 ]; do case "$1" in --python) py=$2; shift 2 ;; -*) shift ;; *) shift ;; esac; done',
  '    [ -x "$py" ] || { echo "uv: no interpreter at $py" >&2; exit 2; }',
  '    touch "$(dirname "$py")/pybyd-installed" ;;',
  '  *) echo "uv stub: unexpected $*" >&2; exit 9 ;;',
  'esac',
].join('\n')

const decoyUvStub = ['#!/bin/bash', 'echo "decoy uv" >> "$STUB_DIR/decoy.log"', 'exit 1'].join('\n')

// The homelab's python3 imports venv but cannot run ensurepip (atto1/95).
const python3Stub = [
  '#!/bin/bash',
  'echo "python3 $*" >> "$STUB_DIR/python3.log"',
  'echo "The virtual environment was not created successfully because ensurepip is not available." >&2',
  'exit 1',
].join('\n')

const nodeStub = ['#!/bin/bash', '[ -z "${STUB_NODE_OLD:-}" ]'].join('\n')
const loggingStub = (name: string, extra = '') =>
  ['#!/bin/bash', `echo "${name} $*" >> "$STUB_DIR/${name}.log"`, extra].join('\n')

function write(path: string, body: string, mode?: number) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${body}\n`)
  if (mode) chmodSync(path, mode)
}

type World = { uv?: boolean }

function world({ uv = true }: World = {}) {
  const stub = mkdtempSync(join(tmpdir(), 'atto1-77-'))
  const home = join(stub, 'home')
  const repo = join(stub, 'repo')
  const tmp = join(stub, 'tmp')
  const venv = join(home, '.local/share/atto1-collector/venv')
  const unitDir = join(home, '.config/systemd/user')
  mkdirSync(tmp)

  write(join(stub, 'bin/uv'), decoyUvStub, 0o755)
  write(join(stub, 'bin/python3'), python3Stub, 0o755)
  write(join(stub, 'bin/bws'), '#!/bin/bash\nexit 0', 0o755)
  write(join(stub, 'bin/systemctl'), loggingStub('systemctl', '[ "$2" = is-enabled ] && echo enabled; exit 0'), 0o755)
  if (uv) write(join(home, '.local/bin/uv'), uvStub, 0o755)
  write(join(home, '.local/share/fnm/aliases/default/bin/node'), nodeStub, 0o755)
  write(join(home, '.bws_token'), 'BWS_ACCESS_TOKEN=stub')

  const git = (...args: string[]) =>
    spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' })
  mkdirSync(join(repo, 'collector/systemd'), { recursive: true })
  git('init', '-q')
  write(join(repo, 'collector/systemd/atto1-collector.service'), '[Service]')
  write(join(repo, 'collector/systemd/atto1-collector.timer'), '[Timer]')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('update-ref', 'refs/remotes/origin/deploy', 'HEAD')

  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${join(stub, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: home,
        TMPDIR: tmp,
        STUB_DIR: stub,
        ATTO1_REPO: repo,
        ATTO1_BATTERY_KWH: '43.2',
        ...env,
      },
    })
    const read = (name: string) => (existsSync(join(stub, name)) ? readFileSync(join(stub, name), 'utf8').split('\n').filter(Boolean) : [])
    return { ...result, all: `${result.stdout}${result.stderr}`, uvCalls: read('uv.log'), systemctl: read('systemctl.log'), python3: read('python3.log'), decoy: read('decoy.log') }
  }
  return { run, stub, home, repo, tmp, venv, unitDir, git }
}

const uvPath = (home: string) => join(home, '.local/bin/uv')

describe('scripts/owner-steps/77.sh', () => {
  it('refuses an unknown argument', () => {
    expect(world().run(['--now']).status).toBe(2)
  })

  it('stops with nothing changed when uv is missing', () => {
    const w = world({ uv: false })
    const result = w.run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('pre-flight FAILED: uv is executable')
    expect(result.stderr).toContain('nothing was changed')
    expect(existsSync(w.venv)).toBe(false)
    expect(existsSync(w.unitDir)).toBe(false)
    expect(result.systemctl).toEqual([])
  })

  it('stops when the uv file is not executable', () => {
    const w = world()
    chmodSync(uvPath(w.home), 0o644)
    const result = w.run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('pre-flight FAILED: uv is executable')
    expect(existsSync(w.venv)).toBe(false)
  })

  it('stops with nothing changed when uv cannot make a venv, the check that import venv never made', () => {
    const w = world()
    const result = w.run([], { STUB_UV_VENV_FAIL: '1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('pre-flight FAILED: uv can make a venv')
    expect(result.stderr).toContain('nothing was changed')
    expect(existsSync(w.venv)).toBe(false)
    expect(existsSync(w.unitDir)).toBe(false)
    expect(result.systemctl).toEqual([])
  })

  it('proves the venv step in a scratch dir and removes it, so the pre-flight leaves nothing behind', () => {
    const w = world()
    const result = w.run(['--dry-run'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pre-flight ok: uv can make a venv')
    expect(result.uvCalls[0]).toMatch(/^uv venv --clear .*\/venv$/)
    expect(result.uvCalls[0]).not.toContain(w.venv)
    expect(readdirSync(w.tmp)).toEqual([])
  })

  it('--dry-run prints the uv commands and changes nothing', () => {
    const w = world()
    const result = w.run(['--dry-run'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`[dry-run] ${uvPath(w.home)} venv --clear ${w.venv}`)
    expect(result.stdout).toContain(`[dry-run] ${uvPath(w.home)} pip install --python ${w.venv}/bin/python ${PYBYD}`)
    expect(result.uvCalls.filter((call) => call.includes(w.venv))).toEqual([])
    expect(existsSync(w.venv)).toBe(false)
    expect(existsSync(w.unitDir)).toBe(false)
    expect(result.systemctl).toEqual([])
  })

  it('installs with uv by absolute path, never python3 -m venv, then links the units and enables the timer', () => {
    const w = world()
    const result = w.run()
    expect(result.status).toBe(0)
    expect(result.python3).toEqual([])
    expect(result.decoy).toEqual([])
    expect(result.uvCalls).toContain(`uv venv --clear ${w.venv}`)
    expect(result.uvCalls).toContain(`uv pip install --python ${w.venv}/bin/python ${PYBYD}`)
    expect(existsSync(join(w.venv, 'bin/pybyd-installed'))).toBe(true)
    expect(lstatSync(join(w.unitDir, 'atto1-collector.timer')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(w.unitDir, 'atto1-collector.service')).isSymbolicLink()).toBe(true)
    const dropin = readFileSync(join(w.unitDir, 'atto1-collector.service.d/collector.conf'), 'utf8')
    expect(dropin).toContain(`Environment=ATTO1_PYTHON=${w.venv}/bin/python`)
    expect(dropin).toContain('Environment=ATTO1_BATTERY_KWH=43.2')
    expect(result.systemctl).toContain('systemctl --user enable --now atto1-collector.timer')
  })

  it('re-runs over the broken venv a failed run left (python symlink only, no pip)', () => {
    const w = world()
    mkdirSync(join(w.venv, 'bin'), { recursive: true })
    symlinkSync('/usr/bin/python3', join(w.venv, 'bin/python'))
    writeFileSync(join(w.venv, 'pyvenv.cfg'), 'home = /usr/bin\n')
    const result = w.run()
    expect(result.status).toBe(0)
    expect(result.python3).toEqual([])
    expect(lstatSync(join(w.venv, 'bin/python')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(w.venv, 'bin/pybyd-installed'))).toBe(true)
  })

  it('is safe to run twice: the second run clears the first venv and reinstalls', () => {
    const w = world()
    expect(w.run().status).toBe(0)
    const second = w.run()
    expect(second.status).toBe(0)
    expect(second.uvCalls.filter((call) => call === `uv venv --clear ${w.venv}`)).toHaveLength(2)
    expect(existsSync(join(w.venv, 'bin/pybyd-installed'))).toBe(true)
  })

  it('still fails the node pre-flight before touching anything', () => {
    const w = world()
    const result = w.run([], { STUB_NODE_OLD: '1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('pre-flight FAILED: node 22.18 or newer')
    expect(existsSync(w.venv)).toBe(false)
  })
})

// pybyd 0.0.80 is the first release that declares a guest account (a car shared to the second
// BYD account) on the requests that reach the car. BYD answers code 1001 to a guest that does
// not, so a pin below it reads the car as "not supported" (atto/3). Every place that names the
// pin must agree, or the runbook installs one version and the audit command runs another.
describe('the pybyd pin', () => {
  const pins = (file: string) =>
    [...readFileSync(join(root, file), 'utf8').matchAll(/pybyd==(\d+)\.(\d+)\.(\d+)/g)].map((match) => match[0])

  it('is at or above the first release that declares a guest account', () => {
    const [major, minor, patch] = PYBYD.replace('pybyd==', '').split('.').map(Number)
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(80)
  })

  it.each([
    'scripts/owner-steps/77.sh',
    'docs/byd-collector.md',
    'docs/decisions/adr-006-read-only-byd-import-via-second-account.md',
  ])('is the same in %s', (file) => {
    const found = pins(file)
    expect(found.length).toBeGreaterThan(0)
    expect(new Set(found)).toEqual(new Set([PYBYD]))
  })
})

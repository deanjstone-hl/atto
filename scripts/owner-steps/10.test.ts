import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/owner-steps/10.sh is run live by the owner (atto/10). These cases run it against stub
// bws, bw and gh programs that serve canned Secrets Manager and GitHub state and log every call,
// so they prove what it would move, create and delete without touching either service. The
// script needs jq; a host without it skips the file rather than failing the deploy Test step
// (atto1/85), and main CI runs it.

const root = join(import.meta.dirname, '../..')
const script = join(root, 'scripts/owner-steps/10.sh')
const hasJq = spawnSync('jq', ['--version']).status === 0

const SOURCE = 'proj-personal'
const ACTIONS = 'proj-actions'
const API_TOKEN_VALUE = 'cloudflare-api-token-VALUE'
const ACCOUNT_ID_VALUE = 'cloudflare-account-id-VALUE'
const WORKER_VALUE = 'worker-value-VALUE'
const SCOPED_TOKEN = 'scoped-token-VALUE'
const OWNER_TOKEN = 'owner-token-VALUE'
const secretValues = [API_TOKEN_VALUE, ACCOUNT_ID_VALUE, WORKER_VALUE, SCOPED_TOKEN, OWNER_TOKEN]

// The map deploy.yml hands to sm-action is the source of truth for the ids: read it the way the
// script does, so the world holds exactly the ids the workflow asks for.
const workflowText = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8')
const workerSecrets = [...workflowText.matchAll(/^\s+([0-9a-f-]{36}) > ([A-Z0-9_]+)\s*$/gm)].map((match) => ({ id: match[1], key: match[2] }))
const CF_TOKEN = { key: 'ATTO_CLOUDFLARE_API_TOKEN', source: 'ci-deploy-atto1', id: 'id-cf-token', sourceId: 'id-ci-deploy' }
const CF_ACCOUNT = { key: 'ATTO_CLOUDFLARE_ACCOUNT_ID', source: 'ARGUS_CLOUDFLARE_ACCOUNT_ID', id: 'id-cf-account', sourceId: 'id-argus-account' }
const OLD_NAMES = [...workerSecrets.map((secret) => secret.key), 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']

const bwsStub = [
  '#!/bin/bash',
  '[ -n "${BWS_ACCESS_TOKEN:-}" ] || { echo "Missing access token" >&2; exit 1; }',
  'scoped=0; [ "$BWS_ACCESS_TOKEN" = "' + SCOPED_TOKEN + '" ] && scoped=1',
  'sub="$1 $2"; shift 2',
  'list="$STUB_DIR/bws_list.json"',
  '[ -f "$STUB_DIR/written" ] && [ -f "$STUB_DIR/bws_list.after.json" ] && list="$STUB_DIR/bws_list.after.json"',
  // A token scoped to the actions project sees only that project, unless the stub is told to leak.
  'view() { if [ "$scoped" = 1 ] && [ -z "${STUB_SCOPE_LEAK:-}" ]; then jq -c --arg p "' + ACTIONS + '" "[.[] | select(.projectId == \\$p)]" "$list"; else cat "$list"; fi; }',
  'case "$sub" in',
  '  "secret list") view ;;',
  '  "project list") cat "$STUB_DIR/bws_projects.json" ;;',
  '  "secret get")',
  '    id=""; while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; *) id="$1"; shift ;; esac; done',
  '    out=$(view | jq -c --arg i "$id" ".[] | select(.id == \\$i)"); [ -n "$out" ] || { echo "bws: not found" >&2; exit 1; }; echo "$out" ;;',
  '  "secret create")',
  '    pos=(); while [ $# -gt 0 ]; do case "$1" in --note|-o) shift 2 ;; *) pos+=("$1"); shift ;; esac; done',
  '    [ -n "${STUB_BWS_FAIL:-}" ] && { echo "bws: simulated failure" >&2; exit 1; }',
  '    echo "bws create ${pos[0]} project=${pos[2]}" >> "$STUB_DIR/calls.log"; echo "${pos[1]}" >> "$STUB_DIR/bws.values"',
  '    touch "$STUB_DIR/written" ;;',
  '  "secret edit")',
  '    id=""; project=""; while [ $# -gt 0 ]; do case "$1" in --project-id) project=$2; shift 2 ;; --value|--key|--note|-o) shift 2 ;; *) id="$1"; shift ;; esac; done',
  '    [ -n "${STUB_BWS_FAIL:-}" ] && { echo "bws: simulated failure" >&2; exit 1; }',
  '    echo "bws move $id project=$project" >> "$STUB_DIR/calls.log"; touch "$STUB_DIR/written" ;;',
  '  *) echo "bws stub: unexpected $sub" >&2; exit 9 ;;',
  'esac',
].join('\n')

const bwStub = [
  '#!/bin/bash',
  'case "$1" in',
  '  sync) echo "bw sync" >> "$STUB_DIR/calls.log"; echo "Syncing complete." ;;',
  '  get) echo "bw get $2 $3" >> "$STUB_DIR/calls.log"; [ -z "${STUB_BW_FAIL:-}" ] || exit 1; echo ' + SCOPED_TOKEN + ' ;;',
  '  *) echo "bw stub: unexpected $1" >&2; exit 9 ;;',
  'esac',
].join('\n')

const ghStub = [
  '#!/bin/bash',
  'echo "gh $*" >> "$STUB_DIR/gh.log"',
  'case "$1 $2" in',
  '  "run list") cat "$STUB_DIR/run_list.json" ;;',
  '  "secret list") cat "$STUB_DIR/actions_secrets.txt" ;;',
  '  "secret delete")',
  '    name="$3"; echo "gh delete $name" >> "$STUB_DIR/calls.log"',
  '    grep -vx "$name" "$STUB_DIR/actions_secrets.txt" > "$STUB_DIR/actions_secrets.tmp"; mv "$STUB_DIR/actions_secrets.tmp" "$STUB_DIR/actions_secrets.txt" ;;',
  '  "api "*|"api repos/"*) cat "$STUB_DIR/workflow_at_sha.yml" ;;',
  '  *) echo "gh stub: unexpected $*" >&2; exit 9 ;;',
  'esac',
].join('\n')

function write(path: string, body: string | object, mode?: number) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? `${body}\n` : `${JSON.stringify(body)}\n`)
  if (mode) chmodSync(path, mode)
}

type Where = 'source' | 'actions'
type State = {
  worker?: Where | Partial<Record<string, Where>>
  cf?: Where | 'absent'
  missingWorker?: string[]
  hasCfSources?: boolean
}

const listFor = ({ worker = 'source', cf = 'absent', missingWorker = [], hasCfSources = true }: State) => {
  const project = (where: Where) => (where === 'actions' ? ACTIONS : SOURCE)
  const items: { id: string; key: string; value: string; projectId: string }[] = [
    { id: 'id-admin', key: 'CLOUDFLARE-TOKEN-ADMIN', value: OWNER_TOKEN, projectId: SOURCE },
  ]
  if (hasCfSources) {
    items.push(
      { id: CF_TOKEN.sourceId, key: CF_TOKEN.source, value: API_TOKEN_VALUE, projectId: SOURCE },
      { id: CF_ACCOUNT.sourceId, key: CF_ACCOUNT.source, value: ACCOUNT_ID_VALUE, projectId: SOURCE },
    )
  }
  for (const secret of workerSecrets) {
    if (missingWorker.includes(secret.key)) continue
    const where = typeof worker === 'string' ? worker : (worker[secret.key] ?? 'source')
    items.push({ id: secret.id, key: secret.key, value: WORKER_VALUE, projectId: project(where) })
  }
  if (cf !== 'absent') {
    items.push(
      { id: CF_TOKEN.id, key: CF_TOKEN.key, value: API_TOKEN_VALUE, projectId: project(cf) },
      { id: CF_ACCOUNT.id, key: CF_ACCOUNT.key, value: ACCOUNT_ID_VALUE, projectId: project(cf) },
    )
  }
  return items
}

function world(before: State, after?: State) {
  const stub = mkdtempSync(join(tmpdir(), 'atto-10-'))
  const home = join(stub, 'home')
  write(join(stub, 'bin/bws'), bwsStub, 0o755)
  write(join(stub, 'bin/bw'), bwStub, 0o755)
  write(join(stub, 'bin/gh'), ghStub, 0o755)
  write(join(stub, 'bitwarden.sh'), 'bitwarden-session() { echo stub-session; }')
  write(join(home, '.bws_token'), `BWS_ACCESS_TOKEN=${OWNER_TOKEN}`)
  write(join(home, '.bw_master'), 'stub-master')
  write(join(stub, 'bws_projects.json'), [
    { id: SOURCE, name: 'personal-machine-secrets' },
    { id: ACTIONS, name: 'actions' },
  ])
  write(join(stub, 'bws_list.json'), listFor(before))
  if (after) write(join(stub, 'bws_list.after.json'), listFor(after))
  write(join(stub, 'actions_secrets.txt'), [...OLD_NAMES, 'BWS_ACCESS_TOKEN'].join('\n'))
  write(join(stub, 'run_list.json'), [{ conclusion: 'success', headSha: 'abc123', databaseId: 42 }])
  write(join(stub, 'workflow_at_sha.yml'), workflowText)

  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${join(stub, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: home,
        STUB_DIR: stub,
        ATTO_BW_HELPER: join(stub, 'bitwarden.sh'),
        ...env,
      },
    })
    const read = (name: string) => (existsSync(join(stub, name)) ? readFileSync(join(stub, name), 'utf8') : '')
    return {
      ...result,
      all: `${result.stdout}${result.stderr}`,
      calls: read('calls.log').split('\n').filter(Boolean),
      ghLog: read('gh.log').split('\n').filter(Boolean),
      remaining: read('actions_secrets.txt').split('\n').filter(Boolean),
    }
  }
  return { run, stub }
}

const allActions: State = { worker: 'actions', cf: 'actions' }
const writes = (calls: string[]) => calls.filter((call) => /^bws (create|move)|^gh delete/.test(call))
const noSecretPrinted = (all: string) => {
  for (const value of secretValues) expect(all).not.toContain(value)
}

describe.skipIf(!hasJq)('scripts/owner-steps/10.sh', () => {
  it('reads the six ids from deploy.yml, which the tests rely on', () => {
    expect(workerSecrets.map((secret) => secret.key).sort()).toEqual([
      'ATTO_ACCESS_AUD',
      'ATTO_ACCESS_TEAM_DOMAIN',
      'ATTO_D1_DATABASE_ID',
      'ATTO_INGEST_CLIENT_ID',
      'ATTO_INGEST_OWNER_SUBJECT',
      'ATTO_TRIGGER_CLIENT_ID',
    ])
  })

  it('refuses an unknown argument and both modes at once', () => {
    expect(world({}).run(['--now']).status).toBe(2)
    expect(world({}).run(['--delete-actions-secrets', '--dry-run', '--extra']).status).toBe(2)
  })

  describe('moving the keys to the actions project', () => {
    it('stops, changing nothing, when the Secrets Manager token file is missing', () => {
      const { run, stub } = world({})
      spawnSync('rm', [join(stub, 'home/.bws_token')])
      const result = run(['--dry-run'])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/pre-flight FAILED: .*\.bws_token exists/)
      expect(result.stderr).toMatch(/nothing was changed/)
    })

    it('stops before any change when an id in deploy.yml has no secret behind it', () => {
      const missing = workerSecrets[0].key
      const result = world({ missingWorker: [missing] }).run([])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(new RegExp(`pre-flight FAILED: .*${missing}`))
      expect(writes(result.calls)).toEqual([])
    })

    it('stops before any change when a key sits in neither project', () => {
      const result = world({ worker: 'source', cf: 'absent', hasCfSources: false }).run([])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/pre-flight FAILED: .*ATTO_CLOUDFLARE_API_TOKEN/)
      expect(writes(result.calls)).toEqual([])
    })

    it('--dry-run prints every action, reads state, and writes nothing', () => {
      const result = world({}).run(['--dry-run'])
      expect(result.status).toBe(0)
      expect(writes(result.calls)).toEqual([])
      for (const { key, id } of workerSecrets) {
        expect(result.stdout).toMatch(new RegExp(`\\[dry-run\\] .*move ${key} \\(${id}\\).*personal-machine-secrets.*actions`))
      }
      expect(result.stdout).toMatch(/\[dry-run\] .*create ATTO_CLOUDFLARE_API_TOKEN in actions from ci-deploy-atto1/)
      expect(result.stdout).toMatch(/\[dry-run\] .*create ATTO_CLOUDFLARE_ACCOUNT_ID in actions from ARGUS_CLOUDFLARE_ACCOUNT_ID/)
      noSecretPrinted(result.all)
    })

    it('moves the six keys by id into actions, creates the two Cloudflare keys there, and prints no value', () => {
      const { run, stub } = world({}, allActions)
      const result = run([])
      expect(result.stderr).not.toMatch(/FAILED|error/i)
      expect(result.status).toBe(0)
      for (const { id } of workerSecrets) expect(result.calls).toContain(`bws move ${id} project=${ACTIONS}`)
      expect(result.calls).toContain(`bws create ${CF_TOKEN.key} project=${ACTIONS}`)
      expect(result.calls).toContain(`bws create ${CF_ACCOUNT.key} project=${ACTIONS}`)
      expect(readFileSync(join(stub, 'bws.values'), 'utf8').split('\n').filter(Boolean)).toEqual([API_TOKEN_VALUE, ACCOUNT_ID_VALUE])
      expect(result.stdout).toMatch(/verify ok: the six deploy\.yml ids are in actions/)
      noSecretPrinted(result.all)
    })

    it('prints the ids of the two new Cloudflare secrets, for the workflow change that follows', () => {
      const result = world({}, allActions).run([])
      expect(result.stdout).toContain(`${CF_TOKEN.id} > ATTO_CLOUDFLARE_API_TOKEN`)
      expect(result.stdout).toContain(`${CF_ACCOUNT.id} > ATTO_CLOUDFLARE_ACCOUNT_ID`)
    })

    it('is read-only when everything is already in place', () => {
      const result = world(allActions).run([])
      expect(result.status).toBe(0)
      expect(writes(result.calls)).toEqual([])
      expect(result.stdout).toMatch(/nothing to change/)
    })

    it('moves only the keys not yet in actions, and does not recreate a Cloudflare key that exists', () => {
      const first = workerSecrets[0]
      const partial: State = { worker: Object.fromEntries(workerSecrets.slice(1).map((secret) => [secret.key, 'actions' as Where])), cf: 'actions' }
      const result = world(partial, allActions).run([])
      expect(result.status).toBe(0)
      expect(writes(result.calls)).toEqual([`bws move ${first.id} project=${ACTIONS}`])
    })

    it('fails, naming the key, when a move or create cannot be done, and goes on to no later step', () => {
      const result = world({}, allActions).run([], { STUB_BWS_FAIL: '1' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/error: could not move/)
      noSecretPrinted(result.all)
    })

    it('fails the verify block when a key is still outside actions after the run', () => {
      const result = world({}, { worker: 'source', cf: 'actions' }).run([])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/verify FAILED: the six deploy\.yml ids are in actions/)
    })

    describe('with a token scoped to the actions project', () => {
      const withItem = { ATTO_ACTIONS_READ_BW_ITEM: 'the actions-read token' }

      it('says the scoped read was not checked, and passes, when no vault item is named', () => {
        const result = world({}, allActions).run([])
        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/verify skipped: the actions-scoped read/)
      })

      it('reads each key by id with it, and checks it cannot see another project', () => {
        const result = world({}, allActions).run([], withItem)
        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/verify ok: the actions-read token reads all 8 keys of actions by id/)
        expect(result.stdout).toMatch(/verify ok: the actions-read token sees no key outside actions/)
        noSecretPrinted(result.all)
      })

      it('fails when the token can read outside actions', () => {
        const result = world({}, allActions).run([], { ...withItem, STUB_SCOPE_LEAK: '1' })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/verify FAILED: the actions-read token sees no key outside actions/)
      })

      it('fails when the named vault item cannot be read', () => {
        const result = world({}, allActions).run([], { ...withItem, STUB_BW_FAIL: '1' })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/FAILED: .*vault item/)
      })
    })

    it('never promotes or pushes deploy', () => {
      const code = readFileSync(script, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
      expect(code).not.toMatch(/promote\.sh|git push|workflow run/)
    })
  })

  describe('--delete-actions-secrets, after a green deploy on the new path', () => {
    const del = ['--delete-actions-secrets']
    const worker = workerSecrets.map((secret) => secret.key)

    it('deletes the six Worker secrets the green workflow no longer reads, and keeps the Cloudflare pair and BWS_ACCESS_TOKEN', () => {
      const result = world(allActions).run(del)
      expect(result.stderr).not.toMatch(/FAILED|error/i)
      expect(result.status).toBe(0)
      expect(result.calls.filter((call) => call.startsWith('gh delete')).sort()).toEqual(worker.map((name) => `gh delete ${name}`).sort())
      expect(result.remaining.sort()).toEqual(['BWS_ACCESS_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'])
      expect(result.stdout).toMatch(/verify ok: BWS_ACCESS_TOKEN is still set/)
    })

    it('also deletes a Cloudflare secret once the green workflow no longer reads it', () => {
      const { run, stub } = world(allActions)
      writeFileSync(join(stub, 'workflow_at_sha.yml'), workflowText.replaceAll('secrets.CLOUDFLARE_', 'steps.sm.outputs.CF_'))
      const result = run(del)
      expect(result.status).toBe(0)
      expect(result.remaining).toEqual(['BWS_ACCESS_TOKEN'])
    })

    it('reads the workflow at the green run SHA, on the deploy branch', () => {
      const result = world(allActions).run(del)
      expect(result.ghLog.find((line) => line.startsWith('gh run list'))).toMatch(/--branch deploy/)
      expect(result.ghLog.find((line) => line.startsWith('gh api'))).toContain('ref=abc123')
    })

    it('deletes nothing when the latest deploy run is not green', () => {
      const { run, stub } = world(allActions)
      write(join(stub, 'run_list.json'), [{ conclusion: 'failure', headSha: 'abc123', databaseId: 42 }])
      const result = run(del)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/pre-flight FAILED: .*latest Deploy run on deploy/)
      expect(writes(result.calls)).toEqual([])
    })

    it('deletes nothing when there is no deploy run at all', () => {
      const { run, stub } = world(allActions)
      write(join(stub, 'run_list.json'), [])
      const result = run(del)
      expect(result.status).toBe(1)
      expect(writes(result.calls)).toEqual([])
    })

    it('deletes nothing when the green run was on the old path, without sm-action', () => {
      const { run, stub } = world(allActions)
      writeFileSync(join(stub, 'workflow_at_sha.yml'), workflowText.replaceAll('bitwarden/sm-action', 'actions/checkout'))
      const result = run(del)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/pre-flight FAILED: .*sm-action/)
      expect(writes(result.calls)).toEqual([])
    })

    it('deletes nothing when BWS_ACCESS_TOKEN is not set, since the deploy could not have used it', () => {
      const { run, stub } = world(allActions)
      write(join(stub, 'actions_secrets.txt'), OLD_NAMES.join('\n'))
      const result = run(del)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/pre-flight FAILED: .*BWS_ACCESS_TOKEN/)
      expect(writes(result.calls)).toEqual([])
    })

    it('--dry-run lists what it would delete and deletes nothing', () => {
      const result = world(allActions).run([...del, '--dry-run'])
      expect(result.status).toBe(0)
      expect(writes(result.calls)).toEqual([])
      for (const name of worker) expect(result.stdout).toMatch(new RegExp(`\\[dry-run\\] .*delete Actions secret ${name}\\b`))
      expect(result.stdout).toMatch(/keep CLOUDFLARE_API_TOKEN: .*still reads it/)
    })

    it('is read-only when the secrets are already gone', () => {
      const { run, stub } = world(allActions)
      write(join(stub, 'actions_secrets.txt'), ['BWS_ACCESS_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].join('\n'))
      const result = run(del)
      expect(result.status).toBe(0)
      expect(writes(result.calls)).toEqual([])
      expect(result.stdout).toMatch(/nothing to delete/)
    })
  })
})

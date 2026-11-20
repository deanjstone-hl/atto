import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/owner-steps/7.sh is run live by the owner (atto/7). These cases run it against stub
// curl, bws, bw and gh programs that serve canned Cloudflare, Secrets Manager and GitHub state
// and log every call, so they prove what it would send and write without touching any of them.
// The script needs jq; a host without it skips the file, and main CI runs it.

const root = join(import.meta.dirname, '../..')
const script = join(root, 'scripts/owner-steps/7.sh')
const hasJq = spawnSync('jq', ['--version']).status === 0

const ADMIN = 'admin-token-VALUE'
const READ = 'read-token-VALUE'
const TEMP = 'tmp-token-VALUE'
const CLIENT_ID = 'phone-client-VALUE.access'
const PHONE_SECRET = 'phone-secret-VALUE'
const secretValues = [ADMIN, READ, TEMP, PHONE_SECRET]
const ACCOUNT = '/accounts/acct123'
const KEY = 'ATTO_TRIGGER_CLIENT_ID'

const curlStub = [
  '#!/bin/bash',
  'argv="$*"; method=GET; url=""; fmt=""; auth=0',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -X) method=$2; shift 2 ;;',
  '    -w) fmt=$2; shift 2 ;;',
  '    -o|-H|-d) shift 2 ;;',
  '    -K) auth=1; shift 2 ;;',
  '    -*) shift ;;',
  '    *) url=$1; shift ;;',
  '  esac',
  'done',
  'config=""; [ "$auth" = 1 ] && config=$(cat)',
  'echo "curl $method $url" >> "$STUB_DIR/calls.log"',
  'echo "$argv" >> "$STUB_DIR/curl.argv"',
  'if [ -n "$fmt" ]; then',
  '  code=302; redirect="https://team.cloudflareaccess.com/login"',
  '  case "$config" in *CF-Access-Client-Id*) code=${STUB_SERVICE_TOKEN_STATUS:-403}; redirect="" ;; esac',
  "  out=${fmt//'%{http_code}'/$code}; out=${out//'%{redirect_url}'/$redirect}",
  "  printf '%s' \"$out\"; exit 0",
  'fi',
  'path=${url#*/client/v4}',
  "key=$(printf '%s_%s' \"$method\" \"$path\" | tr -c 'A-Za-z0-9\\n' '_')",
  "token=$(sed -n 's/.*Bearer \\(.*\\)\"$/\\1/p' <<< \"$config\")",
  'echo "$method $path $token" >> "$STUB_DIR/auth.log"',
  'unauthorized=\'{"success":false,"errors":[{"message":"Unauthorized to access requested resource"}],"result":null}\'',
  'case "$key" in',
  // Cloudflare answers a token revoking itself with Unauthorized; only the minting token may.
  '  DELETE__user_tokens_*)',
  '    if [ -n "${STUB_REVOKE_FAIL:-}" ] || [ "$token" != "' + ADMIN + '" ]; then echo "$unauthorized"; exit 0; fi ;;',
  '  POST__user_tokens) ;;',
  '  POST_*|PUT_*|DELETE_*) touch "$STUB_DIR/written" ;;',
  'esac',
  // A fixture can differ by who is asking: `.temp` is what the minted token sees, which can
  // list service tokens; the read token sees an empty list (a blind read).
  'as=""; case "$config" in *' + TEMP + '*) as=".temp" ;; esac',
  'file=""',
  'for candidate in "$key$as.after" "$key$as" "$key.after" "$key"; do',
  '  [ -f "$STUB_DIR/fixtures/$candidate.json" ] || continue',
  '  case "$candidate" in *.after) [ -f "$STUB_DIR/written" ] || continue ;; esac',
  '  file="$STUB_DIR/fixtures/$candidate.json"; break',
  'done',
  'if [ -n "$file" ]; then cat "$file"; else echo \'{"success":true,"result":[]}\'; fi',
].join('\n')

const bwsStub = [
  '#!/bin/bash',
  '[ -n "${BWS_ACCESS_TOKEN:-}" ] || { echo "Missing access token" >&2; exit 1; }',
  'sub="$1 $2"; shift 2',
  'list="$STUB_DIR/bws_list.json"',
  '[ -f "$STUB_DIR/written" ] && [ -f "$STUB_DIR/bws_list.after.json" ] && list="$STUB_DIR/bws_list.after.json"',
  'case "$sub" in',
  '  "secret list") cat "$list" ;;',
  '  "project list") cat "$STUB_DIR/bws_projects.json" ;;',
  '  "secret create")',
  '    pos=(); while [ $# -gt 0 ]; do case "$1" in --note|-o) shift 2 ;; *) pos+=("$1"); shift ;; esac; done',
  '    [ -n "${STUB_BWS_FAIL:-}" ] && { echo "bws: simulated failure" >&2; exit 1; }',
  '    echo "bws create ${pos[0]} project=${pos[2]}" >> "$STUB_DIR/calls.log"; echo "${pos[1]}" >> "$STUB_DIR/bws.values"',
  '    touch "$STUB_DIR/written" ;;',
  '  "secret edit")',
  '    id=""; while [ $# -gt 0 ]; do case "$1" in --value|-o) shift 2 ;; *) id="$1"; shift ;; esac; done',
  '    [ -n "${STUB_BWS_FAIL:-}" ] && { echo "bws: simulated failure" >&2; exit 1; }',
  '    echo "bws edit $id" >> "$STUB_DIR/calls.log"; touch "$STUB_DIR/written" ;;',
  '  *) echo "bws stub: unexpected $sub" >&2; exit 9 ;;',
  'esac',
].join('\n')

const bwStub = [
  '#!/bin/bash',
  'case "$1" in',
  '  sync) echo "bw sync" >> "$STUB_DIR/calls.log"; echo "Syncing complete." ;;',
  '  get) echo "bw get $2" >> "$STUB_DIR/calls.log"',
  '    [ -n "${STUB_BW_EMPTY:-}" ] && exit 1',
  '    if [ "$2" = username ]; then echo ' + CLIENT_ID + '; else echo ' + PHONE_SECRET + '; fi ;;',
  '  *) echo "bw stub: unexpected $1" >&2; exit 9 ;;',
  'esac',
].join('\n')

// gh: `auth status`, `secret list` (from a fixture, which differs after a write) and
// `secret set`, whose value must arrive on stdin and is logged to a file.
const ghStub = [
  '#!/bin/bash',
  'echo "gh $*" >> "$STUB_DIR/gh.argv"',
  'case "$1 $2" in',
  '  "auth status") [ -z "${STUB_GH_NOAUTH:-}" ] || exit 1 ;;',
  '  "secret list")',
  '    echo "gh secret list" >> "$STUB_DIR/calls.log"',
  '    f="$STUB_DIR/gh_secrets.json"; [ -f "$STUB_DIR/gh_written" ] && [ -f "$STUB_DIR/gh_secrets.after.json" ] && f="$STUB_DIR/gh_secrets.after.json"',
  '    cat "$f" ;;',
  '  "secret set")',
  '    [ -n "${STUB_GH_FAIL:-}" ] && { echo "gh: simulated failure" >&2; exit 1; }',
  '    echo "gh secret set $3" >> "$STUB_DIR/calls.log"; cat > "$STUB_DIR/gh.stdin"; touch "$STUB_DIR/gh_written" ;;',
  '  *) echo "gh stub: unexpected $*" >&2; exit 9 ;;',
  'esac',
].join('\n')

type Present = { token?: boolean; policy?: boolean; bws?: boolean; actions?: boolean; wrongClientId?: boolean }

function write(path: string, body: string | object, mode?: number) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? `${body}\n` : `${JSON.stringify(body)}\n`)
  if (mode) chmodSync(path, mode)
}

const ok = (result: unknown) => ({ success: true, errors: [], result })

// The read token (CLOUDFLARE-TOKEN-ACCESS) lists no service tokens (atto1/91): only the minted
// token sees them, so the token fixtures are keyed `.temp`.
function world(before: Present, after?: Present) {
  const stub = mkdtempSync(join(tmpdir(), 'atto-7-'))
  const home = join(stub, 'home')
  const fixtures = join(stub, 'fixtures')
  const key = (method: string, path: string, suffix = '') =>
    join(fixtures, `${`${method}_${ACCOUNT}${path}`.replace(/[^A-Za-z0-9]/g, '_')}${suffix}.json`)
  const userKey = (method: string, path: string) => join(fixtures, `${`${method}_${path}`.replace(/[^A-Za-z0-9]/g, '_')}.json`)

  write(join(stub, 'bin/curl'), curlStub, 0o755)
  write(join(stub, 'bin/bws'), bwsStub, 0o755)
  write(join(stub, 'bin/bw'), bwStub, 0o755)
  write(join(stub, 'bin/gh'), ghStub, 0o755)
  write(join(stub, 'bitwarden.sh'), 'bitwarden-session() { echo stub-session; }')
  write(join(home, '.bws_token'), 'BWS_ACCESS_TOKEN=stub-bws-token')
  write(join(home, '.bw_master'), 'stub-master')
  write(join(stub, 'bws_projects.json'), [{ id: 'proj-1', name: 'personal-machine-secrets' }])

  const tunnel = Buffer.from(JSON.stringify({ a: 'acct123', t: 'tun123' })).toString('base64')
  const bwsList = (present: Present) => [
    { id: 's-admin', key: 'CLOUDFLARE-TOKEN-ADMIN', value: ADMIN, projectId: 'proj-1' },
    { id: 's-access', key: 'CLOUDFLARE-TOKEN-ACCESS', value: READ, projectId: 'proj-1' },
    { id: 's-tunnel', key: 'homelab-cloudflared-tunnel-token', value: tunnel, projectId: 'proj-1' },
    ...(present.bws ? [{ id: 'id-trigger', key: KEY, value: present.wrongClientId ? 'stale.access' : CLIENT_ID, projectId: 'proj-1' }] : []),
  ]
  const tokens = (present: Present) =>
    present.token === false ? [] : [{ id: 'TOK2', name: 'atto1-carplay-phone', client_id: present.wrongClientId ? 'other.access' : CLIENT_ID }]
  const policies = (present: Present) => [
    { id: 'POL0', name: 'owner only', decision: 'allow', precedence: 1, include: [{ email: { email: 'owner@example.invalid' } }] },
    { id: 'POL1', name: 'ingest', decision: 'non_identity', precedence: 2, include: [{ service_token: { token_id: 'TOK1' } }] },
    ...(present.policy
      ? [{ id: 'POL2', name: 'carplay-trigger', decision: 'non_identity', precedence: 3, include: [{ service_token: { token_id: 'TOK2' } }] }]
      : []),
  ]
  const actions = (present: Present) => (present.actions ? [{ name: 'CLOUDFLARE_API_TOKEN' }, { name: KEY }] : [{ name: 'CLOUDFLARE_API_TOKEN' }])

  write(join(stub, 'bws_list.json'), bwsList(before))
  write(join(stub, 'gh_secrets.json'), actions(before))
  write(key('GET', '/access/apps'), ok([{ id: 'APP1', name: 'atto1', domain: 'atto1.myargus.cc' }]))
  write(key('GET', '/access/apps/APP1/policies'), ok(policies(before)))
  write(key('GET', '/access/service_tokens'), ok([]))
  write(key('GET', '/access/service_tokens', '.temp'), ok(tokens(before)))
  if (after) {
    write(join(stub, 'bws_list.after.json'), bwsList(after))
    write(join(stub, 'gh_secrets.after.json'), actions(after))
    write(key('GET', '/access/apps/APP1/policies', '.after'), ok(policies(after)))
    write(key('GET', '/access/apps/APP1/policies', '.temp.after'), ok(policies(after)))
    write(key('GET', '/access/service_tokens', '.temp.after'), ok(tokens(after)))
  }
  write(userKey('POST', '/user/tokens'), ok({ id: 'tmp1', value: TEMP }))
  write(key('POST', '/access/apps/APP1/policies'), ok({ id: 'POL2', name: 'carplay-trigger' }))

  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync('/bin/bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${join(stub, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: home,
        STUB_DIR: stub,
        ATTO1_BW_HELPER: join(stub, 'bitwarden.sh'),
        ...env,
      },
    })
    const read = (name: string) => (existsSync(join(stub, name)) ? readFileSync(join(stub, name), 'utf8') : '')
    return {
      ...result,
      all: `${result.stdout}${result.stderr}`,
      calls: read('calls.log').split('\n').filter(Boolean),
      curlArgv: read('curl.argv'),
      ghArgv: read('gh.argv'),
      ghStdin: read('gh.stdin'),
      bwsValues: read('bws.values'),
      auth: read('auth.log').split('\n').filter(Boolean),
    }
  }
  return { run, stub, home }
}

const fresh: Present = { policy: false, bws: false, actions: false }
const everything: Present = { policy: true, bws: true, actions: true }
const writes = (calls: string[]) => calls.filter((call) => /^curl (POST|PUT|DELETE|PATCH) |^bws (create|edit)|^gh secret set/.test(call))

describe.skipIf(!hasJq)('scripts/owner-steps/7.sh', () => {
  it('refuses an unknown argument', () => {
    expect(world(fresh).run(['--now']).status).toBe(2)
  })

  describe('--dry-run', () => {
    it('reads state, lists every action and changes nothing: no token minted, no write', () => {
      const result = world(fresh).run(['--dry-run'])
      expect(result.status).toBe(0)
      expect(writes(result.calls)).toEqual([])
      expect(result.calls.filter((call) => call.startsWith('curl POST'))).toEqual([])
      expect(result.all).toMatch(/\[dry-run\] Access policy carplay-trigger/)
      expect(result.all).toMatch(/\[dry-run\] GitHub Actions secret ATTO_TRIGGER_CLIENT_ID/)
      expect(result.all).toMatch(/\[dry-run\] Secrets Manager ATTO_TRIGGER_CLIENT_ID/)
    })

    it('says nothing to change when everything is already in place', () => {
      const result = world(everything).run(['--dry-run'])
      expect(result.status).toBe(0)
      expect(result.all).toMatch(/Access policy carplay-trigger: present/)
    })
  })

  describe('pre-flight', () => {
    it('stops before any write when gh is not signed in', () => {
      const result = world(fresh).run([], { STUB_GH_NOAUTH: '1' })
      expect(result.status).toBe(1)
      expect(result.all).toMatch(/pre-flight FAILED: .*gh/)
      expect(result.all).toMatch(/nothing was changed/)
      expect(writes(result.calls)).toEqual([])
    })

    it('stops when the Bitwarden item has no username', () => {
      const result = world(fresh).run([], { STUB_BW_EMPTY: '1' })
      expect(result.status).toBe(1)
      expect(result.all).toMatch(/pre-flight FAILED: .*Bitwarden item/)
      expect(writes(result.calls)).toEqual([])
    })

    it('stops when the Access application is missing', () => {
      const w = world(fresh)
      write(join(w.stub, 'fixtures', 'GET__accounts_acct123_access_apps.json'), ok([]))
      const result = w.run([])
      expect(result.status).toBe(1)
      expect(result.all).toMatch(/pre-flight FAILED: .*application atto1\.myargus\.cc/)
      expect(writes(result.calls)).toEqual([])
    })
  })

  describe('a real run from nothing', () => {
    const after: Present = everything

    it('adds the policy, sets the Actions secret from stdin, stores the Secrets Manager key, and verifies', () => {
      const result = world(fresh, after).run([])
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(writes(result.calls)).toEqual([
        'curl POST https://api.cloudflare.com/client/v4/user/tokens',
        'curl POST https://api.cloudflare.com/client/v4/accounts/acct123/access/apps/APP1/policies',
        'gh secret set ATTO_TRIGGER_CLIENT_ID',
        'bws create ATTO_TRIGGER_CLIENT_ID project=proj-1',
        'curl DELETE https://api.cloudflare.com/client/v4/user/tokens/tmp1',
      ])
      expect(result.all).toMatch(/verify ok: the carplay-trigger policy/)
      expect(result.all).toMatch(/verify ok: the Actions secret ATTO_TRIGGER_CLIENT_ID is listed/)
      expect(result.all).toMatch(/verify ok: the Secrets Manager key ATTO_TRIGGER_CLIENT_ID exists/)
    })

    it('never creates or rotates the service token', () => {
      const result = world(fresh, after).run([])
      // Reading them (GET) is how it finds the token; no other call may touch them.
      const touching = result.calls.filter((call) => /service_tokens/.test(call))
      expect(touching.length).toBeGreaterThan(0)
      expect(touching.every((call) => call.startsWith('curl GET '))).toBe(true)
      expect(result.calls.join('\n')).not.toMatch(/rotate/)
    })

    it('includes the phone token in the policy, by its id', () => {
      const result = world(fresh, after).run([])
      expect(result.status).toBe(0)
      const body = result.curlArgv.split('\n').find((line) => line.includes('/policies') && line.includes('-d'))
      expect(body).toContain('carplay-trigger')
      expect(body).toContain('TOK2')
      expect(body).toContain('non_identity')
    })

    it('takes the Client ID from the Bitwarden username and the whole value arrives on stdin', () => {
      const result = world(fresh, after).run([])
      expect(result.ghStdin).toBe(CLIENT_ID)
      expect(result.bwsValues.trim()).toBe(CLIENT_ID)
    })

    it('mints a temporary token that can read service tokens but not write them', () => {
      const result = world(fresh, after).run([])
      const mint = result.curlArgv.split('\n').find((line) => line.includes('/user/tokens'))
      expect(mint).toBeDefined()
      expect(result.auth.some((line) => line.startsWith('POST /user/tokens ' + ADMIN))).toBe(true)
      expect(result.auth.some((line) => line.endsWith(' ' + TEMP))).toBe(true)
    })

    it('prints no secret and puts none on a command line', () => {
      const result = world(fresh, after).run([])
      for (const value of [...secretValues, CLIENT_ID]) {
        expect(result.all).not.toContain(value)
        expect(result.curlArgv).not.toContain(value)
        expect(result.ghArgv).not.toContain(value)
      }
    })

    it('never promotes, pushes deploy or starts a workflow', () => {
      const code = readFileSync(script, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
      expect(code).not.toMatch(/promote\.sh|git push|workflow run|gh run/)
    })
  })

  describe('idempotence', () => {
    it('adds nothing when the policy exists and writes only the secrets that are missing', () => {
      const present: Present = { policy: true, bws: true, actions: false }
      const result = world(present, everything).run([])
      expect(result.status).toBe(0)
      expect(writes(result.calls)).toEqual([
        'curl POST https://api.cloudflare.com/client/v4/user/tokens',
        'gh secret set ATTO_TRIGGER_CLIENT_ID',
        'curl DELETE https://api.cloudflare.com/client/v4/user/tokens/tmp1',
      ])
    })

    it('leaves a Secrets Manager key that already holds the Client ID alone, and edits one that holds another', () => {
      const same = world({ policy: true, bws: true, actions: true }, everything).run([])
      expect(writes(same.calls).some((call) => call.startsWith('bws'))).toBe(false)

      const stale = world({ policy: true, bws: true, actions: true, wrongClientId: false }, everything)
      write(join(stale.stub, 'bws_list.json'), [
        { id: 's-admin', key: 'CLOUDFLARE-TOKEN-ADMIN', value: ADMIN, projectId: 'proj-1' },
        { id: 's-access', key: 'CLOUDFLARE-TOKEN-ACCESS', value: READ, projectId: 'proj-1' },
        { id: 's-tunnel', key: 'homelab-cloudflared-tunnel-token', value: Buffer.from('{"a":"acct123"}').toString('base64'), projectId: 'proj-1' },
        { id: 'id-trigger', key: KEY, value: 'stale.access', projectId: 'proj-1' },
      ])
      const edited = stale.run([])
      expect(writes(edited.calls)).toContain('bws edit id-trigger')
    })

    it('is a no-op on the policy and the key when all three exist', () => {
      const result = world(everything, everything).run([])
      expect(result.status).toBe(0)
      expect(writes(result.calls).filter((call) => call.includes('/policies') || call.startsWith('bws'))).toEqual([])
    })
  })

  describe('refusals during a real run', () => {
    it('stops, writing nothing, when the service token is not in the account: it never creates one', () => {
      const result = world({ ...fresh, token: false }).run([])
      expect(result.status).toBe(1)
      expect(result.all).toMatch(/atto1-carplay-phone/)
      expect(writes(result.calls).filter((call) => call.includes('/policies') || call.startsWith('gh') || call.startsWith('bws'))).toEqual([])
      expect(result.calls).toContain('curl DELETE https://api.cloudflare.com/client/v4/user/tokens/tmp1')
    })

    it('stops when the Bitwarden Client ID is not the Cloudflare token\'s, so a stale value is never stored', () => {
      const result = world({ ...fresh, wrongClientId: true }).run([])
      expect(result.status).toBe(1)
      expect(result.all).toMatch(/does not match/)
      expect(writes(result.calls).filter((call) => call.startsWith('gh') || call.startsWith('bws') || call.includes('/policies'))).toEqual([])
    })

    it('revokes the temporary token even when a write fails', () => {
      const result = world(fresh, everything).run([], { STUB_GH_FAIL: '1' })
      expect(result.status).toBe(1)
      expect(result.calls).toContain('curl DELETE https://api.cloudflare.com/client/v4/user/tokens/tmp1')
    })

    it('fails the verify when the Actions secret did not land', () => {
      const result = world(fresh, { ...everything, actions: false }).run([])
      expect(result.status).toBe(1)
      expect(result.all).toMatch(/verify FAILED: the Actions secret/)
    })
  })
})

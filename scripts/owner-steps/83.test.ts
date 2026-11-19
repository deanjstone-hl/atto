import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/owner-steps/83.sh is run live by the owner (atto1/84). These cases run it against
// stub curl, bws and bw programs that serve canned Cloudflare and Secrets Manager state and
// log every call, so they prove what it would send and write without touching either
// service. The script needs jq; a host without it skips the file rather than failing the
// deploy Test step on the host (atto1/85), and main CI runs it.

const root = join(import.meta.dirname, '../..')
const script = join(root, 'scripts/owner-steps/83.sh')
const hasJq = spawnSync('jq', ['--version']).status === 0

const ADMIN = 'admin-token-VALUE'
const READ = 'read-token-VALUE'
const TEMP = 'tmp-token-VALUE'
const CLIENT_SECRET = 'client-secret-VALUE'
const BYD_PASSWORD = 'byd-password-VALUE'
const secretValues = [ADMIN, READ, TEMP, CLIENT_SECRET, BYD_PASSWORD]
const CF = 'https://api.cloudflare.com/client/v4'
const ACCOUNT = '/accounts/acct123'

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
  '  get) echo "bw get $2" >> "$STUB_DIR/calls.log"; if [ "$2" = username ]; then echo byd-user; else echo ' +
    BYD_PASSWORD +
    '; fi ;;',
  '  *) echo "bw stub: unexpected $1" >&2; exit 9 ;;',
  'esac',
].join('\n')

type Present = { token?: boolean; policy?: boolean; secrets?: string[] }
const keyId = 'atto1-ingest-client-id'
const keySecret = 'atto1-ingest-client-secret'
const keyUser = 'atto1-byd-username'
const keyPassword = 'atto1-byd-password'
const allSecrets = [keyId, keySecret, keyUser, keyPassword]

function write(path: string, body: string | object, mode?: number) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? `${body}\n` : `${JSON.stringify(body)}\n`)
  if (mode) chmodSync(path, mode)
}

const ok = (result: unknown) => ({ success: true, errors: [], result })

// blind: the read token (CLOUDFLARE-TOKEN-ACCESS) lists no service tokens, as on the 7 Nov run
// (atto1/84): the call succeeds with an empty result. Only the minted token sees them.
function world(before: Present, after?: Present, { blind = false } = {}) {
  const stub = mkdtempSync(join(tmpdir(), 'atto1-83-'))
  const home = join(stub, 'home')
  const fixtures = join(stub, 'fixtures')
  const key = (method: string, path: string, suffix = '') =>
    join(fixtures, `${`${method}_${ACCOUNT}${path}`.replace(/[^A-Za-z0-9]/g, '_')}${suffix}.json`)
  const userKey = (method: string, path: string) => join(fixtures, `${`${method}_${path}`.replace(/[^A-Za-z0-9]/g, '_')}.json`)

  write(join(stub, 'bin/curl'), curlStub, 0o755)
  write(join(stub, 'bin/bws'), bwsStub, 0o755)
  write(join(stub, 'bin/bw'), bwStub, 0o755)
  write(join(stub, 'bitwarden.sh'), 'bitwarden-session() { echo stub-session; }')
  write(join(home, '.bws_token'), 'BWS_ACCESS_TOKEN=stub-bws-token')
  write(join(home, '.bw_master'), 'stub-master')
  write(join(stub, 'bws_projects.json'), [{ id: 'proj-1', name: 'personal-machine-secrets' }])

  const tunnel = Buffer.from(JSON.stringify({ a: 'acct123', t: 'tun123' })).toString('base64')
  const value = { [keyId]: 'cid123.access', [keySecret]: CLIENT_SECRET, [keyUser]: 'byd-user', [keyPassword]: BYD_PASSWORD }
  const bwsList = (present: Present) => [
    { id: 's-admin', key: 'CLOUDFLARE-TOKEN-ADMIN', value: ADMIN, projectId: 'proj-1' },
    { id: 's-access', key: 'CLOUDFLARE-TOKEN-ACCESS', value: READ, projectId: 'proj-1' },
    { id: 's-tunnel', key: 'homelab-cloudflared-tunnel-token', value: tunnel, projectId: 'proj-1' },
    ...(present.secrets ?? []).map((name) => ({ id: `id-${name}`, key: name, value: value[name as keyof typeof value], projectId: 'proj-1' })),
  ]
  const tokens = (present: Present) => (present.token ? [{ id: 'TOK1', name: 'atto1-ingest', client_id: 'cid123.access' }] : [])
  const policies = (present: Present) => [
    { id: 'POL0', name: 'owner only', decision: 'allow', precedence: 1, include: [{ email: { email: 'owner@example.invalid' } }] },
    ...(present.policy
      ? [{ id: 'POL1', name: 'ingest', decision: 'non_identity', precedence: 2, include: [{ service_token: { token_id: 'TOK1' } }] }]
      : []),
  ]

  write(join(stub, 'bws_list.json'), bwsList(before))
  write(key('GET', '/access/apps'), ok([{ id: 'APP1', name: 'atto1', domain: 'atto1.myargus.cc' }]))
  write(key('GET', '/access/apps/APP1/policies'), ok(policies(before)))
  write(key('GET', '/access/service_tokens'), ok(blind ? [] : tokens(before)))
  if (blind) write(key('GET', '/access/service_tokens', '.temp'), ok(tokens(before)))
  write(key('GET', '/access/users'), ok([{ id: 'user-uid-1', uid: 'user-uid-1', email: 'owner@example.invalid' }]))
  if (after) {
    write(join(stub, 'bws_list.after.json'), bwsList(after))
    write(key('GET', '/access/apps/APP1/policies', '.after'), ok(policies(after)))
    write(key('GET', '/access/service_tokens', blind ? '.temp.after' : '.after'), ok(tokens(after)))
  }
  write(userKey('POST', '/user/tokens'), ok({ id: 'tmp1', value: TEMP }))
  write(key('POST', '/access/service_tokens'), ok({ id: 'TOK1', name: 'atto1-ingest', client_id: 'cid123.access', client_secret: CLIENT_SECRET }))
  write(key('POST', '/access/service_tokens/TOK1/rotate'), ok({ id: 'TOK1', client_id: 'cid123.access', client_secret: CLIENT_SECRET }))
  write(key('POST', '/access/apps/APP1/policies'), ok({ id: 'POL1', name: 'ingest' }))

  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${join(stub, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: home,
        STUB_DIR: stub,
        ATTO1_BW_HELPER: join(stub, 'bitwarden.sh'),
        ATTO1_VERIFY_WAIT: '0',
        ...env,
      },
    })
    const read = (name: string) => (existsSync(join(stub, name)) ? readFileSync(join(stub, name), 'utf8') : '')
    return {
      ...result,
      all: `${result.stdout}${result.stderr}`,
      calls: read('calls.log').split('\n').filter(Boolean),
      curlArgv: read('curl.argv'),
      auth: read('auth.log').split('\n').filter(Boolean),
    }
  }
  return { run, stub, home }
}

const fresh = { token: false, policy: false, secrets: [] }
const everything = { token: true, policy: true, secrets: allSecrets }
const writes = (calls: string[]) => calls.filter((call) => /^curl (POST|PUT|DELETE|PATCH) |^bws (create|edit)/.test(call))

describe.skipIf(!hasJq)('scripts/owner-steps/83.sh', () => {
  it('refuses an unknown argument', () => {
    expect(world(fresh).run(['--now']).status).toBe(2)
  })

  it('stops, changing and calling nothing, when the Secrets Manager token file is missing', () => {
    const { run, home } = world(fresh)
    spawnSync('rm', [join(home, '.bws_token')])
    const result = run(['--dry-run'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/pre-flight FAILED: .*\.bws_token exists/)
    expect(result.stderr).toMatch(/nothing was changed/)
    expect(result.calls.filter((call) => call.startsWith('curl'))).toEqual([])
  })

  it('--dry-run prints every action, reads state, and writes nothing', () => {
    const result = world(fresh).run(['--dry-run'])
    expect(result.status).toBe(0)
    expect(writes(result.calls)).toEqual([])
    expect(result.calls.some((call) => call.startsWith('curl GET'))).toBe(true)
    for (const expected of [
      /\[dry-run\] .*service token atto1-ingest.*create/,
      /\[dry-run\] .*atto1-ingest-client-id/,
      /\[dry-run\] .*atto1-ingest-client-secret/,
      /\[dry-run\] .*atto1-byd-username/,
      /\[dry-run\] .*atto1-byd-password/,
      /\[dry-run\] .*policy ingest.*Service Auth/,
    ]) {
      expect(result.stdout).toMatch(expected)
    }
  })

  it('creates the token, writes the four secrets, adds the policy, verifies, and prints no secret', () => {
    const { run } = world(fresh, everything)
    const result = run([])
    expect(result.stderr).not.toMatch(/FAILED|error/i)
    expect(result.status).toBe(0)
    expect(result.calls).toEqual(
      expect.arrayContaining([
        `curl POST ${CF}/user/tokens`,
        `curl POST ${CF}${ACCOUNT}/access/service_tokens`,
        `bws create ${keyId} project=proj-1`,
        `bws create ${keySecret} project=proj-1`,
        `bws create ${keyUser} project=proj-1`,
        `bws create ${keyPassword} project=proj-1`,
        `curl POST ${CF}${ACCOUNT}/access/apps/APP1/policies`,
        `curl DELETE ${CF}/user/tokens/tmp1`,
      ]),
    )
    expect(result.curlArgv).toMatch(/non_identity/)
    expect(result.curlArgv).toMatch(/TOK1/)
    expect(result.curlArgv).toMatch(/"duration":"8760h"/)
    expect(result.stdout).toMatch(/cid123\.access/)
    expect(result.stdout).toMatch(/user-uid-1/)
    for (const secret of secretValues) {
      expect(result.all).not.toContain(secret)
      expect(result.curlArgv).not.toContain(secret)
    }
  })

  it('is read-only when everything is already in place', () => {
    const result = world(everything).run([])
    expect(result.status).toBe(0)
    expect(writes(result.calls)).toEqual([])
    expect(result.stdout).toMatch(/nothing to change/)
  })

  it('rotates an existing token whose secret is not in Secrets Manager, instead of creating another', () => {
    const { run } = world(
      { token: true, policy: true, secrets: [keyId, keyUser, keyPassword] },
      { token: true, policy: true, secrets: allSecrets },
    )
    const result = run([])
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`curl POST ${CF}${ACCOUNT}/access/service_tokens/TOK1/rotate`)
    expect(result.calls).not.toContain(`curl POST ${CF}${ACCOUNT}/access/service_tokens`)
    expect(result.calls).toContain(`bws create ${keySecret} project=proj-1`)
  })

  it('deletes the token it just made when the secret cannot be stored, so a re-run starts clean', () => {
    const result = world(fresh, everything).run([], { STUB_BWS_FAIL: '1' })
    expect(result.status).not.toBe(0)
    expect(result.calls).toContain(`curl DELETE ${CF}${ACCOUNT}/access/service_tokens/TOK1`)
    expect(result.calls).toContain(`curl DELETE ${CF}/user/tokens/tmp1`)
    expect(result.calls).not.toContain(`curl POST ${CF}${ACCOUNT}/access/apps/APP1/policies`)
    for (const secret of secretValues) expect(result.all).not.toContain(secret)
  })

  it('revokes the temporary token with CLOUDFLARE-TOKEN-ADMIN, the token that minted it', () => {
    const result = world(fresh, everything).run([])
    expect(result.status).toBe(0)
    expect(result.auth).toContain(`DELETE /user/tokens/tmp1 ${ADMIN}`)
    expect(result.auth).not.toContain(`DELETE /user/tokens/tmp1 ${TEMP}`)
    expect(result.all).not.toMatch(/could not revoke/)
  })

  it('revokes the temporary token with the admin token on a failed run too', () => {
    const result = world(fresh, everything).run([], { STUB_BWS_FAIL: '1' })
    expect(result.status).not.toBe(0)
    expect(result.auth).toContain(`DELETE /user/tokens/tmp1 ${ADMIN}`)
    expect(result.all).not.toMatch(/could not revoke/)
  })

  it('says loudly, with the id and expiry, when the temporary token cannot be revoked', () => {
    const result = world(fresh, everything).run([], { STUB_REVOKE_FAIL: '1' })
    expect(result.stderr).toMatch(/warning: could not revoke the temporary Cloudflare token tmp1.*expires/)
    for (const secret of secretValues) expect(result.all).not.toContain(secret)
  })

  describe('when the read token cannot list service tokens (a blind read)', () => {
    const blind = { blind: true }

    it('fails the pre-flight, loudly and before any change, when a policy names a token the list lacks', () => {
      const { run } = world(everything, undefined, blind)
      for (const args of [['--dry-run'], []]) {
        const result = run(args)
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/pre-flight FAILED: .*cannot list Access service tokens/)
        expect(result.stderr).toMatch(/nothing was changed/)
        expect(result.all).not.toMatch(/absent, would create/)
        expect(writes(result.calls)).toEqual([])
      }
    })

    it('reads the service tokens with the minted token before it creates, and rotates instead of duplicating', () => {
      const { run } = world(
        { token: true, policy: false, secrets: [] },
        { token: true, policy: true, secrets: allSecrets },
        blind,
      )
      const result = run([])
      expect(result.stderr).not.toMatch(/FAILED|error/i)
      expect(result.status).toBe(0)
      expect(result.auth).toContain(`GET ${ACCOUNT}/access/service_tokens ${TEMP}`)
      expect(result.calls).toContain(`curl POST ${CF}${ACCOUNT}/access/service_tokens/TOK1/rotate`)
      expect(result.calls).not.toContain(`curl POST ${CF}${ACCOUNT}/access/service_tokens`)
      expect(result.stdout).toMatch(/id TOK1, Client ID cid123\.access/)
    })

    it('verifies with the minted token, so a created token is found and the Results line is filled', () => {
      const result = world(fresh, everything, blind).run([])
      expect(result.stderr).not.toMatch(/verify FAILED/)
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/verify ok: service token atto1-ingest exists/)
      expect(result.stdout).toMatch(/id TOK1, Client ID cid123\.access/)
    })
  })

  it('fails the verify block when the service token is still sent to the Access login', () => {
    const result = world(everything).run([], { STUB_SERVICE_TOKEN_STATUS: '302' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/verify FAILED/)
  })

  it('never promotes or pushes deploy', () => {
    const code = readFileSync(script, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/promote\.sh|git push|workflow run/)
  })
})

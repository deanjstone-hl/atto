import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// This repository is public, so a pull request from a fork runs the workflows on its behalf. These
// pin what keeps that safe: only GitHub-hosted runners, no `pull_request_target`, no action from a
// private repository, and no secret in a workflow a pull request can start. GitHub: secure-use
// ("self-hosted runners should almost never be used for public repositories"; forks get no secrets).

const root = join(import.meta.dirname, '..')
const workflowDir = join(root, '.github/workflows')
const workflows = readdirSync(workflowDir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => {
    const text = readFileSync(join(workflowDir, name), 'utf8')
    // Comment lines explain a workflow and may name what it avoids; only code counts.
    return { name, text, code: text.replace(/^\s*#.*$/gm, '') }
  })

// The one workflow that may use the homelab runner: it installs the BYD collector on that host
// (atto/18). A self-hosted job in a public repository is safe only when no fork can start it, so it
// must trigger on a push to `deploy` or a dispatch and nothing else (argus-config trunk-readiness
// point 5), and hold no secret.
const HOMELAB_WORKFLOW = 'install-homelab.yml'

describe.each(workflows)('.github/workflows/$name', ({ name, code }) => {
  it.skipIf(name === HOMELAB_WORKFLOW)('runs on ubuntu-latest only: no self-hosted runner, no variable that could pick one', () => {
    const runsOn = [...code.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((match) => match[1].trim())
    expect(runsOn.length).toBeGreaterThan(0)
    expect(runsOn.filter((value) => value !== 'ubuntu-latest')).toEqual([])
    expect(code).not.toMatch(/CI_RUNS_ON|runner\.environment|self-hosted/)
  })

  it('never uses pull_request_target', () => {
    expect(code).not.toContain('pull_request_target')
  })

  it('uses no action or workflow from a private repository of the owner', () => {
    const uses = [...code.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1])
    expect(uses.filter((value) => value.startsWith('deanjstone/'))).toEqual([])
  })
})

describe(`.github/workflows/${HOMELAB_WORKFLOW}, the one self-hosted job`, () => {
  const homelab = workflows.find(({ name }) => name === HOMELAB_WORKFLOW)!

  it('exists and uses the homelab runner for the install job only', () => {
    expect(homelab).toBeDefined()
    const runsOn = [...homelab.code.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((match) => match[1].trim())
    expect(runsOn).toEqual(['[self-hosted, homelab, deploy]'])
    expect(homelab.code).not.toMatch(/CI_RUNS_ON|runner\.environment/)
  })

  it('no other workflow names a self-hosted runner', () => {
    expect(workflows.filter(({ name, code }) => name !== HOMELAB_WORKFLOW && /self-hosted/.test(code))).toEqual([])
  })

  it('triggers only on a push to deploy or a dispatch, and holds no secret', () => {
    const triggers = homelab.code.match(/^on:\n((?: {2,}.*\n|\n)+)/m)?.[1] ?? ''
    expect([...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1])).toEqual(['push', 'workflow_dispatch'])
    expect(triggers).toMatch(/branches: \[deploy\]/)
    expect(homelab.code).not.toMatch(/secrets\./)
    expect(homelab.code).toMatch(/permissions:\s*\n\s+contents: read/)
  })
})

describe('a workflow a pull request starts', () => {
  const pullRequestWorkflows = workflows.filter(({ code }) => /^\s{2}pull_request:/m.test(code))

  it('exists (ci.yml at least)', () => {
    expect(pullRequestWorkflows.map(({ name }) => name)).toContain('ci.yml')
  })

  it.each(pullRequestWorkflows)('$name uses no secret but the read-only GITHUB_TOKEN', ({ code }) => {
    const secrets = [...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1])
    expect(secrets.filter((secret) => secret !== 'GITHUB_TOKEN')).toEqual([])
    expect(code).toMatch(/permissions:\s*\n\s+contents: read/)
  })
})

describe('deploy.yml and the Worker values', () => {
  const deploy = workflows.find(({ name }) => name === 'deploy.yml')!
  const VALUES = ['ATTO_D1_DATABASE_ID', 'ATTO_ACCESS_TEAM_DOMAIN', 'ATTO_ACCESS_AUD', 'ATTO_INGEST_CLIENT_ID', 'ATTO_INGEST_OWNER_SUBJECT', 'ATTO_TRIGGER_CLIENT_ID']
  // wrangler reads these two names; their Secrets Manager keys are ATTO_CLOUDFLARE_API_TOKEN and
  // ATTO_CLOUDFLARE_ACCOUNT_ID (scripts/owner-steps/10.sh).
  const CLOUDFLARE = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']
  const steps = deploy.code.split(/\n\s+- /).slice(1)
  const smSteps = steps.filter((step) => /uses:\s*bitwarden\/sm-action@/.test(step))

  it('reads every value through bitwarden/sm-action, pinned by full commit SHA (atto/10)', () => {
    expect(smSteps.length).toBe(1)
    expect(smSteps[0]).toMatch(/uses:\s*bitwarden\/sm-action@[0-9a-f]{40}\b/)
    expect(smSteps[0]).toContain('access_token: ${{ secrets.BWS_ACCESS_TOKEN }}')
  })

  it('maps one Secrets Manager id to each Worker value and Cloudflare credential, in that one step, and no value twice', () => {
    const map = [...smSteps[0].matchAll(/^\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) > ([A-Z0-9_]+)\s*$/gm)]
    expect(map.map((match) => match[2]).sort()).toEqual([...VALUES, ...CLOUDFLARE].sort())
    expect(new Set(map.map((match) => match[1])).size).toBe(VALUES.length + CLOUDFLARE.length)
  })

  it('names every key in a comment above the step, and reads none from an Actions secret', () => {
    for (const name of [...VALUES, ...CLOUDFLARE]) {
      expect(deploy.text, name).toMatch(new RegExp(`^\\s*#.*\\b${name}\\b`, 'm'))
      expect(deploy.code, name).not.toContain(`secrets.${name}`)
    }
  })

  it('installs no bws CLI: the action is the only Secrets Manager call', () => {
    expect(deploy.code).not.toMatch(/install-bws|bws secret|bws run/)
  })

  it('exports the values only to the two wrangler steps: they are the last two steps after sm-action', () => {
    const at = steps.indexOf(smSteps[0])
    const after = steps.slice(at + 1)
    expect(after.length).toBe(2)
    for (const step of after) expect(step).toMatch(/pnpm run (db:migrate|deploy)/)
  })

  it('uses no Actions secret but BWS_ACCESS_TOKEN', () => {
    const used = new Set([...deploy.code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]))
    expect([...used]).toEqual(['BWS_ACCESS_TOKEN'])
  })
})

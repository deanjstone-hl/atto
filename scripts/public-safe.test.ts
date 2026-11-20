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

describe.each(workflows)('.github/workflows/$name', ({ code }) => {
  it('runs on ubuntu-latest only: no self-hosted runner, no variable that could pick one', () => {
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

  it('never calls Secrets Manager: no bws install, no BWS_ACCESS_TOKEN (atto1/108)', () => {
    expect(deploy.code).not.toMatch(/bws|BWS_ACCESS_TOKEN|install-bws/)
  })

  it('reads each private Worker value from an Actions secret of the same name', () => {
    for (const name of VALUES) expect(deploy.code, name).toContain(`${name}: \${{ secrets.${name} }}`)
  })

  it('hands those values, and the Cloudflare credentials, only to the two steps that call wrangler', () => {
    const steps = deploy.code.split(/\n\s+- /).slice(1)
    const holders = steps.filter((step) => /secrets\.(ATTO_|CLOUDFLARE_)/.test(step))
    expect(holders.length).toBe(2)
    for (const step of holders) {
      expect(step).toMatch(/pnpm run (db:migrate|deploy)/)
      for (const name of [...VALUES, 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) expect(step, name).toContain(`secrets.${name}`)
    }
  })
})

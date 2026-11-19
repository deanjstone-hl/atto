import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Trunk readiness (argus-config#1176, #1180): agents push straight to main, so the one
// local check (`pnpm run check`) is what runs before a push, CI runs that same command on
// every push to main, and Release is gated on it. These cases pin the wiring that would
// otherwise fail silently: a check that drifts from CI, a CI job that skips a push by its
// commit subject, or a Release that no longer waits for the check.

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('local check', () => {
  it('is the package.json "check" script, a single entry point', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    expect(scripts.check).toBe('bash scripts/check.sh')
  })

  it('runs the gate steps CI used to run one by one', () => {
    const check = read('scripts/check.sh')
    for (const step of ['pnpm run lint', 'pnpm run build', 'pnpm run test']) {
      expect(check).toContain(step)
    }
    expect(check).toContain('scripts/test/deploy-lock.bats')
  })

  it('pins NODE_ENV=test for the test step (a JIT runner inherits production)', () => {
    expect(read('scripts/check.sh')).toMatch(/NODE_ENV=test\s+pnpm run test/)
  })
})

describe('CI on push to main', () => {
  const ci = read('.github/workflows/ci.yml')

  it('runs the check on a push to main', () => {
    expect(ci).toMatch(/push:\s*\n\s*branches: \[main\]/)
    expect(ci).toContain('pnpm run check')
  })

  it('fails on a hand-edited vendored release script, on every push and pull request', () => {
    expect(ci).toMatch(/push:\s*\n\s*branches: \[main\]/)
    expect(ci).toMatch(/pull_request:\s*\n\s*branches: \[main\]/)
    expect(ci).toContain('bash scripts/ci/release-scripts-check.sh')
  })

  it('never skips a push by its commit subject (no squash-merge guard)', () => {
    expect(ci).not.toContain('head_commit.message')
    expect(ci).not.toContain('pr-merge-push')
  })
})

describe('Release', () => {
  const release = read('.github/workflows/release.yml')
  // Comment lines explain the workflow and may name what it avoids; only code counts.
  const code = release.replace(/^\s*#.*$/gm, '')

  it('is serialised and never cancelled midway', () => {
    expect(code).toMatch(/concurrency:\s*\n\s*group: release\s*\n\s*cancel-in-progress: false/)
  })

  it('has no workflow_run trigger (GitHub reports the default branch and semantic-release dry-runs)', () => {
    expect(code).not.toMatch(/^\s*workflow_run:/m)
  })

  it('has a Test before release job that runs the check on the promoted SHA', () => {
    expect(release).toMatch(/name: Test before release \(bats, lint, build and typecheck, unit tests\)/)
    expect(release).toContain('pnpm run check')
    expect(release).toContain('ref: ${{ github.sha }}')
  })

  it('names the proof job for what it does', () => {
    expect(release).toContain('name: Test before release (main CI on this SHA)')
  })

  it('runs no test and cuts no version when nothing is releasable', () => {
    expect(code).toContain('(feat|fix|perf|revert)')
    expect(code).toContain('BREAKING CHANGE')
    expect(code).toContain("needs.gate.outputs.release == 'true'")
  })

  it('reuses main CI through scripts/ci/release-proof.sh, which fails the job on a red main run', () => {
    expect(code).toContain('bash scripts/ci/release-proof.sh')
    expect(code).toContain("needs.gate.outputs.reuse != 'true'")
  })

  it('sets the proof env the vendored script no longer hard-codes (unset, it reuses nothing)', () => {
    expect(code).toMatch(/run: bash scripts\/ci\/release-proof\.sh\s*\n\s*env:[\s\S]*?RELEASE_PROOF_WORKFLOW: CI\b/)
  })

  it('keeps the retry wrapper authenticated and pointed at deploy', () => {
    expect(code).toMatch(/run: bash scripts\/ci\/release-with-retry\.sh\s*\n\s*env:[\s\S]*?GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}[\s\S]*?RELEASE_BRANCH: deploy/)
  })

  it('vendors the release scripts: a lock beside them names the argus-config source', () => {
    const lock = read('scripts/ci/release-scripts.lock')
    expect(lock).toMatch(/^source deanjstone\/argus-config [0-9a-f]{40}$/m)
    for (const name of ['release-proof.sh', 'release-scripts-check.sh', 'release-with-retry.sh']) {
      expect(lock).toMatch(new RegExp(`^[0-9a-f]{64}  ${name}$`, 'm'))
    }
  })

  it('makes Release wait for the proof or the check, and run only after one passed', () => {
    expect(code).toMatch(/release:\s*\n\s*name: Release\s*\n\s*needs: \[gate, test\]/)
    expect(code).toContain("needs.test.result == 'success'")
    expect(code).toContain("needs.gate.outputs.reuse == 'true'")
    expect(code).toContain("needs.gate.result == 'success'")
  })

  it('refuses any ref but deploy in every job', () => {
    expect(code.match(/github\.ref == 'refs\/heads\/deploy'/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('releases through the retrying wrapper, never bare semantic-release', () => {
    expect(release).toContain('bash scripts/ci/release-with-retry.sh')
    expect(release).not.toMatch(/run: pnpm exec semantic-release/)
  })

  it('stops the github plugin commenting on or labelling issues (foreign #N refs turn Release red after the tag)', () => {
    const rc = JSON.parse(read('.releaserc.json')) as { plugins: (string | [string, Record<string, unknown>])[] }
    const github = rc.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/github')
    expect(github).toBeDefined()
    expect((github as [string, Record<string, unknown>])[1]).toMatchObject({
      successComment: false,
      failComment: false,
      releasedLabels: false,
    })
  })
})

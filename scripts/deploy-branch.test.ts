import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The deploy-branch model for atto1 (argus-config#504, #603): production changes only
// when the owner promotes a commit on main to the `deploy` branch (scripts/promote.sh),
// and every manual production path refuses to run unless its checkout is what `deploy`
// holds (scripts/require-deploy-checkout.sh). The behavioural cases build throwaway
// repos with a local bare origin; nothing touches the real remote. The static cases pin
// the wiring that would otherwise fail silently: a remote `wrangler` script (deploy or
// D1 migration) without the guard, or a deploy workflow back on `main`.

const root = join(import.meta.dirname, '..')
const promote = join(root, 'scripts/promote.sh')
const guardSource = join(root, 'scripts/require-deploy-checkout.sh')

const identity = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...identity },
  }).trim()
}

function run(script: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const inherited = { ...process.env }
  delete inherited.GITHUB_ACTIONS
  const result = spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...inherited, ...identity, ...env },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'deploy-branch-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('scripts/require-deploy-checkout.sh', () => {
  let repo: string
  let guard: string

  // A checkout whose HEAD is what its origin's deploy branch holds, with the guard
  // committed under scripts/. Files a case adds afterwards stay untracked.
  beforeEach(() => {
    repo = join(work, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('mkdir', ['-p', join(repo, 'scripts')])
    execFileSync('cp', [guardSource, join(repo, 'scripts/require-deploy-checkout.sh')])
    git(repo, 'add', 'scripts')
    git(repo, 'commit', '-q', '-m', 'deploy guard')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', `${repo}.origin.git`])
    git(repo, 'remote', 'add', 'origin', `${repo}.origin.git`)
    git(repo, 'push', '-q', 'origin', 'HEAD:main', 'HEAD:deploy')
    guard = join(repo, 'scripts/require-deploy-checkout.sh')
  })

  it('lets a clean checkout at origin/deploy through', () => {
    const result = run(guard, [], repo)
    expect(result.status, result.output).toBe(0)
  })

  it('ignores untracked files such as a .env or a build output', () => {
    writeFileSync(join(repo, '.env.local'), 'X=1\n')
    expect(run(guard, [], repo).status).toBe(0)
  })

  it('refuses when origin has no deploy branch', () => {
    git(repo, 'push', '-q', 'origin', '--delete', 'deploy')
    const result = run(guard, [], repo)
    expect(result.status).toBe(1)
    expect(result.output).toContain('origin/deploy does not exist')
    expect(result.output).toContain('scripts/promote.sh')
  })

  it('refuses a checkout ahead of deploy', () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'unpromoted')
    const result = run(guard, [], repo)
    expect(result.status).toBe(1)
    expect(result.output).toContain('scripts/promote.sh')
  })

  it('refuses a checkout behind deploy: it asks origin, not a stale local ref', () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'promoted')
    git(repo, 'push', '-q', 'origin', 'HEAD:deploy')
    git(repo, 'checkout', '-q', '--detach', 'HEAD~1')
    expect(run(guard, [], repo).status).toBe(1)
  })

  it('refuses uncommitted changes to a tracked file', () => {
    writeFileSync(guard, `${readFileSync(guard, 'utf8')}# local edit\n`)
    const result = run(guard, [], repo)
    expect(result.status).toBe(1)
    expect(result.output).toContain('uncommitted')
  })

  it('refuses when origin is unreachable', () => {
    git(repo, 'remote', 'set-url', 'origin', join(work, 'gone.git'))
    const result = run(guard, [], repo)
    expect(result.status).toBe(1)
    expect(result.output).toContain('unreachable')
  })

  // A rollback (the ops hub's "Roll back" card: a workflow_dispatch of deploy.yml at a release
  // tag, argus#1178) sets DEPLOY_ROLLBACK_TAG=vX.Y.Z. `deploy` has moved on from that release,
  // so HEAD cannot equal it; the guard instead wants HEAD to be the commit of that tag on origin,
  // and that commit to be one `deploy` already held.
  describe('a rollback to a release tag (DEPLOY_ROLLBACK_TAG)', () => {
    // main: guard <- v1.0.0 <- v1.1.0, with deploy at v1.1.0; the checkout is moved to the tag under test.
    beforeEach(() => {
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: one')
      git(repo, 'tag', 'v1.0.0')
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: two')
      git(repo, 'tag', 'v1.1.0')
      git(repo, 'push', '-q', 'origin', 'HEAD:deploy', 'v1.0.0', 'v1.1.0')
    })
    const rollback = (tag: string) => run(guard, [], repo, { DEPLOY_ROLLBACK_TAG: tag })

    it('passes at a release tag that deploy already holds, though deploy has moved on', () => {
      git(repo, 'checkout', '-q', '--detach', 'v1.0.0')
      expect(run(guard, [], repo).status).toBe(1)
      const result = rollback('v1.0.0')
      expect(result.status, result.output).toBe(0)
    })

    it('passes from a shallow checkout of the tag, as actions/checkout makes it', () => {
      const shallow = join(work, 'shallow')
      execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'v1.0.0', `file://${repo}.origin.git`, shallow], {
        stdio: 'ignore',
      })
      const result = run(join(shallow, 'scripts/require-deploy-checkout.sh'), [], shallow, {
        DEPLOY_ROLLBACK_TAG: 'v1.0.0',
      })
      expect(result.status, result.output).toBe(0)
    })

    it('still refuses a checkout behind deploy when no rollback tag is set', () => {
      git(repo, 'checkout', '-q', '--detach', 'v1.0.0')
      expect(run(guard, [], repo, { DEPLOY_ROLLBACK_TAG: '' }).status).toBe(1)
    })

    it('refuses when HEAD is not the tag commit', () => {
      git(repo, 'checkout', '-q', '--detach', 'v1.0.0')
      const result = rollback('v1.1.0')
      expect(result.status).toBe(1)
      expect(result.output).toContain('HEAD is not the commit of tag v1.1.0')
    })

    it('refuses a tag origin does not have', () => {
      git(repo, 'tag', 'v9.9.9')
      git(repo, 'checkout', '-q', '--detach', 'v9.9.9')
      const result = rollback('v9.9.9')
      expect(result.status).toBe(1)
      expect(result.output).toContain('origin has no tag v9.9.9')
    })

    it('refuses a tagged commit that deploy never held', () => {
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: three, never promoted')
      git(repo, 'tag', 'v1.2.0')
      git(repo, 'push', '-q', 'origin', 'v1.2.0')
      const result = rollback('v1.2.0')
      expect(result.status).toBe(1)
      expect(result.output).toContain('was never promoted')
    })

    it('follows an annotated tag to its commit', () => {
      git(repo, 'checkout', '-q', '--detach', 'v1.0.0')
      git(repo, 'tag', '-a', '-m', 'one, annotated', 'v1.0.1')
      git(repo, 'push', '-q', 'origin', 'v1.0.1')
      const result = rollback('v1.0.1')
      expect(result.status, result.output).toBe(0)
    })

    it('refuses anything that is not a release tag name', () => {
      for (const tag of ['main', 'deploy', 'v1', 'latest', 'v1.0.0/../x']) {
        const result = rollback(tag)
        expect(result.status, tag).toBe(1)
        expect(result.output, tag).toContain('not a release tag')
      }
    })

    it('refuses uncommitted changes to tracked files', () => {
      git(repo, 'checkout', '-q', '--detach', 'v1.0.0')
      writeFileSync(guard, `${readFileSync(guard, 'utf8')}# local edit\n`)
      const result = rollback('v1.0.0')
      expect(result.status).toBe(1)
      expect(result.output).toContain('uncommitted')
    })
  })
})

describe('scripts/promote.sh', () => {
  let repo: string
  let one: string
  let two: string
  const originDir = () => join(work, 'origin.git')
  const remoteDeploy = () => git(originDir(), 'rev-parse', '--quiet', '--verify', 'refs/heads/deploy')
  const remoteHasDeploy = () =>
    spawnSync('git', ['-C', originDir(), 'rev-parse', '--verify', '--quiet', 'refs/heads/deploy']).status === 0

  beforeEach(() => {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originDir()])
    execFileSync('git', ['clone', '-q', originDir(), join(work, 'repo')], { stdio: 'ignore' })
    repo = join(work, 'repo')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'one')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'two')
    git(repo, 'push', '-q', 'origin', 'HEAD:main')
    one = git(repo, 'rev-parse', 'HEAD~1')
    two = git(repo, 'rev-parse', 'HEAD')
  })

  it('creates deploy at a main SHA on the first promotion', () => {
    const result = run(promote, [one], repo)
    expect(result.status, result.output).toBe(0)
    expect(remoteDeploy()).toBe(one)
    expect(result.output).toContain('creating deploy')
  })

  it('fast-forwards deploy and lists what ships', () => {
    run(promote, [one], repo)
    const result = run(promote, ['main'], repo)
    expect(result.status, result.output).toBe(0)
    expect(remoteDeploy()).toBe(two)
    expect(result.output).toContain('two')
  })

  it('changes nothing on a dry run', () => {
    const result = run(promote, ['--dry-run', one], repo)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain(`git push origin ${one}:refs/heads/deploy`)
    expect(remoteHasDeploy()).toBe(false)
  })

  it('is a no-op when deploy is already there', () => {
    run(promote, [two], repo)
    const result = run(promote, [two], repo)
    expect(result.status).toBe(0)
    expect(result.output).toContain('Nothing to do')
  })

  it('refuses a SHA that is not on main', () => {
    git(repo, 'checkout', '-q', '-b', 'side')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'side')
    git(repo, 'push', '-q', 'origin', 'side')
    const result = run(promote, [git(repo, 'rev-parse', 'HEAD')], repo)
    expect(result.status).toBe(1)
    expect(result.output).toContain('not on origin/main')
    expect(remoteHasDeploy()).toBe(false)
  })

  it('refuses to move deploy backwards: a rollback is a revert on main', () => {
    run(promote, [two], repo)
    const result = run(promote, [one], repo)
    expect(result.status).toBe(1)
    expect(result.output).toContain('not a fast-forward')
    expect(result.output).toContain('git revert')
    expect(remoteDeploy()).toBe(two)
  })

  it('refuses an unknown ref', () => {
    const result = run(promote, ['no-such-ref'], repo)
    expect(result.status).toBe(1)
    expect(result.output).toContain('unknown commit')
  })

  it('refuses to run in GitHub Actions, where a GITHUB_TOKEN push deploys nothing', () => {
    const result = run(promote, [one], repo, { GITHUB_ACTIONS: 'true' })
    expect(result.status).toBe(1)
    expect(result.output).toContain('refusing to run in GitHub Actions')
    expect(remoteHasDeploy()).toBe(false)
  })

  // GitHub runs no push workflow when the head commit of a push carries the skip-CI marker
  // (a bracketed skip/no-ci phrase, or a "skip-checks: true" trailer), and the release bot
  // adds one to its version commit (argus-config#1060). The markers are built from parts so
  // this file never carries the literal token.
  describe('the skip-CI marker guard', () => {
    const marker = (phrase: string) => `[${phrase}]`
    const commitOnMain = (message: string) => {
      git(repo, 'commit', '-q', '--allow-empty', '-m', message)
      git(repo, 'push', '-q', 'origin', 'HEAD:main')
      return git(repo, 'rev-parse', 'HEAD')
    }
    const release = (version: string, phrase = 'skip ci') => commitOnMain(`chore(release): ${version} ${marker(phrase)}`)

    it.each(['skip ci', 'ci skip', 'no ci', 'skip actions', 'actions skip', 'SKIP CI'])(
      'refuses a marker commit spelled %s',
      (phrase) => {
        const result = run(promote, [release('1.0.0', phrase)], repo)
        expect(result.status, result.output).toBe(1)
        expect(result.output).toContain('carries the skip-CI marker')
        expect(remoteHasDeploy()).toBe(false)
      },
    )

    it('refuses a skip-checks trailer', () => {
      const result = run(promote, [commitOnMain('chore: release\n\nskip-checks: true')], repo)
      expect(result.status, result.output).toBe(1)
      expect(result.output).toContain('carries the skip-CI marker')
      expect(remoteHasDeploy()).toBe(false)
    })

    it('says why: GitHub runs no workflow for such a push', () => {
      const result = run(promote, [release('1.0.0')], repo)
      expect(result.status).toBe(1)
      expect(result.output).toContain('GitHub runs no workflow for a push whose head commit carries the marker')
    })

    it('names the parent as the SHA to promote instead', () => {
      run(promote, [one], repo)
      const result = run(promote, [release('1.0.0')], repo)
      expect(result.status).toBe(1)
      expect(result.output).toContain(`scripts/promote.sh ${two}`)
      expect(remoteDeploy()).toBe(one)
    })

    it('walks past two stacked marker commits', () => {
      run(promote, [one], repo)
      release('1.0.0')
      const result = run(promote, [release('1.0.1', 'ci skip')], repo)
      expect(result.status).toBe(1)
      expect(result.output).toContain(`scripts/promote.sh ${two}`)
    })

    it('reports nothing deployable for a marker commit directly above the deploy tip', () => {
      run(promote, [two], repo)
      const result = run(promote, [release('1.0.0')], repo)
      expect(result.status).toBe(1)
      expect(result.output).toContain('no deployable commit ahead of deploy')
      expect(result.output).not.toContain('Run instead')
      expect(remoteDeploy()).toBe(two)
    })

    it('reports nothing deployable for stacked marker commits above the deploy tip', () => {
      run(promote, [two], repo)
      release('1.0.0')
      const result = run(promote, [release('1.0.1')], repo)
      expect(result.status).toBe(1)
      expect(result.output).toContain('no deployable commit ahead of deploy')
    })

    it('reports nothing deployable when there is no deploy branch and only marker history', () => {
      git(repo, 'checkout', '-q', '--orphan', 'fresh')
      git(repo, 'commit', '-q', '--allow-empty', '-m', `chore(release): 0.1.0 ${marker('skip ci')}`)
      git(repo, 'push', '-q', '--force', 'origin', 'HEAD:main')
      const result = run(promote, [git(repo, 'rev-parse', 'HEAD')], repo)
      expect(result.status).toBe(1)
      expect(result.output).toContain('no deployable commit ahead of deploy')
      expect(remoteHasDeploy()).toBe(false)
    })

    it('still promotes an ordinary commit', () => {
      const sha = commitOnMain('feat: something')
      const result = run(promote, [sha], repo)
      expect(result.status, result.output).toBe(0)
      expect(remoteDeploy()).toBe(sha)
    })

    it('is not blocked by a marker in a commit below the head of the range', () => {
      run(promote, [one], repo)
      release('1.0.0')
      const sha = commitOnMain('feat: after the release')
      const result = run(promote, [sha], repo)
      expect(result.status, result.output).toBe(0)
      expect(remoteDeploy()).toBe(sha)
    })

    it('refuses under --dry-run too and prints no push', () => {
      const result = run(promote, ['--dry-run', release('1.0.0')], repo)
      expect(result.status).toBe(1)
      expect(result.output).toContain('carries the skip-CI marker')
      expect(result.output).toContain(`scripts/promote.sh ${two}`)
      expect(result.output).not.toContain('would run')
      expect(remoteHasDeploy()).toBe(false)
    })
  })
})

describe('the wiring', () => {
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const guardCall = 'bash scripts/require-deploy-checkout.sh && '
  const workflows = readdirSync(join(root, '.github/workflows')).filter((file) => file.endsWith('.yml'))
  const triggerOf = (file: string) => read(`.github/workflows/${file}`).split('\njobs:')[0]

  // Wrangler commands that change a Cloudflare account: a Worker deploy, or anything that
  // writes to D1, secrets or Access-adjacent resources (argus-config#519: migrations are a
  // manual path, run from a deploy checkout). `--local` runs touch only a local file.
  const remoteWrangler =
    /wrangler (deploy|versions deploy|rollback|delete|secret|d1 (create|delete|migrations apply|execute|import|time-travel))\b/
  const pagesOrWorkerDeploy = /wrangler (pages )?deploy|pages deploy/

  it('starts every package.json script that writes to Cloudflare with the guard', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    const writing = Object.entries(scripts).filter(
      ([, command]) => remoteWrangler.test(command) && !command.includes('--local'),
    )
    // Reads the scripts it should guard: a rename that hid one would otherwise pass.
    expect(writing.map(([name]) => name).sort()).toEqual(['db:migrate', 'deploy'])
    const unguarded = writing.filter(([, command]) => !command.startsWith(guardCall)).map(([name]) => name)
    expect(unguarded).toEqual([])
  })

  it('targets the remote D1 database only from the guarded migrate script', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    expect(scripts['db:migrate']).toContain('wrangler d1 migrations apply atto1 --remote')
  })

  // The one workflow that deploys (argus-config#1048, atto1#58). It reaches Cloudflare only
  // through the guarded package.json scripts, so the guard stays the single check.
  const deployFile = 'deploy.yml'
  const others = workflows.filter((file) => file !== deployFile)

  it('has no workflow other than deploy.yml that migrates a database or holds a Cloudflare credential', () => {
    for (const file of others) {
      const text = read(`.github/workflows/${file}`)
      expect(text, file).not.toMatch(/wrangler d1|d1 migrations/)
      expect(text, file).not.toMatch(/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)/)
      expect(text, file).not.toMatch(/supabase/i)
    }
  })

  describe('deploy.yml (deploys on promotion, argus-config#1048)', () => {
    const text = () => read(`.github/workflows/${deployFile}`)
    const onBlock = () => text().split(/^jobs:/m)[0].split(/^on:/m)[1] ?? ''

    it('exists', () => {
      expect(workflows).toContain(deployFile)
    })

    it('triggers on a push to deploy and on a manual dispatch, and nothing else', () => {
      const trigger = onBlock()
      expect(trigger).toContain('branches: [deploy]')
      expect(trigger).toMatch(/^ {2}workflow_dispatch:/m)
      expect(trigger).not.toMatch(/pull_request|schedule:|workflow_run|branches:.*main/)
    })

    it('has no path filter, so a promotion whose files miss a filter is not silently skipped', () => {
      expect(onBlock()).not.toContain('paths')
    })

    it('refuses any ref other than deploy and a release tag, which covers a dispatch from main', () => {
      const body = text()
      expect(body).toContain("github.ref == 'refs/heads/deploy'")
      expect(body).toContain("github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/tags/v')")
      expect(body).not.toMatch(/github\.ref == 'refs\/heads\/main'/)
      expect(body).not.toMatch(/startsWith\(github\.ref, 'refs\/heads/)
    })

    // The ops hub's "Roll back" card dispatches deploy.yml at a release tag (argus#1178). The job's
    // checkout is that tag, which is the code to redeploy; the guard is told the tag and accepts
    // it only if `deploy` already held that commit.
    it('tells the guard which tag it is rolling back to, on the two steps that run the guard', () => {
      const body = text()
      const tagEnv = "DEPLOY_ROLLBACK_TAG: ${{ github.ref_type == 'tag' && github.ref_name || '' }}"
      const guarded = body.split(/^ {6}- /m).slice(1).filter((step) => /run: pnpm run (db:migrate|deploy)\b/.test(step))
      expect(guarded).toHaveLength(2)
      for (const step of guarded) expect(step, step.split('\n')[0]).toContain(tagEnv)
      expect(body.split(tagEnv)).toHaveLength(3)
    })

    it('builds the dispatched ref, so a tag dispatch redeploys the tag and a push deploys deploy', () => {
      const checkout = text().split(/^ {6}- /m).find((step) => step.startsWith('uses: actions/checkout'))
      expect(checkout).toBeDefined()
      expect(checkout).not.toMatch(/\bref:/)
    })

    it('runs the guarded scripts: migrate, then deploy, never wrangler directly', () => {
      const body = text()
      const migrate = body.indexOf('run: pnpm run db:migrate')
      const deploy = body.indexOf('run: pnpm run deploy')
      expect(migrate).toBeGreaterThan(-1)
      expect(deploy).toBeGreaterThan(migrate)
      expect(body).not.toMatch(/run:.*wrangler (deploy|d1)/)
    })

    it('tests before it deploys', () => {
      const body = text()
      expect(body.indexOf('run: pnpm run test')).toBeGreaterThan(-1)
      expect(body.indexOf('run: pnpm run test')).toBeLessThan(body.indexOf('run: pnpm run db:migrate'))
    })

    it('takes its credentials from repository secrets, on the steps that need them only', () => {
      const body = text()
      expect(body).toContain('secrets.CLOUDFLARE_API_TOKEN')
      expect(body).toContain('secrets.CLOUDFLARE_ACCOUNT_ID')
      expect(body).not.toMatch(/^env:/m)
      expect(body).not.toMatch(/^ {4}env:/m)
      for (const step of body.split(/^ {6}- /m).slice(1)) {
        const needsCredential = /run: pnpm run (db:migrate|deploy)\b/.test(step)
        expect(/CLOUDFLARE_API_TOKEN/.test(step), step.split('\n')[0]).toBe(needsCredential)
      }
    })

    it('serialises deploys and never cancels one midway', () => {
      expect(text()).toContain('group: deploy-atto1')
      expect(text()).toContain('cancel-in-progress: false')
    })

    it('pins the wrangler it installs to the version atto1 was built against', () => {
      expect(text()).toMatch(/wrangler@\d+\.\d+\.\d+/)
    })

    it('never names the skip-CI marker literally', () => {
      for (const file of workflows) {
        expect(read(`.github/workflows/${file}`), file).not.toMatch(
          /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i,
        )
      }
    })
  })

  it('keeps Supabase out of the repo: no dependency, no client, no migration directory', () => {
    const manifest = read('package.json')
    expect(manifest).not.toMatch(/supabase/i)
    expect(existsSync(join(root, 'supabase'))).toBe(false)
    expect(existsSync(join(root, 'src/lib/supabase.ts'))).toBe(false)
  })

  it('runs any workflow that deploys to Cloudflare on the deploy branch only', () => {
    for (const file of workflows) {
      if (!pagesOrWorkerDeploy.test(read(`.github/workflows/${file}`))) continue
      expect(triggerOf(file), file).toContain('branches: [deploy]')
      expect(triggerOf(file), file).not.toContain('branches: [main]')
    }
  })

  it('keeps CI on main: a merge builds and tests, and changes nothing in production', () => {
    expect(triggerOf('ci.yml')).toContain('branches: [main]')
  })

  // argus-config#1048, atto1#65: versions are cut when the owner promotes, one per
  // promotion, and never by a merge to main.
  describe('release.yml (cuts a version on promotion)', () => {
    // Comment lines explain the workflow and may name what it avoids; only code counts.
    const withoutComments = (text: string) => text.replace(/^\s*#.*$/gm, '')
    const release = () => withoutComments(read('.github/workflows/release.yml'))
    const releaseConfig = () =>
      JSON.parse(read('.releaserc.json')) as { branches: string[]; plugins: (string | [string, unknown])[] }
    const pluginNames = () => releaseConfig().plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin))

    it('triggers on a push to deploy and on a manual dispatch, and nothing else', () => {
      const trigger = withoutComments(triggerOf('release.yml'))
      expect(trigger).toContain('branches: [deploy]')
      expect(trigger).not.toContain('main')
      expect(trigger).toContain('workflow_dispatch:')
      expect(trigger).not.toContain('pull_request')
    })

    it('refuses any ref other than deploy, which covers a dispatch from main', () => {
      expect(release()).toContain("if: github.ref == 'refs/heads/deploy'")
    })

    it('has no commit-list filter: the push event lists 20 commits at most, a promotion can ship more', () => {
      expect(release()).not.toContain('github.event.commits')
    })

    it('releases from deploy only', () => {
      expect(releaseConfig().branches).toEqual(['deploy'])
    })

    it('never commits back: deploy is fast-forwarded from main, so a release commit would fork it', () => {
      expect(pluginNames()).not.toContain('@semantic-release/git')
      expect(pluginNames()).not.toContain('@semantic-release/changelog')
      expect(pluginNames()).not.toContain('@semantic-release/npm')
    })

    it('still analyses commits, writes notes and publishes the GitHub release', () => {
      expect(pluginNames()).toEqual([
        '@semantic-release/commit-analyzer',
        '@semantic-release/release-notes-generator',
        '@semantic-release/github',
      ])
    })

    it('holds no Cloudflare credential: a release is not a deploy', () => {
      expect(release()).not.toMatch(/CLOUDFLARE_|wrangler/)
    })
  })
})

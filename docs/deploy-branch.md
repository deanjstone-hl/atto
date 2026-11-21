---
summary: "How atto1 changes production: only when the owner promotes main to the deploy branch, which runs deploy.yml (D1 migrations, then the Worker); promote, roll back, replay, the break-glass manual deploy, the first-time D1, Access and secrets setup"
read_when:
  - "promoting, deploying or rolling back anything in atto1"
  - "applying a D1 migration or deploying the Worker"
  - "creating the D1 database or the Access application"
  - "asking why a merge to main did not deploy"
  - "a promotion that deployed nothing, or replaying deploy.yml"
---

# atto1: the deploy branch

Production changes only from the `deploy` branch. Merging to `main` builds and tests, and
changes nothing in production and cuts no version. A version is cut when the owner promotes. The owner moves `deploy` forward to a
commit that is already on `main`. Model and decisions: argus-config#504 (map), #506, #507,
#508, #509, #519, #548. Pilot: myargus (argus-config#510). Roll-out here: argus-config#603
(agent work) and #523 (owner steps). Decision record: [ADR-004](decisions/adr-004-deploy-only-from-the-deploy-branch.md).

## What runs where

| Event | Workflow | Result |
|---|---|---|
| PR to `main` | `ci.yml` | lint, build, test |
| push to `main` | `ci.yml` | the same checks; no tag, no release, no deploy |
| push to `deploy` | `release.yml` | `Test before release`, then semantic-release tags the promoted SHA and publishes the GitHub Release: one version per promotion (atto1#65, #70) |
| push to `deploy` | `deploy.yml` | typecheck, lint, test, then `pnpm run db:migrate` and `pnpm run deploy`: the promotion is the deploy (argus-config#1048) |
| manual dispatch | `deploy.yml`, `release.yml` | the same job, refused unless the ref is `deploy` (replay, below) |

## Versions

`release.yml` runs on every push to `deploy` and asks semantic-release for the next version
from the commits since the last tag. A red or untested SHA never gets one: `Release` `needs:`
the `Test before release` job (argus-config#1167, amended by #1198, atto1#70), which does one of
three things:

- **Nothing releasable** (no `feat`, `fix`, `perf`, `revert` or breaking commit since the last tag):
  no test and no version; the run ends green.
- **Reuse main's run** (`Test before release (main CI on this SHA)`): `scripts/ci/release-proof.sh`
  reuses the green `CI` run on `main` from a push of the exact promoted SHA, when every other
  `main` run on that SHA is green too. A pull_request run never counts. A red `main` run on the
  SHA fails the job, so nothing releases.
- **Otherwise run the gate** (`Test before release (bats, lint, build and typecheck, unit tests)`):
  no full green `main` run yet (still running, skipped, cancelled, API error), so `pnpm run check`
  runs on the promoted SHA.
 A `fix`, `feat`, `perf` or `revert` commit, or a
breaking change, among the promoted commits releases a patch, minor or major. A promotion
of only `chore`, `docs`, `ci`, `refactor` or `test` commits deploys and cuts no version.
Two promotions are two versions at most, however many commits each holds.

semantic-release only tags and publishes the GitHub Release. It commits nothing back to
`deploy` (a commit there would fork it from `main`), and the github plugin comments on and labels
no issue (`successComment`, `failComment`, `releasedLabels` are false in `.releaserc.json`):
commit messages cite `#N` refs that point at other repos' issues, which the plugin cannot
resolve, and its success step would end the job red after the tag was cut. `package.json` `version` and
`CHANGELOG.md` stop at 1.3.1, the last release made from `main`; the release notes on
GitHub are the changelog from here on. The job has no commit-list filter, because a push
event lists 20 commits at most and a promotion can ship more.

Retry a release whose run failed (the next promotion only tags what is new since the last
tag, so a failed one is otherwise skipped):

```bash
gh workflow run release.yml --ref deploy
gh run list --workflow release.yml --limit 3
```

`deploy.yml` runs the two guarded `package.json` scripts, so `scripts/require-deploy-checkout.sh`
still checks that the checkout is exactly what `origin/deploy` holds; if `deploy` moved on
while a run was queued, the run stops and the newer run deploys. It has no path filter (one
target) and serialises runs (`concurrency: deploy-atto1`, never cancelled midway).

atto1 has no production deploy yet: no D1 database, no Access application and no Worker
(ADR-005), and the repository secrets below are not set. Until the first-time setup is done a
promotion's run fails at the migrate step, on purpose, and changes nothing.

## See what is merged but not deployed

```bash
git fetch origin && git log --oneline origin/deploy..origin/main
```

## Promote

Run it from a T3 **approval-required** thread or a terminal. The deploy gate asks for live
approval there and denies it in every other permission mode (argus-config#548).

```bash
scripts/promote.sh --dry-run <sha>   # what would ship, and the exact push
scripts/promote.sh <sha>             # git push origin <sha>:refs/heads/deploy
gh run list --branch deploy --limit 5
```

`<sha>` is any commit on `origin/main`, not only a release tag. `scripts/promote.sh main`
promotes the tip. The push is fast-forward only: the script refuses a SHA that is not on
`main` or that would move `deploy` backwards.

It also refuses a commit whose message carries the skip-CI marker (a bracketed skip phrase,
or a `skip-checks: true` trailer), under `--dry-run` too. GitHub runs no workflow for a
push whose head commit carries the marker. The release bot used to add it to the
`chore(release)` commits it made on `main`, and those commits are still in history, so
promoting one moves `deploy` and runs nothing (argus-config#1060). The refusal prints the nearest commit below it without the marker and
the command to run, `scripts/promote.sh <that-sha>`. The script never swaps the SHA itself:
the deploy gate approves the literal command, so it must be the SHA you read. When no such
commit is ahead of `deploy`, there is nothing deployable yet.

## Replay a promotion that deployed nothing

`deploy.yml` also has a `workflow_dispatch`, so a promotion whose head commit carried the
skip-CI marker (promoted by hand around `promote.sh`) can be replayed without moving
`deploy`. The job refuses any ref other than `deploy` (or a release tag, see Roll back):

```bash
gh workflow run deploy.yml --ref deploy
gh run list --workflow deploy.yml --limit 3
```

Run it from an approval-required thread or a terminal, like any deploy.

## Roll back

A rollback is a deploy, and it never force-pushes `deploy`:

1. `git revert <bad-sha>` on a branch, open a PR, merge it to `main`.
2. `scripts/promote.sh <the revert's SHA on main>`.

A migration is not undone by a revert. Write a new migration that reverses it.

The ops hub's Roll back card is a second path, an owner step like any deploy: it dispatches
`deploy.yml` at a release tag (`vX.Y.Z`), and `deploy` stays where it is. The job accepts a
tag ref as well as `deploy`, builds that tag, and tells `scripts/require-deploy-checkout.sh`
the tag in `DEPLOY_ROLLBACK_TAG`. The guard then requires HEAD to be the tag's commit on
origin and `origin/deploy` to already hold that commit, so a rollback never ships an
unpromoted commit. A dispatch from any branch is still refused. It works only for releases cut
after this change: the workflow at an older tag has no tag dispatch. `db:migrate` runs as
usual and finds nothing new at an older tag; it never reverses a migration.

## First-time setup (owner, once)

Nothing below exists until the owner runs it. Agents prepare it and never run it. Wrangler
is a global tool (ADR-002); `wrangler login` or a `CLOUDFLARE_API_TOKEN` from Bitwarden
supplies the credentials, never a file in the repo.

**Status (7 Nov 2026, atto1/72):** first-time setup is done. The D1 database `atto1` exists (region OC), the Access application `atto1` (self-hosted, `atto1.myargus.cc`, one "owner only" Allow policy, 168h session) exists, and the Cloudflare credentials were set from the `ci-deploy-atto1` token, which is kept in Bitwarden Secrets Manager (since atto/10 they reach CI as the `actions` keys `ATTO_CLOUDFLARE_API_TOKEN` and `ATTO_CLOUDFLARE_ACCOUNT_ID`).

**None of those ids is in the tree.** `wrangler.jsonc` holds `@@ATTO_…@@` placeholders; where this list says
"put it in `wrangler.jsonc`", store it in Bitwarden Secrets Manager
instead (`ATTO_D1_DATABASE_ID`, `ATTO_ACCESS_AUD`, `ATTO_ACCESS_TEAM_DOMAIN`, see [public-cutover.md](public-cutover.md)),
in the `actions` project: the deploy workflow reads them with `bitwarden/sm-action` (by secret id, mapped in
`deploy.yml`; atto/10), hands them to the two wrangler steps as environment variables and
`scripts/render-wrangler.ts` renders them into the gitignored `wrangler.deploy.jsonc`. The one Actions secret
involved is `BWS_ACCESS_TOKEN`. A new key needs a secret in `actions` and an `<id> > <NAME>` line in `deploy.yml`,
or the render step stops on an empty value.

1. **Create the database**, then store the `database_id` it prints in Secrets Manager as
   `ATTO_D1_DATABASE_ID`:

   ```bash
   wrangler d1 create atto1
   ```

2. **Create the Access application** for `atto1.myargus.cc`. In Cloudflare Zero Trust,
   Access > Applications > Add an application > Self-hosted, domain `atto1.myargus.cc`, one
   Allow policy naming the owner's email (or identity-provider group), nothing else. Then
   store two values in Secrets Manager:
   - `ATTO_ACCESS_AUD`: the application's **Audience (AUD) tag** (the application's overview page).
   - `ATTO_ACCESS_TEAM_DOMAIN`: your team domain, `<team>.cloudflareaccess.com` (Settings > Custom Pages).

   Neither is a credential, but both name the owner's Cloudflare account, so neither is committed.
   While either is empty the Worker answers 503 to everything.
3. **Store the two Cloudflare credentials** `deploy.yml` reads, in the `actions` project of Secrets Manager as
   `ATTO_CLOUDFLARE_API_TOKEN` and `ATTO_CLOUDFLARE_ACCOUNT_ID`, and map their ids in the `secrets:` block of
   `deploy.yml` (`<id> > CLOUDFLARE_API_TOKEN`, `<id> > CLOUDFLARE_ACCOUNT_ID`). Create a Cloudflare API token
   (My Profile > API Tokens > Create Token) with `Workers Scripts: Edit`, `D1: Edit` and
   `Workers Routes: Edit` on the account and the `myargus.cc` zone, and keep it in Bitwarden.
   The account id is on the Cloudflare dashboard, Workers & Pages overview. The workflow
   exposes them only to the migrate and deploy steps.
4. **Promote** the change (below). `deploy.yml` renders the config from Secrets Manager.

## Break-glass: apply D1 migrations and deploy the Worker by hand

The normal path is `deploy.yml` on a promotion. These scripts are the break-glass path for a
failed run or an unavailable runner (argus-config#519). Run them from a checkout of `deploy`,
with live approval, and say why the workflow was not used:

```bash
git fetch origin deploy && git switch --detach origin/deploy
pnpm install --frozen-lockfile
set -a; . ~/.bws_token; set +a   # BWS_ACCESS_TOKEN, so scripts/render-wrangler.ts can read the ATTO_* values by name
pnpm run db:migrate     # require-deploy-checkout.sh, render wrangler.deploy.jsonc, then wrangler d1 migrations apply atto1 --remote
pnpm run deploy         # require-deploy-checkout.sh, pnpm run build, render wrangler.deploy.jsonc, then wrangler deploy
```

Check it:

```bash
curl -sI https://atto1.myargus.cc/api/me | head -3     # 302 to <team>.cloudflareaccess.com: Access is in front
curl -s -o /dev/null -w '%{http_code}\n' https://atto1.<account>.workers.dev/api/me   # no route: workers_dev is off
```

Then sign in through the browser: the dashboard should load, empty, with an "Add vehicle"
button. Add the vehicle, charges, range readings and features there; no manual seeding is
needed.

The guard refuses when `origin/deploy` does not exist, `HEAD` is a different commit, tracked
files are modified or origin is unreachable. Read-only checks are not production changes:
`wrangler d1 migrations list atto1 --remote`, `wrangler deploy --dry-run`, and anything with
`--local`, such as `wrangler d1 migrations apply atto1 --local` to rehearse a migration
against Wrangler's local D1.

A migration is not undone by a revert: add a new migration that reverses it.

## Tests

`scripts/deploy-branch.test.ts` covers `promote.sh` (including the skip-CI marker refusal) and the guard against throwaway repos,
and the wiring: every remote `wrangler` write in `package.json` (`db:migrate`, `deploy`)
starts with the guard, no workflow but `deploy.yml` runs D1 commands or holds a Cloudflare
credential, `deploy.yml` triggers on `deploy` and a dispatch only, refuses any other ref, runs
migrate then deploy through those guarded scripts, scopes the credentials to those two steps,
no Supabase remains, and any workflow that deploys to Cloudflare triggers on `deploy` only.
It also pins `release.yml`: it triggers on `deploy` and a dispatch only, refuses any other ref,
has no commit-list filter, has no `workflow_run` trigger, serialises on `concurrency: release`,
gates `Release` on the proof or the check, holds no Cloudflare credential, and `.releaserc.json` releases from
`deploy` with no plugin that commits back. `scripts/check-wiring.test.ts` pins the `Test before release` jobs and `scripts/ci/release-scripts-check.sh` (run by `ci.yml`) fails on a hand-edited copy of the vendored release scripts, whose bodies argus-config tests. `worker/config.test.ts` pins the `wrangler.jsonc` settings that keep the Worker behind Access, and that it holds only Secrets Manager placeholders and is deployed only through the rendered copy. `scripts/render-wrangler.test.ts`, `scripts/scrub-scan.test.ts`, `scripts/ci/install-bws.test.ts`, `scripts/public-safe.test.ts` (no self-hosted job, no `pull_request_target`, no secret in a pull-request workflow) and `scripts/owner-steps/108.test.ts` cover the public-repo changes ([public-cutover.md](public-cutover.md)).

## Gotchas

- **A push made with `GITHUB_TOKEN` triggers no other workflow.** A workflow that moved
  `deploy` would move the branch and deploy nothing. Promotion is a local push with the
  owner's own credentials; `promote.sh` refuses to run inside GitHub Actions.
- **A push whose head commit carries the skip-CI marker runs no workflow.** `promote.sh`
  refuses it (above); if one is pushed anyway, replay it with the dispatch (above).
- **Never squash-merge `main` into `deploy`.** It would fork the branches. Promotion is a
  fast-forward push only.
- **Keep Cloudflare's Git integration off.** If a Workers Builds or Pages Git connection is
  ever attached to this repo, it deploys every push to its production branch. Deploys come
  from `pnpm run deploy` on a `deploy` checkout, or from a workflow that triggers on
  `deploy` only.
- **Creating `deploy` runs `deploy.yml` once.** Until the first-time setup is done it fails
  at the migrate step and changes nothing.

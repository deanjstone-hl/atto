---
title: ADR-004 — Production changes only from the deploy branch
status: accepted
date: 2026-10-25
context: argus-config#504 (model), #603 (atto1 roll-out)
summary: "ADR-004: atto1 changes production only by promoting main to the deploy branch; binds the manual production paths (D1 migrations, Worker deploy, per ADR-005) to it"
read_when:
  - wiring up the Cloudflare Pages deploy
  - applying a Supabase migration to a remote project
  - asking why a merge to main did not deploy
---

# ADR-004: Production changes only from the deploy branch

> **Amended by [ADR-005](adr-005-d1-worker-behind-access.md).** The two production paths
> below are now a D1 migration (`pnpm run db:migrate`) and a Worker deploy
> (`pnpm run deploy`), both behind the same guard. Read "Supabase migrations" and
> "Cloudflare Pages" as those. The promotion model is unchanged.

## Context

Agents squash-merge their own green PRs, so a merge to `main` that deploys is also an
unattended production change. The account-wide model (argus-config#504, decisions #506,
#507, #508, #509, #519, #548) makes production move only when the owner promotes a commit
on `main` to a `deploy` branch, with live approval at a harness prompt. atto1 is in scope
(#507) for two production paths: Supabase migrations and the Cloudflare Pages site planned
in [ADR-001](adr-001-deploy-via-myargus-subdomain.md).

Neither path exists yet. There is no Supabase project ([#2](https://github.com/deanjstone/atto1/issues/2)),
no Pages project and no deploy workflow, so nothing in atto1 deploys from `main` today.
This ADR fixes how both will bind to `deploy` before either is built.

## Decision

- **Promotion.** `scripts/promote.sh <sha>` fast-forwards `deploy` to a SHA already on
  `origin/main` (#509). `deploy` never moves backwards and is never force-pushed. A rollback
  is a revert on `main`, then a new promotion. The script refuses to run in GitHub Actions,
  because a push made with `GITHUB_TOKEN` triggers no other workflow.
- **Supabase migrations** are a manual path (#519). `pnpm run db:push` runs
  `scripts/require-deploy-checkout.sh` and then `supabase db push`; the guard refuses unless
  the checkout's `HEAD` is what `origin/deploy` holds and tracked files are clean. There is
  no CI migration job and CI holds no database credential. Live approval at the harness
  prompt is required as well (#508, #548).
- **Cloudflare Pages** (amends ADR-001's plan). When the Pages project is built, its
  workflow triggers on `push: [deploy]` only and publishes with
  `wrangler pages deploy dist --branch=main`, so a deploy push is the production deploy
  and no Cloudflare setting names `deploy`. The project uses direct upload. Cloudflare's own
  Git integration is not connected, because it would deploy every push to its production
  branch. PR previews, if wanted, run on `pull_request` as in myargus.
- `ci.yml` (build, test) stays on `main`. `release.yml` (semantic-release) moved to
  `push: [deploy]` with atto1#65 (argus-config#1048): one version per promotion, and a
  chore/docs-only promotion cuts none. A release is still not a deploy: `release.yml` holds
  no Cloudflare credential, and it commits nothing back to `deploy` (#507).

## Consequences

- `scripts/deploy-branch.test.ts` enforces the wiring: `promote.sh` and the guard against
  throwaway repos, every `supabase` write in `package.json` behind the guard, no workflow
  holding a database credential, and any Cloudflare deploy workflow on `deploy` only.
- The first promotion creates `deploy` at `main`. Until the Pages workflow exists it ships
  nothing; it still proves the promotion path and that the guard sees `deploy`.
- The ADR-001 consequences stand, with the Pages workflow built to the shape above.
- A raw `supabase db push` typed at a shell is not covered by the package script; the
  account-wide deploy gate hook still holds it for live approval.

# atto1

This file provides guidance to coding agents when working with code in this repository.

## Commands

```bash
pnpm run dev       # start dev server (Vite HMR)
pnpm run build     # tsc -b && vite build
pnpm run lint      # oxlint --type-aware
pnpm run preview   # preview production build
pnpm run typecheck # tsc -b
pnpm test          # vitest run (unit tests + migration and Worker tests against in-process SQLite)
pnpm run check     # the one local gate (scripts/check.sh): bats, lint, build, test. Run it before every push to main
bash scripts/scrub-scan.sh   # gitleaks + personal-data rules over tracked and new files; must print "pass"
```


## Deploying

Production changes only from the `deploy` branch (argus-config#504). A merge to `main` builds, tests and releases, and changes nothing in production. The owner promotes (the ops hub approval, or `scripts/promote.sh <sha>` from a T3 approval-required thread or a terminal); the push to `deploy` runs `.github/workflows/deploy.yml`, which applies the D1 migrations and deploys the Worker. The `package.json` scripts below stay as break-glass. Agents never promote, never run `gh workflow run deploy.yml`, never create or push `deploy`, and never run `pnpm run db:migrate` (`wrangler d1 migrations apply --remote`), `pnpm run deploy` (`wrangler deploy`) or any other Wrangler command that changes the Cloudflare account (creating the D1 database, the Access application, secrets). Rollback is a revert on `main`, then a new promotion. See `docs/deploy-branch.md` and ADR-004.

## Environment

There are no environment variables. This repository is public (`docs/public-cutover.md`), so the tree holds
**no private value**: no tailnet or LAN address, email, Cloudflare id, Access team
domain or audience, and no fixture that looks like one (build it at run time). Private values live in
Bitwarden Secrets Manager and are read by name; run `bash scripts/scrub-scan.sh` before a push that
adds one. The app is served by a Cloudflare Worker (`worker/`) behind
Cloudflare Access, over a D1 database (ADR-005). The Worker's only settings are `ACCESS_TEAM_DOMAIN`
and `ACCESS_AUD`, `vars` in `wrangler.jsonc` held as `@@<bws secret name>@@` placeholders that
`scripts/render-wrangler.ts` fills at deploy time from the environment, which `deploy.yml` fills from plain Actions secrets (`.env.example` lists them); empty, the Worker refuses every request. Two more,
`INGEST_CLIENT_ID` and `INGEST_OWNER_SUBJECT`, name the BYD collector's one Access service token (ADR-006);
empty, every service token is refused. CI stays safe for fork pull requests: every job runs on
`ubuntu-latest`, never `self-hosted`, no `pull_request_target`, no secret in a pull-request workflow
(`scripts/public-safe.test.ts`). The collector (`collector/`, run by a homelab timer) reads
`BYD_USERNAME`, `BYD_PASSWORD`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and `ATTO1_BATTERY_KWH`,
the first four from Bitwarden Secrets Manager by name; optional `ATTO1_BYD_BASE_URL` and `ATTO1_BYD_COUNTRY` name the BYD regional node for a non-AU account (default AU); see `docs/byd-collector.md`. Never run the reader
with the owner's main account, never add a pybyd command method to it, and never run it from CI.
`pnpm run dev` answers `/api/*` from fixtures (`vite.config.ts`), with no Worker, database or sign-in.

## Stack

- **Vite 8** + **React 19** + **TypeScript 6**
- **Tailwind CSS v4** — loaded via `@tailwindcss/vite` plugin (no `tailwind.config.*`; config lives in CSS via `@import "tailwindcss"`)
- **Cloudflare Worker + D1 (SQLite)** — the API and the host (`worker/`, `migrations/`, `wrangler.jsonc`); Cloudflare Access signs the owner in. Wrangler is a global tool (ADR-002), not a dependency.

## Project purpose

EV tracking app — planned features: charging sessions, range, vehicle specs, maintenance log, notes, dashboard. Data model defined in `migrations/` (D1, ADR-005) and mirrored in `src/lib/data-model/` (ADR-003). The dashboard (`src/components/dashboard/`) loads through `GET /api/dashboard` (`worker/dashboard.ts`, called by `src/lib/api.ts`) and is shaped by `src/lib/dashboard/shape.ts`. Entry forms (`src/components/entry/`) add a vehicle, charging sessions, range readings and features through `POST /api/vehicles`, `/api/charging-sessions`, `/api/range-observations` and `/api/vehicle-features` (`worker/writes.ts`). Writes only add rows, are bound to the Access `sub`, and share their rules with the forms through `src/lib/data-model/validation.ts`; there is no update or delete.

## Project goals

- **One-stop shop for the ATTO1**: track mileage and charging patterns, and serve as an easy-access knowledge source for vehicle manuals — not just a trip/session log.
- **Data privacy over BYD telemetry**: audit what data the BYD integration automatically shares back to BYD and provide a way to limit/disable it. Tracked as issue 10 of the archived `atto1`.

## Key architecture notes

- `src/lib/api.ts` is the browser's only data-access entry point; it calls the Worker. The Worker (`worker/index.ts`) verifies the Cloudflare Access token before anything else (`worker/access.ts`) and every D1 query binds the caller's `user_id`; that is the authorisation. Never serve a route that skips `verifyAccess`, and never add a bypass flag for local development.
- Tailwind v4 uses CSS-first config (`src/index.css`), not a JS config file. Add design tokens via `@theme` blocks in CSS.
- `src/components/ui/` is vendored from the `deanjstone/design-system` shadcn registry, pinned to a release tag as `@design-system` in `components.json`. Pull or update a component with `pnpm exec shadcn add @design-system/<name>`; bump the tag there to move to a newer release.
- No router installed yet. When adding routing, prefer React Router v7.

**Package manager:** pnpm. Never use npm or yarn. Read `.claude/SYSTEM.md` before making structural changes.

## Governance

**Director-Agent workflow:** All non-trivial work is recorded as a GitHub issue (spec + AI implementation plan), gated on Director approval in chat. `.claude/tasks/` holds only pre-2026-07-17 history. Read `.claude/SYSTEM.md` before making any structural changes.

## Agent skills

### Issue tracker

GitHub Issues (`deanjstone/atto`) — authoritative record for all non-trivial Director-Agent work, and used by `to-tickets`, `wayfinder`, `to-spec`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. ADRs live in `docs/decisions/`, indexed by `docs/DECISIONS.md`. There is no `CONTEXT.md` yet; `/domain-modeling` creates it at the repo root when a term first needs pinning down. See `docs/agents/domain.md`.

## Docs layout

```
docs/
├── DECISIONS.md     # ADR index
├── decisions/       # adr-NNN-*.md
└── agents/          # issue-tracker.md, domain.md (how agent skills use this repo)
```

Every `.md` under `docs/` carries `summary:` and `read_when:` front matter (the docs index in
argus's repo structure standard, argus#444). Add both when you create a doc.

## Repo structure standard

Trimmed tier. This repo follows the account-wide repo structure standard —
`docs/system-specs/common/repo-structure-standard.md` in `argus` — as `AGENTS.md`/`CLAUDE.md`
convention + PR template. Trimmed adds no `docs/` subdirectories; the two above predate the
rollout and stay because they hold real content (ADRs, agent-skill config). Don't add further
`docs/` subdirectories without moving the repo up a tier. `CONTEXT.md` stays optional. See
`CLAUDE.md` for the rollout status marker.

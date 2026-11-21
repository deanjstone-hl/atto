# atto1

A personal companion app for the BYD ATTO 1: one place to track charging sessions, range,
vehicle specs, maintenance and notes, and to keep the car's manuals within easy reach. A second
goal is auditing what the BYD integration shares back to BYD, and limiting it
(issue 10 of the archived `atto1`).

The repository is public and holds no private value: the Cloudflare ids, the Access team domain and
audience, and every credential live in Bitwarden Secrets Manager (BWS) and are read by name
([docs/public-cutover.md](docs/public-cutover.md)). Its history starts from the earlier private
repository `atto1`, which is archived.

## Status

- **Data model:** a Cloudflare D1 (SQLite) schema in `migrations/`, mirrored in
  `src/lib/data-model/` ([ADR-003](docs/decisions/adr-003-data-model.md), moved off Supabase by
  [ADR-005](docs/decisions/adr-005-d1-worker-behind-access.md)). The D1 database `atto1` exists
  and every promotion applies the migrations.
- **API:** a Cloudflare Worker (`worker/`) that verifies Cloudflare Access tokens on every
  request, reads D1 and adds rows to it (`worker/writes.ts`). It also serves the built app, and
  one path (`POST /api/ingest/byd`) for the BYD collector's service token, and the CarPlay trigger
  endpoints: `POST /api/collect/trigger` for the phone's own service token, `GET /api/collect/pending`
  and `POST /api/collect/ack` for the collector's.
- **UI:** a dashboard (vehicle status, recent charging sessions, key specs, range trend and
  trips paired from CarPlay connect and disconnect readings; for the vehicle with the latest
  reading) in
  `src/components/dashboard/`, and entry forms for a vehicle, charging sessions, range
  readings and features in `src/components/entry/`. Entries only add rows; there is no edit
  or delete yet.
- **Deploy target:** `atto1.myargus.cc`, a Worker with static assets behind Cloudflare Access
  ([ADR-001](docs/decisions/adr-001-deploy-via-myargus-subdomain.md), ADR-005). First-time setup
  (D1 database, Access application, repository secrets) is done
  ([docs/deploy-branch.md](docs/deploy-branch.md)). Production changes only from the `deploy`
  branch, never from a merge to `main`
  ([ADR-004](docs/decisions/adr-004-deploy-only-from-the-deploy-branch.md)); see Deploy below.

## Stack

Vite 8, React 19, TypeScript 6, Tailwind CSS v4 (CSS-first config in `src/index.css`), a Cloudflare
Worker over D1, and UI components from the
[`deanjstone/design-system`](https://github.com/deanjstone/design-system) shadcn registry.

## Prerequisites

- Node 22 or later and pnpm (the version is pinned by `packageManager` in `package.json`).
- `bats` on PATH for `pnpm run check`; without it the script fetches `bats@1.10.0` with `pnpm dlx`.
- Wrangler, only for the owner's break-glass deploy: it is a global tool, not a dependency
  ([ADR-002](docs/decisions/adr-002-pnpm-global-cli-tools.md)).

## Getting started

```bash
pnpm install
pnpm run dev
```

The app has no environment variables. The dev server answers `/api/*` from fixture data, with no
Worker, database or sign-in; the Worker and the collector are covered by `pnpm test`.

### Private values

Nothing private is committed. `wrangler.jsonc` holds placeholders named after Bitwarden Secrets
Manager (BWS) secrets, and `scripts/render-wrangler.ts` fills them at deploy time into the
gitignored `wrangler.deploy.jsonc`, which `pnpm run db:migrate` and `pnpm run deploy` hand to
wrangler. A placeholder name is the BWS key and the environment variable at once
(`ATTO_ACCESS_AUD`, the `<REPO>_<KEY>` layout of
[argus-config/1414](https://github.com/deanjstone/argus-config/issues/1414)). Each value comes from
the environment (in CI, `bitwarden/sm-action` exports the Secrets Manager secret of the same name), else, for a
break-glass deploy by hand, from Secrets Manager through `bws secret list` with your own `BWS_ACCESS_TOKEN`.
`.env.example` lists every key.

| BWS secret | Becomes |
|---|---|
| `ATTO_D1_DATABASE_ID` | the D1 `database_id` |
| `ATTO_ACCESS_TEAM_DOMAIN`, `ATTO_ACCESS_AUD` | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (empty or wrong: the Worker refuses every request) |
| `ATTO_INGEST_CLIENT_ID`, `ATTO_INGEST_OWNER_SUBJECT` | `INGEST_CLIENT_ID`, `INGEST_OWNER_SUBJECT` for the BYD collector's service token (empty: no service token is accepted) |
| `ATTO_TRIGGER_CLIENT_ID` | `TRIGGER_CLIENT_ID`, the phone's CarPlay service token (`atto1-carplay-phone`; empty: the phone token is refused) |

`deploy.yml` reads every deploy value from the `actions` project of Secrets Manager through `bitwarden/sm-action` (pinned by commit SHA), with one Actions secret, `BWS_ACCESS_TOKEN`: the token `github-actions` of the machine account `actions-read`, which has Can read on `actions` only ([argus-config/1418](https://github.com/deanjstone/argus-config/issues/1418)). The action looks a secret up by id, so the id-to-variable map sits in one place, the `secrets:` block of the `Read the deploy values from Secrets Manager` step: the six `ATTO_*` values, and wrangler's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, which are the keys `ATTO_CLOUDFLARE_API_TOKEN` (a copy of `ci-deploy-atto1`) and `ATTO_CLOUDFLARE_ACCOUNT_ID`. A new value needs a secret in `actions` and an `<id> > <NAME>` line there. Without the token, or a secret behind an id, `deploy.yml` fails at that step before it changes anything.

The values were moved into `actions` by the owner's one-time step, `scripts/owner-steps/10.sh` (idempotent; `--dry-run` first; it moves each mapped key, keeping its id, and checks each by id). `scripts/owner-steps/10.sh --delete-actions-secrets` deletes the Actions secrets it replaced, once the latest `Deploy` run on `deploy` is green on this path.

`bash scripts/scrub-scan.sh` runs gitleaks with `.gitleaks.toml` (default rules plus tailnet and LAN
addresses, hostnames, emails, mobile numbers, Cloudflare ids and Access team domains) over the
tracked and new files and fails on any hit, without printing a value. Run it before pushing a
change that adds an id, an address or a fixture.

## BYD collector

A timer on the homelab reads the car through a second BYD account, read-only, and posts the
reading to the Worker ([ADR-006](docs/decisions/adr-006-read-only-byd-import-via-second-account.md),
[docs/byd-collector.md](docs/byd-collector.md)). Nothing runs it until the owner turns it on.
The Worker attaches the readings to the vehicle with the car's VIN, or to the owner's only
vehicle when it has none (it fills the VIN in, never the nickname), else it makes one.

| Variable (collector only) | Meaning |
|---|---|
| `BYD_USERNAME`, `BYD_PASSWORD` | The second account's login; else read from Bitwarden Secrets Manager as `atto1-byd-username` and `atto1-byd-password` |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | The `atto1-ingest` service token; else `atto1-ingest-client-id` and `atto1-ingest-client-secret` |
| `ATTO1_BATTERY_KWH` | Pack capacity in kWh; without it charging sessions are not recorded |
| `ATTO1_URL`, `ATTO1_NICKNAME`, `ATTO1_PYTHON`, `ATTO1_VIN` | Optional: Worker URL (default `https://atto1.myargus.cc`), vehicle name (default `ATTO 1`), the Python with pybyd, which vehicle to read |
| `ATTO1_BYD_BASE_URL`, `ATTO1_BYD_COUNTRY` | Optional: the BYD regional node for an account registered outside Australia (default `https://dilinkappoversea-au.byd.auto`, `AU`). A `code=3008` refusal on a new account usually means it has not been signed in to once in the BYD phone app |

```bash
node collector/run.ts   # one run: needs Node 22.18+, pybyd, and the secrets above
```

### CarPlay trips

When the iPhone connects to or leaves CarPlay, an iOS Shortcut posts the event to the Worker with
its own Access service token; a second homelab timer (`atto1-collector-trigger.timer`, every
minute) picks it up, runs the collector once, tags that reading `carplay_connect` or
`carplay_disconnect` and adds the car's position to it (only a triggered reading carries one).
The dashboard's Trips card pairs each connect with the next disconnect. Triggers are debounced:
one run covers everything pending, and no run starts within two minutes of the last. Setup,
in order, and the Shortcut's exact settings: [docs/carplay-shortcut.md](docs/carplay-shortcut.md);
the position amendment: [ADR-006](docs/decisions/adr-006-read-only-byd-import-via-second-account.md).
`bash scripts/owner-steps/7.sh --dry-run` previews the pre-promotion owner step (the Access policy for the phone's token and the `ATTO_TRIGGER_CLIENT_ID` secret); `bash scripts/owner-steps/6.sh --dry-run` previews the homelab install.

## Scripts

| Command | What it does |
|---|---|
| `pnpm run dev` | Vite dev server with HMR |
| `pnpm run build` | `tsc -b && vite build` |
| `pnpm run lint` | oxlint (type-aware) |
| `pnpm run typecheck` | `tsc -b` |
| `pnpm run check` | The one local gate, run before every push to `main` and by CI and, when `main` has no green CI run of the promoted SHA, by Release: bats on the release scripts, lint, build, tests (`scripts/check.sh`). Takes the host-wide heavy lock first ([argus-config/1506](https://github.com/deanjstone/argus-config/issues/1506)): `scripts/check.sh` re-runs itself through `scripts/heavy-lock.sh`, so one full check runs at a time per host, a queued run prints `waiting for the host lock`, and it exits 75 without running once `HEAVY_LOCK_TIMEOUT` (3600 s) passes; `scripts/heavy-lock.sh` and `heavy-lock.lock` are vendored from argus-config (never edit them; its `scripts/sync-heavy-lock.sh` rewrites both). Prints `check: pass <sha>` |
| `pnpm test` | Vitest: unit tests, plus migration and Worker tests against in-process SQLite |
| `pnpm run preview` | Serve the production build |
| `node collector/run.ts` | One collector run: reads the car, posts to the Worker. Owner-enabled; see above |
| `node collector/trigger.ts` | The CarPlay pick-up: asks the Worker for pending triggers and, if there are any, runs the collector once for the newest. Run every minute by `atto1-collector-trigger.timer` |
| `pnpm run db:migrate` | Render `wrangler.deploy.jsonc` from BWS, then apply D1 migrations to the remote database: owner only, from a checkout of `deploy` |
| `pnpm run deploy` | Build, render `wrangler.deploy.jsonc` from BWS and deploy the Worker: owner only, from a checkout of `deploy` |
| `node scripts/render-wrangler.ts` | Write `wrangler.deploy.jsonc` from `wrangler.jsonc` and BWS (see Private values) |
| `bash scripts/scrub-scan.sh` | gitleaks plus the personal-data rules over the tracked and new files; `--head` scans HEAD |

## Deploy

Production changes only from the `deploy` branch; full runbook in
[docs/deploy-branch.md](docs/deploy-branch.md).

1. A change lands on `main`. `ci.yml` runs `pnpm run check` and nothing deploys or releases.
2. The owner promotes: the Approve on the ops-hub promotion card fast-forwards `deploy` to a
   commit already on `main`. Break-glass for a dead hub: `scripts/promote.sh --dry-run <sha>`, then
   `scripts/promote.sh <sha>` (owner's live approval of the exact command; fast-forward only).
3. The push to `deploy` runs `deploy.yml`: install, typecheck, lint, test, then
   `pnpm run db:migrate` and `pnpm run deploy`, with the `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` credentials and the six `ATTO_*` Worker values read from Secrets
   Manager by `bitwarden/sm-action` just before them, scoped to those two steps as environment variables. Both scripts start with
   `scripts/require-deploy-checkout.sh`, which refuses unless the checkout is exactly
   `origin/deploy`.
4. The same push runs `release.yml` (below).

Roll back with `git revert` on `main` plus a new promotion, never a force-push of `deploy`. The
ops hub's Roll back card is the other path: it dispatches `deploy.yml` at a release tag (`vX.Y.Z`)
and redeploys that version without moving `deploy`. The guard accepts the tag only if `deploy`
already held its commit, and only a release cut after this change can be rolled back to. A
migration is not undone by a revert: write a new migration that reverses it. `db:migrate` and
`deploy` run by hand are break-glass, from a checkout of `deploy` with the owner's live approval.

### Releases

A version is cut when the owner promotes, never when a change merges to `main`. `release.yml`
(workflow `Release`) runs on the push to `deploy`, beside `deploy.yml`, and semantic-release tags
one version for the whole promotion (`feat` = minor, `fix`/`perf`/`revert` = patch, a breaking
change = major) and publishes the GitHub Release. A promotion of only chore/docs/ci/test/refactor
commits runs no test and cuts no version. The test before release reuses `main`'s green `CI` run on
the exact promoted SHA (`scripts/ci/release-proof.sh`, with `RELEASE_PROOF_WORKFLOW=CI` set in `release.yml`), or runs `pnpm run check` on it when there is
none; a red `main` run fails it, and `Release` needs it. Nothing is committed back to `deploy`, so
`package.json` `version` and `CHANGELOG.md` stop at 1.3.1 and the GitHub Release notes are the
changelog. The release comments on and labels no issue (`.releaserc.json` turns the github plugin's
`successComment`, `failComment` and `releasedLabels` off). Retry a failed release with `gh workflow run release.yml --ref deploy`.

The release scripts in `scripts/ci/` (`release-with-retry.sh`, `release-proof.sh`, `release-scripts-check.sh`) are vendored from argus-config (`scripts/sync-release-scripts.sh`) and are synced, never edited here; `release-scripts-check.sh` fails CI on a hand-edited copy, and argus-config tests the script bodies.

## Repo layout

| Path | Contents |
|---|---|
| `src/components/dashboard/` | Dashboard UI |
| `src/components/ui/` | Components vendored from the design-system registry |
| `src/lib/dashboard/` | Dashboard data shaping and the API response types |
| `src/lib/api.ts` | The thin client for the Worker's API |
| `src/lib/data-model/` | TypeScript types and validation mirroring the schema |
| `migrations/` | D1 schema |
| `worker/` | The Worker (Access check, API) and its tests, including the schema tests |
| `wrangler.jsonc` | Worker, assets, D1 binding and Access settings, with BWS placeholders for the private values |
| `.env.example`, `.gitleaks.toml` | The BWS key names and placeholders; the scrub rules for `scripts/scrub-scan.sh` |
| `collector/` | The BYD collector: read-only reader, mapping, session detection, systemd units, tests |
| `scripts/` | `check.sh`, `ci/release-with-retry.sh`, `ci/release-proof.sh` (whether Release may reuse main's CI run), `ci/release-scripts-check.sh` and `ci/release-scripts.lock` (the vendored-copy drift check), `promote.sh`, the deploy-checkout guard (it also takes one per-host deploy lock, `~/.cache/argus-deploy.lock`, shared with every repo's guard, so two deploys never overlap; `ARGUS_DEPLOY_LOCK_WAIT` sets the wait, 3600 s), `render-wrangler.ts` (fills the config from BWS), `scrub-scan.sh`, `ci/install-bws.sh` (the pinned, checksum-checked `bws`), `owner-steps/` and their tests |
| `docs/public-cutover.md` | Where each private value lives and how CI stays public-safe |
| `docs/diagrams/` | Architecture, dashboard flow, collector flow, and build and deploy diagrams (self-contained HTML, indexed in its README) |
| `docs/decisions/` | Architecture Decision Records, indexed in `docs/DECISIONS.md` |
| `docs/agents/` | How agent skills use this repo's issue tracker and domain docs |

## Contributing

Work is tracked in [GitHub issues](https://github.com/deanjstone/atto/issues). Agents work trunk-based:
small commits straight to `main`, each after a green `pnpm run check` (CI runs the same command on
every push to `main`; the script resolves the repo root from its own path, so
`bash /path/to/atto/scripts/check.sh` checks this tree from any directory). Commits follow
Conventional Commits and drive semantic-release; see [CONTRIBUTING.md](CONTRIBUTING.md). Agents
start at [AGENTS.md](AGENTS.md).

### Keeping this README current

`.github/workflows/readme-guard.yml` fails a change that alters a workflow, a deploy, install or
promote script, `package.json` scripts, an env template or a CLI entry point without touching a
README. A pull request says why it needs none with a `README: not needed because <reason>` line
in its body; a direct push to `main` does the same in a commit message. The PR template
(`.github/pull_request_template.md`) carries the line. `design-detect.yml` separately flags
contrast and design drift in the UI files a pull request changes; it never blocks a merge.

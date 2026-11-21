---
summary: "atto is a public repository with no private value in the tree: where each private value lives (Bitwarden Secrets Manager ATTO_* keys in the actions project, read by deploy.yml through sm-action), what keeps CI safe against fork pull requests, and the scrub scan"
read_when:
  - "adding an id, an address, an email or a fixture that looks like one to the tree"
  - "changing what the Worker or deploy.yml reads from Secrets Manager"
  - "a fork pull request, a self-hosted runner or a new workflow trigger on this repository"
---

# atto: public, private values in secrets

This repository was published from the private repository `atto1` (now archived) with a fresh history, so
nothing private is in any commit. Keep it that way.

## Where each private value lives

In the `actions` project of Bitwarden Secrets Manager (BWS) as `ATTO_*` keys (the `<REPO>_<KEY>` layout of
[argus-config/1414](https://github.com/deanjstone/argus-config/issues/1414)). `deploy.yml` reads them with
`bitwarden/sm-action` (pinned by commit SHA), using the Actions secret `BWS_ACCESS_TOKEN`, the token of the
read-only machine account `actions-read` (Can read on `actions` only), and the action exports them as masked
environment variables to the two wrangler steps, the last steps of the job. It looks a secret up by id, so the
`secrets:` block of the `Read the deploy values from Secrets Manager` step is the one place that pairs each id
with its variable; an id names a secret and reads nothing without the token, and `.gitleaks.toml` allows a
UUID only on such a `<id> > <NAME>` line. `scripts/owner-steps/10.sh` moved the keys into `actions` (ids
unchanged). A placeholder name in
`wrangler.jsonc` is the environment variable and the BWS key at once; `scripts/render-wrangler.ts` reads each
from the environment at deploy time (by hand it falls back to Secrets Manager with your own token).

| Key (BWS secret in `actions`) | Used by |
|---|---|
| `ATTO_D1_DATABASE_ID` | D1 `database_id` |
| `ATTO_ACCESS_TEAM_DOMAIN` | Worker var `ACCESS_TEAM_DOMAIN` |
| `ATTO_ACCESS_AUD` | Worker var `ACCESS_AUD` |
| `ATTO_INGEST_CLIENT_ID` | Worker var `INGEST_CLIENT_ID` |
| `ATTO_INGEST_OWNER_SUBJECT` | Worker var `INGEST_OWNER_SUBJECT` |
| `ATTO_TRIGGER_CLIENT_ID` | Worker var `TRIGGER_CLIENT_ID`, the phone's CarPlay service token (atto/6; deploy fails closed at the render step while the secret is missing) |

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` come the same way, from the keys `ATTO_CLOUDFLARE_API_TOKEN` (a copy of `ci-deploy-atto1`) and `ATTO_CLOUDFLARE_ACCOUNT_ID`, exported under the names wrangler reads. `pnpm run db:migrate` and
`pnpm run deploy` run `node scripts/render-wrangler.ts`, which writes the gitignored `wrangler.deploy.jsonc`
(mode 600) and passes it to wrangler with `--config`. An unrendered file cannot go live by accident: the
placeholders are not a team domain or an audience, so the Worker refuses every request, and wrangler rejects
the database id. Under GitHub Actions the script first prints `::add-mask::` for each value.

## What keeps CI safe on a public repository

A fork's pull request starts workflows on this repository; secrets are not passed to it; self-hosted runners
"should almost never be used for public repositories". So `scripts/public-safe.test.ts` pins, for every
workflow: `ubuntu-latest` only; no `pull_request_target`; no action from a private repository; no secret but
`GITHUB_TOKEN` in a workflow a pull request starts. `deploy.yml` (push to `deploy`, or a dispatch) is the only
workflow that holds Cloudflare credentials or the Worker values. The fork pull-request approval policy is
`all_external_contributors`.

## The scrub scan

`bash scripts/scrub-scan.sh` runs gitleaks 8 with `.gitleaks.toml`: the default rules plus emails (placeholders
at example.com and similar are allowed), tailnet and LAN addresses, tailnet hostnames, Australian mobile
numbers, Cloudflare ids (32 or 64 hex, UUIDs) and Access team domains. It prints rule, file and line, never a
value. Test fixtures build any value that looks private at run time so the scan stays at zero.

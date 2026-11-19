---
summary: "atto is a public repository with no private value in the tree: where each private value lives (Bitwarden Secrets Manager ATTO_* keys and Actions secrets of the same names), what keeps CI safe against fork pull requests, and the scrub scan"
read_when:
  - "adding an id, an address, an email or a fixture that looks like one to the tree"
  - "changing what the Worker or deploy.yml reads as an Actions secret"
  - "a fork pull request, a self-hosted runner or a new workflow trigger on this repository"
---

# atto: public, private values in secrets

This repository was published from the private repository `atto1` (now archived) with a fresh history, so
nothing private is in any commit. Keep it that way.

## Where each private value lives

In Bitwarden Secrets Manager (BWS) as `ATTO_*` keys (the `<REPO>_<KEY>` layout of
[argus-config/1414](https://github.com/deanjstone/argus-config/issues/1414)), and as plain Actions secrets of
the same names. `deploy.yml` hands the Actions secrets to its two wrangler steps as environment variables, so
CI never calls Secrets Manager: no machine account and no `BWS_ACCESS_TOKEN` secret. A placeholder name in
`wrangler.jsonc` is the environment variable and the BWS key at once; `scripts/render-wrangler.ts` reads each
from the environment at deploy time (by hand it falls back to Secrets Manager with your own token).

| Key (BWS secret and Actions secret) | Used by |
|---|---|
| `ATTO_D1_DATABASE_ID` | D1 `database_id` |
| `ATTO_ACCESS_TEAM_DOMAIN` | Worker var `ACCESS_TEAM_DOMAIN` |
| `ATTO_ACCESS_AUD` | Worker var `ACCESS_AUD` |
| `ATTO_INGEST_CLIENT_ID` | Worker var `INGEST_CLIENT_ID` |
| `ATTO_INGEST_OWNER_SUBJECT` | Worker var `INGEST_OWNER_SUBJECT` |

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are Actions secrets too. `pnpm run db:migrate` and
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

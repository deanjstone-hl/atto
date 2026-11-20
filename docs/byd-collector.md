---
summary: "Runbook for the BYD collector (ADR-006): what it reads, the owner steps that turn it on (Access service token, Secrets Manager entries, timer), the first run, and the audit that shows the grant the second BYD account holds"
read_when:
  - "turning the BYD collector on, off or debugging a failed run"
  - "creating or rotating the atto1-ingest Access service token"
  - "checking what the second BYD account is authorised for"
  - "asking why the dashboard has no collected readings"
---

# The BYD collector

Decision and trade-offs: [ADR-006](decisions/adr-006-read-only-byd-import-via-second-account.md).
The library is [pyBYD](https://github.com/jkaberg/pyBYD) (MIT).

## What it is

Every 30 minutes a systemd timer on the homelab runs `collector/run.ts` once:

1. `collector/read-byd.py` signs in as the **second** BYD account (its email is in Secrets Manager as `atto1-byd-username`) with
   pybyd and prints eight values: VIN, model, online flag, the car's timestamp, state of charge,
   range, odometer and charge state. It calls `get_vehicles` and `get_vehicle_realtime` and
   nothing else.
2. `collector/map.ts` turns that into a `range_observations` row, `collector/sessions.ts` works
   out a `charging_sessions` row when a charge has ended, and `collector/run.ts` posts both to
   `POST /api/ingest/byd` with the `atto1-ingest` service token.
3. It writes `~/.local/state/atto1-collector/state.json` (the last poll time and any open
   charge), only after the Worker accepted the post. A refused poll is read again next run.

Never run it with the owner's main account, and never add a command call to the reader:
`collector/read-byd.test.ts` fails if the source names one.

## Secrets

Four secrets, all read by name from Bitwarden Secrets Manager (project of your choice) by
`collector/secrets.ts`, with the access token in `~/.bws_token` on the host. None is ever in a
repo file, a unit file or the journal.

| Secret name | Value |
|---|---|
| `atto1-byd-username` | the second account's email address |
| `atto1-byd-password` | the password in the Bitwarden item `atto1 BYD second account` |
| `atto1-ingest-client-id` | the service token's Client ID |
| `atto1-ingest-client-secret` | the service token's Client Secret |

For a one-off run from WSL2 you can instead export `BYD_USERNAME`, `BYD_PASSWORD`,
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`; a variable that is set wins over Secrets
Manager.

## Turning it on (owner, once)

Steps 1 to 3 are one script, approved live as one command (the owner-steps convention in
argus-config). Preview it first; it reads state and changes nothing:

```bash
bash scripts/owner-steps/83.sh --dry-run
bash scripts/owner-steps/83.sh
```

It is idempotent, so a re-run after a partial failure is safe. It does, only where the state
is not already right:

1. **Service token.** Creates the Access service token `atto1-ingest` (one year). If the
   token exists but its Client Secret is not in Secrets Manager (the secret is shown once), it
   rotates that token instead of making another.
2. **Secrets Manager.** Writes the four secrets in the table above into the
   `personal-machine-secrets` project: the token's Client ID and Client Secret, and the second
   account's username and password from the Bitwarden item `atto1 BYD second account`. An
   existing secret is left as is. If a secret cannot be stored, the token it just created is
   deleted so a re-run starts clean.
3. **Let it through Access.** Adds the policy `ingest`, action **Service Auth**, include service
   token `atto1-ingest`, to the `atto1` application. The owner's Allow policy is not touched.
   (An Allow policy does not admit a service token.)

It mints one 2-hour Cloudflare token for the run (from `CLOUDFLARE-TOKEN-ADMIN`, the way
homelab's `cf-expose.sh` does) and revokes it on exit, with `CLOUDFLARE-TOKEN-ADMIN` (a token
cannot revoke itself). The read token `CLOUDFLARE-TOKEN-ACCESS` cannot list service tokens: it
answers with an empty list. So the pre-flight stops, changing nothing, if that list is empty
while a policy on the application names a token, and a real run reads the service tokens (and
does its checks) with the minted token before it creates or rotates anything. It prints only the Client ID, ids and
the owner's Access user id, never a secret, and ends with checks: the token, the four secrets
and the policy exist; an unauthenticated request to `/api/me` goes to the Access login; a
request with the service token does not. By hand instead: Zero Trust > Access > Service
credentials (token), Applications > `atto1` > Policies (the policy), and the web vault (the
secrets).

4. **Tell the Worker.** Put the token's Client ID (printed by the script) in `INGEST_CLIENT_ID` and the owner's Access
   `sub` (the script prints the owner's Access user id, which should equal it; or sign in, open `https://atto1.myargus.cc/api/me`, copy `subject`) in
   `INGEST_OWNER_SUBJECT`, both in `wrangler.jsonc`. They are not secrets. Merge to `main`,
   then promote as usual ([deploy-branch.md](deploy-branch.md)). Until then every service token is
   refused. Both are set in `wrangler.jsonc` from the 7 Nov 2026 run (atto1/90); the subject is the
   Access user id the script printed, and a 401/403 on the first collector run means it differs from `/api/me`'s `subject`.
5. **Install the timer** on the homelab, after the promotion, from the checkout at
   `origin/deploy`. The capacity is the ATTO 1 pack's usable kWh from its spec sheet:

   ```bash
   git -C ~/repos/atto fetch && git -C ~/repos/atto switch --detach origin/deploy
   ATTO1_BATTERY_KWH=<kWh> bash ~/repos/atto/scripts/owner-steps/77.sh --dry-run
   ATTO1_BATTERY_KWH=<kWh> bash ~/repos/atto/scripts/owner-steps/77.sh
   ```

   It checks its pre-flight (including that `~/.local/bin/uv` can make a venv, so the host
   needs no `python3-venv`), builds the venv with `uv venv --clear` and installs `pybyd==0.0.80`
   into it, links the units and enables `atto1-collector.timer`. It is safe to re-run over a
   half-built venv. It changes nothing if a check fails. Without a capacity charging
   sessions are not recorded; readings still are.
6. **First run.** One manual run, then read it:

   ```bash
   systemctl --user start atto1-collector.service
   journalctl --user -u atto1-collector.service -n 20 --no-pager
   ```

   Expect `atto1-collector: sent 53% / 164 km, odometer 3447 km` (your numbers; `odometer unknown` when the car sent none). A `code=3008` from BYD on a new account usually means it has not been signed in to on the BYD phone app yet (see Troubleshooting); a 401 from the Worker means steps 2 or 4 are
   not live yet; a 403 means the token is not the one named in `INGEST_CLIENT_ID`.

To turn it off: `systemctl --user disable --now atto1-collector.timer`. Rows already stored stay.

## The second account's grant

The car is authorised to the second account with Keys and control (Basic control), More control
(Charging reservation) and Privacy (Vehicle location). The owner confirmed in the BYD app on
7 Nov 2026 that this is the lowest grant the app allows, so there is nothing to narrow
(ADR-006). The collector only reads, and a leaked password plus Basic control could act on the
car, so keep the password in Secrets Manager only.

To see the grant the account holds and which realtime fields came back populated, by name only
(no value, VIN or location), run the audit. It is a login with the second account, so run it
only when the owner approves:

```bash
# Run from the repo, with the collector's venv (or any Python with pybyd installed).
source ~/repos/argus-config/envs/wsl2/bashrc.d/bitwarden.sh
S=$(bitwarden-session)
export BYD_USERNAME="$(bw get username 'atto1 BYD second account' --session "$S" --nointeraction)"
export BYD_PASSWORD="$(bw get password 'atto1 BYD second account' --session "$S" --nointeraction)"
uv run --no-project --with pybyd==0.0.80 python collector/read-byd.py --audit
```

A login with the second account does not sign the phone app out.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `code=3008 Wrong email or password` | A new BYD account answers 3008 until it has been signed in to once in the BYD phone app, even with the right password. The second account's 3008 on 7 Nov 2026 cleared after its first phone sign-in (cause inferred, not proven). Sign in to the app once with that account, then retry once; do not retry in a loop. If the account is registered under a country other than Australia, set `ATTO1_BYD_BASE_URL` (e.g. `https://dilinkappoversea-sg.byd.auto`) and `ATTO1_BYD_COUNTRY` (e.g. `SG`) in the service's `collector.conf` drop-in. A known account with a wrong password answers 3002 and counts the tries left. |
| `BYD refused the realtime read with code 1001` (`BydEndpointNotSupportedError`) | The second account is a guest of the car (shared through Family and friends). Since 12 Nov 2026 BYD answers 1001 to a guest on every request that reaches the car unless the request declares the account as a guest; pybyd 0.0.80 and later do ([pyBYD#81](https://github.com/jkaberg/pyBYD/pull/81)), 0.0.79 does not. Fix: the venv must be on the pinned version, so re-run `scripts/owner-steps/77.sh` from `origin/deploy` (it rebuilds the venv with `uv venv --clear`). If the venv is already on 0.0.80 or later and 1001 persists, the cause is something else (an unsupported model or region, or a grant without live vehicle data): run `read-byd.py --audit` with the owner's approval and read the granted scopes. |
| `the account has no vehicle` | The ATTO 1 is not authorised to the second account (BYD app > Authorisation management). |
| `the car sent no charge or range` | The car is offline or asleep; the run sends nothing and tries again in 30 minutes. |
| `the Worker answered 302` | Access redirected the request: the service token is wrong, expired, or not in the `ingest` policy. |
| `the Worker answered 401` / `403` | `INGEST_*` are not set in the deployed Worker / the token is not the named one. |
| `the state file ... is not valid JSON` | Delete `~/.local/state/atto1-collector/state.json`; the next poll starts fresh (an open charge is lost). |

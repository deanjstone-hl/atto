---
summary: "Runbook for the CarPlay trigger (atto/6): the iOS Shortcuts personal automations that post a connect or disconnect to atto1, the owner steps that make the endpoint and the homelab pick-up live, how to check a trip was recorded, and what leaves the phone"
read_when:
  - "setting up or repairing the CarPlay connect and disconnect automations on the iPhone"
  - "a trip is missing from the dashboard, or a trip has no position"
  - "rotating the atto1-carplay-phone Access service token"
  - "asking what the phone sends to atto1 and what is stored"
---

# The CarPlay trigger

Decision and trade-offs: [ADR-006, Amendment 1](decisions/adr-006-read-only-byd-import-via-second-account.md#amendment-1-carplay-triggers-and-the-position-atto6).
The collector it triggers: [byd-collector.md](byd-collector.md).

## What it does

When the iPhone connects to or leaves CarPlay, a Shortcut posts the event to
`POST /api/collect/trigger` on atto1. Within about a minute the homelab runs the collector once,
tags that reading `carplay_connect` or `carplay_disconnect` and adds the car's position to it. The
dashboard pairs each connect with the next disconnect into a trip (duration, distance, charge
and range used, start and end point).

The phone sends only the event name. It never sees or sends a position: the position comes from
the car, through the second BYD account, and is stored only in the private D1 database.

## Owner steps, in order

These are live changes, so they are yours (tracked in
[atto/7](https://github.com/deanjstone/atto/issues/7)); the code that makes them useful is on `main`.

1. **Let the phone's token through Access, then tell the Worker its Client ID.** One command does
   steps 1 and 2 (the token `atto1-carplay-phone` already exists; this never creates or rotates it):

   ```bash
   bash scripts/owner-steps/7.sh --dry-run   # reads state, prints every action, changes nothing
   bash scripts/owner-steps/7.sh
   ```

   It adds the Access policy `carplay-trigger` (Service Auth, include that token) to the existing
   `atto1.myargus.cc` application, the way `ingest` admits the collector's token. It must be that
   application and not a separate one for `/api/collect/trigger`: every Access application has its
   own audience tag, and the Worker checks the one `ACCESS_AUD` (`worker/access.ts`), so a token
   issued through a path-specific application would be refused as `wrong audience`. Access then
   lets the token reach every path, and the Worker is what limits it: the phone token is accepted on
   `POST /api/collect/trigger` and answered 403 everywhere else, including `/api/ingest/byd`
   (`worker/collect.test.ts` pins this).
2. **Tell the Worker which token is the phone's.** The same script reads the token's Client ID from
   the Bitwarden item `atto1 CarPlay trigger (Access service token)` (the login username) and
   writes it to the Actions secret `ATTO_TRIGGER_CLIENT_ID` on `deanjstone/atto` and to Secrets
   Manager under the same name ([public-cutover.md](public-cutover.md)). It must be done
   **before** the next promotion: `deploy.yml` renders `wrangler.jsonc` from the Actions secrets
   and stops, changing nothing, while one is missing. It prints no value, and checks by reading
   back that the policy, the Actions secret and the Secrets Manager key exist.
3. **Promote** `main` as usual ([deploy-branch.md](deploy-branch.md)). The push to `deploy`
   applies migration `0002_collect_triggers.sql` and deploys the Worker.
4. **Install the pick-up on the homelab**, from the checkout at `origin/deploy`, after
   `scripts/owner-steps/77.sh` has installed the collector:

   ```bash
   git -C ~/repos/atto fetch && git -C ~/repos/atto switch --detach origin/deploy
   bash ~/repos/atto/scripts/owner-steps/6.sh --dry-run
   bash ~/repos/atto/scripts/owner-steps/6.sh
   ```

   It links `atto1-collector-trigger.service` and `.timer`, copies the collector's drop-in to the
   trigger service, reloads and enables the timer. Both services now share a lock, so a timer run
   and a triggered run never read the car together.
5. **Build the two automations on the iPhone** (below), then drive somewhere.

## The Shortcut

Make it twice, once per event. On the iPhone: Shortcuts > Automation > New Automation >
**CarPlay**, then pick **Connects** (or **Disconnects**) and **Run Immediately** (not "Run After
Confirmation"). Turn **Notify When Run** off. Add one action, **Get Contents of URL**:

| Setting | Value |
|---|---|
| URL | `https://atto1.myargus.cc/api/collect/trigger` |
| Method | `POST` |
| Headers | `CF-Access-Client-Id`: `<the service token's Client ID>` |
| | `CF-Access-Client-Secret`: `<the service token's Client Secret>` |
| Request Body | `JSON`, one field: `event` (Text) = `carplay_connect` on the Connects automation, `carplay_disconnect` on the Disconnects one |

The Client ID and Secret are in the Bitwarden item `atto1 CarPlay trigger (Access service token)`.
Paste them into the Shortcut only; they are not in this repository and should not be in a
screenshot, a chat or a note. The JSON body type makes the Shortcut send
`Content-Type: application/json`, which the Worker requires (415 otherwise).

An answer of `202` with `{"id": ..., "event": ...}` means it was filed. The Shortcut has no
reason to look at it; a failure is silent on the phone, so check the homelab (next section) the
first time.

## Check it worked

Tap the automation's **Run** once, or connect to CarPlay, then on the homelab within two minutes:

```bash
journalctl --user -u atto1-collector-trigger.service -n 20 --no-pager
journalctl --user -u atto1-collector.service -n 20 --no-pager
```

Expect `atto1-collector-trigger: 1 trigger(s) pending; running once for carplay_connect`, and a
collector line ending `, tagged carplay_connect, position read` (or `no position`). The Trips
card on the dashboard then shows the trip in progress; it completes when the disconnect is read.

## What gets stored and when

- One `collect_triggers` row per request, one `collect_acks` row when the homelab has handled
  it, a tagged reading with its position (migration `0002`). Nothing is updated or deleted.
- Triggers filed within two minutes of each other, or of the last run (either timer), are
  covered by one run, tagged with the newest event. The pick-up waits instead of reading the car
  more often. A trigger older than 30 minutes is dropped from the list.
- The 30-minute timer's readings carry no tag and no position, as before.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing in the trigger journal | The Shortcut did not run (check the automation is **Run Immediately** and CarPlay really connected), Access refused the token (step 1), or the timer is not enabled (`systemctl --user list-timers atto1-collector-trigger.timer`). |
| `the Worker answered 302 to the pending list` | The collector's own token is not admitted by Access; see [byd-collector.md](byd-collector.md). |
| Phone gets 401 | The Worker does not know the token: `ATTO_TRIGGER_CLIENT_ID` is empty or wrong in the deployed Worker (step 2, then a promotion). |
| Phone gets 403 | The token reached the Worker but is the collector's, or the path is wrong. The phone token reaches `/api/collect/trigger` only. |
| Phone gets 415 or 422 | The body is not JSON, or `event` is not exactly `carplay_connect` or `carplay_disconnect`. |
| A trip shows no position | The GPS read failed (`no position` in the log), or the car was asleep or offline; the reading is still stored and the trip still counts. |
| A trip never completes | The disconnect Shortcut did not run, or its reading failed. A connect followed by another connect starts a new trip; a lone disconnect is skipped. |
| `waiting` in the log | Another run was under two minutes ago. The trigger stays pending and is picked up on a later tick. |

## Rotating the token

Rotate `atto1-carplay-phone` in Zero Trust > Access > Service credentials, update the Bitwarden
item and `ATTO_TRIGGER_CLIENT_ID` (Actions and Secrets Manager), promote, then paste the new
Client ID and Secret into both Shortcuts. A leaked token can only file triggers, which cost at
most one collector run every two minutes.

// The trigger pick-up (atto/6), run by atto1-collector-trigger.timer every minute on the
// homelab. It asks the Worker what is pending; when a CarPlay connect or disconnect is, it
// runs the collector once, tagged with the oldest pending event (the reading then carries
// the position), and acknowledges what that run covered.
//
// One run per event, in order (atto/16): a connect and a disconnect are never folded into
// one run, because a trip is paired from the connect reading and folding would lose it.
// Repeats of the same event at the head of the queue share one run; the rest stay pending
// and are picked up on later ticks.
//
// Debounce: no run starts within two minutes of the end of the last one, from either timer.
// A trigger that arrives inside that window stays pending and is picked up on a later tick.
//
// A run that fails leaves its triggers pending and counts the attempt (atto/16), so a later
// tick tries again: the BYD read can time out while the car is moving, and acknowledging
// at once lost the drive's connect. After MAX_ATTEMPTS failed runs a trigger is
// acknowledged, so a broken BYD login is tried a few times, not once a minute until the
// Worker stops listing it (after 30 minutes). The unit still fails and shows in the
// journal; the 30-minute timer carries on regardless.

import { join } from 'node:path'
import { isTriggerEvent, type TriggerEvent } from '../worker/trigger-events.ts'
import { fileAttempts, type Attempts } from './attempts.ts'
import { fileLastRun } from './last-run.ts'
import {
  createRunDeps,
  exec,
  LAST_RUN_FILE,
  runOnce,
  serviceHeaders,
  stateDirectoryFor,
  type Fetcher,
  type IngestTarget,
} from './run.ts'
import { loadSecrets } from './secrets.ts'

export const COALESCE_MS = 2 * 60_000
export const MAX_ATTEMPTS = 3
export const ATTEMPTS_FILE = 'trigger-attempts.json'

export type PendingTrigger = { id: string; event: string; requested_at: string }

export type PickUpDeps = {
  fetchPending: () => Promise<PendingTrigger[]>
  ack: (ids: string[]) => Promise<void>
  run: (event: TriggerEvent) => Promise<void>
  loadLastRun: () => Promise<Date | null>
  saveLastRun: (at: Date) => Promise<void>
  loadAttempts: () => Promise<Attempts>
  saveAttempts: (attempts: Attempts) => Promise<void>
  now: () => Date
  log: (message: string) => void
}

export type PickUpResult = 'idle' | 'waiting' | 'ran'

export async function pickUp(deps: PickUpDeps): Promise<PickUpResult> {
  const pending = await deps.fetchPending()
  // An event this collector does not know (a newer Worker's) is left pending, not guessed at.
  const known = pending
    .filter((entry): entry is PendingTrigger & { event: TriggerEvent } => isTriggerEvent(entry.event))
    .sort((a, b) => Date.parse(a.requested_at) - Date.parse(b.requested_at))
  if (known.length === 0) return 'idle'

  const lastRun = await deps.loadLastRun()
  const now = deps.now()
  if (lastRun !== null && now.getTime() - lastRun.getTime() < COALESCE_MS) {
    deps.log(`${known.length} trigger(s) pending; the last run was under two minutes ago, waiting`)
    return 'waiting'
  }

  // The oldest event, and any repeats of it that follow before a different event.
  const [oldest] = known
  const covered: PendingTrigger[] = []
  for (const entry of known) {
    if (entry.event !== oldest.event) break
    covered.push(entry)
  }
  const ids = covered.map((entry) => entry.id)
  const later = known.length - covered.length
  deps.log(
    `${known.length} trigger(s) pending; running once for ${oldest.event}` +
      (later > 0 ? `, ${later} later one(s) left for the next tick` : ''),
  )

  let failure: unknown = null
  try {
    await deps.run(oldest.event as TriggerEvent)
  } catch (error) {
    failure = error
  }
  // From the end of the run: a run that took its full timeout is not retried at once.
  await deps.saveLastRun(deps.now())

  const pendingIds = new Set(pending.map((entry) => entry.id))
  const attempts: Attempts = {}
  for (const [id, count] of Object.entries(await deps.loadAttempts())) {
    if (pendingIds.has(id)) attempts[id] = count
  }

  if (failure === null) {
    for (const id of ids) delete attempts[id]
    await deps.saveAttempts(attempts)
    await deps.ack(ids)
    return 'ran'
  }

  const exhausted: string[] = []
  for (const id of ids) {
    attempts[id] = (attempts[id] ?? 0) + 1
    if (attempts[id] >= MAX_ATTEMPTS) {
      exhausted.push(id)
      delete attempts[id]
    }
  }
  await deps.saveAttempts(attempts)
  if (exhausted.length > 0) {
    deps.log(`giving up on ${exhausted.length} trigger(s) after ${MAX_ATTEMPTS} failed runs`)
    await deps.ack(exhausted)
  }
  throw failure
}

const base = (target: IngestTarget) => target.baseUrl.replace(/\/+$/, '')

function isTriggerList(value: unknown): value is { triggers: PendingTrigger[] } {
  if (typeof value !== 'object' || value === null) return false
  const { triggers } = value as { triggers?: unknown }
  return (
    Array.isArray(triggers) &&
    triggers.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.id === 'string' &&
        typeof entry.event === 'string' &&
        typeof entry.requested_at === 'string',
    )
  )
}

export async function fetchPending(target: IngestTarget, fetcher: Fetcher = fetch): Promise<PendingTrigger[]> {
  const response = await fetcher(`${base(target)}/api/collect/pending`, {
    method: 'GET',
    // Access answers a bad token with a redirect to its login page; that is a refusal.
    redirect: 'manual',
    headers: serviceHeaders(target),
  })
  if (response.status !== 200) throw new Error(`the Worker answered ${response.status} to the pending list`)
  const body: unknown = await response.json().catch(() => null)
  if (!isTriggerList(body)) throw new Error('the Worker did not send a trigger list')
  return body.triggers
}

export async function ackTriggers(target: IngestTarget, ids: string[], fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`${base(target)}/api/collect/ack`, {
    method: 'POST',
    redirect: 'manual',
    headers: serviceHeaders(target),
    body: JSON.stringify({ trigger_ids: ids }),
  })
  if (response.status !== 200) throw new Error(`the Worker answered ${response.status} to the acknowledgement`)
}

async function main(): Promise<void> {
  const env = process.env
  // Only the collector token: the BYD login is read when a run actually starts.
  const { clientId, clientSecret } = await loadSecrets(env, exec, ['clientId', 'clientSecret'])
  const target: IngestTarget = {
    baseUrl: env.ATTO1_URL ?? 'https://atto1.myargus.cc',
    clientId,
    clientSecret,
  }
  const lastRun = fileLastRun(join(stateDirectoryFor(env), LAST_RUN_FILE))
  const attempts = fileAttempts(join(stateDirectoryFor(env), ATTEMPTS_FILE))

  await pickUp({
    fetchPending: () => fetchPending(target),
    ack: (ids) => ackTriggers(target, ids),
    run: async (event) => runOnce(await createRunDeps(env), { event }),
    loadLastRun: () => lastRun.load(),
    saveLastRun: (at) => lastRun.save(at),
    loadAttempts: () => attempts.load(),
    saveAttempts: (next) => attempts.save(next),
    now: () => new Date(),
    log: (message) => console.log(`atto1-collector-trigger: ${message}`),
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`atto1-collector-trigger: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

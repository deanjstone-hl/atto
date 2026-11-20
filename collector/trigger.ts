// The trigger pick-up (atto/6), run by atto1-collector-trigger.timer every minute on the
// homelab. It asks the Worker what is pending; when a CarPlay connect or disconnect is, it
// runs the collector once, tagged with the newest event (the reading then carries the
// position), and acknowledges what that run covered.
//
// Debounce, two rules: every trigger pending at once is covered by one run, and no run
// starts within two minutes of the last one, from either timer. A trigger that arrives
// inside that window stays pending and is picked up on a later tick.
//
// A run that fails still acknowledges its triggers, after recording the attempt: a broken
// BYD login is then tried once per trigger, not once a minute until the trigger expires
// (the Worker stops listing one after 30 minutes). The unit still fails and shows in the
// journal; the 30-minute timer carries on regardless.

import { join } from 'node:path'
import { isTriggerEvent, type TriggerEvent } from '../worker/trigger-events.ts'
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

export type PendingTrigger = { id: string; event: string; requested_at: string }

export type PickUpDeps = {
  fetchPending: () => Promise<PendingTrigger[]>
  ack: (ids: string[]) => Promise<void>
  run: (event: TriggerEvent) => Promise<void>
  loadLastRun: () => Promise<Date | null>
  saveLastRun: (at: Date) => Promise<void>
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

  const newest = known[known.length - 1]
  deps.log(`${known.length} trigger(s) pending; running once for ${newest.event}`)
  let failure: unknown = null
  try {
    await deps.run(newest.event)
  } catch (error) {
    failure = error
  }
  await deps.saveLastRun(now)
  await deps.ack(known.map((entry) => entry.id))
  if (failure !== null) throw failure
  return 'ran'
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

  await pickUp({
    fetchPending: () => fetchPending(target),
    ack: (ids) => ackTriggers(target, ids),
    run: async (event) => runOnce(await createRunDeps(env), { event }),
    loadLastRun: () => lastRun.load(),
    saveLastRun: (at) => lastRun.save(at),
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

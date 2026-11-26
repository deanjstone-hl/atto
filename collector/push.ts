// The BYD push listener's supervisor (atto/8), run by atto1-collector-push.service, which keeps
// it up. It starts collector/listen-byd.py, which prints {"charging": bool} whenever the BYD
// cloud pushes a charge state, and turns a change of that state into charge_start or
// charge_stop. Each runs the collector once (collector/run.ts --event ...), so a charging
// session has a reading within seconds of each end instead of up to 30 minutes after.
//
// Debounce: as for the CarPlay pick-up, no run starts within two minutes of the end of the last
// one, from any of the three triggers (the 30-minute timer, the pick-up and this). An event that
// arrives inside that window waits and runs when it is over, in order, one run per event.
//
// A run that fails is tried again, up to MAX_ATTEMPTS runs, then given up on and logged; the
// 30-minute timer carries on regardless and still brackets the session, as before.
//
// The first state seen is a baseline, not an event. The baseline is seeded at start from the
// collector's own state (an open session means the car was charging), so a charge that is
// already under way when the listener starts still gets its stop (atto/20: the listener started
// mid-charge, its first push was the stop, and that push only set the baseline).

import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { ChargeEvent } from '../worker/trigger-events.ts'
import { fileLastRun } from './last-run.ts'
import { exec, fileStateStore, LAST_RUN_FILE, stateDirectoryFor } from './run.ts'
import { loadSecrets } from './secrets.ts'
import type { SessionState } from './sessions.ts'
import { COALESCE_MS, MAX_ATTEMPTS } from './trigger.ts'

export function nextCharge(previous: boolean | null, charging: boolean): { charging: boolean; event: ChargeEvent | null } {
  if (previous === null || previous === charging) return { charging, event: null }
  return { charging, event: charging ? 'charge_start' : 'charge_stop' }
}

// One line of the listener's stdout: {"charging": true|false}. Anything else is not a signal.
export function parseSignal(line: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const { charging } = parsed as { charging?: unknown }
      if (typeof charging === 'boolean') return charging
    }
  } catch {
    // A log line or a partial line: not a signal.
  }
  return null
}

// What the collector's state file says about the charge: a session open is a car charging.
export const seedFromState = (state: SessionState): boolean => state.open !== null

export const HEARTBEAT_MS = 30 * 60_000

export type PushDeps = {
  run: (event: ChargeEvent) => Promise<void>
  loadLastRun: () => Promise<Date | null>
  now: () => Date
  log: (message: string) => void
}

export function createPushQueue(deps: PushDeps) {
  let charging: boolean | null = null
  const pending: ChargeEvent[] = []
  let failedRuns = 0
  let lastPushAt: Date | null = null

  return {
    // Set the baseline from what the collector already knows. A push that has already set it wins.
    seed(state: boolean): void {
      if (charging !== null) return
      charging = state
      deps.log(`baseline charging=${state}`)
    },

    // One line that says the listener is alive and when it last heard from the cloud.
    heartbeat(): void {
      if (lastPushAt === null) {
        deps.log('listening, no push yet')
        return
      }
      const minutes = Math.round((deps.now().getTime() - lastPushAt.getTime()) / 60_000)
      deps.log(`listening, last push ${minutes} min ago`)
    },

    // Feed one charge state from the listener; returns the event it makes, if any.
    signal(state: boolean): ChargeEvent | null {
      lastPushAt = deps.now()
      const next = nextCharge(charging, state)
      charging = next.charging
      if (next.event !== null) {
        pending.push(next.event)
        deps.log(`${next.event} push seen`)
      }
      return next.event
    },

    pending: (): ChargeEvent[] => [...pending],

    // Run the oldest pending event if the last run is far enough back. Returns how long to wait
    // before draining again, or null when nothing is left.
    async drain(): Promise<number | null> {
      const [event] = pending
      if (event === undefined) return null

      const lastRun = await deps.loadLastRun()
      if (lastRun !== null) {
        const wait = COALESCE_MS - (deps.now().getTime() - lastRun.getTime())
        if (wait > 0) {
          deps.log(`${event} waiting: the last run was under two minutes ago`)
          return wait
        }
      }

      try {
        await deps.run(event)
        pending.shift()
        failedRuns = 0
      } catch (error) {
        failedRuns += 1
        deps.log(`${event} run failed (${failedRuns} of ${MAX_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`)
        if (failedRuns >= MAX_ATTEMPTS) {
          deps.log(`giving up on ${event} after ${MAX_ATTEMPTS} failed runs`)
          pending.shift()
          failedRuns = 0
        }
      }
      return pending.length > 0 ? COALESCE_MS : null
    },
  }
}

// The listener never ends by itself, so when it closes this process ends with it. A close after
// SIGTERM or SIGINT is a requested stop (systemctl stop, a restart, RuntimeMaxSec): exit 0, so the
// unit ends `inactive` and an install can start it. Any other close is a failure: exit 1, so
// Restart=always brings both back. A unit left `failed` by a stop was never restarted (atto/26).
export function superviseListener(options: {
  listener: { on: (event: 'close', handler: (code: number | null, signal: string | null) => void) => unknown; kill: () => unknown }
  signals: { on: (event: 'SIGTERM' | 'SIGINT', handler: () => void) => unknown }
  exit: (code: number) => void
  logError: (message: string) => void
}): void {
  const { listener, signals, exit, logError } = options
  let stopRequested = false
  for (const name of ['SIGTERM', 'SIGINT'] as const) {
    signals.on(name, () => {
      stopRequested = true
      listener.kill()
    })
  }
  listener.on('close', (code, signal) => {
    const ended = signal ?? `exit code ${code}`
    if (stopRequested) {
      logError(`the listener ended (${ended}) after a stop was requested`)
      exit(0)
      return
    }
    logError(`the listener ended (${ended})`)
    exit(1)
  })
}

const runFile = promisify(execFile)

// The run goes through flock on the lock both timers' units hold, so two runs never read the
// car or write state.json together; run.ts saves last-run.json itself when it ends.
export function collectorRunner(env: NodeJS.ProcessEnv) {
  const lock = join(env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, 'atto1-collector.lock')
  const script = join(import.meta.dirname, 'run.ts')
  return async (event: ChargeEvent): Promise<void> => {
    try {
      await runFile('flock', ['-w', '150', lock, process.execPath, script, '--event', event], {
        env,
        timeout: 300_000,
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      const { stderr } = error as { stderr?: unknown }
      const detail = typeof stderr === 'string' ? stderr.trim().split('\n').at(-1) : ''
      throw new Error(detail || (error instanceof Error ? error.message : String(error)))
    }
  }
}

async function main(): Promise<void> {
  const env = process.env
  const { bydUsername, bydPassword } = await loadSecrets(env, exec, ['bydUsername', 'bydPassword'])
  const lastRun = fileLastRun(join(stateDirectoryFor(env), LAST_RUN_FILE))
  const log = (message: string) => console.log(`atto1-collector-push: ${message}`)
  const stateFile = fileStateStore(join(stateDirectoryFor(env), 'state.json'))
  const queue = createPushQueue({
    run: collectorRunner(env),
    loadLastRun: () => lastRun.load(),
    now: () => new Date(),
    log,
  })

  let timer: NodeJS.Timeout | null = null
  let draining = false
  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      if (timer !== null) clearTimeout(timer)
      timer = null
      const delay = await queue.drain()
      if (delay !== null) timer = setTimeout(() => void drain(), delay)
    } catch (error) {
      log(`could not drain: ${error instanceof Error ? error.message : String(error)}`)
      timer = setTimeout(() => void drain(), COALESCE_MS)
    } finally {
      draining = false
    }
  }

  const python = env.ATTO1_PYTHON ?? 'python3'
  const listener = spawn(python, [join(import.meta.dirname, 'listen-byd.py')], {
    env: { ...env, BYD_USERNAME: bydUsername, BYD_PASSWORD: bydPassword },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  createInterface({ input: listener.stdout }).on('line', (line) => {
    const state = parseSignal(line)
    if (state !== null && queue.signal(state) !== null) void drain()
  })
  listener.on('error', (error) => {
    console.error(`atto1-collector-push: could not start the listener: ${error.message}`)
    process.exitCode = 1
  })
  superviseListener({ listener, signals: process, exit: (code) => process.exit(code), logError: (message) => console.error(`atto1-collector-push: ${message}`) })
  log('listening for charge pushes')
  try {
    queue.seed(seedFromState(await stateFile.load()))
  } catch (error) {
    log(`no baseline from the state file: ${error instanceof Error ? error.message : String(error)}`)
  }
  setInterval(() => queue.heartbeat(), HEARTBEAT_MS).unref()
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`atto1-collector-push: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

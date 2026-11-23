// The collector's one run (ADR-006): read the car once, send what it said, remember the
// poll. Run by a systemd timer; it holds no loop of its own. All I/O is injected, so the
// tests use fakes and CI never touches BYD.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { TriggerEvent } from '../worker/trigger-events.ts'
import { fileLastRun } from './last-run.ts'
import { parseReading, toObservation, toVehicle, type Reading } from './map.ts'
import { loadSecrets, type Exec } from './secrets.ts'
import { advance, emptyState, type SessionState } from './sessions.ts'

const CHARGING = 1

export type RunDeps = {
  // `withLocation` is true only for a run a CarPlay connect or disconnect triggered (atto/6).
  readCar: (withLocation: boolean) => Promise<Reading>
  loadState: () => Promise<SessionState>
  saveState: (state: SessionState) => Promise<void>
  post: (payload: Record<string, unknown>) => Promise<{ status: number }>
  now: () => Date
  config: { nickname: string; batteryKwh: number | null }
  log: (message: string) => void
}

export type RunOptions = {
  // The event that triggered this run. Set, the reading is tagged with it and carries the
  // car's position; unset (the timer), it carries neither.
  event?: TriggerEvent
}

export async function runOnce(deps: RunDeps, options: RunOptions = {}): Promise<void> {
  const { event } = options
  const reading = await deps.readCar(event !== undefined)
  const state = await deps.loadState()

  const observation = toObservation(reading, deps.now(), event)
  if (observation === null) {
    deps.log('the car sent no charge or range; nothing to send')
    return
  }

  const next = advance(
    state,
    {
      at: observation.observed_at,
      soc: observation.soc_pct,
      charging: reading.charge_state === CHARGING,
      odometerKm: observation.odometer_km ?? null,
    },
    { batteryKwh: deps.config.batteryKwh },
  )

  const payload: Record<string, unknown> = { vehicle: toVehicle(reading, deps.config), observation }
  if (next.session) payload.charging_session = next.session

  const { status } = await deps.post(payload)
  if (status < 200 || status >= 300) throw new Error(`the Worker answered ${status}; the poll was not recorded`)

  // Only after the Worker took it: a refused poll is read again next run.
  await deps.saveState(next.state)
  deps.log(
    `sent ${observation.soc_pct}% / ${observation.displayed_range_km} km, ` +
      (observation.odometer_km === undefined ? 'odometer unknown' : `odometer ${observation.odometer_km} km`) +
      // Whether a position was read, never the position itself.
      (event === undefined ? '' : `, tagged ${event}, ${observation.latitude === undefined ? 'no position' : 'position read'}`) +
      (next.session ? `, and a ${next.session.energy_kwh} kWh charging session` : ''),
  )
}

export type IngestTarget = { baseUrl: string; clientId: string; clientSecret: string }

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export const serviceHeaders = (target: IngestTarget): Record<string, string> => ({
  'content-type': 'application/json',
  'cf-access-client-id': target.clientId,
  'cf-access-client-secret': target.clientSecret,
})

export async function postIngest(
  target: IngestTarget,
  payload: unknown,
  fetcher: Fetcher = fetch,
): Promise<{ status: number }> {
  const response = await fetcher(`${target.baseUrl.replace(/\/+$/, '')}/api/ingest/byd`, {
    method: 'POST',
    // Access answers a bad token with a redirect to its login page; that is a refusal.
    redirect: 'manual',
    headers: serviceHeaders(target),
    body: JSON.stringify(payload),
  })
  return { status: response.status }
}

export function fileStateStore(path: string) {
  return {
    async load(): Promise<SessionState> {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
        throw error
      }
      try {
        return JSON.parse(text) as SessionState
      } catch {
        throw new Error(`the state file ${path} is not valid JSON; fix or delete it`)
      }
    },
    async save(state: SessionState): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      await writeFile(temporary, JSON.stringify(state))
      await rename(temporary, path)
    },
  }
}

const run = promisify(execFile)
export const exec: Exec = async (file, args) => (await run(file, args, { maxBuffer: 1024 * 1024 })).stdout

const STDERR_LIMIT = 600
const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/g

// An execFile failure says only `Command failed: <command line>`; the reader's stderr and
// the signal that killed it are fields on the error. Put them in the message so the journal
// shows why a run failed (atto/16), minus the credentials and any VIN, and bounded.
export function explainReadFailure(error: unknown, secrets: { username: string; password: string }): Error {
  if (!(error instanceof Error)) return new Error(String(error))
  const { killed, signal, code, stderr } = error as Error & {
    killed?: boolean
    signal?: string | null
    code?: number | string | null
    stderr?: unknown
  }
  if (killed === undefined && signal === undefined && code === undefined && stderr === undefined) return error

  const ended = signal ? `${killed ? 'killed' : 'stopped'} by ${signal}` : code != null ? `exit code ${code}` : 'ended'
  let text = typeof stderr === 'string' ? stderr.trim() : ''
  for (const secret of [secrets.username, secrets.password]) {
    if (secret) text = text.split(secret).join('[redacted]')
  }
  text = text.replace(VIN_PATTERN, '[vin]')
  if (text.length > STDERR_LIMIT) text = `...${text.slice(-STDERR_LIMIT)}`
  return new Error(`${error.message} (${ended})${text ? `; reader stderr: ${text}` : '; the reader printed nothing to stderr'}`, {
    cause: error,
  })
}

async function readCar(
  env: NodeJS.ProcessEnv,
  username: string,
  password: string,
  withLocation: boolean,
): Promise<Reading> {
  const python = env.ATTO1_PYTHON ?? 'python3'
  const args = [join(import.meta.dirname, 'read-byd.py'), ...(withLocation ? ['--with-location'] : [])]
  try {
    const { stdout } = await run(python, args, {
      env: { ...env, BYD_USERNAME: username, BYD_PASSWORD: password },
      timeout: 120_000,
    })
    return parseReading(JSON.parse(stdout))
  } catch (error) {
    throw explainReadFailure(error, { username, password })
  }
}

export const stateDirectoryFor = (env: NodeJS.ProcessEnv): string =>
  env.STATE_DIRECTORY ?? join(env.HOME ?? '.', '.local', 'state', 'atto1-collector')

export const LAST_RUN_FILE = 'last-run.json'

// Everything one run needs, from the environment and Secrets Manager. The timer run and the
// trigger pick-up share it, so a triggered run is the same run with an event.
export async function createRunDeps(env: NodeJS.ProcessEnv): Promise<RunDeps> {
  const secrets = await loadSecrets(env, exec)
  const stateDirectory = stateDirectoryFor(env)
  const store = fileStateStore(join(stateDirectory, 'state.json'))
  const batteryKwh = env.ATTO1_BATTERY_KWH ? Number(env.ATTO1_BATTERY_KWH) : null
  if (batteryKwh !== null && !(batteryKwh > 0)) throw new Error('ATTO1_BATTERY_KWH is not a positive number')
  if (batteryKwh === null) console.warn('ATTO1_BATTERY_KWH is not set: charging sessions are not recorded')

  return {
    readCar: (withLocation) => readCar(env, secrets.bydUsername, secrets.bydPassword, withLocation),
    loadState: () => store.load(),
    saveState: (state) => store.save(state),
    post: (payload) =>
      postIngest(
        {
          baseUrl: env.ATTO1_URL ?? 'https://atto1.myargus.cc',
          clientId: secrets.clientId,
          clientSecret: secrets.clientSecret,
        },
        payload,
      ),
    now: () => new Date(),
    config: { nickname: env.ATTO1_NICKNAME ?? 'ATTO 1', batteryKwh },
    log: (message) => console.log(`atto1-collector: ${message}`),
  }
}

async function main(): Promise<void> {
  const env = process.env
  const deps = await createRunDeps(env)
  try {
    await runOnce(deps)
  } finally {
    // Every attempt counts as a run for the trigger pick-up's two-minute spacing.
    await fileLastRun(join(stateDirectoryFor(env), LAST_RUN_FILE)).save(new Date())
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`atto1-collector: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

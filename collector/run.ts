// The collector's one run (ADR-006): read the car once, send what it said, remember the
// poll. Run by a systemd timer; it holds no loop of its own. All I/O is injected, so the
// tests use fakes and CI never touches BYD.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parseReading, toObservation, toVehicle, type Reading } from './map.ts'
import { loadSecrets, type Exec } from './secrets.ts'
import { advance, emptyState, type SessionState } from './sessions.ts'

const CHARGING = 1

export type RunDeps = {
  readCar: () => Promise<Reading>
  loadState: () => Promise<SessionState>
  saveState: (state: SessionState) => Promise<void>
  post: (payload: Record<string, unknown>) => Promise<{ status: number }>
  now: () => Date
  config: { nickname: string; batteryKwh: number | null }
  log: (message: string) => void
}

export async function runOnce(deps: RunDeps): Promise<void> {
  const reading = await deps.readCar()
  const state = await deps.loadState()

  const observation = toObservation(reading, deps.now())
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
      (next.session ? `, and a ${next.session.energy_kwh} kWh charging session` : ''),
  )
}

export type IngestTarget = { baseUrl: string; clientId: string; clientSecret: string }

export async function postIngest(
  target: IngestTarget,
  payload: unknown,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<{ status: number }> {
  const response = await fetcher(`${target.baseUrl.replace(/\/+$/, '')}/api/ingest/byd`, {
    method: 'POST',
    // Access answers a bad token with a redirect to its login page; that is a refusal.
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      'cf-access-client-id': target.clientId,
      'cf-access-client-secret': target.clientSecret,
    },
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
const exec: Exec = async (file, args) => (await run(file, args, { maxBuffer: 1024 * 1024 })).stdout

async function readCar(env: NodeJS.ProcessEnv, username: string, password: string): Promise<Reading> {
  const python = env.ATTO1_PYTHON ?? 'python3'
  const { stdout } = await run(python, [join(import.meta.dirname, 'read-byd.py')], {
    env: { ...env, BYD_USERNAME: username, BYD_PASSWORD: password },
    timeout: 120_000,
  })
  return parseReading(JSON.parse(stdout))
}

async function main(): Promise<void> {
  const env = process.env
  const secrets = await loadSecrets(env, exec)
  const stateDirectory = env.STATE_DIRECTORY ?? join(env.HOME ?? '.', '.local', 'state', 'atto1-collector')
  const store = fileStateStore(join(stateDirectory, 'state.json'))
  const batteryKwh = env.ATTO1_BATTERY_KWH ? Number(env.ATTO1_BATTERY_KWH) : null
  if (batteryKwh !== null && !(batteryKwh > 0)) throw new Error('ATTO1_BATTERY_KWH is not a positive number')
  if (batteryKwh === null) console.warn('ATTO1_BATTERY_KWH is not set: charging sessions are not recorded')

  await runOnce({
    readCar: () => readCar(env, secrets.bydUsername, secrets.bydPassword),
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
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`atto1-collector: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

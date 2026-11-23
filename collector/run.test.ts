import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Reading } from './map.ts'
import { eventFromArguments, explainReadFailure, fileStateStore, postIngest, runOnce, type RunDeps } from './run.ts'
import { emptyState, type SessionState } from './sessions.ts'

const reading = (overrides: Partial<Reading> = {}): Reading => ({
  vin: 'LC0CE4CB5S0123456',
  model_name: 'ATTO 1',
  online: true,
  observed_at: '2026-11-07T01:00:00.000Z',
  soc_pct: 53,
  range_km: 164,
  odometer_km: 3447,
  charge_state: 15,
  ...overrides,
})

function setup(overrides: Partial<RunDeps> = {}, initial: SessionState = emptyState()) {
  let saved: SessionState | null = null
  const sent: unknown[] = []
  const deps: RunDeps = {
    readCar: async (_withLocation: boolean) => reading(),
    loadState: async () => initial,
    saveState: async (state) => {
      saved = state
    },
    post: async (payload) => {
      sent.push(payload)
      return { status: 201 }
    },
    now: () => new Date('2026-11-07T02:00:00Z'),
    config: { nickname: 'ATTO 1', batteryKwh: 30 },
    log: () => undefined,
    ...overrides,
  }
  return { deps, sent, saved: () => saved }
}

describe('runOnce', () => {
  it('sends the vehicle and the reading, then records the poll', async () => {
    const { deps, sent, saved } = setup()
    await runOnce(deps)
    expect(sent).toEqual([
      {
        vehicle: { vin: 'LC0CE4CB5S0123456', nickname: 'ATTO 1', battery_capacity_kwh: 30 },
        observation: { observed_at: '2026-11-07T01:00:00.000Z', soc_pct: 53, displayed_range_km: 164, odometer_km: 3447 },
      },
    ])
    expect(saved()).toMatchObject({ lastAt: '2026-11-07T01:00:00.000Z' })
  })

  it('logs the odometer it sent, so the log shows what the dashboard should read', async () => {
    const log = vi.fn()
    const { deps } = setup({ log, readCar: async () => reading({ soc_pct: 75, range_km: 234, odometer_km: 4624 }) })
    await runOnce(deps)
    expect(log).toHaveBeenCalledWith('sent 75% / 234 km, odometer 4624 km')
  })

  it('logs odometer unknown when the car sent none', async () => {
    const log = vi.fn()
    const { deps } = setup({ log, readCar: async () => reading({ odometer_km: null }) })
    await runOnce(deps)
    expect(log).toHaveBeenCalledWith('sent 53% / 164 km, odometer unknown')
  })

  it('logs the odometer before the session it also sent', async () => {
    const log = vi.fn()
    const open: SessionState = {
      lastAt: '2026-11-07T00:30:00.000Z',
      open: { startedAt: '2026-11-06T22:00:00.000Z', startSoc: 20, lastAt: '2026-11-07T00:30:00.000Z', lastSoc: 60, odometerKm: 3447 },
    }
    const { deps } = setup({ log, readCar: async () => reading({ soc_pct: 70 }) }, open)
    await runOnce(deps)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^sent 70% \/ 164 km, odometer 3447 km, and a [\d.]+ kWh charging session$/))
  })

  it('sends a session in the same request when the poll ends one', async () => {
    const open: SessionState = {
      lastAt: '2026-11-07T00:30:00.000Z',
      open: { startedAt: '2026-11-06T22:00:00.000Z', startSoc: 20, lastAt: '2026-11-07T00:30:00.000Z', lastSoc: 60, odometerKm: 3447 },
    }
    const { deps, sent, saved } = setup({ readCar: async () => reading({ soc_pct: 70, charge_state: 15 }) }, open)
    await runOnce(deps)
    expect(sent[0]).toMatchObject({
      charging_session: { started_at: '2026-11-06T22:00:00.000Z', ended_at: '2026-11-07T01:00:00.000Z', end_soc_pct: 70 },
    })
    expect(saved()?.open).toBeNull()
  })

  it('treats charge_state 1 as charging and opens a session', async () => {
    const { deps, saved } = setup({ readCar: async () => reading({ charge_state: 1 }) })
    await runOnce(deps)
    expect(saved()?.open).toMatchObject({ startSoc: 53 })
  })

  it('does not record the poll when the Worker refuses it, so the next run retries', async () => {
    const { deps, saved } = setup({ post: async () => ({ status: 503 }) })
    await expect(runOnce(deps)).rejects.toThrow(/503/)
    expect(saved()).toBeNull()
  })

  it('sends nothing when the car gave no charge or range', async () => {
    const post = vi.fn(async () => ({ status: 201 }))
    const { deps } = setup({ readCar: async () => reading({ soc_pct: null }), post })
    await runOnce(deps)
    expect(post).not.toHaveBeenCalled()
  })

  it('lets a failed read through without touching state or the Worker', async () => {
    const post = vi.fn(async () => ({ status: 201 }))
    const { deps, saved } = setup({
      readCar: async () => {
        throw new Error('reader failed')
      },
      post,
    })
    await expect(runOnce(deps)).rejects.toThrow('reader failed')
    expect(post).not.toHaveBeenCalled()
    expect(saved()).toBeNull()
  })
})

describe('runOnce for a triggered run (atto/6)', () => {
  const located = (overrides: Partial<Reading> = {}) => reading({ latitude: 0, longitude: 0, ...overrides })

  it('asks the reader for the position, tags the reading and sends both', async () => {
    const readCar = vi.fn(async (_withLocation: boolean) => located())
    const { deps, sent } = setup({ readCar })
    await runOnce(deps, { event: 'carplay_connect' })
    expect(readCar).toHaveBeenCalledWith(true)
    expect(sent[0]).toMatchObject({
      observation: { trigger_event: 'carplay_connect', latitude: 0, longitude: 0, soc_pct: 53 },
    })
  })

  it('does not ask the reader for the position on a timer run', async () => {
    const readCar = vi.fn(async (_withLocation: boolean) => reading())
    const { deps, sent } = setup({ readCar })
    await runOnce(deps)
    expect(readCar).toHaveBeenCalledWith(false)
    expect(JSON.stringify(sent)).not.toMatch(/trigger_event|latitude|longitude/)
  })

  it('still sends the tagged reading when the position could not be read', async () => {
    const { deps, sent } = setup({ readCar: async () => reading() })
    await runOnce(deps, { event: 'carplay_disconnect' })
    expect(sent[0]).toMatchObject({ observation: { trigger_event: 'carplay_disconnect' } })
    expect(JSON.stringify(sent)).not.toMatch(/latitude|longitude/)
  })

  it('logs the tag and whether a position was read, never the position', async () => {
    const log = vi.fn()
    const { deps } = setup({ log, readCar: async () => located({ latitude: 12.3456, longitude: 65.4321 }) })
    await runOnce(deps, { event: 'carplay_connect' })
    const lines = log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(lines).toContain('carplay_connect')
    expect(lines).toContain('position read')
    expect(lines).not.toMatch(/12\.3456|65\.4321/)
  })

  it('logs that no position was read when the reader gave none', async () => {
    const log = vi.fn()
    const { deps } = setup({ log })
    await runOnce(deps, { event: 'carplay_connect' })
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('no position')
  })

  it('does not record the poll when the Worker refuses it, tagged or not', async () => {
    const { deps, saved } = setup({ post: async () => ({ status: 503 }) })
    await expect(runOnce(deps, { event: 'carplay_connect' })).rejects.toThrow(/503/)
    expect(saved()).toBeNull()
  })
})

describe('postIngest', () => {
  const target = { baseUrl: 'https://atto1.myargus.cc', clientId: 'id.access', clientSecret: 's3cret' }

  it('posts JSON to the ingest path with the service token headers, without following redirects', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 201 }))
    const result = await postIngest(target, { vehicle: {} }, fetcher)
    expect(result).toEqual({ status: 201 })
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://atto1.myargus.cc/api/ingest/byd')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    const headers = new Headers(init.headers)
    expect(headers.get('cf-access-client-id')).toBe('id.access')
    expect(headers.get('cf-access-client-secret')).toBe('s3cret')
    expect(headers.get('content-type')).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ vehicle: {} }))
  })

  it('reports an Access redirect as a refusal, not a success', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 302, headers: { location: 'https://x' } }))
    expect(await postIngest(target, {}, fetcher)).toEqual({ status: 302 })
  })
})

describe('fileStateStore', () => {
  it('starts empty, then returns what was saved', async () => {
    const store = fileStateStore(join(mkdtempSync(join(tmpdir(), 'atto1-collector-')), 'state.json'))
    expect(await store.load()).toEqual(emptyState())
    const state: SessionState = { lastAt: '2026-11-07T01:00:00.000Z', open: null }
    await store.save(state)
    expect(await store.load()).toEqual(state)
  })

  it('refuses a state file it cannot read rather than starting over silently', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atto1-collector-')), 'state.json')
    writeFileSync(path, '{not json')
    await expect(fileStateStore(path).load()).rejects.toThrow(/state file/i)
  })

  it('keeps no secrets or coordinates in the file', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atto1-collector-')), 'state.json')
    await fileStateStore(path).save({ lastAt: '2026-11-07T01:00:00.000Z', open: null })
    expect(readFileSync(path, 'utf8')).not.toMatch(/vin|lat|lon|password|secret/i)
  })
})

describe('explainReadFailure', () => {
  const secrets = { username: 'owner@example.test', password: 'hunter2-example' }

  it('names the kill signal and the reader stderr, which the bare "Command failed" line dropped', () => {
    const error = Object.assign(new Error('Command failed: python read-byd.py --with-location'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
      stderr: 'GPS read failed: TimeoutError\n',
    })
    const message = explainReadFailure(error, secrets).message
    expect(message).toContain('Command failed')
    expect(message).toContain('killed by SIGTERM')
    expect(message).toContain('GPS read failed: TimeoutError')
  })

  it('names the exit code when the reader exited by itself', () => {
    const error = Object.assign(new Error('Command failed: python read-byd.py'), {
      killed: false,
      signal: null,
      code: 1,
      stderr: 'BYD login failed: code=3002',
    })
    const message = explainReadFailure(error, secrets).message
    expect(message).toContain('exit code 1')
    expect(message).toContain('BYD login failed: code=3002')
  })

  it('keeps the credentials and a VIN out of the message and bounds its length', () => {
    const error = Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: `login ${secrets.username} ${secrets.password} LC0CE4CB5S0123456 ${'x'.repeat(5000)}`,
    })
    const message = explainReadFailure(error, secrets).message
    expect(message).not.toContain(secrets.username)
    expect(message).not.toContain(secrets.password)
    expect(message).not.toContain('LC0CE4CB5S0123456')
    expect(message.length).toBeLessThan(1500)
  })

  it('passes something that is not an exec failure through unchanged', () => {
    const error = new Error('boom')
    expect(explainReadFailure(error, secrets)).toBe(error)
    expect(explainReadFailure('text', secrets).message).toBe('text')
  })
})

describe('runOnce for a charge run (atto/8)', () => {
  it.each(['charge_start', 'charge_stop'] as const)('tags the reading %s and never asks for the position', async (event) => {
    const readCar = vi.fn(async (_withLocation: boolean) => reading())
    const { deps, sent } = setup({ readCar })
    await runOnce(deps, { event })
    expect(readCar).toHaveBeenCalledWith(false)
    expect(sent[0]).toMatchObject({ observation: { trigger_event: event, soc_pct: 53 } })
  })

  it('drops a position the reader should not have sent', async () => {
    const { deps, sent } = setup({ readCar: async () => reading({ latitude: 0, longitude: 0 }) })
    await runOnce(deps, { event: 'charge_start' })
    expect(JSON.stringify(sent)).not.toMatch(/latitude|longitude/)
  })

  it('logs the tag and no position line', async () => {
    const log = vi.fn()
    const { deps } = setup({ log })
    await runOnce(deps, { event: 'charge_stop' })
    const lines = log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(lines).toContain('tagged charge_stop')
    expect(lines).not.toMatch(/position/)
  })

  it('opens a session on a charge_start reading and closes it on a charge_stop one', async () => {
    const charging = reading({ charge_state: 1, soc_pct: 40, observed_at: '2026-11-07T01:00:00.000Z' })
    const first = setup({ readCar: async () => charging })
    await runOnce(first.deps, { event: 'charge_start' })
    expect(first.saved()).toMatchObject({ open: { startedAt: '2026-11-07T01:00:00.000Z', startSoc: 40 } })

    const done = reading({ charge_state: 0, soc_pct: 80, observed_at: '2026-11-07T03:00:00.000Z' })
    const second = setup({ readCar: async () => done }, first.saved() as SessionState)
    await runOnce(second.deps, { event: 'charge_stop' })
    expect(second.sent[0]).toMatchObject({
      charging_session: { started_at: '2026-11-07T01:00:00.000Z', ended_at: '2026-11-07T03:00:00.000Z', start_soc_pct: 40, end_soc_pct: 80 },
    })
  })
})

describe('eventFromArguments', () => {
  it('is no event without arguments (the timer run)', () => {
    expect(eventFromArguments([])).toBeUndefined()
  })

  it.each(['charge_start', 'charge_stop'])('reads --event %s', (event) => {
    expect(eventFromArguments(['--event', event])).toBe(event)
  })

  it.each([
    ['an unknown event', ['--event', 'ignition_on']],
    ['a CarPlay event, which only the pick-up may run', ['--event', 'carplay_connect']],
    ['no value', ['--event']],
    ['an unknown argument', ['--now']],
  ])('refuses %s', (_label, args) => {
    expect(() => eventFromArguments(args)).toThrow(/--event/)
  })
})

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Reading } from './map.ts'
import { fileStateStore, postIngest, runOnce, type RunDeps } from './run.ts'
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
    readCar: async () => reading(),
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

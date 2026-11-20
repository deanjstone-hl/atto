import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { clearAccessKeyCache } from './access'
import { handle, type Env } from './index'
import {
  AUDIENCE,
  NOW_SECONDS,
  TEAM_DOMAIN,
  createSigningKey,
  requestWith,
  signToken,
  validClaims,
  type SigningKey,
} from './test-support/access-tokens'
import { d1Over, migratedDatabase } from './test-support/sqlite-d1'

const ownerSubject = 'subject-owner'
const ingestClientId = '0123456789abcdef0123456789abcdef.access'
const VIN = 'LC0CE4CB5S0123456'

let db: DatabaseSync
let key: SigningKey
let assets: Mock<(request: Request) => Promise<Response>>
let env: Env

const deps = () => ({ fetchKeys: async () => [key.publicJwk], now: () => NOW_SECONDS * 1000 })

// What Access signs for a service token: no `sub`, the client id in `common_name`.
const serviceClaims = (overrides: Record<string, unknown> = {}) =>
  validClaims({ sub: '', email: undefined, common_name: ingestClientId, type: 'app', ...overrides })

const reading = {
  observed_at: '2026-11-07T01:00:00Z',
  soc_pct: 53,
  displayed_range_km: 164,
  odometer_km: 3447,
}

const session = {
  started_at: '2026-11-07T02:00:00Z',
  ended_at: '2026-11-07T04:00:00Z',
  energy_kwh: 11.4,
  charger_type: 'ac_home',
  start_soc_pct: 20,
  end_soc_pct: 50,
  odometer_km: 3447,
}

const body = (overrides: Record<string, unknown> = {}) => ({
  vehicle: { vin: VIN, nickname: 'ATTO 1' },
  observation: reading,
  ...overrides,
})

type CallOptions = { claims?: Record<string, unknown>; token?: string | null; method?: string; raw?: string }

async function call(path: string, payload: unknown, options: CallOptions = {}) {
  const token =
    options.token !== undefined ? options.token : await signToken(key, options.claims ?? serviceClaims())
  const method = options.method ?? 'POST'
  const request = requestWith(token, `https://atto1.myargus.cc${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' || method === 'HEAD' ? undefined : (options.raw ?? JSON.stringify(payload)),
  })
  return handle(request, env, deps())
}

const ingest = (payload: unknown, options: CallOptions = {}) => call('/api/ingest/byd', payload, options)

type Row = Record<string, unknown>
const rows = (table: string): Row[] => db.prepare(`select * from ${table} order by created_at`).all() as Row[]

beforeEach(async () => {
  clearAccessKeyCache()
  key ??= await createSigningKey()
  db = migratedDatabase()
  assets = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('<!doctype html>'))
  env = {
    DB: d1Over(db),
    ASSETS: { fetch: assets },
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUDIENCE,
    INGEST_CLIENT_ID: ingestClientId,
    INGEST_OWNER_SUBJECT: ownerSubject,
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

describe('who may ingest', () => {
  it('lets the named service token write, as the owner', async () => {
    const response = await ingest(body())
    expect(response.status).toBe(201)
    expect(rows('vehicles')).toMatchObject([{ user_id: ownerSubject, vin: VIN, nickname: 'ATTO 1' }])
    expect(rows('range_observations')).toMatchObject([
      { user_id: ownerSubject, soc_pct: 53, displayed_range_km: 164, odometer_km: 3447, observed_at: '2026-11-07T01:00:00.000Z' },
    ])
  })

  it('refuses a service token with another client id', async () => {
    const response = await ingest(body(), { claims: serviceClaims({ common_name: 'someone-else.access' }) })
    expect(response.status).toBe(401)
    expect(rows('vehicles')).toEqual([])
  })

  it('refuses a service token that names no client', async () => {
    const response = await ingest(body(), { claims: serviceClaims({ common_name: undefined }) })
    expect(response.status).toBe(401)
  })

  it.each([
    ['no client id', { INGEST_CLIENT_ID: '' }],
    ['no owner subject', { INGEST_OWNER_SUBJECT: '' }],
    ['neither set', { INGEST_CLIENT_ID: undefined, INGEST_OWNER_SUBJECT: undefined }],
  ])('refuses every service token when ingest has %s configured', async (_label, settings) => {
    env = { ...env, ...settings }
    expect((await ingest(body())).status).toBe(401)
    expect(rows('vehicles')).toEqual([])
  })

  it('treats a token that has a subject as that person, whatever its common_name', async () => {
    const claims = validClaims({ sub: 'subject-stranger', common_name: ingestClientId })
    const response = await ingest(body(), { claims })
    expect(response.status).toBe(403)
    expect(rows('vehicles')).toEqual([])
  })

  it('refuses a signed-in owner on the ingest path: it is for the service token only', async () => {
    const response = await ingest(body(), { claims: validClaims({ sub: ownerSubject }) })
    expect(response.status).toBe(403)
    expect(rows('vehicles')).toEqual([])
  })

  it('refuses a request with no token', async () => {
    expect((await ingest(body(), { token: null })).status).toBe(401)
  })

  it('still refuses an expired service token', async () => {
    const response = await ingest(body(), { claims: serviceClaims({ exp: NOW_SECONDS - 3600 }) })
    expect(response.status).toBe(401)
  })
})

describe('what the service token may not do', () => {
  it.each([
    ['GET', '/api/me'],
    ['GET', '/api/dashboard'],
    ['GET', '/'],
    ['GET', '/assets/app.js'],
    ['GET', '/api/ingest/other'],
    ['POST', '/api/vehicles'],
    ['POST', '/api/charging-sessions'],
    ['POST', '/api/range-observations'],
    ['POST', '/api/vehicle-features'],
  ])('refuses %s %s', async (method, path) => {
    const response = await call(path, { nickname: 'x' }, { method })
    expect(response.status).toBe(403)
    expect(assets).not.toHaveBeenCalled()
    expect(rows('vehicles')).toEqual([])
  })

  it('answers only POST on the ingest path', async () => {
    const response = await ingest(null, { method: 'GET' })
    expect(response.status).toBe(405)
  })
})

describe('what ingest writes', () => {
  it('reuses the vehicle for the same VIN and adds a row per reading', async () => {
    await ingest(body())
    await ingest(body({ observation: { ...reading, observed_at: '2026-11-07T01:30:00Z', soc_pct: 52 } }))
    expect(rows('vehicles')).toHaveLength(1)
    expect(rows('range_observations').map((row) => row.soc_pct)).toEqual([53, 52])
  })

  it('reports the vehicle id and what it did with each part', async () => {
    const response = await ingest(body({ charging_session: session }))
    const result = (await response.json()) as Record<string, unknown>
    expect(result).toEqual({
      vehicle_id: rows('vehicles')[0].id,
      observation: 'created',
      charging_session: 'created',
    })
  })

  it('does not add the same observation twice (a retry after a lost response)', async () => {
    await ingest(body())
    const response = await ingest(body())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ observation: 'duplicate' })
    expect(rows('range_observations')).toHaveLength(1)
  })

  it('adds a charging session, once', async () => {
    await ingest({ vehicle: { vin: VIN, nickname: 'ATTO 1' }, charging_session: session })
    const again = await ingest({ vehicle: { vin: VIN, nickname: 'ATTO 1' }, charging_session: session })
    expect(await again.json()).toMatchObject({ charging_session: 'duplicate', observation: 'none' })
    expect(rows('charging_sessions')).toMatchObject([
      { user_id: ownerSubject, energy_kwh: 11.4, charger_type: 'ac_home', start_soc_pct: 20, end_soc_pct: 50 },
    ])
  })

  it('takes the battery capacity from the vehicle on first sight only', async () => {
    await ingest({ vehicle: { vin: VIN, nickname: 'ATTO 1', battery_capacity_kwh: 30 }, observation: reading })
    await ingest({
      vehicle: { vin: VIN, nickname: 'Renamed', battery_capacity_kwh: 99 },
      observation: { ...reading, observed_at: '2026-11-07T02:00:00Z' },
    })
    expect(rows('vehicles')).toMatchObject([{ nickname: 'ATTO 1', battery_capacity_kwh: 30 }])
  })

  it("never reuses another user's vehicle with the same VIN", async () => {
    db.prepare('insert into vehicles (user_id, nickname, vin) values (?, ?, ?)').run('subject-stranger', 'Theirs', VIN)
    await ingest(body())
    const owned = db.prepare('select user_id from vehicles where vin = ? order by created_at').all(VIN)
    expect(owned).toEqual([{ user_id: 'subject-stranger' }, { user_id: ownerSubject }])
    expect(rows('range_observations')).toMatchObject([{ user_id: ownerSubject }])
  })

  it('never updates or deletes: an existing row is left as it was', async () => {
    await ingest(body())
    const before = rows('vehicles')
    await ingest(body({ vehicle: { vin: VIN, nickname: 'Changed' } }))
    expect(rows('vehicles')).toEqual(before)
  })
})

describe('which vehicle a reading lands on (atto/5)', () => {
  const addVehicle = (userId: string, nickname: string, vin: string | null) =>
    (db.prepare('insert into vehicles (user_id, nickname, vin) values (?, ?, ?) returning id').get(userId, nickname, vin) as {
      id: string
    }).id

  it("attaches to the owner's only vehicle when it has no VIN and fills the VIN in, instead of making a second one", async () => {
    const handMade = addVehicle(ownerSubject, 'Toothless', null)
    const response = await ingest(body())
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ vehicle_id: handMade, observation: 'created' })
    expect(rows('vehicles')).toMatchObject([{ id: handMade, nickname: 'Toothless', vin: VIN }])
    expect(rows('range_observations')).toMatchObject([{ vehicle_id: handMade, soc_pct: 53 }])
  })

  it('never sets or overwrites the nickname of the vehicle it attaches to', async () => {
    addVehicle(ownerSubject, 'Toothless', null)
    await ingest(body({ vehicle: { vin: VIN, nickname: 'ATTO 1', battery_capacity_kwh: 30 } }))
    expect(rows('vehicles')).toMatchObject([{ nickname: 'Toothless', battery_capacity_kwh: null }])
  })

  it('keeps landing later readings on that vehicle through the VIN it now carries', async () => {
    const handMade = addVehicle(ownerSubject, 'Toothless', null)
    await ingest(body())
    await ingest(body({ observation: { ...reading, observed_at: '2026-11-07T01:30:00Z', soc_pct: 52 } }))
    expect(rows('vehicles')).toHaveLength(1)
    expect(rows('range_observations').map((row) => [row.vehicle_id, row.soc_pct])).toEqual([
      [handMade, 53],
      [handMade, 52],
    ])
  })

  it('attaches a charging session to it too', async () => {
    const handMade = addVehicle(ownerSubject, 'Toothless', null)
    await ingest(body({ charging_session: session }))
    expect(rows('charging_sessions')).toMatchObject([{ vehicle_id: handMade }])
  })

  it('prefers the vehicle that already carries the VIN over a vehicle without one', async () => {
    addVehicle(ownerSubject, 'Toothless', null)
    const withVin = addVehicle(ownerSubject, 'ATTO 1', VIN)
    await ingest(body())
    expect(rows('range_observations')).toMatchObject([{ vehicle_id: withVin }])
    expect(rows('vehicles')).toHaveLength(2)
  })

  it('makes a vehicle when the only one has a different VIN', async () => {
    addVehicle(ownerSubject, 'Other car', 'LC0CE4CB5S0654321')
    await ingest(body())
    expect(rows('vehicles')).toHaveLength(2)
    expect(rows('vehicles')[1]).toMatchObject({ vin: VIN })
  })

  it('makes a vehicle when more than one has no VIN, because it cannot tell which is the car', async () => {
    addVehicle(ownerSubject, 'One', null)
    addVehicle(ownerSubject, 'Two', null)
    await ingest(body())
    expect(rows('vehicles')).toHaveLength(3)
    expect(rows('vehicles')[2]).toMatchObject({ vin: VIN })
  })

  it("never attaches to another user's vehicle without a VIN", async () => {
    addVehicle('subject-stranger', 'Theirs', null)
    await ingest(body())
    expect(rows('range_observations')).toMatchObject([{ user_id: ownerSubject }])
    expect(rows('vehicles')).toHaveLength(2)
  })
})

describe('what ingest refuses', () => {
  it.each([
    ['a vehicle with no VIN', { vehicle: { nickname: 'ATTO 1' }, observation: reading }],
    ['a malformed VIN', { vehicle: { vin: 'not-a-vin', nickname: 'ATTO 1' }, observation: reading }],
    ['a charge above 100', body({ observation: { ...reading, soc_pct: 101 } })],
    ['a negative range', body({ observation: { ...reading, displayed_range_km: -1 } })],
    ['an observation time with no zone', body({ observation: { ...reading, observed_at: '2026-11-07T01:00:00' } })],
    ['a session with an unknown charger', body({ charging_session: { ...session, charger_type: 'rocket' } })],
    ['a session with no energy', body({ charging_session: { ...session, energy_kwh: undefined } })],
    ['a vehicle_id in the observation', body({ observation: { ...reading, vehicle_id: 'x' } })],
    ['a user_id in the vehicle', body({ vehicle: { vin: VIN, nickname: 'ATTO 1', user_id: 'someone' } })],
    ['an unknown top-level field', body({ extra: 1 })],
    ['neither an observation nor a session', { vehicle: { vin: VIN, nickname: 'ATTO 1' } }],
  ])('answers 422 for %s and writes nothing, not even the vehicle', async (_label, payload) => {
    const response = await ingest(payload)
    expect(response.status).toBe(422)
    expect(rows('vehicles')).toEqual([])
    expect(rows('range_observations')).toEqual([])
    expect(rows('charging_sessions')).toEqual([])
  })

  it('answers 415 for a body that is not JSON', async () => {
    const request = requestWith(await signToken(key, serviceClaims()), 'https://atto1.myargus.cc/api/ingest/byd', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    })
    expect((await handle(request, env, deps())).status).toBe(415)
  })

  it('answers 400 for malformed JSON', async () => {
    expect((await ingest(null, { raw: '{' })).status).toBe(400)
  })
})

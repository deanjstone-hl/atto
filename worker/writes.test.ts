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
const strangerSubject = 'subject-stranger'

let db: DatabaseSync
let key: SigningKey
let assets: Mock<(request: Request) => Promise<Response>>
let env: Env

const deps = () => ({ fetchKeys: async () => [key.publicJwk], now: () => NOW_SECONDS * 1000 })

type CallOptions = { as?: string; token?: string | null; contentType?: string | null; raw?: string }

async function post(path: string, body: unknown, options: CallOptions = {}) {
  const token = options.token !== undefined ? options.token : await signToken(key, validClaims({ sub: options.as ?? ownerSubject }))
  const headers: Record<string, string> = {}
  if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json'
  const request = requestWith(token, `https://atto1.myargus.cc${path}`, {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  })
  return handle(request, env, deps())
}

type Row = Record<string, unknown>

function rows(table: string): Row[] {
  return db.prepare(`select * from ${table} order by created_at`).all() as Row[]
}

function addVehicle(userId: string, nickname = 'Mine'): string {
  const row = db.prepare('insert into vehicles (user_id, nickname) values (?, ?) returning id').get(userId, nickname) as {
    id: string
  }
  return row.id
}

beforeEach(async () => {
  clearAccessKeyCache()
  key ??= await createSigningKey()
  db = migratedDatabase()
  assets = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('<!doctype html>'))
  env = { DB: d1Over(db), ASSETS: { fetch: assets }, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUDIENCE }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

const WRITE_ROUTES = ['/api/vehicles', '/api/charging-sessions', '/api/range-observations', '/api/vehicle-features']

describe('every write route', () => {
  it.each(WRITE_ROUTES)('refuses %s with no Access token and writes nothing', async (path) => {
    const response = await post(path, {}, { token: null })
    expect(response.status).toBe(401)
    expect(rows('vehicles')).toEqual([])
  })

  it.each(WRITE_ROUTES)('refuses a %s body that is not JSON', async (path) => {
    const response = await post(path, null, { contentType: 'text/plain' })
    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: 'unsupported_media_type' })
  })

  it.each(WRITE_ROUTES)('refuses malformed JSON on %s', async (path) => {
    const response = await post(path, null, { raw: '{"nickname":' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_json' })
  })

  it.each(WRITE_ROUTES)('refuses a body that is not an object on %s', async (path) => {
    for (const body of [[], 'text', 5, null]) {
      const response = await post(path, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_json' })
    }
  })

  it.each(WRITE_ROUTES)('refuses an oversized body on %s', async (path) => {
    const response = await post(path, { notes: 'x'.repeat(20_000) })
    expect(response.status).toBe(413)
  })

  it.each(WRITE_ROUTES)('answers 405 with the right Allow header for GET %s', async (path) => {
    const token = await signToken(key, validClaims({ sub: ownerSubject }))
    const response = await handle(requestWith(token, `https://atto1.myargus.cc${path}`), env, deps())
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('has no %s: nothing the owner entered can be changed or removed here', async (method) => {
    const token = await signToken(key, validClaims({ sub: ownerSubject }))
    const response = await handle(
      requestWith(token, 'https://atto1.myargus.cc/api/vehicles', { method }),
      env,
      deps(),
    )
    expect(response.status).toBe(405)
  })

  it.each(WRITE_ROUTES)('never lets the body choose the owner or the id on %s', async (path) => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post(path, { user_id: strangerSubject, id: 'chosen', vehicle_id: vehicleId })
    expect(response.status).toBe(422)
    const { fields } = (await response.json()) as { fields: Record<string, string> }
    expect(fields.user_id).toMatch(/not a field/i)
    expect(fields.id).toMatch(/not a field/i)
  })

  it('does not leak a database error', async () => {
    env = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1_ERROR: secret table detail')
        },
      },
    }
    const response = await post('/api/vehicles', { nickname: 'Atto' })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'write_failed' })
  })

  it('reports the missing schema before the migration is applied', async () => {
    env = { ...env, DB: d1Over(new DatabaseSync(':memory:')) }
    const response = await post('/api/vehicles', { nickname: 'Atto' })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'schema_missing' })
  })
})

describe('POST /api/vehicles', () => {
  it('creates a vehicle for the signed-in user and returns it', async () => {
    const response = await post('/api/vehicles', {
      nickname: '  Atto  ',
      vin: 'LC0CE4CB5R1234567',
      model_year: 2024,
      variant: 'Dynamic',
      battery_capacity_kwh: 60.48,
      purchased_on: '2024-03-02',
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const created = (await response.json()) as Row
    expect(created).toMatchObject({
      user_id: ownerSubject,
      nickname: 'Atto',
      vin: 'LC0CE4CB5R1234567',
      model_year: 2024,
      variant: 'Dynamic',
      battery_capacity_kwh: 60.48,
      purchased_on: '2024-03-02',
    })
    expect(created.id).toEqual(expect.any(String))
    expect(rows('vehicles')).toHaveLength(1)
  })

  it('needs only a nickname, and stores the rest as null', async () => {
    const response = await post('/api/vehicles', { nickname: 'Atto' })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      vin: null,
      model_year: null,
      variant: null,
      battery_capacity_kwh: null,
      purchased_on: null,
    })
  })

  it('shows up on the dashboard of the user who wrote it, and nobody else', async () => {
    await post('/api/vehicles', { nickname: 'Mine' })
    const mine = await handle(
      requestWith(await signToken(key, validClaims({ sub: ownerSubject })), 'https://atto1.myargus.cc/api/dashboard'),
      env,
      deps(),
    )
    expect(((await mine.json()) as { data: { vehicle: { nickname: string } } }).data.vehicle.nickname).toBe('Mine')
    const theirs = await handle(
      requestWith(await signToken(key, validClaims({ sub: strangerSubject })), 'https://atto1.myargus.cc/api/dashboard'),
      env,
      deps(),
    )
    expect(((await theirs.json()) as { data: { vehicle: unknown } }).data.vehicle).toBeNull()
  })

  it.each([
    ['a missing nickname', {}, 'nickname'],
    ['a blank nickname', { nickname: '   ' }, 'nickname'],
    ['a nickname over 80 characters', { nickname: 'x'.repeat(81) }, 'nickname'],
    ['a nickname that is not text', { nickname: 5 }, 'nickname'],
    ['a short VIN', { nickname: 'A', vin: 'ABC' }, 'vin'],
    ['a VIN with an I, O or Q', { nickname: 'A', vin: 'LC0CE4CB5R123456I' }, 'vin'],
    ['a lower-case VIN', { nickname: 'A', vin: 'lc0ce4cb5r1234567' }, 'vin'],
    ['a model year before 2020', { nickname: 'A', model_year: 2019 }, 'model_year'],
    ['a model year after 2100', { nickname: 'A', model_year: 2101 }, 'model_year'],
    ['a fractional model year', { nickname: 'A', model_year: 2024.5 }, 'model_year'],
    ['a model year as text', { nickname: 'A', model_year: '2024' }, 'model_year'],
    ['a variant over 80 characters', { nickname: 'A', variant: 'v'.repeat(81) }, 'variant'],
    ['a zero battery capacity', { nickname: 'A', battery_capacity_kwh: 0 }, 'battery_capacity_kwh'],
    ['a negative battery capacity', { nickname: 'A', battery_capacity_kwh: -1 }, 'battery_capacity_kwh'],
    ['a purchase date that is not a date', { nickname: 'A', purchased_on: '2024-02-30' }, 'purchased_on'],
    ['a purchase date with a time', { nickname: 'A', purchased_on: '2024-03-02T10:00:00Z' }, 'purchased_on'],
  ])('rejects %s with 422 naming the field, and writes nothing', async (_label, body, field) => {
    const response = await post('/api/vehicles', body)
    expect(response.status).toBe(422)
    const payload = (await response.json()) as { error: string; fields: Record<string, string> }
    expect(payload.error).toBe('validation_failed')
    expect(Object.keys(payload.fields)).toContain(field)
    expect(rows('vehicles')).toEqual([])
  })

  it('reports every problem at once', async () => {
    const response = await post('/api/vehicles', { nickname: '', vin: 'x', model_year: 1999 })
    const { fields } = (await response.json()) as { fields: Record<string, string> }
    expect(Object.keys(fields).sort()).toEqual(['model_year', 'nickname', 'vin'])
  })

  it('answers 409 for a VIN the user already has, and 201 for the same VIN under another user', async () => {
    expect((await post('/api/vehicles', { nickname: 'A', vin: 'LC0CE4CB5R1234567' })).status).toBe(201)

    const again = await post('/api/vehicles', { nickname: 'B', vin: 'LC0CE4CB5R1234567' })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'already_exists' })
    expect(rows('vehicles')).toHaveLength(1)

    expect((await post('/api/vehicles', { nickname: 'C', vin: 'LC0CE4CB5R1234567' }, { as: strangerSubject })).status).toBe(201)
  })

  it('falls back to 422 if the database rejects a value the Worker let through', async () => {
    const rejecting = new Error('D1_ERROR: CHECK constraint failed: length(trim(nickname)) between 1 and 80')
    env = {
      ...env,
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- partial D1 stub; the double assertion is the point of the fake
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => Promise.reject(rejecting) }) }) } as unknown as Env['DB'],
    }
    const response = await post('/api/vehicles', { nickname: 'Atto' })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'validation_failed', fields: {} })
  })
})

describe('POST /api/charging-sessions', () => {
  const session = {
    started_at: '2026-10-07T01:00:00Z',
    ended_at: '2026-10-07T03:30:00+00:00',
    energy_kwh: 32.5,
    cost_cents: 1250,
    currency: 'AUD',
    charger_type: 'ac_home',
    location_name: 'Home',
    start_soc_pct: 20,
    end_soc_pct: 80,
    odometer_km: 12000,
    notes: 'Off-peak',
  }

  it("creates a session on the user's own vehicle and returns it", async () => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/charging-sessions', { vehicle_id: vehicleId, ...session })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      user_id: ownerSubject,
      vehicle_id: vehicleId,
      started_at: '2026-10-07T01:00:00.000Z',
      ended_at: '2026-10-07T03:30:00.000Z',
      energy_kwh: 32.5,
      cost_cents: 1250,
      charger_type: 'ac_home',
    })
    expect(rows('charging_sessions')).toHaveLength(1)
  })

  it('needs only the vehicle, start, energy and charger type, defaulting the currency to AUD', async () => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/charging-sessions', {
      vehicle_id: vehicleId,
      started_at: '2026-10-07T01:00:00Z',
      energy_kwh: 10,
      charger_type: 'dc_fast',
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ currency: 'AUD', ended_at: null, cost_cents: null, notes: null })
  })

  it("refuses another user's vehicle with 404 and writes nothing", async () => {
    const theirs = addVehicle(strangerSubject, 'Theirs')
    const response = await post('/api/charging-sessions', { vehicle_id: theirs, ...session })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'vehicle_not_found' })
    expect(rows('charging_sessions')).toEqual([])
  })

  it('refuses a vehicle that does not exist with the same 404', async () => {
    const response = await post('/api/charging-sessions', { vehicle_id: 'no-such-vehicle', ...session })
    expect(response.status).toBe(404)
  })

  it.each([
    ['a missing vehicle', { vehicle_id: undefined }, 'vehicle_id'],
    ['a missing start', { started_at: undefined }, 'started_at'],
    ['a start with no time zone', { started_at: '2026-10-07T01:00:00' }, 'started_at'],
    ['a start that is not a date', { started_at: 'yesterday' }, 'started_at'],
    ['an end before the start', { ended_at: '2026-10-07T00:00:00Z' }, 'ended_at'],
    ['an end equal to the start', { ended_at: '2026-10-07T01:00:00Z' }, 'ended_at'],
    ['missing energy', { energy_kwh: undefined }, 'energy_kwh'],
    ['zero energy', { energy_kwh: 0 }, 'energy_kwh'],
    ['energy as text', { energy_kwh: '10' }, 'energy_kwh'],
    ['a fractional cost', { cost_cents: 12.5 }, 'cost_cents'],
    ['a negative cost', { cost_cents: -1 }, 'cost_cents'],
    ['a lower-case currency', { currency: 'aud' }, 'currency'],
    ['a two-letter currency', { currency: 'AU' }, 'currency'],
    ['a missing charger type', { charger_type: undefined }, 'charger_type'],
    ['an unknown charger type', { charger_type: 'solar' }, 'charger_type'],
    ['a location over 200 characters', { location_name: 'x'.repeat(201) }, 'location_name'],
    ['a start charge over 100', { start_soc_pct: 101 }, 'start_soc_pct'],
    ['a fractional end charge', { end_soc_pct: 80.5 }, 'end_soc_pct'],
    ['an end charge below the start charge', { start_soc_pct: 80, end_soc_pct: 20 }, 'end_soc_pct'],
    ['a negative odometer', { odometer_km: -1 }, 'odometer_km'],
  ])('rejects %s with 422 naming the field, and writes nothing', async (_label, override, field) => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/charging-sessions', { vehicle_id: vehicleId, ...session, ...override })
    expect(response.status).toBe(422)
    const { fields } = (await response.json()) as { fields: Record<string, string> }
    expect(Object.keys(fields)).toContain(field)
    expect(rows('charging_sessions')).toEqual([])
  })

  it('accepts an end charge when the start charge is not given', async () => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/charging-sessions', {
      vehicle_id: vehicleId,
      ...session,
      start_soc_pct: null,
      end_soc_pct: 50,
    })
    expect(response.status).toBe(201)
  })
})

describe('the collector-only fields on POST /api/range-observations (atto/6)', () => {
  it.each([
    ['trigger_event', 'carplay_connect'],
    ['latitude', 0],
    ['longitude', 0],
  ])('refuses %s: only the collector tags a reading or gives it a position', async (field, value) => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/range-observations', {
      vehicle_id: vehicleId,
      soc_pct: 80,
      displayed_range_km: 330,
      [field]: value,
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ fields: { [field]: `${field} is not a field` } })
    expect(rows('range_observations')).toEqual([])
  })
})

describe('POST /api/range-observations', () => {
  const observation = {
    observed_at: '2026-10-07T01:00:00Z',
    soc_pct: 80,
    displayed_range_km: 330,
    odometer_km: 12000,
    outside_temp_c: 18.5,
    climate_on: true,
    notes: 'Cruising at 100',
  }

  it('creates an observation, returns the climate flag as a boolean', async () => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/range-observations', { vehicle_id: vehicleId, ...observation })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      user_id: ownerSubject,
      vehicle_id: vehicleId,
      soc_pct: 80,
      displayed_range_km: 330,
      outside_temp_c: 18.5,
      climate_on: true,
    })
    expect(rows('range_observations')[0].climate_on).toBe(1)
  })

  it('stores climate off as false, and an unknown climate state as null', async () => {
    const vehicleId = addVehicle(ownerSubject)
    const off = await post('/api/range-observations', { vehicle_id: vehicleId, ...observation, climate_on: false })
    expect(((await off.json()) as Row).climate_on).toBe(false)
    const unknown = await post('/api/range-observations', { vehicle_id: vehicleId, ...observation, climate_on: null })
    expect(((await unknown.json()) as Row).climate_on).toBeNull()
  })

  it('defaults the observation time to now when it is not given', async () => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/range-observations', { vehicle_id: vehicleId, soc_pct: 50, displayed_range_km: 200 })
    expect(response.status).toBe(201)
    const created = (await response.json()) as { observed_at: string }
    expect(Number.isNaN(Date.parse(created.observed_at))).toBe(false)
  })

  it("refuses another user's vehicle with 404 and writes nothing", async () => {
    const theirs = addVehicle(strangerSubject, 'Theirs')
    const response = await post('/api/range-observations', { vehicle_id: theirs, ...observation })
    expect(response.status).toBe(404)
    expect(rows('range_observations')).toEqual([])
  })

  it.each([
    ['a missing charge', { soc_pct: undefined }, 'soc_pct'],
    ['a charge over 100', { soc_pct: 101 }, 'soc_pct'],
    ['a fractional charge', { soc_pct: 50.5 }, 'soc_pct'],
    ['a missing displayed range', { displayed_range_km: undefined }, 'displayed_range_km'],
    ['a negative displayed range', { displayed_range_km: -1 }, 'displayed_range_km'],
    ['a time that is not a date', { observed_at: 'later' }, 'observed_at'],
    ['a negative odometer', { odometer_km: -5 }, 'odometer_km'],
    ['a temperature above 60', { outside_temp_c: 61 }, 'outside_temp_c'],
    ['a temperature below -50', { outside_temp_c: -51 }, 'outside_temp_c'],
    ['a climate flag that is not a boolean', { climate_on: 1 }, 'climate_on'],
  ])('rejects %s with 422 naming the field, and writes nothing', async (_label, override, field) => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/range-observations', { vehicle_id: vehicleId, ...observation, ...override })
    expect(response.status).toBe(422)
    const { fields } = (await response.json()) as { fields: Record<string, string> }
    expect(Object.keys(fields)).toContain(field)
    expect(rows('range_observations')).toEqual([])
  })
})

describe('POST /api/vehicle-features', () => {
  const feature = { category: 'battery', name: 'Usable capacity', value: '60.48', unit: 'kWh', manual_reference: 'p. 120', notes: null }

  it("creates a feature on the user's own vehicle and returns it", async () => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/vehicle-features', { vehicle_id: vehicleId, ...feature })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      user_id: ownerSubject,
      vehicle_id: vehicleId,
      category: 'battery',
      name: 'Usable capacity',
      value: '60.48',
      unit: 'kWh',
    })
  })

  it('answers 409 for the same category and name on the same vehicle', async () => {
    const vehicleId = addVehicle(ownerSubject)
    expect((await post('/api/vehicle-features', { vehicle_id: vehicleId, ...feature })).status).toBe(201)
    const again = await post('/api/vehicle-features', { vehicle_id: vehicleId, ...feature, value: '61' })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'already_exists' })
    expect(rows('vehicle_features')).toHaveLength(1)
    expect(rows('vehicle_features')[0].value).toBe('60.48')
  })

  it("refuses another user's vehicle with 404 and writes nothing", async () => {
    const theirs = addVehicle(strangerSubject, 'Theirs')
    const response = await post('/api/vehicle-features', { vehicle_id: theirs, ...feature })
    expect(response.status).toBe(404)
    expect(rows('vehicle_features')).toEqual([])
  })

  it.each([
    ['a missing category', { category: undefined }, 'category'],
    ['an unknown category', { category: 'engine' }, 'category'],
    ['a missing name', { name: undefined }, 'name'],
    ['a blank name', { name: '  ' }, 'name'],
    ['a name over 120 characters', { name: 'n'.repeat(121) }, 'name'],
    ['a missing value', { value: undefined }, 'value'],
    ['a value over 500 characters', { value: 'v'.repeat(501) }, 'value'],
    ['a unit over 20 characters', { unit: 'u'.repeat(21) }, 'unit'],
    ['a manual reference over 200 characters', { manual_reference: 'r'.repeat(201) }, 'manual_reference'],
  ])('rejects %s with 422 naming the field, and writes nothing', async (_label, override, field) => {
    const vehicleId = addVehicle(ownerSubject)
    const response = await post('/api/vehicle-features', { vehicle_id: vehicleId, ...feature, ...override })
    expect(response.status).toBe(422)
    const { fields } = (await response.json()) as { fields: Record<string, string> }
    expect(Object.keys(fields)).toContain(field)
    expect(rows('vehicle_features')).toEqual([])
  })
})

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RANGE_OBSERVATION_LIMIT, RECENT_SESSION_LIMIT, TRIP_READING_LIMIT } from '../src/lib/dashboard/types'
import { DashboardLoadError, loadDashboard } from './dashboard'
import { d1Over, migratedDatabase } from './test-support/sqlite-d1'

const owner = 'owner-subject'
const stranger = 'stranger-subject'

let db: DatabaseSync

function addVehicle(userId: string, nickname: string, createdAt: string): string {
  const row = db
    .prepare('insert into vehicles (user_id, nickname, created_at) values (?, ?, ?) returning id')
    .get(userId, nickname, createdAt) as { id: string }
  return row.id
}

function addSession(userId: string, vehicleId: string, startedAt: string) {
  db.prepare(
    "insert into charging_sessions (user_id, vehicle_id, started_at, energy_kwh, charger_type) values (?, ?, ?, 10, 'ac_home')",
  ).run(userId, vehicleId, startedAt)
}

function addObservation(userId: string, vehicleId: string, observedAt: string, climateOn: number | null = null) {
  db.prepare(
    'insert into range_observations (user_id, vehicle_id, observed_at, soc_pct, displayed_range_km, climate_on) values (?, ?, ?, 80, 250, ?)',
  ).run(userId, vehicleId, observedAt, climateOn)
}

beforeEach(() => {
  db = migratedDatabase()
})

afterEach(() => {
  db.close()
})

describe('loadDashboard', () => {
  it('returns empty data, not an error, when the user has no vehicle', async () => {
    await expect(loadDashboard(d1Over(db), owner)).resolves.toEqual({
      kind: 'ready',
      data: { vehicle: null, sessions: [], observations: [], features: [], tripReadings: [] },
    })
  })

  it('picks the oldest vehicle and returns every section for it', async () => {
    const first = addVehicle(owner, 'First', '2026-01-01T00:00:00.000Z')
    const second = addVehicle(owner, 'Second', '2026-02-01T00:00:00.000Z')
    addSession(owner, first, '2026-03-01T00:00:00Z')
    addSession(owner, second, '2026-03-02T00:00:00Z')
    addObservation(owner, first, '2026-03-01T00:00:00Z', 1)
    db.prepare(
      "insert into vehicle_features (user_id, vehicle_id, category, name, value) values (?, ?, 'battery', 'Capacity', '43.2')",
    ).run(owner, first)

    const result = await loadDashboard(d1Over(db), owner)

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(result.data.vehicle).toMatchObject({ id: first, nickname: 'First', user_id: owner })
    expect(result.data.sessions.map((session) => session.vehicle_id)).toEqual([first])
    expect(result.data.observations).toHaveLength(1)
    expect(result.data.features).toMatchObject([{ name: 'Capacity' }])
  })

  it('picks the vehicle with the latest reading when the owner has more than one (atto/5)', async () => {
    const handMade = addVehicle(owner, 'Toothless', '2026-01-01T00:00:00.000Z')
    const collected = addVehicle(owner, 'ATTO 1', '2026-11-20T00:00:00.000Z')
    addObservation(owner, handMade, '2026-11-17T07:58:00Z')
    addObservation(owner, collected, '2026-11-20T22:00:28Z')

    const result = await loadDashboard(d1Over(db), owner)
    if (result.kind !== 'ready') throw new Error('expected ready')

    expect(result.data.vehicle).toMatchObject({ id: collected })
    expect(result.data.observations.map((entry) => entry.vehicle_id)).toEqual([collected])
  })

  it('falls back to the oldest vehicle when none has a reading', async () => {
    const first = addVehicle(owner, 'First', '2026-01-01T00:00:00.000Z')
    addVehicle(owner, 'Second', '2026-02-01T00:00:00.000Z')

    const result = await loadDashboard(d1Over(db), owner)
    if (result.kind !== 'ready') throw new Error('expected ready')

    expect(result.data.vehicle).toMatchObject({ id: first })
  })

  it('prefers a vehicle with a reading over an older one with none', async () => {
    addVehicle(owner, 'Empty', '2026-01-01T00:00:00.000Z')
    const read = addVehicle(owner, 'Read', '2026-02-01T00:00:00.000Z')
    addObservation(owner, read, '2026-03-01T00:00:00Z')

    const result = await loadDashboard(d1Over(db), owner)
    if (result.kind !== 'ready') throw new Error('expected ready')

    expect(result.data.vehicle).toMatchObject({ id: read })
  })

  it("ignores another user's newer readings when choosing", async () => {
    const mine = addVehicle(owner, 'Mine', '2026-01-01T00:00:00.000Z')
    addObservation(owner, mine, '2026-03-01T00:00:00Z')
    const theirs = addVehicle(stranger, 'Theirs', '2026-01-01T00:00:00.000Z')
    addObservation(stranger, theirs, '2026-04-01T00:00:00Z')

    const result = await loadDashboard(d1Over(db), owner)
    if (result.kind !== 'ready') throw new Error('expected ready')

    expect(result.data.vehicle).toMatchObject({ id: mine })
  })

  it('returns climate_on as a boolean or null', async () => {
    const vehicleId = addVehicle(owner, 'Atto', '2026-01-01T00:00:00.000Z')
    addObservation(owner, vehicleId, '2026-03-01T00:00:00Z', 1)
    addObservation(owner, vehicleId, '2026-03-02T00:00:00Z', 0)
    addObservation(owner, vehicleId, '2026-03-03T00:00:00Z', null)

    const result = await loadDashboard(d1Over(db), owner)
    if (result.kind !== 'ready') throw new Error('expected ready')

    expect(result.data.observations.map((entry) => entry.climate_on)).toEqual([null, false, true])
  })

  it('orders sessions newest first and caps them', async () => {
    const vehicleId = addVehicle(owner, 'Atto', '2026-01-01T00:00:00.000Z')
    for (let day = 1; day <= RECENT_SESSION_LIMIT + 3; day += 1) {
      addSession(owner, vehicleId, `2026-03-${String(day).padStart(2, '0')}T00:00:00Z`)
    }
    const result = await loadDashboard(d1Over(db), owner)
    if (result.kind !== 'ready') throw new Error('expected ready')

    expect(result.data.sessions).toHaveLength(RECENT_SESSION_LIMIT)
    expect(result.data.sessions[0].started_at).toBe('2026-03-08T00:00:00Z')
  })

  it('caps range observations', async () => {
    const vehicleId = addVehicle(owner, 'Atto', '2026-01-01T00:00:00.000Z')
    for (let index = 0; index < RANGE_OBSERVATION_LIMIT + 2; index += 1) {
      addObservation(owner, vehicleId, new Date(Date.UTC(2026, 0, 1, index)).toISOString())
    }
    const result = await loadDashboard(d1Over(db), owner)
    if (result.kind !== 'ready') throw new Error('expected ready')
    expect(result.data.observations).toHaveLength(RANGE_OBSERVATION_LIMIT)
  })

  describe('trip readings (atto/6)', () => {
    const addTagged = (userId: string, vehicleId: string, observedAt: string, event: string, position = false) =>
      db
        .prepare(
          `insert into range_observations
             (user_id, vehicle_id, observed_at, soc_pct, displayed_range_km, trigger_event, latitude, longitude)
           values (?, ?, ?, 80, 250, ?, ?, ?)`,
        )
        .run(userId, vehicleId, observedAt, event, position ? 0.5 : null, position ? -0.5 : null)

    it('returns only the readings a trigger tagged, newest first, with their position', async () => {
      const vehicleId = addVehicle(owner, 'Atto', '2026-01-01T00:00:00.000Z')
      addObservation(owner, vehicleId, '2026-03-01T00:00:00Z')
      addTagged(owner, vehicleId, '2026-03-02T00:00:00Z', 'carplay_connect', true)
      addTagged(owner, vehicleId, '2026-03-02T01:00:00Z', 'carplay_disconnect')

      const result = await loadDashboard(d1Over(db), owner)
      if (result.kind !== 'ready') throw new Error('expected ready')

      expect(result.data.tripReadings.map((row) => [row.observed_at, row.trigger_event, row.latitude, row.longitude])).toEqual([
        ['2026-03-02T01:00:00Z', 'carplay_disconnect', null, null],
        ['2026-03-02T00:00:00Z', 'carplay_connect', 0.5, -0.5],
      ])
    })

    it("never returns another vehicle's or another user's tagged readings", async () => {
      const mine = addVehicle(owner, 'Mine', '2026-01-01T00:00:00.000Z')
      const other = addVehicle(owner, 'Other', '2026-01-02T00:00:00.000Z')
      const theirs = addVehicle(stranger, 'Theirs', '2026-01-01T00:00:00.000Z')
      addTagged(owner, mine, '2026-03-02T00:00:00Z', 'carplay_connect')
      addObservation(owner, mine, '2026-03-03T00:00:00Z')
      addTagged(owner, other, '2026-03-01T00:00:00Z', 'carplay_connect')
      addTagged(stranger, theirs, '2026-03-04T00:00:00Z', 'carplay_connect')

      const result = await loadDashboard(d1Over(db), owner)
      if (result.kind !== 'ready') throw new Error('expected ready')

      expect(result.data.vehicle).toMatchObject({ id: mine })
      expect(result.data.tripReadings.map((row) => row.vehicle_id)).toEqual([mine])
    })

    it('caps them', async () => {
      const vehicleId = addVehicle(owner, 'Atto', '2026-01-01T00:00:00.000Z')
      for (let index = 0; index < TRIP_READING_LIMIT + 2; index += 1) {
        addTagged(owner, vehicleId, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), 'carplay_connect')
      }
      const result = await loadDashboard(d1Over(db), owner)
      if (result.kind !== 'ready') throw new Error('expected ready')
      expect(result.data.tripReadings).toHaveLength(TRIP_READING_LIMIT)
    })
  })

  describe('authorisation', () => {
    it("never returns another user's rows", async () => {
      const theirs = addVehicle(stranger, 'Theirs', '2026-01-01T00:00:00.000Z')
      addSession(stranger, theirs, '2026-03-01T00:00:00Z')
      addObservation(stranger, theirs, '2026-03-01T00:00:00Z')
      db.prepare(
        "insert into vehicle_features (user_id, vehicle_id, category, name, value) values (?, ?, 'battery', 'Capacity', '1')",
      ).run(stranger, theirs)

      await expect(loadDashboard(d1Over(db), owner)).resolves.toEqual({
        kind: 'ready',
        data: { vehicle: null, sessions: [], observations: [], features: [], tripReadings: [] },
      })
    })

    it("shows each user only their own vehicle even when theirs is older", async () => {
      addVehicle(stranger, 'Theirs', '2025-01-01T00:00:00.000Z')
      addVehicle(owner, 'Mine', '2026-01-01T00:00:00.000Z')
      const result = await loadDashboard(d1Over(db), owner)
      if (result.kind !== 'ready') throw new Error('expected ready')
      expect(result.data.vehicle).toMatchObject({ nickname: 'Mine', user_id: owner })
    })

    it('binds the user as a parameter rather than splicing it into the SQL', async () => {
      const seen: string[] = []
      const spying = {
        prepare(query: string) {
          seen.push(query)
          return d1Over(db).prepare(query)
        },
      }
      await loadDashboard(spying, "x' or '1'='1")
      expect(seen.join('\n')).not.toContain("x' or")
    })

    it('treats a hostile subject as an ordinary, empty user', async () => {
      addVehicle(owner, 'Mine', '2026-01-01T00:00:00.000Z')
      const result = await loadDashboard(d1Over(db), "' or user_id is not null --")
      expect(result).toMatchObject({ kind: 'ready', data: { vehicle: null } })
    })
  })

  describe('errors', () => {
    it('reports schema-missing when the migration is not applied', async () => {
      const bare = d1Over(new DatabaseSync(':memory:'))
      await expect(loadDashboard(bare, owner)).resolves.toEqual({ kind: 'schema-missing' })
    })

    it('reports schema-missing when only a child table is missing', async () => {
      addVehicle(owner, 'Atto', '2026-01-01T00:00:00.000Z')
      db.exec('drop table vehicle_features')
      await expect(loadDashboard(d1Over(db), owner)).resolves.toEqual({ kind: 'schema-missing' })
    })

    it('throws any other error, naming the table', async () => {
      addVehicle(owner, 'Atto', '2026-01-01T00:00:00.000Z')
      const real = d1Over(db)
      const failing = {
        prepare(query: string) {
          const statement = real.prepare(query)
          if (!query.includes('charging_sessions')) return statement
          const broken = {
            ...statement,
            bind: () => broken,
            all: async () => {
              throw new Error('D1_ERROR: database is locked')
            },
          }
          return broken
        },
      }
      const result = loadDashboard(failing, owner)
      await expect(result).rejects.toBeInstanceOf(DashboardLoadError)
      await expect(result).rejects.toThrow('charging_sessions: D1_ERROR: database is locked')
    })
  })
})

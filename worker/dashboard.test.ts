import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RANGE_OBSERVATION_LIMIT, RECENT_SESSION_LIMIT } from '../src/lib/dashboard/types'
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
      data: { vehicle: null, sessions: [], observations: [], features: [] },
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
        data: { vehicle: null, sessions: [], observations: [], features: [] },
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

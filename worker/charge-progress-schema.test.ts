import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migratedDatabase } from './test-support/sqlite-d1'

// Migration 0003 (atto/19): the charge in progress, one insert-only row per poll.

const user = 'a0000000-0000-4000-8000-00000000000a'

let db: DatabaseSync
let vehicleId: string

beforeAll(() => {
  db = migratedDatabase()
  vehicleId = (
    db.prepare("insert into vehicles (user_id, nickname) values (?, 'Atto') returning id").get(user) as { id: string }
  ).id
})

afterAll(() => {
  db.close()
})

const insert = (overrides: Record<string, unknown> = {}) => {
  const row = {
    started_at: '2026-11-23T06:48:00.000Z',
    observed_at: '2026-11-23T07:18:00.000Z',
    start_soc_pct: 40,
    soc_pct: 45,
    energy_kwh: 2.5,
    ...overrides,
  }
  return db
    .prepare(
      `insert into charge_progress (user_id, vehicle_id, started_at, observed_at, start_soc_pct, soc_pct, energy_kwh)
       values (?, ?, ?, ?, ?, ?, ?) returning *`,
    )
    .get(user, vehicleId, row.started_at, row.observed_at, row.start_soc_pct, row.soc_pct, row.energy_kwh) as Record<
    string,
    unknown
  >
}

describe('migration 0003: charge_progress', () => {
  it('stores a poll of the open charge with a generated id and a UTC created_at', () => {
    const row = insert()
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('has no updated_at: a row is never updated', () => {
    const columns = db.prepare('pragma table_info(charge_progress)').all() as { name: string }[]
    expect(columns.map((column) => column.name)).not.toContain('updated_at')
  })

  it('takes a poll without an energy figure, for a collector with no battery capacity', () => {
    expect(insert({ observed_at: '2026-11-23T07:48:00.000Z', energy_kwh: null }).energy_kwh).toBeNull()
  })

  it('refuses the same poll of the same charge twice', () => {
    insert({ observed_at: '2026-11-23T08:18:00.000Z' })
    expect(() => insert({ observed_at: '2026-11-23T08:18:00.000Z' })).toThrow(/UNIQUE constraint failed/)
  })

  it.each([
    ['a percentage over 100', { soc_pct: 101 }],
    ['a start percentage under 0', { start_soc_pct: -1 }],
    ['a charge below its start', { start_soc_pct: 50, soc_pct: 45 }],
    ['a negative energy', { energy_kwh: -1 }],
    ['a poll before the start', { observed_at: '2026-11-23T06:00:00.000Z' }],
    ['a start that is not a time', { started_at: 'yesterday' }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => insert({ observed_at: '2026-11-23T09:18:00.000Z', ...overrides })).toThrow(/CHECK constraint failed/)
  })

  it("refuses a row for a vehicle that is not the user's", () => {
    expect(() =>
      db
        .prepare(
          `insert into charge_progress (user_id, vehicle_id, started_at, observed_at, start_soc_pct, soc_pct)
           values ('someone-else', ?, '2026-11-23T06:48:00.000Z', '2026-11-23T10:18:00.000Z', 40, 45)`,
        )
        .run(vehicleId),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })
})
